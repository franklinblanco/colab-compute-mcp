#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runtimeDirectory } from "./files.js";
import { DaemonClient, MAX_FRAME_BYTES } from "./ipc.js";
import { tools, type ToolName } from "./tools.js";

async function main() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("colab-compute-mcp requires macOS or Linux.");
  }

  const server = new McpServer({ name: "colab-compute-mcp", version: "0.1.0" },
    { maxToolInputElements: 16384 });
  process.chdir(await runtimeDirectory());
  const clientId = randomUUID();
  let daemon: Promise<DaemonClient> | undefined;
  let connected: DaemonClient | undefined;
  let closed = false;

  // Initialize MCP immediately and start the shared daemon on the first tool call.
  const call = (tool: ToolName) => async (input: unknown, extra: { signal: AbortSignal }) => {
    try {
      if (closed) throw new Error("The Colab MCP client has closed.");
      if (connected?.disconnected) {
        connected = undefined;
        daemon = undefined;
      }
      daemon ??= DaemonClient.connect(clientId).then((client) => {
        connected = client;
        return client;
      }, (error: unknown) => {
        daemon = undefined;
        throw error;
      });
      const client = await daemon;
      if (closed) throw new Error("The Colab MCP client has closed.");
      const result = await client.call(tool, input, extra.signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const,
        text: error instanceof Error ? error.message : "Colab tool call failed." }] };
    }
  };

  server.registerTool("colab_run_job", tools.colab_run_job, call("colab_run_job"));
  server.registerTool("colab_job_status", tools.colab_job_status, call("colab_job_status"));
  server.registerTool("colab_cancel_job", tools.colab_cancel_job, call("colab_cancel_job"));
  server.registerTool("colab_pool_status", tools.colab_pool_status, call("colab_pool_status"));
  server.registerTool("colab_pool_stop", tools.colab_pool_stop, call("colab_pool_stop"));

  const shutdown = () => {
    if (closed) return;
    closed = true;
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    void daemon?.then((client) => client.close(), () => {});
    void server.close().catch(() => {});
  };

  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.stdout.on("error", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_FRAME_BYTES }));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not start the Colab MCP server.");
  process.exitCode = 1;
}
