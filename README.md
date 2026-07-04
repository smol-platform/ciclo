# Ciclo

Ciclo is a spec-driven standalone orchestrator agent for coding work. It watches available harnesses and AI clouds, detects when agents are working, idle, blocked, or done, and keeps project loops moving without taking unsafe actions by default.

The initial product target is an agentic babysitter for Claude Code, Codex, Pi-backed agents, and future AI cloud harnesses. A user defines project loops, such as review, deploy, triage, benchmark, or Beads-backed work loops. Ciclo observes Herdr agent state, repository state, Beads work state, remote sessions, and harness-specific events, then decides whether to wait, claim ready work, nudge an agent, ask for human input, route a question, update a task, sync external trackers, or update the loop goal.

The first specification is [SPEC-CICLO-001: Agentic Babysitter Harness](/Users/ztaylor/repos/workspaces/ciclo/docs/specs/SPEC-CICLO-001-agentic-babysitter.md).

Operator runbooks for review, deploy, benchmark, approval, remote, multi-user, recovery, and closeout workflows are in [docs/operator-workflows.md](/Users/ztaylor/repos/workspaces/ciclo/docs/operator-workflows.md).

For first-run setup, use [docs/getting-started.md](docs/getting-started.md). To connect an existing repository so Claude can drive work through Ciclo, use [docs/onboarding-project.md](docs/onboarding-project.md).

## Development Model

- Specs define behavior before implementation.
- Beads tracks epics, tasks, decisions, and benchmark work.
- Every implementation task should link back to a spec ID.
- Harness support is plugin-based; Claude Code and Codex are the first plugins.
- Beads is the durable work queue; Ciclo can use local Beads or a configured Beads remote database so agents centralize ready work, claims, progress, and closures through Beads.
- Jira and Linear are optional outbound sync targets through Beads-native integrations when configured.
- Ciclo exposes an MCP control plane for Claude, Codex, and generic harnesses to query status, coordinate work, ask/answer questions, and report feedback to the operator session.
- Ciclo can own worker sessions: the operator talks to Ciclo, and Ciclo launches Claude Code or Codex workers with scoped prompts, model parameters, lifecycle tracking, and cleanup.
- Ciclo can plan remote runner sessions for Kubernetes, AWS Lambda MicroVM, and Cloudflare environments, including WireGuard tunnel setup and Herdr attach commands for interactivity.
- Remote sessions use Herdr remote attach over SSH (`herdr --remote ...`) with explicit registration, heartbeat, scoped access, and stale/lost detection.
- Ciclo supports `single` mode without auth friction and `multiuser` mode with OAuth device-code login, scoped grants, and per-user authorization for work and commands.
- Ciclo tracks context size, builds bounded context packs, and smart-compacts completed work into Beads so durable memory stays with the task.
- Core coordination invariants are modeled with Quint under `formal/quint/`.
- Benchmarks score Ciclo responses across simulated scenarios and multiple judge or driver models.

## Development Environment

Ciclo uses `devenv` for a reproducible shell with Dolt, Quint, Node, TypeScript, Python transitional tooling, Go, Rust bootstrap tooling, SSH, and validation helpers.

```bash
devenv shell
ciclo-check
```

Or run the quality gate without entering the shell:

```bash
just check
```

`bd` and `herdr` are required for runtime development. The shell intentionally uses the host Beads CLI so its version matches the local Beads database; Herdr is host-installed because it is not available from nixpkgs. `ciclo-doctor` verifies both before running the full check.

The primary implementation runtime is a standalone TypeScript Ciclo orchestrator agent. OpenAI is the default decision provider for live orchestration, reached through the Pi SDK adapter; Pi is not Ciclo's product boundary. Ciclo uses the OpenAI brain for remote-session monitoring, deciding when to insert more context, answering questions it can reason about from known state, and interfacing with the controlling user session. Short, specific CLI utilities such as help, status, install, and deterministic benchmark runs can remain local. [src/cli.ts](/Users/ztaylor/repos/workspaces/ciclo/src/cli.ts) and MCP/daemon entrypoints are Ciclo's user-facing surfaces. The earlier Python package under `src/ciclo` remains transitional support for Herdr/config fixtures until equivalent TypeScript adapters replace it.

## Image Builds

GitHub Actions builds the Ciclo runner image on pull requests and publishes `ghcr.io/smol-platform/ciclo` from `main`, release tags, and manual workflow runs. The image contains the Ciclo CLI, Ciclo MCP entrypoints, Herdr, SSH, Git, and WireGuard tools; layer harness CLIs and auth bootstrap on top when a remote runner needs Claude Code, Codex, or cloud-specific tools preinstalled.

```bash
docker build -t ciclo:dev .
docker run ciclo:dev --version
```

## Using Ciclo

Build once, then either run the built CLI directly or expose the package binary with `npm link`:

```bash
npm ci --ignore-scripts
npm run build
npm link
```

Without `npm link`, replace `ciclo` below with `node dist/src/cli.js`.

Inspect the CLI and current runtime:

```bash
ciclo --help
ciclo --version
ciclo status --compact
ciclo runtime
npm run demo
```

Run the benchmark fixture suite:

```bash
ciclo benchmark --scenario-dir tests/fixtures/benchmarks
```

Start MCP over stdio for Claude, Codex, or a generic MCP client:

```bash
ciclo mcp stdio
```

When MCP is running, Ciclo starts an internal heartbeat for the sessions it owns. The heartbeat refreshes worker state, marks silent workers stale or stalled, checks registered remote sessions through Herdr remote attach when a remote heartbeat client is configured, and asks the OpenAI brain for follow-up decisions instead of waiting for an external poll.

Project defaults can live in `.ciclo/config.json`:

```bash
ciclo config init --project /path/to/project
ciclo config show --project /path/to/project --compact
ciclo config path --project /path/to/project
```

The config stores secret provider references, MCP defaults, and remote runner defaults. It should contain provider ids, secret references, and non-secret `vars`, not raw secret values. `ciclo mcp install`, MCP runtime startup, spawned worker MCP setup, and remote runner planning all read this file; explicit CLI or MCP tool arguments override config values.

Use [examples/ciclo-config.json](/Users/ztaylor/repos/workspaces/ciclo/examples/ciclo-config.json) as the checked-in reference shape. It shows OpenBao, 1Password, and plugin-backed provider aliases, MCP secret bindings for spawned workers, Claude/Codex client defaults, remote runner defaults, WireGuard tunnel fields, and provider-specific Kubernetes, AWS Lambda MicroVM, and Cloudflare runner settings. `ciclo config show --compact` redacts secret references before display.

Remote runner plans also include `mcp_config`: generated `.mcp.json` and/or `.codex/config.toml` artifacts for the remote `repoPath`, plus a `ciclo mcp install` command to run inside the runner when the remote checkout already has client config that should be merged.

Install Ciclo into a target project's MCP client config:

```bash
ciclo mcp install --client claude --project /path/to/project
ciclo mcp install --client all --project /path/to/project --dry-run --compact
ciclo mcp install --client claude --project /path/to/project --claude-channel
```

Claude project installs update `.mcp.json`; Codex installs update `.codex/config.toml`. The generated config sets `CICLO_PROJECT_ROOT` so the MCP server coordinates against the target repo even when launched by the client.

For Claude Code channel preview workflows, add `--claude-channel`. Ciclo writes `CICLO_CLAUDE_CHANNEL=true` into the Claude MCP server config and returns the Claude launch selector, for example `--dangerously-load-development-channels server:ciclo`.

Install Ciclo's agent skill guidance into the same target project:

```bash
ciclo skill install --client all --project /path/to/project
ciclo skill install --client codex --project /path/to/project --dry-run --compact
```

Claude skill installs write `.claude/skills/ciclo-mcp.md`, `.claude/skills/release.md`, and `.claude/commands/release.md`; Codex-compatible installs write `.agents/skills/ciclo-mcp/` and `.agents/skills/release/`. Use `/release <tag>` in Claude, or the `release` skill in Codex, to run the guarded tag, remote publish, and GitHub release workflow.

To start an interactive local Claude or Codex session with Ciclo MCP and configured additional MCP servers installed first, use `ciclo launch`:

```bash
ciclo launch codex
ciclo launch codex --session infra-blocks
ciclo launch claude --model claude-fable-5
ciclo launch codex --prompt "Review the repo" -- --full-auto
ciclo launch claude --dry-run --compact
ciclo launch codex --terminal
```

`ciclo launch` reads `.ciclo/config.json`, writes the generated `.mcp.json` or `.codex/config.toml`, then starts the selected harness as the first pane in a named Herdr session. Secret-backed MCP entries are written as `ciclo secret exec` runtime wrappers that carry provider references, not resolved secret values; the wrapper resolves the secret immediately before starting the intended child process. The default Herdr session and pane name are the project directory name, so `ciclo launch codex` in this repository starts session `ciclo` with pane `ciclo` and then attaches to it. Use `--session`, `--pane-name`, or `--no-attach` to control the Herdr wrapper, and use `--terminal` when you explicitly want the harness process in the current terminal instead. Use `--project`, `--server-name`, `--mcp-command`, `--harness-command`, `--model`, `--effort`, `--permission-mode`, `--approval-policy`, `--sandbox`, `--prompt`, and `--extra-arg` to override one launch.

Use Ciclo as the operator interface for managed worker sessions. MCP clients can call:

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

Use `dry_run: true` on `ciclo_launch_worker_session` to inspect the exact Claude Code or Codex launch plan before starting a process. Pass `isolation: "worktree"` to create a worker worktree, defaulting bead work to a `ciclo/<bead-id>` branch. When Ciclo is running inside Herdr, local worktree-isolated workers use fresh `herdr worktree create` workspaces and start the pane with the returned Herdr workspace id; outside Herdr, Ciclo falls back to `git worktree add`. Existing Herdr worktree paths fail instead of reopening stale workspace state. Pass `configure_mcp: true` to install Ciclo MCP client config into the worker cwd or worktree before the harness starts; Ciclo defaults to the matching client (`claude` for Claude Code, `codex` for Codex) and accepts `mcp_clients`, `mcp_server_name`, `mcp_command`, and `mcp_claude_channel` overrides. Once launched, workers should report liveness and optional token/cost deltas with `ciclo_heartbeat_worker_session`, and report progress, blockers, questions, secret requests, and closeout evidence back through Ciclo MCP tools. `ciclo_poll_events` returns cursor-based runtime events, and `ciclo_board` joins Beads work, workers, worktrees, pending questions, rollup metrics, and validation/PR state for operator monitoring. Pass `expected_pr_after_ms` to `ciclo_board` to raise an `expected_pr_missing` blocker when a worker branch has not opened a PR by the deadline.

When `.ciclo/config.json` contains `mcp`, spawned workers inherit its `clients`, `serverName`, `command`, `vars`, `secretBindings`, `workerSecretBindings`, and `claudeChannel` defaults. Inline `ciclo_launch_worker_session` fields still win for one-off launches.

Use `mcp.secretBindings` when the generated Ciclo MCP server config needs secret-backed environment variables. Each binding names the env var and references a configured provider; the provider may be built in, such as OpenBao or 1Password, or plugin-backed through `secrets.providers[].pluginProviderId`:

```json
{
  "secrets": {
    "providers": [
      {
        "id": "team-keychain",
        "kind": "keychain",
        "pluginProviderId": "keychain-test"
      }
    ]
  },
  "mcp": {
    "secretBindings": [
      {
        "name": "PLUGIN_BACKED_API_TOKEN",
        "providerId": "team-keychain",
        "ref": "keychain://ciclo/example-api-token",
        "format": "Bearer ${secret}",
        "reason": "Provide task-scoped API access to the Ciclo MCP server."
      }
    ]
  }
}
```

For non-dry-run installs and worker launches, Ciclo writes a runtime wrapper into the generated `ciclo` server entry instead of writing the resolved value into `.mcp.json` or `.codex/config.toml`. The wrapper resolves the provider reference and applies `format` only when the MCP server process starts; install and launch responses stay redacted. Add `format` when the target variable needs a prefix, suffix, or wrapper string. The format must contain exactly one `${secret}` placeholder, for example `Bearer ${secret}`.

Secret support has three process-scoped paths:

- Ciclo MCP server environment: use project `mcp.secretBindings` or launch-time `mcp_secret_env`. Ciclo writes a runtime wrapper around the generated `ciclo` MCP server command; only that server subprocess receives the resolved variables.
- Worker process environment: use project `mcp.workerSecretBindings` or launch-time `worker_secret_env` when the launched Claude/Codex shell tools need credentials, such as `gh`, `git`, or `curl`. Ciclo wraps the harness command so the worker process tree receives the resolved variables, while generated MCP config files still contain no resolved values.
- Additional MCP servers: project `mcp.additionalServers` and launch-time `mcp_additional_servers` accept environment maps where raw values must be non-secret. When a third-party server needs a Ciclo-managed secret, put a placeholder in the value, such as `Bearer ${secret://team-1password/Ciclo/API/token}`. The placeholder host is the configured provider id, the path is the provider secret reference, and `?field=token` or `#token` can select a field for providers such as OpenBao. Ciclo wraps that additional server command so only that MCP server subprocess receives the resolved variable.

Workers can request scoped secrets through Ciclo instead of asking the operator to paste values:

```text
ciclo_list_secret_providers
ciclo_request_secret
ciclo://secret-providers
```

Built-in providers are `openbao` and `onepassword`. OpenBao uses `bao kv get -field=<field> <secret_ref>` and requires an explicit field. 1Password uses `op read <secret_ref>`, for example an `op://vault/item/field` reference. Ciclo returns the secret value only to the requesting MCP caller; audit records and events store provider id, kind, field, and a stable secret-reference hash.

Plan a remote runner environment through MCP:

```text
ciclo_launch_remote_runner
ciclo_list_remote_runners
ciclo_attach_plan
ciclo://remote-runners
```

Supported runner kinds are `kubernetes`, `aws-lambda`, and `cloudflare`. Each kind is implemented by a remote runner provider plugin so new runnable environments can be added without changing the core planner. Each plan includes provider artifacts or commands, generated remote MCP client config artifacts, image resolution evidence, repo bootstrap commands, a runtime preflight that checks Claude Code access and Ciclo-like build tools, a WireGuard runner config or existing Secret reference, the Herdr remote target reachable over that tunnel, and a `ciclo attach` plan for monitoring the overall Ciclo session.

Ciclo image resolution supports `static`, `variant`, and `nixery` strategies. Official image variants are built with Nix `dockerTools` as `base-latest`, `codex-latest`, `claude-latest`, and `full-latest`; CI smoke-tests each variant with `ciclo --version`. Use `preflight_only: true` to validate image, repo bootstrap, Claude access, and project dependencies before starting WireGuard or Herdr. Kubernetes launches clone `repo_url` into `repo_path` when needed and run `devenv shell -- true` when the project has `devenv.nix`, so project dependencies are loaded as the last mile in the remote environment.

The AWS provider targets Lambda MicroVMs, not legacy Lambda function invocation. It emits `aws lambda-microvms` image creation plus `run-microvm`, `suspend-microvm`, `resume-microvm`, and `terminate-microvm` lifecycle commands.

Install third-party remote runner or secret provider plugins:

```bash
ciclo plugin install @acme/ciclo-runner-fly --trust
ciclo plugin list --compact
ciclo plugin disable @acme/ciclo-runner-fly
ciclo plugin enable @acme/ciclo-runner-fly
```

During plugin development, install from a local package directory:

```bash
ciclo plugin install @acme/ciclo-runner-fly --path ../ciclo-runner-fly --trust
```

External plugin packages include `ciclo.plugin.json` and export `activate(api)`. The manifest is validated before code loads, and enabled plugins must be trusted before activation. Plugin config is stored in `.ciclo/plugins.json`; npm-installed plugin packages are placed under `.ciclo/plugins/`. Plugins can declare `remote-runner` with `runnerKinds`, `image-resolver` with `imageResolverStrategies`, `secret-provider` with `secretProviderKinds`, or a combination.

Minimal plugin entrypoint:

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

  api.secretProviders.register({
    id: "acme-vault",
    kind: "acme-vault",
    name: "Acme Vault",
    async resolve(input) {
      return {
        resolved: true,
        providerId: "acme-vault",
        providerKind: "acme-vault",
        secretRefHash: "hash-the-secret-ref",
        field: input.field,
        value: "resolved-secret",
        reason: "secret was resolved by provider",
        evidence: ["secret.provider:acme-vault", "secret.resolved:true"]
      };
    }
  });
}
```

Attach to Ciclo's Herdr session:

```bash
ciclo attach --session ciclo
ciclo attach --remote ciclo@10.44.0.2:/workspace/ciclo --session ciclo
ciclo attach --remote ciclo@10.44.0.2:/workspace/ciclo --session ciclo --target pane-1
```

By default, Ciclo reuses the active Herdr session when it can detect one. Every local Claude/Codex worker session launched by Ciclo then runs through a visible Herdr agent pane in that session, so `ciclo attach` shows jobs as they spin up and work. If no active Herdr session is detected, Ciclo falls back to the repository directory name; in this repo the fallback is `ciclo`. Set `CICLO_REUSE_HERDR_SESSION=false` to force direct process launches and repo-name fallback. Use `--dry-run --compact` to print the attach command as JSON instead of running Herdr.

Start local MCP over HTTP:

```bash
ciclo mcp http --host 127.0.0.1 --port 7331 --path /mcp
```

Run validation gates:

```bash
just check
just hooks
just typescript
just python
just quint
```

## Agent Gates

Claude Code and Codex project hooks call [scripts/agent-gate.py](/Users/ztaylor/repos/workspaces/ciclo/scripts/agent-gate.py) to keep agents inside Ciclo's ground rules. The gate injects project guardrails at session/prompt boundaries and blocks risky tool calls such as:

- Direct edits to `.env*`, `.git/`, generated caches, and Beads internals.
- `git commit`, `git push`, and Beads remote sync without explicit environment opt-in for the approved command.
- Destructive Git/shell commands, interactive `bd edit`, normal-workflow `bd import`, and file writes through shell redirection.
- `bd close` without a `--reason` completion note.

Validate hook configuration with:

```bash
just hooks
```

## Codex Remote

Codex remote/cloud setup scripts live in [scripts/codex-remote-setup.sh](/Users/ztaylor/repos/workspaces/ciclo/scripts/codex-remote-setup.sh) and [scripts/codex-remote-maintenance.sh](/Users/ztaylor/repos/workspaces/ciclo/scripts/codex-remote-maintenance.sh). Use the setup script in Codex environment settings and the maintenance script for cached-container resumes. Details are in [.codex/remote/README.md](/Users/ztaylor/repos/workspaces/ciclo/.codex/remote/README.md).
