import { chmodSync, fstatSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { lstatIfPresent, lockName, socketName } from "./files.js";
import { cancelSchema, helloSchema, receiveFrames, requestSchema, sendFrame } from "./ipc.js";
import { ColabPool, type ColabTransport, type PoolOptions } from "./pool.js";
import { resolveWorkspace } from "./transport.js";
import { tools } from "./tools.js";

const EXIT_GRACE_MS = 3000;
const MAX_PENDING_REQUESTS = 128;

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function poolOptions(): PoolOptions {
  return {
    maxVms: positiveInt("COLAB_MCP_MAX_VMS", 2),
    idleTimeoutSeconds: positiveInt("COLAB_MCP_IDLE_TIMEOUT_SECONDS", 600),
    maxCpuJobs: positiveInt("COLAB_MCP_MAX_JOBS_PER_CPU_VM", 2),
    maxHighMemJobs: positiveInt("COLAB_MCP_MAX_JOBS_PER_HIGH_MEM_VM", 4),
  };
}

async function dispatch(pool: ColabPool, clientId: string, tool: string, input: unknown, signal: AbortSignal) {
  switch (tool) {
    case "colab_run_job": {
      const job = tools[tool].inputSchema.parse(input);
      if (job.workspacePath) job.workspacePath = await resolveWorkspace(job.workspacePath);
      return pool.run(clientId, job, signal);
    }
    case "colab_job_status":
      return pool.jobStatus(clientId, tools[tool].inputSchema.parse(input).jobId);
    case "colab_cancel_job":
      return pool.cancel(clientId, tools[tool].inputSchema.parse(input).jobId);
    case "colab_pool_status":
      tools[tool].inputSchema.parse(input);
      return pool.status();
    case "colab_pool_stop":
      return { stopped: await pool.stop(clientId, tools[tool].inputSchema.parse(input)) };
    default:
      throw new Error("Unknown Colab tool.");
  }
}

export async function serveDaemon(transport: ColabTransport) {
  const lock = await lstatIfPresent(lockName);
  const inherited = fstatSync(3);
  if (!lock?.isFile() || lock.dev !== inherited.dev || lock.ino !== inherited.ino) {
    throw new Error("Launch the Colab daemon through the stdio MCP server.");
  }

  const stale = await lstatIfPresent(socketName);
  if (stale) {
    if (!stale.isSocket() || stale.uid !== process.getuid?.()) {
      throw new Error("Cannot replace an unexpected Colab daemon socket path.");
    }
    await rm(socketName);
  }

  const pool = new ColabPool(transport, poolOptions());
  const sockets = new Set<Socket>();
  const clients = new Set<string>();
  let lastActive = Date.now();
  let closing = false;

  const server = createServer((socket) => {
    sockets.add(socket);
    lastActive = Date.now();
    const requests = new Map<number, AbortController>();
    let clientId: string | undefined;
    const handshake = setTimeout(() => socket.destroy(), EXIT_GRACE_MS);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(handshake);
      sockets.delete(socket);
      if (clientId) clients.delete(clientId);
      for (const controller of requests.values()) controller.abort();
      lastActive = Date.now();
    });
    receiveFrames(socket, (frame) => {
      if (!clientId) {
        const hello = helloSchema.parse(frame);
        if (clients.has(hello.clientId)) throw new Error("Duplicate client identity.");
        clearTimeout(handshake);
        clientId = hello.clientId;
        clients.add(clientId);
        sendFrame(socket, { id: 0, result: {} });
        return;
      }

      const cancel = cancelSchema.safeParse(frame);
      if (cancel.success) {
        requests.get(cancel.data.cancel)?.abort();
        return;
      }
      const { id, tool, input } = requestSchema.parse(frame);
      if (requests.has(id)) throw new Error("Duplicate request ID.");
      if (requests.size >= MAX_PENDING_REQUESTS) {
        sendFrame(socket, { id, error: "Too many concurrent requests from this Colab client." });
        return;
      }

      const controller = new AbortController();
      requests.set(id, controller);
      const reply = (response: object) => {
        if (!socket.destroyed) sendFrame(socket, { id, ...response });
      };
      void dispatch(pool, clientId, tool, input, controller.signal).then(
        (result) => reply({ result }),
        (error: unknown) => reply({ error: error instanceof Error ? error.message : "Colab request failed." }),
      ).catch(() => {
        reply({ error: "Colab response exceeded the message size limit." });
      }).finally(() => requests.delete(id));
    });
  });

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(idleCheck);
    for (const socket of sockets) socket.destroy();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      // Keep the startup lock through cleanup. Retry transient Colab stop failures.
      for (let attempt = 0; ; attempt++) {
        try {
          await pool.close();
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await delay(1000);
        }
      }
    } finally {
      await closed;
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
  };
  const onSignal = () => {
    void shutdown().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Colab shutdown failed.");
      process.exitCode = 1;
    });
  };
  const idleCheck = setInterval(() => {
    if (sockets.size || pool.activeVms || pool.pendingJobs) lastActive = Date.now();
    else if (Date.now() - lastActive >= EXIT_GRACE_MS) onSignal();
  }, 250);

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketName, () => {
        try {
          chmodSync(socketName, 0o600);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    server.on("error", onSignal);
  } catch (error) {
    await shutdown();
    throw error;
  }
}
