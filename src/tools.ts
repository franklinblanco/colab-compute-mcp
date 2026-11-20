import { isAbsolute } from "node:path";
import { z } from "zod";

export const profiles = {
  cpu: { flags: [], maxJobs: 2 },
  "cpu-high-mem": { flags: ["--high-mem"], maxJobs: 4 },
  "gpu-t4": { flags: ["--gpu", "T4", "--high-mem"], maxJobs: 2 },
  "gpu-l4": { flags: ["--gpu", "L4"], maxJobs: 2 },
  "gpu-g4": { flags: ["--gpu", "G4", "--high-mem"], maxJobs: 2 },
  "gpu-a100": { flags: ["--gpu", "A100", "--high-mem"], maxJobs: 2 },
  "gpu-h100": { flags: ["--gpu", "H100", "--high-mem"], maxJobs: 2 },
  "tpu-v5e1": { flags: ["--tpu", "v5e1"], maxJobs: 1 },
  "tpu-v6e1": { flags: ["--tpu", "v6e1"], maxJobs: 1 },
} as const;

export type Hardware = keyof typeof profiles;
const hardware = z.enum(Object.keys(profiles) as [Hardware, ...Hardware[]]);

export function safeRelative(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !/^[A-Za-z]:/u.test(path) &&
    !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every((part) => part !== ".." && part.toLowerCase() !== ".git");
}

const cwd = z.string().refine(safeRelative, "cwd must be inside the job directory.");
const artifact = z.string().refine((path) =>
  safeRelative(path) && path.split("/").some((part) => part && part !== "."),
"Artifact paths must be relative to and inside the job directory.");
const envKey = z.string().refine((key) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && !/^(?:LD_|DYLD_|BASH_FUNC_)/u.test(key) &&
  !["BASH_ENV", "ENV", "HOME", "USER", "LOGNAME", "PWD", "SHELL"].includes(key),
"Invalid job environment variable name.");

export const runSchema = z.strictObject({
  command: z.string().refine((value) => value.trim() && !value.includes("\0"), "Provide a nonempty command."),
  workspacePath: z.string().refine((path) => isAbsolute(path) && !path.includes("\0"),
    "workspacePath must be an absolute local path.").optional(),
  hardware: hardware.default("cpu"),
  syncWorkspace: z.boolean().default(true),
  cwd: cwd.optional(),
  env: z.record(envKey, z.string().refine((value) => !value.includes("\0"))).optional(),
  artifactPaths: z.array(artifact).optional(),
  mode: z.enum(["wait", "async"]).default("wait"),
  timeoutSeconds: z.int().min(1).max(1800).default(300),
}).superRefine((input, context) => {
  if ((input.syncWorkspace || input.artifactPaths?.length) && !input.workspacePath) {
    context.addIssue({
      code: "custom", path: ["workspacePath"],
      message: "workspacePath is required for workspace sync or artifact retrieval.",
    });
  }
});

export type JobInput = z.output<typeof runSchema>;

const jobSchema = z.strictObject({ jobId: z.uuid() });
export const poolStopSchema = z.strictObject({
  sessionName: z.string().min(1).optional(),
  force: z.boolean().optional(),
});

export const tools = {
  colab_run_job: {
    description: "Build or test on a shared Colab VM. Defaults to CPU, syncing an absolute local workspace, and waiting up to 300 seconds. Async returns a job ID. cwd and artifactPaths are workspace-relative.",
    inputSchema: runSchema,
    annotations: { openWorldHint: true },
  },
  colab_job_status: {
    description: "Get one of this client's Colab jobs, including its state, exit code, log tails, and artifacts.",
    inputSchema: jobSchema,
    annotations: { readOnlyHint: true },
  },
  colab_cancel_job: {
    description: "Cancel one of this client's queued or running Colab jobs.",
    inputSchema: jobSchema,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  colab_pool_status: {
    description: "List shared Colab VMs, available slots, queued jobs, and the compute-unit balance.",
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  colab_pool_stop: {
    description: "Stop idle VMs, optionally by session name. Force can also cancel this client's jobs on selected VMs.",
    inputSchema: poolStopSchema,
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
} as const;

export type ToolName = keyof typeof tools;
