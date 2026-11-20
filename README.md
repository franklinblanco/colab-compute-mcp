# Colab Compute MCP

> **Quick install with an AI agent:** Paste this to Claude Code, Codex, or Gemini/Antigravity:
> `Install and configure the colab-compute MCP server from https://github.com/franklinblanco/colab-compute-mcp following its README, verify colab CLI auth, and register it in my local MCP config.`

Share warm Google Colab VMs across local MCP clients, including Claude Code, Codex, and Antigravity or Gemini. Each client runs a stdio MCP process. Those processes use one local Unix-socket daemon, so they can share an already running VM from separate clients or threads.

## Install

Use macOS or Linux with Node.js 22+, pnpm, the authenticated `colab` CLI, Git, tar, and OpenSSH. Linux also needs `flock` from util-linux. Run `colab sessions` on the host to confirm that Colab authentication works.

```sh
pnpm install --frozen-lockfile
pnpm run build
```

Register a stdio MCP server named `colab-compute` in each client. Use the absolute path to Node as the command and the absolute path to `dist/cli.js` as its only argument. For example, adapt the following entry to your client's MCP configuration format.

```json
{
  "mcpServers": {
    "colab-compute": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/colab-compute-mcp/dist/cli.js"]
    }
  }
}
```

Keep all client processes under the same OS user and point them at the same runtime directory. The daemon starts when a tool is first called. The daemon uses the environment of the client that starts it, so use the same Colab authentication and pool settings in each client. The Colab CLI can be found in `~/.local/bin`, common system locations, or the launcher's `PATH`.

## Tools

| Tool | Usage |
| --- | --- |
| `colab_run_job` | Submit a shell command. Provide an absolute `workspacePath` when syncing files or retrieving artifacts. Defaults to CPU, workspace sync, `mode: "wait"`, and a 300-second deadline including queue time. |
| `colab_job_status` | Read a job submitted by the current MCP session using its `jobId`. Finished jobs include the exit code, up to 64 KiB each of stdout and stderr, and retrieved artifact paths. |
| `colab_cancel_job` | Cancel a queued or running job from the current MCP session using its `jobId`. |
| `colab_pool_status` | Get VM hardware, state, available slots, queued jobs, and the current compute-unit balance if available. |
| `colab_pool_stop` | Stop idle VMs, optionally filtered by `sessionName`. `force: true` can cancel active jobs when every selected VM's jobs belong to the current MCP session. |

Example arguments for `colab_run_job` point to a local checkout and copy `reports/test.xml` back when the job ends.

```json
{
  "command": "python -m pip install -r requirements.txt && python -m pytest --junitxml=reports/test.xml",
  "workspacePath": "/absolute/path/to/project",
  "artifactPaths": ["reports/test.xml"],
  "timeoutSeconds": 600
}
```

Use `cwd` to select a directory relative to the job root and `env` to set explicit job variables. Use `syncWorkspace: false` for commands that need no workspace files. Use `mode: "async"` to get a job ID immediately and poll it from the same MCP session. Async jobs continue if the client disconnects, subject to their deadline, but a new session cannot manage their IDs. Cancelling a waiting MCP request cancels its job.

## Pool behavior

Compatible jobs share warm VMs if a slot is available and the VM passes the CPU and memory check. Concurrent CPU jobs also reserve slots on a booting VM. The pool grows up to its VM limit, serves queued jobs in arrival order within each hardware profile, and evicts idle incompatible VMs when a profile needs capacity. A failed cleanup drains the VM so no new job can enter it.

Supported profiles are `cpu`, `cpu-high-mem`, `gpu-t4`, `gpu-l4`, `gpu-g4`, `gpu-a100`, `gpu-h100`, `tpu-v5e1`, and `tpu-v6e1`. Google Colab controls the availability and cost of each profile.

| Environment variable | Default |
| --- | --- |
| `COLAB_MCP_MAX_VMS` | `2` |
| `COLAB_MCP_IDLE_TIMEOUT_SECONDS` | `600` |
| `COLAB_MCP_MAX_JOBS_PER_CPU_VM` | `2` |
| `COLAB_MCP_MAX_JOBS_PER_HIGH_MEM_VM` | `4` |
| `COLAB_MCP_STATE_DIR` | `~/.colab-compute-mcp` |

The state directory holds the private socket, the pool's generated SSH identity, and Colab runtime records. Keep it private. The pool reconciles its own orphaned sessions at startup, releases idle VMs, and stops its VMs when the daemon receives SIGTERM or SIGINT. The daemon exits after a short grace period once the pool is empty and no clients are connected.

## Workspace and artifact handling

Each job runs as a disposable non-root Linux account in `/content/t3-jobs/<jobId>`. Keep each shared pool under one local user's control. Colab jobs share the VM kernel, so the Linux accounts provide process and file separation for normal build and test workloads. The job command and its environment travel over SSH stdin.

Git workspaces sync tracked files and unignored new files, including local edits. Git metadata and `.t3` directories are excluded. Other directories use a tar snapshot that also excludes `node_modules`, `target`, `dist`, and `.venv`. Review what your workspace will upload, especially tracked files and unignored local configuration. Requested artifacts can overwrite regular files in your workspace. Paths must stay inside the workspace, and the server rejects symlinks and hard links in downloaded artifacts.

## Verify

```sh
pnpm test
pnpm run test:live
```

Unit tests use a fake transport. The live test uses the local Colab account, provisions a CPU VM, submits two jobs from separate stdio processes, verifies separate non-root accounts and artifact round-trips, and stops the test VM. Its final assertion checks that the account has zero active Colab sessions, so run it when the account is idle.

The remote supervisor and pool behavior are adapted from T3 Code, distributed under the MIT license.
