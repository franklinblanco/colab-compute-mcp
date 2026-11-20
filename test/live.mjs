import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, connect, until } from "./client.mjs";

const directory = await mkdtemp(join(tmpdir(), "colab-mcp-live-"));
const state = join(directory, "state");
const clients = [];
const jobs = [];
const env = {
  COLAB_MCP_MAX_VMS: "2",
  COLAB_MCP_MAX_JOBS_PER_CPU_VM: "2",
  COLAB_MCP_IDLE_TIMEOUT_SECONDS: "10",
};

function sessions() {
  const result = execFileSync("colab", ["sessions"], { encoding: "utf8", timeout: 30_000, stdio: "pipe" });
  process.stdout.write(result);
  return result;
}

const command = [
  'test -f input.txt && test ! -e ignored.txt',
  'test "$(cat input.txt)" = "$CLIENT_MARKER"',
  'test "$(id -u)" -ne 0',
  'umask 077',
  'mkdir -p out',
  'printf "%s|%s|%s|%s|%s\\n" "$CLIENT_MARKER" "$(hostname)" "$(id -un)" "$(id -u)" "$PWD" | tee out/result.txt',
  'sleep 12',
].join(" && ");

try {
  const workspaces = await Promise.all(["client-a", "client-b"].map(async (name) => {
    const workspace = join(directory, name + " workspace");
    await mkdir(workspace);
    execFileSync("git", ["init", "-q", workspace]);
    await Promise.all([
      writeFile(join(workspace, ".gitignore"), "ignored.txt\n"),
      writeFile(join(workspace, "ignored.txt"), "unused\n"),
      writeFile(join(workspace, "input.txt"), name + "\n"),
    ]);
    return { name, workspace };
  }));
  await Promise.all(workspaces.map(async ({ name }, index) => {
    clients[index] = await connect(state, { env, name });
  }));
  await Promise.all(clients.map(async (client, index) => {
    jobs[index] = await call(client, "colab_run_job", {
      command, workspacePath: workspaces[index].workspace, env: { CLIENT_MARKER: workspaces[index].name },
      artifactPaths: ["out/result.txt"], mode: "async", timeoutSeconds: 240,
    });
  }));
  console.log("Submitted two CPU jobs via separate stdio MCP clients.");

  let concurrent;
  const results = await until(async () => {
    const progress = await Promise.all(jobs.map(({ jobId }, index) =>
      call(clients[index], "colab_job_status", { jobId })));
    if (progress.every(({ status }) => status === "running") && !concurrent) {
      const report = await call(clients[0], "colab_pool_status");
      if (report.vms.length === 1 && report.vms[0].activeJobs === 2) {
        concurrent = report.vms[0].sessionName;
        console.log(`Pool: ${concurrent}, cpu, 2/2 slots busy, 1 VM total.`);
      }
    }
    if (progress.some(({ status }) => status !== "queued" && status !== "running" && status !== "completed")) {
      throw new Error(JSON.stringify(progress));
    }
    return progress.every(({ status }) => status === "completed") && progress;
  }, 245_000);

  assert.ok(concurrent, "Expected to observe both jobs running concurrently on one VM.");
  const evidence = await Promise.all(results.map(async (job, index) => {
    assert.equal(job.sessionName, concurrent);
    assert.equal(job.exitCode, 0);
    assert.deepEqual(job.artifacts, ["out/result.txt"]);
    const artifact = await readFile(join(workspaces[index].workspace, job.artifacts[0]), "utf8");
    assert.equal(job.stdout, artifact);
    const [marker, hostname, username, uid, cwd] = artifact.trim().split("|");
    assert.equal(marker, workspaces[index].name);
    assert.match(username, /^t3-[a-f0-9]+$/u);
    assert.ok(Number(uid) > 0);
    assert.equal(cwd, "/content/t3-jobs/" + job.jobId);
    console.log(`${marker}: ${job.status}; host=${hostname}; user=${username}; uid=${uid}; cwd=${cwd}; artifact=${job.artifacts[0]}`);
    return { hostname, username, uid };
  }));
  assert.equal(evidence[0].hostname, evidence[1].hostname);
  assert.notEqual(evidence[0].username, evidence[1].username);
  assert.notEqual(evidence[0].uid, evidence[1].uid);
  assert.deepEqual(await call(clients[0], "colab_pool_stop"), { stopped: [concurrent] });
  console.log(`Stopped ${concurrent}.`);
  assert.match(sessions(), /No active sessions found on server/u);
} finally {
  await Promise.allSettled(jobs.map(({ jobId }, index) => call(clients[index], "colab_cancel_job", { jobId })));
  if (jobs.length) await call(clients[0], "colab_pool_stop").catch(() => {});
  await Promise.allSettled(clients.map((client) => client?.close()));
  try {
    await until(async () => !(await lstat(join(state, "daemon.sock")).catch(() => undefined)), 25_000);
  } finally {
    // Recover test-owned VMs even when an assertion fails before pool_stop.
    const pool = join(state, "pool");
    const entries = await readdir(pool).catch(() => []);
    for (const entry of entries) {
      const name = /^(mcp-[a-f0-9]{12})\.json$/u.exec(entry)?.[1];
      if (!name) continue;
      // Leave failed state accessible if cleanup itself fails.
      execFileSync("colab", ["--config", join(pool, entry), "stop", "-s", name], { timeout: 35_000 });
    }
    await rm(directory, { recursive: true, force: true });
  }
}
