import assert from "node:assert/strict";
import { cp, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { call, cliPath, connect, request, until } from "./client.mjs";

test("two separate stdio MCP clients share one cold daemon and one fake VM", { timeout: 25_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "colab-mcp-daemon-test-"));
  const overlay = join(root, "dist");
  // Exceed macOS's absolute sockaddr limit to exercise relative socket paths.
  const state = join(root, "state-" + "a".repeat(110));
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client?.close()));
    try {
      await until(async () => !(await lstat(join(state, "daemon.sock")).catch(() => undefined)), 8000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await cp(dirname(cliPath), overlay, { recursive: true });
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"));
  await writeFile(join(overlay, "daemon.js"), `
    import { appendFile, writeFile } from "node:fs/promises";
    import { setTimeout } from "node:timers/promises";
    import { serveDaemon } from "./server.js";
    await appendFile("daemon-starts", process.pid + "\\n");
    await writeFile("daemon-pid", String(process.pid));
    await serveDaemon({
      isAvailable: () => true,
      async start(session) {
        await appendFile("vm-starts", session + "\\n");
        await setTimeout(400);
      },
      probe: async () => ({ cpu: 0.1, memoryAvailable: 0.9 }),
      async run(session, job, input, signal) {
        await setTimeout(60_000, undefined, { signal });
        return { exitCode: 0, stdout: input.command, stderr: "", artifacts: [] };
      },
      async clean() {},
      async stop(session) { await appendFile("vm-stops", session + "\\n"); },
      async reconcileOrphans() { await appendFile("reconciled", "yes\\n"); },
      async balance() { return 123; },
    });
  `);
  await Promise.all(["a", "b"].map(async (name, index) => {
    clients[index] = await connect(state, { entrypoint: join(overlay, "cli.js"), name });
  }));
  const [a, b] = clients;
  const listed = (await a.listTools()).tools;
  assert.equal(listed.length, 5);
  assert.equal(listed.find(({ name }) => name === "colab_run_job").inputSchema.properties.hardware.default, "cpu");
  assert.equal((await request(a, "colab_run_job", { command: "true" })).isError, true);
  const jobs = await Promise.all(clients.map((client) => call(client, "colab_run_job", {
    command: "test", syncWorkspace: false, mode: "async",
  })));
  const status = await until(async () => {
    const status = await call(a, "colab_pool_status");
    return status.vms[0]?.activeJobs === 2 && status;
  });
  assert.equal(status.vms.length, 1);
  assert.equal(status.computeUnitBalance, 123);
  const sessionName = status.vms[0].sessionName;
  assert.equal((await lstat(join(state, "daemon.sock"))).mode & 0o777, 0o600);
  assert.match(await readFile(join(state, "daemon-starts"), "utf8"), /^\d+\n$/u);
  assert.equal(await readFile(join(state, "vm-starts"), "utf8"), sessionName + "\n");
  assert.equal(await readFile(join(state, "reconciled"), "utf8"), "yes\n");
  assert.equal((await call(a, "colab_job_status", { jobId: jobs[0].jobId })).sessionName, sessionName);
  assert.equal((await call(b, "colab_job_status", { jobId: jobs[1].jobId })).sessionName, sessionName);
  assert.match((await request(b, "colab_job_status", { jobId: jobs[0].jobId })).content[0].text, /not found/u);
  assert.match((await request(a, "colab_cancel_job", { jobId: jobs[1].jobId })).content[0].text, /not found/u);
  assert.match((await request(a, "colab_pool_stop", { force: true })).content[0].text, /another client/u);

  // SIGTERM must cancel both clients' jobs, stop the VM and unlink the socket.
  const pid = Number(await readFile(join(state, "daemon-pid"), "utf8"));
  process.kill(pid, "SIGTERM");
  await until(async () => await readFile(join(state, "vm-stops"), "utf8").catch(() => ""));
  assert.equal(await readFile(join(state, "vm-stops"), "utf8"), sessionName + "\n");

  // A new stdio process must be able to take over the same socket after shutdown.
  const restarted = await connect(state, { entrypoint: join(overlay, "cli.js"), name: "restarted" });
  clients.push(restarted);
  assert.deepEqual((await call(restarted, "colab_pool_status")).vms, []);
  assert.equal((await readFile(join(state, "daemon-starts"), "utf8")).trim().split("\n").length, 2);
  await restarted.close();
});
