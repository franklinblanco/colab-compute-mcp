import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const socketName = "daemon.sock";
export const lockName = "startup.lock";

export async function lstatIfPresent(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function privateDirectory(directory: string): Promise<string> {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) {
    throw new Error("Colab runtime directories must be owned by this user and private (0700).");
  }
  return realpath(directory);
}

export async function runtimeDirectory() {
  const directory = process.env.COLAB_MCP_STATE_DIR ?? join(homedir(), ".colab-compute-mcp");
  if (!isAbsolute(directory)) throw new Error("COLAB_MCP_STATE_DIR must be an absolute path.");
  return privateDirectory(directory);
}

export async function openLock() {
  const lock = await open(lockName, constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR, 0o600);
  const info = await lock.stat();
  if (info.isFile() && info.uid === process.getuid?.() && !(info.mode & 0o077)) return lock;
  await lock.close();
  throw new Error("The Colab daemon startup lock must be a private regular file.");
}
