import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { profiles, type Hardware, type JobInput, type poolStopSchema } from "./tools.js";

const MAX_RETAINED_RESULTS = 128;
const MAX_LOG_BYTES = 64 * 1024;

type VmState = "provisioning" | "ready" | "draining" | "stopping";
type JobState = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface JobResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts: string[];
  error?: string;
}

interface JobStatus extends Partial<JobResult> {
  jobId: string;
  hardware: Hardware;
  status: JobState;
  sessionName?: string;
  queuedMs: number;
  durationMs: number;
  artifacts: string[];
}

interface Vm {
  sessionName: string;
  hardware: Hardware;
  maxJobs: number;
  state: VmState;
  jobs: Set<Job>;
  booted: Promise<void>;
  lastIdleAt: number;
  stopping?: Promise<void>;
}

interface Job {
  id: string;
  clientId: string;
  hardware: Hardware;
  input: JobInput;
  queuedAt: number;
  startedAt?: number;
  vm?: Vm;
  controller: AbortController;
  timeout: NodeJS.Timeout;
  done: PromiseWithResolvers<JobStatus>;
  result?: JobStatus;
  finishing: boolean;
}

export interface ColabTransport {
  isAvailable(): boolean;
  start(session: string, flags: readonly string[]): Promise<void>;
  probe(session: string): Promise<{ cpu: number; memoryAvailable: number }>;
  run(session: string, job: string, input: JobInput, signal: AbortSignal): Promise<JobResult>;
  clean(session: string, job: string): Promise<void>;
  stop(session: string): Promise<void>;
  reconcileOrphans(ownsSession: (session: string) => boolean): Promise<void>;
  balance(): Promise<number | null>;
}

export interface PoolOptions {
  maxVms: number;
  idleTimeoutSeconds: number;
  maxCpuJobs: number;
  maxHighMemJobs: number;
}

const message = (error: unknown) => error instanceof Error ? error.message : "Colab operation failed.";
const tail = (log: string) => Buffer.from(log).subarray(-MAX_LOG_BYTES).toString("utf8");

export class ColabPool {
  private readonly vms = new Map<string, Vm>();
  private readonly jobs = new Map<string, Job>();
  private readonly waiting = new Set<Job>();
  private readonly finished = new Set<string>();
  private readonly timer: NodeJS.Timeout;
  private readonly reconciliation: Promise<void>;
  private closing = false;
  private dispatching: Promise<void> | undefined;
  private dispatchRequested = false;

  constructor(private readonly transport: ColabTransport, readonly options: PoolOptions) {
    this.timer = setInterval(() => this.reap(), Math.min(options.idleTimeoutSeconds, 5) * 1000);
    this.timer.unref();
    this.reconciliation = transport.reconcileOrphans((session) => this.vms.has(session))
      .catch((error: unknown) => console.error("Colab orphan reconciliation failed:", message(error)));
  }

  get activeVms(): number {
    return this.vms.size;
  }

  get pendingJobs(): number {
    return this.jobs.size - this.finished.size;
  }

  private snapshot(job: Job): JobStatus {
    const now = Date.now();
    return job.result ?? {
      jobId: job.id,
      hardware: job.hardware,
      status: job.vm ? "running" : "queued",
      ...(job.vm && { sessionName: job.vm.sessionName }),
      queuedMs: (job.startedAt ?? now) - job.queuedAt,
      durationMs: job.startedAt === undefined ? 0 : now - job.startedAt,
      artifacts: [],
    };
  }

  async run(clientId: string, input: JobInput, signal?: AbortSignal): Promise<JobStatus> {
    signal?.throwIfAborted();
    if (this.closing) throw new Error("The Colab pool is shutting down.");
    if (!this.transport.isAvailable()) throw new Error("The Colab CLI is unavailable.");

    const job: Job = {
      id: randomUUID(), clientId, hardware: input.hardware, input, queuedAt: Date.now(),
      controller: new AbortController(), done: Promise.withResolvers(), finishing: false,
      timeout: setTimeout(() => this.abort(job, "timed_out"), input.timeoutSeconds * 1000),
    };
    this.jobs.set(job.id, job);
    this.waiting.add(job);
    this.wake();

    if (input.mode === "async") return this.snapshot(job);
    const abort = () => this.abort(job, "cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await job.done.promise;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private findJob(clientId: string, jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (job?.clientId !== clientId) throw new Error("Colab job not found for this client.");
    return job;
  }

  jobStatus(clientId: string, jobId: string): JobStatus {
    return this.snapshot(this.findJob(clientId, jobId));
  }

  cancel(clientId: string, jobId: string): Promise<JobStatus> {
    const job = this.findJob(clientId, jobId);
    this.abort(job, "cancelled");
    return job.done.promise;
  }

  private abort(job: Job, reason: "cancelled" | "timed_out"): void {
    if (job.finishing || job.controller.signal.aborted) return;
    job.controller.abort(reason);
    if (!job.vm) this.finish(job, { status: reason });
  }

  private finish(job: Job, result: Partial<JobStatus> & { status: JobState }): void {
    job.finishing = true;
    clearTimeout(job.timeout);
    this.waiting.delete(job);
    job.result = { ...this.snapshot(job), ...result };
    this.finished.add(job.id);
    if (this.finished.size > MAX_RETAINED_RESULTS) {
      const oldest = this.finished.values().next().value!;
      this.finished.delete(oldest);
      this.jobs.delete(oldest);
    }
    job.done.resolve(job.result);
    this.wake();
  }

  private async execute(job: Job, vm: Vm): Promise<void> {
    let result: Partial<JobStatus> & { status: JobState };
    try {
      const output = await this.transport.run(vm.sessionName, job.id, job.input, job.controller.signal);
      result = {
        ...output, stdout: tail(output.stdout), stderr: tail(output.stderr),
        status: output.exitCode === 0 && output.error === undefined ? "completed" : "failed",
      };
    } catch (error) {
      result = { status: "failed", error: message(error) };
    }
    if (job.controller.signal.aborted) result = { status: job.controller.signal.reason };
    job.finishing = true;
    clearTimeout(job.timeout);
    try {
      await this.transport.clean(vm.sessionName, job.id);
    } catch {
      // Never return an unconfirmed slot to service. Other jobs can finish before retirement.
      if (vm.state === "ready") vm.state = "draining";
    }
    vm.jobs.delete(job);
    vm.lastIdleAt = Date.now();
    if (vm.state === "draining" && vm.jobs.size === 0 && !this.closing) {
      void this.stopVm(vm).catch(() => {});
    }
    this.finish(job, result);
  }

  private provision(hardware: Hardware): Vm {
    const maxJobs = hardware === "cpu" ? this.options.maxCpuJobs :
      hardware === "cpu-high-mem" ? this.options.maxHighMemJobs : profiles[hardware].maxJobs;
    const vm: Vm = {
      sessionName: `mcp-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      hardware, maxJobs, state: "provisioning", jobs: new Set(), lastIdleAt: Date.now(),
      booted: Promise.resolve(),
    };
    this.vms.set(vm.sessionName, vm);
    vm.booted = this.boot(vm);
    return vm;
  }

  private async boot(vm: Vm): Promise<void> {
    try {
      await this.transport.start(vm.sessionName, profiles[vm.hardware].flags);
      vm.lastIdleAt = Date.now();
      if (vm.state === "provisioning") vm.state = "ready";
    } catch (error) {
      if (vm.state === "provisioning") {
        vm.state = "draining";
        const next = [...this.waiting].find((job) => job.hardware === vm.hardware);
        if (next) this.finish(next, { status: "failed", error: message(error) });
        if (!this.closing) void this.stopVm(vm).catch(() => {});
      }
    }
    this.wake();
  }

  private async chooseVm(hardware: Hardware): Promise<Vm | undefined> {
    const candidates = [...this.vms.values()].filter((vm) =>
      vm.hardware === hardware && vm.state === "ready" && vm.jobs.size < vm.maxJobs);
    const idle = candidates.find((vm) => vm.jobs.size === 0);
    if (idle) return idle;
    const probes = await Promise.all(candidates.map(async (vm) => {
      try {
        const load = await this.transport.probe(vm.sessionName);
        return load.cpu < 0.9 && load.memoryAvailable > 0.1 ? { vm, ...load } : undefined;
      } catch {
        return undefined;
      }
    }));
    return probes.filter((probe) => probe !== undefined).sort((a, b) =>
      a.cpu - b.cpu || b.memoryAvailable - a.memoryAvailable || a.vm.jobs.size - b.vm.jobs.size)[0]?.vm;
  }

  private wake(): void {
    if (this.closing) return;
    this.dispatchRequested = true;
    this.dispatching ??= Promise.resolve().then(async () => {
      try {
        while (this.dispatchRequested && !this.closing) {
          this.dispatchRequested = false;
          await this.dispatch();
        }
      } finally {
        this.dispatching = undefined;
      }
    }).catch((error: unknown) => console.error("Colab dispatch failed:", message(error)));
  }

  private async dispatch(): Promise<void> {
    const blocked = new Set<Hardware>();
    for (const job of this.waiting) {
      if (this.closing) return;
      if (blocked.has(job.hardware)) continue;
      const vm = await this.chooseVm(job.hardware);
      if (this.closing) return;
      if (!this.waiting.has(job)) continue;
      if (Date.now() - job.queuedAt >= job.input.timeoutSeconds * 1000) {
        this.abort(job, "timed_out");
        continue;
      }
      if (vm?.state !== "ready" || vm.jobs.size >= vm.maxJobs) {
        blocked.add(job.hardware);
        continue;
      }
      this.waiting.delete(job);
      job.vm = vm;
      job.startedAt = Date.now();
      vm.jobs.add(job);
      void this.execute(job, vm);
    }

    const demand = new Map<Hardware, number>();
    for (const { hardware } of this.waiting) demand.set(hardware, (demand.get(hardware) ?? 0) + 1);
    for (const [hardware, count] of demand) {
      if (!blocked.has(hardware)) continue;
      let capacity = 0;
      for (const vm of this.vms.values()) {
        if (vm.hardware === hardware && (vm.state === "ready" || vm.state === "provisioning")) {
          capacity += vm.maxJobs - vm.jobs.size;
        }
      }
      // Count booting capacity to reserve slots for concurrent cold jobs.
      while (capacity < count && this.vms.size < this.options.maxVms) {
        capacity += this.provision(hardware).maxJobs;
      }
      if (capacity >= count || [...this.vms.values()].some((vm) => vm.state === "stopping")) continue;
      const idle = [...this.vms.values()].find((vm) =>
        vm.state === "ready" && vm.jobs.size === 0 && !demand.has(vm.hardware));
      if (idle) void this.stopVm(idle).catch(() => {});
    }
  }

  private reap(): void {
    const now = Date.now();
    for (const vm of this.vms.values()) {
      if (vm.jobs.size !== 0) continue;
      if (vm.state === "draining" || (vm.state === "ready" &&
        now - vm.lastIdleAt >= this.options.idleTimeoutSeconds * 1000 &&
        ![...this.waiting].some((job) => job.hardware === vm.hardware))) {
        void this.stopVm(vm).catch(() => {});
      }
    }
    if (this.waiting.size) this.wake();
  }

  async status() {
    const computeUnitBalance = await this.transport.balance();
    return {
      vms: [...this.vms.values()].map((vm) => ({
        sessionName: vm.sessionName, hardware: vm.hardware, state: vm.state,
        activeJobs: vm.jobs.size, maxJobs: vm.maxJobs,
        availableSlots: vm.state === "ready" ? vm.maxJobs - vm.jobs.size : 0,
        queuedJobs: [...this.waiting].filter((job) => job.hardware === vm.hardware).length,
      })),
      maxVms: this.options.maxVms, queuedJobs: this.waiting.size, computeUnitBalance,
    };
  }

  private stopVm(vm: Vm): Promise<void> {
    vm.state = "stopping";
    vm.stopping ??= vm.booted.then(() => this.transport.stop(vm.sessionName)).then(() => {
      this.vms.delete(vm.sessionName);
      this.wake();
    }, (error: unknown) => {
      vm.stopping = undefined;
      vm.state = "draining";
      throw error;
    });
    return vm.stopping;
  }

  async stop(clientId: string, { sessionName, force }: z.output<typeof poolStopSchema>): Promise<string[]> {
    const selected = [...this.vms.values()].filter((vm) =>
      (!sessionName || vm.sessionName === sessionName) &&
      (force || (vm.state !== "provisioning" && vm.jobs.size === 0)));
    if (selected.some((vm) => [...vm.jobs].some((job) => job.clientId !== clientId))) {
      throw new Error("A selected Colab VM has jobs from another client.");
    }
    // Reserve every selected VM synchronously so dispatch cannot add jobs while cleanup runs.
    for (const vm of selected) if (vm.state !== "stopping") vm.state = "draining";
    await Promise.all(selected.map(async (vm) => {
      await Promise.all([...vm.jobs].map((job) => this.cancel(clientId, job.id)));
      if (this.vms.has(vm.sessionName)) await this.stopVm(vm);
    }));
    return selected.map((vm) => vm.sessionName);
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    const pending = [...this.jobs.values()].filter((job) => !job.result);
    for (const job of pending) this.abort(job, "cancelled");
    await Promise.all([this.dispatching, this.reconciliation, ...pending.map((job) => job.done.promise)]);
    const results = await Promise.allSettled([...this.vms.values()].map((vm) => this.stopVm(vm)));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError(failures.map((failure) => failure.reason), "Could not stop every Colab VM.");
    }
  }
}
