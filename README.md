# Ciclo

Ciclo is a spec-driven standalone orchestrator agent for coding work. It watches available harnesses and AI clouds, detects when agents are working, idle, blocked, or done, and keeps project loops moving without taking unsafe actions by default.

The initial product target is an agentic babysitter for Claude Code, Codex, Pi-backed agents, and future AI cloud harnesses. A user defines project loops, such as review, deploy, triage, benchmark, or Beads-backed work loops. Ciclo observes Herdr agent state, repository state, Beads work state, remote sessions, and harness-specific events, then decides whether to wait, claim ready work, nudge an agent, ask for human input, route a question, update a task, sync external trackers, or update the loop goal.

The first specification is [SPEC-CICLO-001: Agentic Babysitter Harness](/Users/ztaylor/repos/workspaces/ciclo/docs/specs/SPEC-CICLO-001-agentic-babysitter.md).

Operator runbooks for review, deploy, benchmark, approval, remote, multi-user, recovery, and closeout workflows are in [docs/operator-workflows.md](/Users/ztaylor/repos/workspaces/ciclo/docs/operator-workflows.md).

For first-run setup, use [docs/getting-started.md](/Users/ztaylor/repos/workspaces/ciclo/docs/getting-started.md). For the shortest executable path through a local checkout, use [EGG.md](/Users/ztaylor/repos/workspaces/ciclo/EGG.md).

## Development Model

- Specs define behavior before implementation.
- Beads tracks epics, tasks, decisions, and benchmark work.
- Every implementation task should link back to a spec ID.
- Harness support is plugin-based; Claude Code and Codex are the first plugins.
- Beads is the durable work queue; Ciclo can use local Beads or a configured Beads remote database so agents centralize ready work, claims, progress, and closures through Beads.
- Jira and Linear are optional outbound sync targets through Beads-native integrations when configured.
- Ciclo exposes an MCP control plane for Claude, Codex, and generic harnesses to query status, coordinate work, ask/answer questions, and report feedback to the operator session.
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

The primary implementation runtime is a standalone TypeScript Ciclo orchestrator agent. Pi is used under the covers as an internal brain provider through [src/pi-extension.ts](/Users/ztaylor/repos/workspaces/ciclo/src/pi-extension.ts), while [src/cli.ts](/Users/ztaylor/repos/workspaces/ciclo/src/cli.ts) and future MCP/daemon entrypoints are Ciclo's user-facing surfaces. The earlier Python package under `src/ciclo` remains transitional support for Herdr/config fixtures until equivalent TypeScript adapters replace it.

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
