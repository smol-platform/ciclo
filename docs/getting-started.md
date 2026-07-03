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

`status` returns the current standalone Ciclo status. `runtime` reports the product boundary: Ciclo is the standalone orchestrator agent, while OpenAI is the default orchestration brain reached through the Pi SDK adapter.

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

MCP starts Ciclo's internal heartbeat. That heartbeat periodically checks Ciclo-owned worker and remote sessions, marks silent sessions stalled or stale, and invokes the OpenAI brain for follow-up decisions about monitoring, context insertion, answerable worker questions, and controlling-session feedback. Workers should still call `ciclo_heartbeat_worker_session`; the internal heartbeat is Ciclo's independent supervisor loop, not a replacement for worker liveness reports.

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

Claude skill installs write `.claude/skills/ciclo-mcp.md`, `.claude/skills/release.md`, and `.claude/commands/release.md`. Codex-compatible installs write `.agents/skills/ciclo-mcp/` and `.agents/skills/release/`. Use `/release <tag>` in Claude, or the `release` skill in Codex, to run the guarded tag, remote publish, and GitHub release workflow.

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
ciclo_decide
ciclo_poll_events
ciclo_board
ciclo://worker-sessions
ciclo://events
ciclo://board
```

To join a Ciclo-enabled project from your terminal instead of asking an existing Claude/Codex session to spawn a worker, run:

```bash
ciclo launch codex
ciclo launch codex --session infra-blocks
ciclo launch claude --model claude-fable-5
ciclo launch codex --prompt "Review the repo" -- --full-auto
ciclo launch claude --dry-run --compact
ciclo launch codex --terminal
```

`ciclo launch` installs the selected client MCP config for the current project first, including the Ciclo server, project `mcp.additionalServers`, `mcp.secretBindings`, and additional-server `${secret://provider-id/ref}` placeholders. Non-dry-run launches write `.mcp.json` or `.codex/config.toml`, start the selected harness as the first pane in a named Herdr session, and attach to that session. Secret-backed entries are written as `ciclo secret exec` runtime wrappers that resolve provider references only when the intended child process starts, so generated config files do not contain resolved secret values. By default the Herdr session and first pane are named after the project directory; use `--session`, `--pane-name`, or `--no-attach` to tune the wrapper, and use `--terminal` only when you explicitly want the harness process in the current terminal. Use dry-run to inspect the redacted MCP install plan, Herdr command, and exact harness command without writing files or starting Claude/Codex.

A launch request includes the harness, loop, prompt, optional Beads issue, model, effort, cwd, `extra_args`, `isolation`, worktree options, MCP config options, and `dry_run`. Use `dry_run: true` to inspect the launch command, planned worktree, and planned MCP client config without starting a process. Use `isolation: "worktree"` for bead-level fan-out; Ciclo defaults the branch to `ciclo/<bead-id>` unless `worktree_branch` is set. When running inside Herdr, Ciclo uses fresh `herdr worktree create` workspaces and starts the local pane with the returned Herdr workspace id; outside Herdr, it uses `git worktree add`. Existing Herdr worktree paths fail instead of reopening stale workspace state. Use `configure_mcp: true` when the worker should receive Ciclo MCP config in its cwd or worktree before launch.

For Claude Code sessions, `model` accepts `claude-fable-5` directly and normalizes `fable 5`, `Fable 5`, or `claude fable 5` to `claude-fable-5`. Other model ids remain pass-through so new Claude models can be used without a Ciclo release.

Use `mcp_env` only for non-secret MCP server environment variables. When the generated Ciclo MCP server needs a secret, pass `mcp_secret_env` bindings with `env_name`, `provider_id`, `secret_ref`, optional `field`, optional `format`, and `reason`; Ciclo writes a runtime wrapper around the generated Ciclo MCP server command, resolves the value only for that subprocess, and redacts values from responses, audit records, events, board rows, and worker-session listings. Formats must contain exactly one `${secret}` placeholder, for example `Bearer ${secret}`.

Use `worker_secret_env` when the launched Claude/Codex worker shell needs credentials for tools such as `gh`, `git`, or `curl`. These bindings use the same fields as `mcp_secret_env`, but Ciclo wraps the harness command itself so the worker process tree receives the variables. Do not use `mcp_secret_env` for shell credentials; those variables belong to the Ciclo MCP subprocess, not the agent shell.

Additional MCP servers are configured separately with `mcp_additional_servers` or project `mcp.additionalServers`. Raw environment values must be non-secret, but a value may include a Ciclo secret placeholder such as `Bearer ${secret://team-1password/Ciclo/API/token}`. The placeholder host is the configured provider id, the path is the provider secret reference, and `?field=token` or `#token` selects a field for providers such as OpenBao. Ciclo wraps that additional server command with `ciclo secret exec`, so only that MCP server subprocess receives the resolved variable. If a third-party MCP server needs credentials, use one of these patterns:

- Use a Ciclo placeholder in that server's `env` value when Ciclo should resolve the secret at session startup.
- Configure the server with its own provider-native reference, such as a vault path or `op://` reference, when the server supports it.
- Launch a wrapper command that reads the secret at runtime and then starts the MCP server without storing the value in Ciclo config.
- Let the spawned worker call `ciclo_request_secret` through Ciclo MCP for task-scoped use instead of injecting the value into that third-party server.

### Project Config

Use `.ciclo/config.json` to store shared Ciclo defaults for a repository:

```bash
node dist/src/cli.js config init --project /path/to/project
node dist/src/cli.js config show --project /path/to/project --compact
node dist/src/cli.js config path --project /path/to/project
```

Use [examples/ciclo-config.json](/Users/ztaylor/repos/workspaces/ciclo/examples/ciclo-config.json) as the reference shape when wiring a real project. It is intentionally safe to commit because it contains provider ids and secret references, not secret values.

The config supports:

- `secrets.providers`: OpenBao and 1Password provider ids, display names, and CLI commands.
- `mcp`: default clients, server name, Ciclo command, non-secret `vars`, secret provider bindings for Ciclo MCP server subprocesses, `workerSecretBindings` for spawned worker shells, and Claude channel mode for generated MCP configs.
- `remote`: default runner kind, image, repository path, SSH user, WireGuard settings, provider-specific Kubernetes/AWS Lambda MicroVM/Cloudflare settings, and non-secret `vars`.

Precedence is simple: inline CLI flags and MCP tool payload fields win for the current operation; `.ciclo/config.json` fills any omitted values; Ciclo's built-in defaults apply last. That means the shared config can define the normal Claude/Codex MCP setup, secret provider aliases, and remote runner defaults while a single launch can still override the model, worktree, remote runner kind, or provider-specific field.

Use provider references in `mcp.secretBindings` and `mcp.workerSecretBindings`; do not store raw secret values. Ciclo redacts secret references from `ciclo config show --compact`, launch responses, worker-session listings, audit records, events, and board rows. `vars` are only for non-secret strings. For secrets needed by the generated Ciclo MCP server, bind a `name` to a configured provider and reference under `secretBindings`; for secrets needed by the launched agent shell, use `workerSecretBindings`. Ciclo writes runtime wrappers that resolve the value only when the intended process starts. Add `format` only when the generated variable needs a prefix, suffix, or wrapper string. For additional MCP servers, keep raw environment values non-secret or use `${secret://provider-id/ref}` placeholders that Ciclo turns into runtime wrappers.

The same file is read in four places:

- `ciclo mcp install` merges `mcp` defaults into Claude and Codex client config generation.
- `ciclo mcp stdio` and HTTP MCP startup register configured secret providers.
- `ciclo_launch_worker_session` applies `mcp` defaults when `configure_mcp` is enabled.
- `ciclo_launch_remote_runner` applies `remote` defaults before building the runner, WireGuard, remote MCP config, and Herdr attach plan.

Example launch payload:

```json
{
  "harness_id": "codex",
  "loop_id": "review-loop",
  "bead_id": "ciclo-774",
  "model": "gpt-5.5",
  "isolation": "worktree",
  "configure_mcp": true,
  "mcp_clients": ["codex"],
  "mcp_secret_env": [
    {
      "env_name": "API_TOKEN",
      "provider_id": "onepassword",
      "secret_ref": "op://Ciclo/API/token",
      "reason": "worker MCP server needs the API token"
    }
  ],
  "worker_secret_env": [
    {
      "env_name": "GITHUB_TOKEN",
      "provider_id": "onepassword",
      "secret_ref": "op://Ciclo/GitHub/token",
      "reason": "worker shell needs gh access"
    }
  ],
  "prompt": "Use Ciclo MCP as the control plane. Claim scoped work, report progress, ask questions through Ciclo, and record validation evidence before close.",
  "dry_run": true
}
```

Ciclo owns the worker lifecycle. Workers should communicate back through Ciclo MCP tools such as `ciclo_update_work`, `ciclo_ask_operator`, `ciclo_request_secret`, `ciclo_report_feedback`, and `ciclo_close_work`. Use `ciclo_poll_events` with the returned cursor for monitoring state changes, and use `ciclo_board` for the joined operator dashboard.
Workers should heartbeat through `ciclo_heartbeat_worker_session` while active and may include token and cost deltas. `ciclo_status`, `ciclo_board`, and `ciclo_list_worker_sessions` accept `stale_after_ms` to mark silent running workers as `stalled`.
For PR-producing loops, pass `expected_pr_after_ms` to `ciclo_board`. If a worker branch has no PR after that deadline, Ciclo emits a `blocker.raised` event with `kind: "expected_pr_missing"` and includes recovery actions on the board row.

When a task closes through `ciclo_close_work`, Ciclo launches a bounded review worker by default. The reviewer verifies the closed task, leaves comments with `ciclo_report_feedback`, records validation with `ciclo_update_work`, and asks the operator when a risk needs a decision. Use `review_dry_run: true` to inspect the planned reviewer, `review_harness_id` to choose `codex` or `claude-code`, or `launch_review: false` only when the operator has explicitly waived post-close review.

### Secret Providers

Ciclo-managed sessions should request task-scoped secrets through MCP instead of asking the operator to paste credentials into chat:

```text
ciclo_list_secret_providers
ciclo_request_secret
ciclo://secret-providers
```

Built-in providers:

- `openbao`: calls `bao kv get -field=<field> <secret_ref>` and requires `field`.
- `onepassword`: calls `op read <secret_ref>`, such as `op://Ciclo/API/token`.

Example request:

```json
{
  "provider_id": "onepassword",
  "secret_ref": "op://Ciclo/API/token",
  "loop_id": "deploy-loop",
  "bead_id": "ciclo-42",
  "worker_session_id": "worker-1",
  "reason": "deploy validation needs the API token",
  "dry_run": false
}
```

The response includes `value` only for a successful non-dry-run request. Audit logs and runtime events keep `provider_id`, provider kind, field, and `secret_ref_hash`; they do not store the secret value or raw secret reference.

### Remote Runner Sessions

Ciclo can plan remote runners before a provider executor exists. The plan is the interface: it records what should be launched, how WireGuard should connect the runner back to Ciclo, and how Herdr should attach for interactive monitoring. Provider behavior is plugin-backed; Kubernetes, AWS Lambda MicroVM, and Cloudflare ship as the default plugins.

From MCP, use:

```text
ciclo_launch_remote_runner
ciclo_list_remote_runners
ciclo_attach_plan
ciclo://remote-runners
```

Remote runner responses include `mcp_config` when remote MCP setup is enabled. It contains:

- `clients`, `serverName`, `command`, `vars`, and generated install metadata from the project config or one-off launch fields.
- Fresh `.mcp.json` and/or `.codex/config.toml` artifacts targeted at the remote `repo_path`.
- A `ciclo mcp install` command to run inside the runner when the remote checkout already has MCP client config and needs a merge instead of replacing files with the rendered artifacts.

Set `configure_mcp: false` only when the remote image or bootstrap process already installs Ciclo MCP for the remote repo. Otherwise leave it enabled so the remote Claude or Codex session can report status, ask questions, request secrets, and close work through Ciclo.

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
