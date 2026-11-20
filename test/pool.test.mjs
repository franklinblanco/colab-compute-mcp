import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { ColabPool } from "../dist/pool.js";
import { runSchema } from "../dist/tools.js";
import { until } from "./client.mjs";

function createPool(t, overrides = {}) {
  const starts = [];
  const assigned = [];
  const stops = [];
  const cleaned = [];
  const transport = {
    isAvailable: () => true,
    start: async (session, flags) => {
      const gate = Promise.withResolvers();
      starts.push({ session, flags, gate });
      await gate.promise;
    },
    probe: async () => ({ cpu: 0.2, memoryAvailable: 0.8 }),
    run: async (session, id, input, signal) => {
      const gate = Promise.withResolvers();
      assigned.push({ session, id, command: input.command, gate });
      try {
        signal.throwIfAborted();
        await Promise.race([gate.promise, delay(30_000, undefined, { signal, ref: false })]);
        return { exitCode: 0, stdout: input.command, stderr: "", artifacts: [] };
      } finally {
        gate.resolve();
      }
    },
    clean: async (session, id) => { cleaned.push({ session, id }); },
    stop: async (session) => { stops.push(session); },
    reconcileOrphans: async () => {},
    balance: async () => 500,
  };
  const pool = new ColabPool(transport, {
    maxVms: 2, maxCpuJobs: 2, maxHighMemJobs: 4, idleTimeoutSeconds: 600, ...overrides,
  });
  t.after(async () => {
    for (const { gate } of starts) gate.resolve();
    await pool.close();
  });
  function submit(client, command, { mode = "async", ...options } = {}, signal) {
    return pool.run(client, runSchema.parse({ command, syncWorkspace: false, mode, ...options }), signal);
  }
  return { pool, transport, starts, assigned, stops, cleaned, submit };
}

const finish = (job) => job.gate.resolve();
const count = (array, length) => until(() => array.length >= length);

test("two cold CPU jobs coalesce and use independent slots", async (t) => {
  const { pool, submit, starts, assigned } = createPool(t);
  const [a, b] = await Promise.all([submit("a", "one"), submit("b", "two")]);
  assert.equal(a.status, "queued");
  await count(starts, 1);
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].flags, []);
  assert.equal((await pool.status()).vms[0].state, "provisioning");
  finish(starts[0]);
  await count(assigned, 2);
  assert.equal(assigned[0].session, assigned[1].session);
  assert.deepEqual(assigned.map(({ id }) => id), [a.jobId, b.jobId]);
  const { vms, computeUnitBalance } = await pool.status();
  assert.equal(vms[0].activeJobs, 2);
  assert.equal(vms[0].availableSlots, 0);
  assert.equal(computeUnitBalance, 500);
});

test("the third cold CPU job scales out and overflow jobs are served FIFO", async (t) => {
  const { pool, submit, starts, assigned } = createPool(t);
  const jobs = await Promise.all(["one", "two", "three"].map((command) => submit("a", command)));
  await count(starts, 2);
  assert.equal(starts.length, 2);
  finish(starts[0]);
  await count(assigned, 2);
  finish(starts[1]);
  await count(assigned, 3);
  jobs.push(...await Promise.all(["four", "five", "six"].map((command) => submit("a", command))));
  await count(assigned, 4);
  assert.equal((await pool.status()).queuedJobs, 2);
  finish(assigned[1]);
  await count(assigned, 5);
  assert.deepEqual(assigned.map(({ id }) => id), jobs.slice(0, 5).map(({ jobId }) => jobId));
  finish(assigned[0]);
  await count(assigned, 6);
  assert.deepEqual(assigned.map(({ id }) => id), jobs.map(({ jobId }) => jobId));
});

test("a busy VM must pass both CPU and memory probes before accepting another job", async (t) => {
  const { transport, pool, submit, starts, assigned } = createPool(t, { maxVms: 1 });
  let cpu = 0.9;
  let memoryAvailable = 0.2;
  let calls = 0;
  transport.probe = async () => {
    calls++;
    return { cpu, memoryAvailable };
  };
  await submit("a", "first");
  await count(starts, 1);
  finish(starts[0]);
  await count(assigned, 1);
  const b = await submit("b", "second");
  await until(() => calls >= 1);
  assert.equal(pool.jobStatus("b", b.jobId).status, "queued");
  cpu = 0.1;
  memoryAvailable = 0.1;
  const previous = calls;
  const c = await submit("c", "third");
  await until(() => calls > previous);
  assert.equal(pool.jobStatus("b", b.jobId).status, "queued");
  assert.equal(pool.jobStatus("c", c.jobId).status, "queued");
  memoryAvailable = 0.6;
  finish(assigned[0]);
  await count(assigned, 3);
  assert.equal(starts.length, 1);
});

test("incompatible demand immediately evicts an idle VM at maxVms", async (t) => {
  const { submit, starts, stops, assigned } = createPool(t, { maxVms: 1 });
  const first = submit("a", "cpu", { mode: "wait" });
  await count(starts, 1);
  finish(starts[0]);
  await count(assigned, 1);
  finish(assigned[0]);
  assert.equal((await first).stdout, "cpu");

  await submit("b", "gpu", { hardware: "gpu-t4" });
  await count(starts, 2);
  assert.deepEqual(stops, [starts[0].session]);
  assert.deepEqual(starts[1].flags, ["--gpu", "T4", "--high-mem"]);
});

test("status, cancellation, and forced VM stop enforce client ownership", async (t) => {
  const { pool, submit, starts, assigned, cleaned } = createPool(t, { maxVms: 1 });
  const a = await submit("a", "first");
  const b = await submit("b", "second");
  await count(starts, 1);
  finish(starts[0]);
  await count(assigned, 2);
  assert.throws(() => pool.jobStatus("a", b.jobId), /not found for this client/u);
  assert.throws(() => pool.cancel("a", b.jobId), /not found for this client/u);
  await assert.rejects(pool.stop("a", { force: true }), /another client/u);
  assert.deepEqual(await pool.stop("a", {}), []);
  assert.equal((await pool.cancel("b", b.jobId)).status, "cancelled");
  assert.deepEqual(await pool.stop("a", { force: true }), [starts[0].session]);
  assert.equal(pool.jobStatus("a", a.jobId).status, "cancelled");
  assert.deepEqual(new Set(cleaned.map(({ id }) => id)), new Set([a.jobId, b.jobId]));
});

test("cancellation keeps a slot occupied until cleanup is confirmed", async (t) => {
  const { pool, transport, submit, starts, assigned, cleaned } = createPool(t, { maxVms: 1, maxCpuJobs: 1 });
  const a = await submit("a", "first");
  const b = await submit("b", "second");
  await count(starts, 1);
  finish(starts[0]);
  await count(assigned, 1);
  const clean = transport.clean;
  const gate = Promise.withResolvers();
  transport.clean = async (session, id) => {
    await clean(session, id);
    if (id === a.jobId) await gate.promise;
  };
  const cancelled = pool.cancel("a", a.jobId);
  try {
    await count(cleaned, 1);
    assert.equal(pool.jobStatus("b", b.jobId).status, "queued");
    assert.equal((await pool.status()).vms[0].availableSlots, 0);
  } finally {
    gate.resolve();
  }
  assert.equal((await cancelled).status, "cancelled");
  await count(assigned, 2);
});

test("failed cleanup drains a VM without interrupting the other job", async (t) => {
  const { pool, transport, submit, starts, assigned, stops } = createPool(t, { maxVms: 1 });
  const a = await submit("a", "first");
  const b = await submit("b", "second");
  transport.clean = async (_, id) => {
    if (id === a.jobId) throw new Error("unconfirmed");
  };
  await count(starts, 1);
  finish(starts[0]);
  await count(assigned, 2);
  assert.equal((await pool.cancel("a", a.jobId)).status, "cancelled");
  assert.equal((await pool.status()).vms[0].state, "draining");
  assert.equal(pool.jobStatus("b", b.jobId).status, "running");
  assert.deepEqual(stops, []);
  finish(assigned[1]);
  await count(stops, 1);
  assert.equal(pool.jobStatus("b", b.jobId).status, "completed");
});

test("queued and running jobs honor deadlines and idle VMs are reaped", async (t) => {
  const { pool, submit, starts, assigned, stops } = createPool(t, {
    maxVms: 1, maxCpuJobs: 1, idleTimeoutSeconds: 1,
  });
  const [a, b] = await Promise.all([
    submit("a", "first", { timeoutSeconds: 2 }),
    submit("b", "second", { timeoutSeconds: 1 }),
  ]);
  await count(starts, 1);
  finish(starts[0]);
  await count(assigned, 1);
  await until(() => pool.jobStatus("a", a.jobId).status === "timed_out" &&
    pool.jobStatus("b", b.jobId).status === "timed_out");
  assert.equal(assigned.length, 1);
  await count(stops, 1);
  assert.deepEqual((await pool.status()).vms, []);
});

test("aborting a waiting MCP call cancels and cleans its job", async (t) => {
  const { submit, starts, assigned, cleaned } = createPool(t);
  const controller = new AbortController();
  const result = submit("a", "wait", { mode: "wait" }, controller.signal);
  await count(starts, 1);
  finish(starts[0]);
  await count(assigned, 1);
  controller.abort();
  assert.equal((await result).status, "cancelled");
  assert.equal(cleaned.length, 1);
});
