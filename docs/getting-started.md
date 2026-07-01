# Getting Started With Ciclo

Ciclo is a standalone orchestrator agent. It uses Pi as an internal brain provider, Herdr for harness state, Beads for durable work memory, and MCP for coordination with Claude, Codex, and generic clients.

This guide is for a local development checkout.

## Prerequisites

- Nix with `devenv`.
- Host-installed `bd` for Beads.
- Host-installed `herdr`.
- Git, SSH, and access to any remote repositories or machines you plan to coordinate.

The devenv shell supplies Node, TypeScript, Python, Dolt, Quint, Go/Rust bootstrap tooling, and validation helpers.

## Bootstrap

```bash
devenv shell
ciclo-doctor
npm ci --ignore-scripts
npm run build
```

From outside the shell, use:

```bash
just doctor
just typescript
```

## Common Commands

Use the built CLI directly:

```bash
node dist/src/cli.js --help
```

Optionally expose the package binary in your shell:

```bash
npm link
ciclo --help
```

### Status And Runtime

```bash
node dist/src/cli.js status --compact
node dist/src/cli.js runtime
npm run demo
```

`status` returns the current standalone Ciclo status. `runtime` reports the product boundary: Ciclo is the standalone orchestrator agent, while Pi is used internally as a brain provider.

### Benchmarks

```bash
node dist/src/cli.js benchmark --scenario-dir tests/fixtures/benchmarks
```

The benchmark runner loads scenario fixtures and scores Ciclo behavior with deterministic safety checks plus configured driver and judge models.

For a walkthrough of what each benchmark category covers, see [Ciclo Benchmarks](./benchmarks.md).

### MCP Stdio

Use stdio MCP for local Claude, Codex, or generic MCP clients:

```bash
node dist/src/cli.js mcp stdio
```

Legacy package script:

```bash
npm run mcp:stdio
```

### MCP Client Install

Install Ciclo into another project's MCP config so a Claude or Codex session can use Ciclo as its control plane:

```bash
ciclo mcp install --client claude --project /path/to/project
ciclo mcp install --client codex --project /path/to/project
ciclo mcp install --client all --project /path/to/project --dry-run --compact
ciclo mcp install --client claude --project /path/to/project --claude-channel
```

Claude installs write `.mcp.json`. Codex installs write `.codex/config.toml`. The generated server config runs `ciclo mcp stdio` and sets `CICLO_PROJECT_ROOT` to the target project.

Use `--claude-channel` when a Claude Code session should load Ciclo as a channel-capable MCP server. The install response includes the Claude launch selector, such as `--dangerously-load-development-channels server:ciclo`.

Install the companion project skills so Claude or Codex knows how to use Ciclo once the MCP tools are available:

```bash
ciclo skill install --client all --project /path/to/project
ciclo skill install --client claude --project /path/to/project --dry-run --compact
```

Claude skill installs write `.claude/skills/ciclo-mcp.md`. Codex-compatible installs write `.agents/skills/ciclo-mcp/`.

For the full operator workflow, see [onboarding-project.md](onboarding-project.md).

### Ciclo-Managed Worker Sessions

The intended operator workflow is to talk to Ciclo first. Ciclo then starts Claude Code or Codex worker sessions with bounded prompts, model parameters, and cleanup tracking.

Start Ciclo MCP:

```bash
node dist/src/cli.js mcp stdio
```

From an MCP client, use:

```text
ciclo_launch_worker_session
ciclo_heartbeat_worker_session
ciclo_list_worker_sessions
ciclo_stop_worker_session
ciclo_poll_events
ciclo_board
ciclo://worker-sessions
ciclo://events
ciclo://board
```

A launch request includes the harness, loop, prompt, optional Beads issue, model, effort, cwd, `extra_args`, `isolation`, worktree options, and `dry_run`. Use `dry_run: true` to inspect the launch command and planned worktree without starting a process. Use `isolation: "worktree"` for bead-level fan-out; Ciclo defaults the branch to `ciclo/<bead-id>` unless `worktree_branch` is set.

Example launch payload:

```json
{
  "harness_id": "codex",
  "loop_id": "review-loop",
  "bead_id": "ciclo-774",
  "model": "gpt-5.5",
  "prompt": "Use Ciclo MCP as the control plane. Claim scoped work, report progress, ask questions through Ciclo, and record validation evidence before close.",
  "dry_run": true
}
```

Ciclo owns the worker lifecycle. Workers should communicate back through Ciclo MCP tools such as `ciclo_update_work`, `ciclo_ask_operator`, `ciclo_report_feedback`, and `ciclo_close_work`. Use `ciclo_poll_events` with the returned cursor for monitoring state changes, and use `ciclo_board` for the joined operator dashboard.
Workers should heartbeat through `ciclo_heartbeat_worker_session` while active and may include token and cost deltas. `ciclo_status`, `ciclo_board`, and `ciclo_list_worker_sessions` accept `stale_after_ms` to mark silent running workers as `stalled`.
For PR-producing loops, pass `expected_pr_after_ms` to `ciclo_board`. If a worker branch has no PR after that deadline, Ciclo emits a `blocker.raised` event with `kind: "expected_pr_missing"` and includes recovery actions on the board row.

### Remote Runner Sessions

Ciclo can plan remote runners before a provider executor exists. The plan is the interface: it records what should be launched, how WireGuard should connect the runner back to Ciclo, and how Herdr should attach for interactive monitoring. Provider behavior is plugin-backed; Kubernetes, AWS Lambda MicroVM, and Cloudflare ship as the default plugins.

From MCP, use:

```text
ciclo_launch_remote_runner
ciclo_list_remote_runners
ciclo_attach_plan
ciclo://remote-runners
```

Example Kubernetes runner payload:

```json
{
  "runner_kind": "kubernetes",
  "runner_id": "runner-k8s-1",
  "loop_id": "review-loop",
  "bead_id": "ciclo-remote.1",
  "harness_id": "codex",
  "image": "ghcr.io/example/ciclo-runner:latest",
  "repo_path": "/workspace/ciclo",
  "prompt": "Use Ciclo MCP and report progress.",
  "herdr_session": "ciclo",
  "ssh_user": "ciclo",
  "wireguard": {
    "runner_address": "10.44.0.2/24",
    "ciclo_endpoint": "198.51.100.10:51820"
  },
  "kubernetes": {
    "namespace": "ciclo-runners",
    "job_name": "runner-k8s-1"
  },
  "dry_run": true
}
```

The response includes provider commands, artifacts, WireGuard config with secret references, a Herdr remote target like `ciclo@10.44.0.2:/workspace/ciclo`, and an attach plan.

### Third-Party Remote Runner Plugins

Customers can install external remote runner plugins into a Ciclo checkout:

```bash
node dist/src/cli.js plugin install @acme/ciclo-runner-fly --trust
node dist/src/cli.js plugin list --compact
node dist/src/cli.js plugin disable @acme/ciclo-runner-fly
node dist/src/cli.js plugin enable @acme/ciclo-runner-fly
```

Plugin packages must include:

```text
ciclo.plugin.json
dist/index.js
package.json
```

`ciclo.plugin.json` declares the package name, entrypoint, capabilities, runner kinds, and requested permissions. Ciclo validates the manifest before it imports plugin code. Enabled plugins must be trusted before activation.

Plugin entrypoints export `activate(api)` and register capabilities through the SDK API:

```ts
import type { CicloPluginApi } from "ciclo/plugin-sdk";

export function activate(api: CicloPluginApi) {
  api.remoteRunners.register({
    kind: "fly",
    name: "fly-machines",
    executionModel: "fly_machine",
    plan(input, wireGuard) {
      return {
        providerName: "fly-machines",
        executionModel: "fly_machine",
        commands: [`fly machines run ${input.image} --name ${input.runnerId}`],
        artifacts: [],
        warnings: [],
        evidence: ["remote.runner.plugin:fly-machines"]
      };
    }
  });
}
```

During local plugin development, use `--path`:

```bash
node dist/src/cli.js plugin install @acme/ciclo-runner-fly --path ../ciclo-runner-fly --trust
```

Attach to the overall Ciclo Herdr session:

```bash
node dist/src/cli.js attach --session ciclo
node dist/src/cli.js attach --remote ciclo@10.44.0.2:/workspace/ciclo --session ciclo
node dist/src/cli.js attach --remote ciclo@10.44.0.2:/workspace/ciclo --session ciclo --dry-run --compact
```

If `--session` is omitted, Ciclo first reuses the active Herdr session when it can detect one, then falls back to the repository directory name. Every local Claude/Codex worker session launched from that MCP session uses a visible Herdr agent pane, so attaching to the Ciclo session shows the worker jobs directly. For this repo the fallback is `ciclo`. Set `CICLO_REUSE_HERDR_SESSION=false` to force direct process launches and repo-name fallback.

AWS Lambda runner plans target Lambda MicroVMs, not legacy Lambda function invocation. The AWS plugin emits `aws lambda-microvms` image creation plus `run-microvm`, `suspend-microvm`, `resume-microvm`, and `terminate-microvm` lifecycle commands. Cloudflare runner plans remain control-plane plans and include warnings when a container or userspace connector is needed for Herdr plus WireGuard interactivity.

### MCP HTTP

Use HTTP MCP for local integration experiments:

```bash
node dist/src/cli.js mcp http --host 127.0.0.1 --port 7331 --path /mcp
```

Equivalent environment-variable form:

```bash
CICLO_MCP_HTTP_HOST=127.0.0.1 CICLO_MCP_HTTP_PORT=7331 node dist/src/cli.js mcp-http
```

The server prints the listening endpoint on stderr, normally:

```text
http://127.0.0.1:7331/mcp
```

Keep HTTP bound to localhost unless multiuser auth is configured.

## Development Gates

Run the full gate:

```bash
just check
```

Run focused gates:

```bash
just hooks
just python
just typescript
just quint
```

Inside `devenv shell`, the same scripts are available directly:

```bash
ciclo-hooks-check
ciclo-python-check
ciclo-typescript-check
ciclo-quint
ciclo-check
```

## Beads Workflow

Ciclo uses Beads as the durable work queue and memory layer. Useful local commands:

```bash
bd ready
bd show <task-id>
bd dep cycles
```

When Beads remote DB or Dolt sync is configured, Ciclo coordinates through Beads and triggers Beads-native tracker sync. Ciclo does not implement direct Jira or Linear providers in the MVP.

## Herdr And Remote Sessions

Herdr tells Ciclo whether harnesses are idle, working, blocked, done, or unavailable. For remote sessions, Ciclo follows Herdr remote attach over SSH.

Typical remote setup checks:

```bash
herdr --version
ssh <remote-host> 'herdr --version'
```

Codex remote environment setup lives in:

```bash
.codex/remote/README.md
scripts/codex-remote-setup.sh
scripts/codex-remote-maintenance.sh
```

## Agent Hooks

Claude and Codex hooks call:

```bash
scripts/agent-gate.py
```

The gate blocks risky operations unless the user has explicitly approved the matching opt-in environment variable. Validate hook configuration with:

```bash
just hooks
```

## Local Command Reference

```bash
# install/build
devenv shell
npm ci --ignore-scripts
npm run build

# inspect
node dist/src/cli.js --help
node dist/src/cli.js status --compact
node dist/src/cli.js runtime
npm run demo

# benchmark
node dist/src/cli.js benchmark --scenario-dir tests/fixtures/benchmarks

# MCP
node dist/src/cli.js mcp stdio
node dist/src/cli.js mcp http --host 127.0.0.1 --port 7331 --path /mcp
node dist/src/cli.js mcp install --client claude --project /path/to/project

# quality gates
just check
just hooks
just typescript
just python
just quint
```
