import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { lstatIfPresent, openLock, socketName } from "./files.js";
import { exit, launch } from "./process.js";
import type { ToolName } from "./tools.js";

export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const helloSchema = z.strictObject({ clientId: z.uuid(), version: z.literal(1) });
export const requestSchema = z.strictObject({ id: z.int().positive(), tool: z.string(), input: z.unknown() });
export const cancelSchema = z.strictObject({ cancel: z.int().positive() });
const responseSchema = z.union([
  z.strictObject({ id: z.int().nonnegative(), result: z.record(z.string(), z.unknown()) }),
  z.strictObject({ id: z.int().nonnegative(), error: z.string() }),
]);

export function receiveFrames(socket: Socket, onFrame: (value: unknown) => void): void {
  let chunks: Buffer[] = [];
  let bytes = 0;
  socket.on("data", (chunk: Buffer) => {
    let start = 0;
    while (start < chunk.length && !socket.destroyed) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      bytes += part.length;
      if (bytes > MAX_FRAME_BYTES) {
        socket.destroy(new Error("Colab daemon message exceeded the size limit."));
        return;
      }
      chunks.push(part);
      if (newline === -1) return;
      try {
        onFrame(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
      } catch {
        socket.destroy(new Error("The Colab daemon received an invalid message."));
        return;
      }
      chunks = [];
      bytes = 0;
      start = end + 1;
    }
  });
}

export function sendFrame(socket: Socket, frame: object): void {
  const line = JSON.stringify(frame) + "\n";
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("Colab daemon message exceeded the size limit.");
  // Bound queued output if a local peer stops reading.
  if (socket.writableLength > MAX_FRAME_BYTES) socket.destroy();
  if (!socket.destroyed) socket.write(line);
}

async function tryConnect(): Promise<Socket | undefined> {
  const info = await lstatIfPresent(socketName);
  if (!info) return undefined;
  if (!info.isSocket() || info.uid !== process.getuid?.()) {
    throw new Error("The Colab daemon socket is not a Unix socket owned by this user.");
  }
  // A newly bound socket may still be waiting for chmod.
  if ((info.mode & 0o777) !== 0o600) return undefined;

  const socket = createConnection(socketName);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => socket.destroy(), 1000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EAGAIN") resolve(undefined);
      else reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
  });
}

async function startDaemon(): Promise<boolean> {
  // Both lock utilities lock the inherited open file description. The daemon keeps a
  // duplicate of fd 3 for its lifetime, so a crash releases the lock automatically.
  const lock = await openLock();
  try {
    const darwin = process.platform === "darwin";
    const utility = darwin ? "/usr/bin/lockf" : "flock";
    const helper = launch({ program: utility, args: darwin ? ["-s", "-t", "0", "3"] : ["-n", "3"] },
      { stdio: ["ignore", "ignore", "ignore", lock.fd] });
    const code = await exit(helper).catch(() => {
      throw new Error(`The Colab daemon requires ${utility} to acquire its startup lock.`);
    });
    if (code === (darwin ? 75 : 1)) return false;
    if (code !== 0) throw new Error("Could not acquire the Colab daemon startup lock.");

    const daemon = launch({
      program: process.execPath, args: [fileURLToPath(new URL("./daemon.js", import.meta.url))], cwd: process.cwd(),
    }, { detached: true, stdio: ["ignore", "ignore", "ignore", lock.fd] });
    await new Promise<void>((resolve, reject) => {
      daemon.once("error", reject);
      daemon.once("spawn", resolve);
    });
    daemon.unref();
    return true;
  } finally {
    await lock.close();
  }
}

export class DaemonClient {
  private nextId = 1;
  private readonly pending = new Map<number, PromiseWithResolvers<Record<string, unknown>>>();
  private readonly stopped = new Error("The shared Colab daemon connection closed.");

  private constructor(private readonly socket: Socket) {
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      for (const request of this.pending.values()) request.reject(this.stopped);
      this.pending.clear();
    });
    receiveFrames(socket, (frame) => {
      const response = responseSchema.parse(frame);
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      if ("error" in response) request.reject(new Error(response.error));
      else request.resolve(response.result);
    });
  }

  get disconnected() {
    return this.socket.destroyed;
  }

  static async connect(clientId: string) {
    const deadline = Date.now() + 15_000;
    let launched = false;
    while (Date.now() < deadline) {
      const socket = await tryConnect();
      if (socket) {
        const client = new DaemonClient(socket);
        const hello = Promise.withResolvers<Record<string, unknown>>();
        const timer = setTimeout(() => client.close(), 5000);
        client.pending.set(0, hello);
        sendFrame(socket, { clientId, version: 1 });
        try {
          await hello.promise;
          return client;
        } catch (error) {
          client.close();
          throw error;
        } finally {
          clearTimeout(timer);
        }
      }
      if (!launched) launched = await startDaemon();
      await delay(200);
    }
    throw new Error("Timed out waiting for the shared Colab daemon.");
  }

  async call(tool: ToolName, input: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.socket.destroyed) throw this.stopped;
    const id = this.nextId++;
    const request = Promise.withResolvers<Record<string, unknown>>();
    const abort = () => sendFrame(this.socket, { cancel: id });
    this.pending.set(id, request);
    signal.addEventListener("abort", abort, { once: true });
    try {
      sendFrame(this.socket, { id, tool, input });
      return await request.promise;
    } finally {
      signal.removeEventListener("abort", abort);
      this.pending.delete(id);
    }
  }

  close() {
    this.socket.destroy();
  }
}
