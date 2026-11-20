import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import { pipeline } from "node:stream/promises";

const LOG_BYTES = 64 * 1024;
const debug = process.env.COLAB_MCP_DEBUG === "1";

export interface Command {
  program: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function launch(command: Command, options: SpawnOptions): ChildProcess {
  return spawn(command.program, command.args, { cwd: command.cwd, env: command.env, ...options });
}

export function exit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
}

export function terminate(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 1000);
  force.unref();
  child.once("exit", () => clearTimeout(force));
}

function watchAbort(child: ChildProcess, signal?: AbortSignal): () => void {
  const abort = () => terminate(child);
  signal?.addEventListener("abort", abort, { once: true });
  return () => signal?.removeEventListener("abort", abort);
}

function capture(stream: NodeJS.ReadableStream, limit: number): () => Buffer {
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on("data", (chunk: Buffer) => {
    const end = chunk.subarray(-limit);
    chunks.push(end);
    size += end.length;
    while (size > limit) {
      const excess = size - limit;
      const first = chunks[0]!;
      if (first.length <= excess) {
        chunks.shift();
        size -= first.length;
      } else {
        chunks[0] = first.subarray(excess);
        size = limit;
      }
    }
  });
  return () => Buffer.concat(chunks, size);
}

export async function collect(command: Command, options: {
  input?: string | Buffer;
  signal?: AbortSignal;
  stdoutLimit?: number;
} = {}) {
  const { input, signal, stdoutLimit = LOG_BYTES } = options;
  signal?.throwIfAborted();
  const child = launch(command, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  const removeAbort = watchAbort(child, signal);
  const stdout = capture(child.stdout!, stdoutLimit);
  const stderr = capture(child.stderr!, LOG_BYTES);
  const closed = exit(child);
  // A remote channel may reject the request and close its input before the write finishes.
  child.stdin?.on("error", () => {});
  child.stdin?.end(input);
  try {
    const code = await closed;
    signal?.throwIfAborted();
    return { code, stdout: stdout(), stderr: stderr().toString("utf8") };
  } finally {
    removeAbort();
  }
}

export async function checked(command: Command, message: string, timeoutMs = 15_000, options: {
  input?: string | Buffer;
  signal?: AbortSignal;
  stdoutLimit?: number;
  diagnostic?: boolean;
} = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const result = await collect(command, { ...options, signal });
    if (result.code === 0) return result;
    // Only opt-in infrastructure diagnostics reach the daemon log.
    if (debug && options.diagnostic) console.error(result.stderr.trim());
  } catch {
    options.signal?.throwIfAborted();
  }
  throw new Error(message);
}

export async function transfer(source: Command, destination: Command, message: string, options: {
  input?: Buffer;
  signal: AbortSignal;
}): Promise<void> {
  const { input, signal } = options;
  signal.throwIfAborted();
  const producer = launch(source, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
  const consumer = launch(destination, { stdio: ["pipe", "ignore", "ignore"] });
  const children = [producer, consumer];
  const removers = children.map((child) => watchAbort(child, signal));
  const statuses = children.map(exit);
  producer.stdin?.on("error", () => {});
  producer.stdin?.end(input);
  try {
    const [produced, consumed] = await Promise.all([
      ...statuses, pipeline(producer.stdout!, consumer.stdin!, { signal }),
    ]);
    signal.throwIfAborted();
    if (produced !== 0 || consumed !== 0) throw new Error(message);
  } catch {
    for (const child of children) terminate(child);
    await Promise.allSettled(statuses);
    signal.throwIfAborted();
    throw new Error(message);
  } finally {
    for (const remove of removers) remove();
  }
}
