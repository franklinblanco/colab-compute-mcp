import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

export async function connect(stateDir, { entrypoint = cliPath, env = {}, name = "test-client" } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    env: { PATH: process.env.PATH, COLAB_MCP_STATE_DIR: stateDir, ...env },
    stderr: "pipe",
  });
  transport.stderr?.setEncoding("utf8").on("data", (data) => process.stderr.write(data));
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

export function request(client, name, args = {}) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 270_000 });
}

export async function call(client, name, args) {
  const result = await request(client, name, args);
  if (result.isError) throw new Error(result.content.map((part) => part.text).join("\n"));
  return result.structuredContent;
}

export async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error("Timed out waiting for the expected state.");
}
