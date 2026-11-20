import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishArtifacts, workspaceFileList } from "../dist/transport.js";
import { runSchema } from "../dist/tools.js";

const signal = new AbortController().signal;

test("rejects path traversal, control paths, unsafe env names, and missing workspaces", () => {
  for (const path of ["../outside", "/tmp/a", "nested/../file", ".GiT/config", "C:/a", "sub\\file", "a\0b"]) {
    assert.equal(runSchema.safeParse({ command: "true", cwd: path, syncWorkspace: false }).success, false);
    assert.equal(runSchema.safeParse({ command: "true", artifactPaths: [path], workspacePath: "/tmp" }).success, false);
  }
  assert.equal(runSchema.safeParse({ command: "true", workspacePath: "/tmp", artifactPaths: ["."] }).success, false);
  assert.equal(runSchema.safeParse({ command: "true", workspacePath: "./relative" }).success, false);
  assert.equal(runSchema.safeParse({ command: "true" }).success, false);
  assert.equal(runSchema.safeParse({ command: "true", artifactPaths: ["out"], syncWorkspace: false }).success, false);
  for (const key of ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_FUNC_X", "BASH_ENV", "HOME", "A=B", "3FOO"]) {
    assert.equal(runSchema.safeParse({ command: "true", syncWorkspace: false, env: { [key]: "x" } }).success, false);
  }
  const parsed = runSchema.parse({ command: "echo ok", workspacePath: "/tmp", cwd: ".", env: { FLAG: "1" } });
  assert.deepEqual([parsed.hardware, parsed.mode, parsed.timeoutSeconds, parsed.syncWorkspace], ["cpu", "wait", 300, true]);
});

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "colab-mcp-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return realpath(dir);
}

test("workspace listing keeps tracked and new files and skips ignored or deleted files and metadata", async (t) => {
  const root = await temp(t);
  execFileSync("git", ["init", "-q", root]);
  await mkdir(join(root, ".t3"));
  await Promise.all([
    writeFile(join(root, ".t3", "metadata"), "local"),
    writeFile(join(root, ".gitignore"), "ignored\n"),
    writeFile(join(root, "tracked"), "tracked"),
    writeFile(join(root, "deleted"), "deleted"),
    writeFile(join(root, "ignored"), "ignored"),
    writeFile(join(root, "new file\nname"), "new"),
  ]);
  execFileSync("git", ["-C", root, "add", "tracked", "deleted"]);
  await rm(join(root, "deleted"));
  await symlink("tracked", join(root, "link"));
  const list = await workspaceFileList(root, process.env, signal);
  assert.deepEqual(list.toString().split("\0").filter(Boolean).sort(), [".gitignore", "link", "new file\nname", "tracked"]);
});

test("artifact publishing refuses source links, hard links, Git metadata and symlink destinations", async (t) => {
  const root = await temp(t);
  const local = join(root, "workspace");
  const stage = join(root, "stage");
  const outside = join(root, "outside");
  await Promise.all([mkdir(stage), mkdir(outside), mkdir(local)]);
  await writeFile(join(outside, "sentinel"), "original");
  await symlink(outside, join(stage, "linked"));
  await assert.rejects(publishArtifacts(stage, local, signal), /conflict/u);
  await rm(join(stage, "linked"));
  await link(join(outside, "sentinel"), join(stage, "hard"));
  await assert.rejects(publishArtifacts(stage, local, signal), /conflict/u);
  await rm(join(stage, "hard"));
  await mkdir(join(stage, ".git"));
  await assert.rejects(publishArtifacts(stage, local, signal), /conflict/u);
  await rm(join(stage, ".git"), { recursive: true });

  await symlink(outside, join(local, "nested"));
  await mkdir(join(stage, "nested"));
  await writeFile(join(stage, "nested", "sentinel"), "updated");
  await assert.rejects(publishArtifacts(stage, local, signal), /conflict/u);
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "original");
  await rm(join(local, "nested"));
  await publishArtifacts(stage, local, signal);
  assert.equal(await readFile(join(local, "nested", "sentinel"), "utf8"), "updated");
});
