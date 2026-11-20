import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, normalize } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { lstatIfPresent, privateDirectory } from "./files.js";
import { checked, collect, exit, launch, terminate, transfer, type Command } from "./process.js";
import { probe, supervisor } from "./remote.js";
import type { ColabTransport } from "./pool.js";
import { safeRelative, type JobInput } from "./tools.js";

const host = "root@colab-runtime";
const fallbackExclusions = [".git", "node_modules", "target", "dist", ".t3", ".venv"];
const shellCommand = (args: readonly string[]) => args.map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'").join(" ");
const loadSchema = z.object({ cpu: z.number(), memoryAvailable: z.number() });
const gitListLimit = 32 * 1024 * 1024;

async function findColab(paths: string[]) {
  for (const directory of paths) {
    const candidate = join(directory, "colab");
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Search the remaining PATH entries.
    }
  }
}

export async function resolveWorkspace(workspace: string): Promise<string> {
  try {
    const root = await realpath(workspace);
    if ((await stat(root)).isDirectory()) return root;
  } catch {
    // Give invalid and inaccessible paths the same error.
  }
  throw new Error("workspacePath must name an accessible local directory.");
}

export async function workspaceFileList(root: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const command = (args: string[]) => ({ program: "git", args, cwd: root, env });
  const repo = await collect(command(["rev-parse", "--is-inside-work-tree"]), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (repo.code !== 0 || repo.stdout.toString().trim() !== "true") return undefined;
  const list = await checked(command([
    "ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z", "--", ".",
  ]), "Could not list Colab workspace files.", 30_000, { signal, stdoutLimit: gitListLimit + 1 });
  if (list.stdout.length > gitListLimit) throw new Error("Colab workspace file list is too large.");
  const decoded = list.stdout.toString("utf8");
  if (!Buffer.from(decoded).equals(list.stdout)) throw new Error("Workspace filenames must use UTF-8.");
  const archiveFiles: string[] = [];
  for (const name of decoded.split("\0")) {
    signal.throwIfAborted();
    if (!safeRelative(name) || name.split("/").some((part) => part.toLowerCase() === ".t3")) continue;
    const file = join(root, name);
    const parent = dirname(file);
    if (await realpath(parent).catch(() => undefined) !== parent) continue;
    const info = await lstatIfPresent(file);
    if (info?.isFile() || info?.isSymbolicLink()) archiveFiles.push(name + "\0");
  }
  return Buffer.from(archiveFiles.join(""));
}

export async function publishArtifacts(source: string, workspace: string, signal: AbortSignal) {
  const error = new Error("Colab artifacts conflict with paths in the local workspace.");
  const root = await realpath(workspace);
  if (root !== workspace) throw error;
  const entries: Array<{ from: string; to: string; directory: boolean; mode: number }> = [];
  async function inspect(relative: string) {
    signal.throwIfAborted();
    if (!safeRelative(relative)) throw error;
    const from = join(source, relative);
    const to = join(root, relative);
    const info = await statEntry(from);
    const existing = await lstatIfPresent(to);
    if (existing && (info.isDirectory() !== existing.isDirectory() ||
      info.isFile() !== existing.isFile())) throw error;
    entries.push({ from, to, directory: info.isDirectory(), mode: info.mode });
    if (info.isDirectory()) {
      for (const entry of await readdir(from)) await inspect(join(relative, entry));
    }
  }
  async function statEntry(file: string) {
    const info = await lstatIfPresent(file);
    if (!info || (!info.isDirectory() && !(info.isFile() && info.nlink === 1))) throw error;
    return info;
  }
  for (const entry of await readdir(source)) await inspect(entry);
  for (const { from, to, directory, mode } of entries) {
    signal.throwIfAborted();
    const parent = dirname(to);
    if (await realpath(parent) !== parent) throw error;
    if (directory) {
      try {
        await mkdir(to);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "EEXIST" ||
          !(await lstatIfPresent(to))?.isDirectory()) throw error;
      }
      continue;
    }
    const stage = await mkdtemp(join(parent, ".colab-artifact-"));
    try {
      const staged = join(stage, "file");
      await copyFile(from, staged, constants.COPYFILE_EXCL);
      await chmod(staged, mode & 0o777);
      signal.throwIfAborted();
      if (await realpath(parent) !== parent) throw error;
      await rename(staged, to);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}

export async function makeTransport(directory: string): Promise<ColabTransport> {
  const poolDir = await privateDirectory(join(directory, "pool"));
  const key = join(poolDir, "id_ed25519");
  const paths = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin",
    ...(process.env.PATH ?? "").split(delimiter).filter(isAbsolute), "/usr/bin", "/bin"];
  const env = { ...process.env, PATH: [...new Set(paths)].join(delimiter) };
  const program = await findColab(paths);
  const masters = new Map<string, { child: ReturnType<typeof launch>; closed: Promise<number> }>();
  let keyReady: Promise<void> | undefined;
  let balanceRequest: Promise<number | null> | undefined;

  const socket = (session: string) => session + ".sock";
  const config = (session: string) => join(poolDir, session + ".json");
  const owner = (session: string) => join(poolDir, session + ".owner");
  const local = (program: string, args: string[], cwd = poolDir): Command => ({ program, args, cwd, env });
  const colab = (args: string[]) => {
    if (!program) throw new Error("The Colab CLI is unavailable.");
    return local(program, args);
  };
  const control = (session: string, operation: "check" | "exit") =>
    local("ssh", ["-F", "/dev/null", "-S", socket(session), "-O", operation, host]);

  const ssh = (session: string, args: string[]) => local("ssh", [
    "-F", "/dev/null", "-S", socket(session), "-o", "BatchMode=yes",
    // A dead master must never create a second connection to the VM.
    "-o", "ProxyCommand=false", "--", host, shellCommand(args),
  ]);
  const remote = (session: string, action: string, job: string, args: string[] = []) =>
    ssh(session, ["python3", "-c", supervisor, action, job, ...args]);

  const ensureKey = () => keyReady ??= (async () => {
    const info = await lstatIfPresent(key);
    if (info && (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077))
      throw new Error("The Colab SSH key must be a private regular file.");
    if (!info) {
      await checked(local("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]),
        "Could not prepare the Colab SSH key.");
    }
    if (!(await lstatIfPresent(key + ".pub"))?.isFile()) {
      const generated = await checked(local("ssh-keygen", ["-y", "-f", key]),
        "Could not read the Colab SSH public key.");
      await writeFile(key + ".pub", generated.stdout, { mode: 0o600, flag: "wx" });
    }
  })().catch((error: unknown) => {
    keyReady = undefined;
    throw error;
  });

  async function upload(session: string, job: string, workspace: string, signal: AbortSignal) {
    const list = await workspaceFileList(workspace, env, signal);
    const args = list === undefined ?
      [...fallbackExclusions.map((entry) => "--exclude=" + entry), "."] : ["--null", "-T", "-"];
    const tar = { ...local("tar", ["-czf", "-", ...args], workspace), env: { ...env, COPYFILE_DISABLE: "1" } };
    await transfer(tar, remote(session, "upload", job), "Could not upload the Colab workspace.",
      { input: list, signal });
  }

  async function download(session: string, job: string, workspace: string, paths: string[], signal: AbortSignal) {
    const stage = await mkdtemp(join(tmpdir(), "colab-artifacts-"));
    const normalized = [...new Set(paths.map((entry) => normalize(entry).replace(/\/$/u, "")))];
    try {
      await transfer(remote(session, "artifacts", job, [JSON.stringify(normalized)]),
        local("tar", ["-xzf", "-", "--no-same-owner", "--no-same-permissions"], stage),
        "Could not retrieve Colab artifacts. Use existing files or directories without symlinks.", { signal });
      await publishArtifacts(stage, workspace, signal);
      return normalized;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async function stop(session: string) {
    const message = "Could not stop the Colab VM.";
    await checked(control(session, "exit"), message, 5000).catch(() => {});
    const master = masters.get(session);
    if (master) {
      terminate(master.child);
      await master.closed;
      masters.delete(session);
    }
    await rm(join(poolDir, socket(session)), { force: true });
    if (await lstatIfPresent(config(session))) {
      await checked(colab(["--config", config(session), "stop", "-s", session]), message, 30_000,
        { diagnostic: true });
      await rm(config(session), { force: true });
    }
    await rm(config(session) + ".lock", { force: true });
    await rm(owner(session), { force: true });
  }

  return {
    isAvailable: () => program !== undefined,
    async start(session, flags) {
      const allocate = colab(["--config", config(session), "new", "-s", session, ...flags]);
      await ensureKey();
      await writeFile(owner(session), String(process.pid), { mode: 0o600, flag: "wx" });
      await checked(allocate,
        "Could not allocate a Colab VM. Check CLI authentication, quota, and requested hardware.",
        120_000, { diagnostic: true });
      const proxy = colab(["--config", config(session), "ssh", "--proxy-mode", "-s", session, "-i", key]);
      const proxyCommand = shellCommand([proxy.program, ...proxy.args]);
      const command = local("ssh", [
        "-F", "/dev/null", "-N", "-M", "-S", socket(session),
        "-o", "ControlPersist=no", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=30",
        "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
        "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "BatchMode=yes", "-o", "ProxyCommand=" + proxyCommand.replaceAll("%", "%%"), "-i", key, host,
      ]);
      const child = launch(command, { stdio: "ignore" });
      const closed = exit(child).catch(() => -1);
      masters.set(session, { child, closed });
      const unavailable = "Could not open the Colab SSH ControlMaster.";
      const ready = new AbortController();
      const signal = AbortSignal.any([ready.signal, AbortSignal.timeout(45_000)]);
      try {
        await Promise.race([closed.then(() => { throw new Error(unavailable); }), (async () => {
          while (true) {
            signal.throwIfAborted();
            if ((await lstatIfPresent(join(poolDir, socket(session))))?.isSocket()) {
              const check = await checked(control(session, "check"), unavailable, 5000, { signal })
                .catch(() => undefined);
              if (check) return;
            }
            await delay(200, undefined, { signal });
          }
        })()]);
      } catch {
        throw new Error(unavailable);
      } finally {
        ready.abort();
      }
    },
    async probe(session) {
      const result = await checked(ssh(session, ["python3", "-c", probe]),
        "Could not check Colab VM capacity.", 5000);
      return loadSchema.parse(JSON.parse(result.stdout.toString("utf8")));
    },
    async run(session, job, input: JobInput, signal) {
      await checked(remote(session, "prepare", job), "Could not prepare the isolated job directory.",
        15_000, { signal });
      if (input.syncWorkspace) await upload(session, job, input.workspacePath!, signal);
      const request = JSON.stringify({
        cwd: normalize(input.cwd ?? "."), env: input.env ?? {}, command: input.command,
      });
      const result = await collect(remote(session, "run", job), { input: request, signal });
      if (result.code === 255 || result.code < 0) {
        throw new Error("The Colab SSH connection closed during the command.");
      }
      const output = {
        exitCode: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr, artifacts: [] as string[],
      };
      if (!input.artifactPaths?.length) return output;
      try {
        output.artifacts = await download(session, job, input.workspacePath!, input.artifactPaths, signal);
        return output;
      } catch (error) {
        signal.throwIfAborted();
        return { ...output, error: error instanceof Error ? error.message : "Could not retrieve Colab artifacts." };
      }
    },
    async clean(session, job) {
      await checked(remote(session, "clean", job), "Could not clean the Colab job directory.");
    },
    stop,
    async reconcileOrphans(ownsSession) {
      const entries = await readdir(poolDir);
      const sessions = new Set(entries.flatMap((entry) => {
        const match = /^(mcp-[a-f0-9]{12})\.(?:json|owner)$/u.exec(entry);
        return match?.[1] ? [match[1]] : [];
      }));
      for (const session of sessions) {
        if (ownsSession(session) || masters.has(session)) continue;
        const info = await lstatIfPresent(owner(session));
        const pid = info?.isFile() ? Number(await readFile(owner(session), "utf8")) : 0;
        if (pid && pid !== process.pid) {
          try {
            process.kill(pid, 0);
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
          }
        }
        if (!ownsSession(session)) {
          await stop(session).catch(() => console.error("Could not reconcile an orphaned Colab VM."));
        }
      }
    },
    balance() {
      balanceRequest ??= (async () => {
        if (!program) return null;
        const result = await checked(colab(["usage"]), "Could not fetch Colab compute-unit balance.");
        const balance = result.stdout.toString().match(/Current balance:\s*(-?\d+(?:\.\d+)?)/u)?.[1];
        return balance === undefined ? null : Number(balance);
      })().catch(() => null).finally(() => { balanceRequest = undefined; });
      return balanceRequest;
    },
  };
}
