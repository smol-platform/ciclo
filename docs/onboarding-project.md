# Onboard A Project Into Ciclo

This guide sets up a project so an operator can start a Claude session in that project and have Claude drive work through Ciclo instead of acting as an uncoordinated agent.

## 1. Install Ciclo On The Machine

From the Ciclo checkout:

```bash
npm ci --ignore-scripts
npm run build
npm link
ciclo --version
```

The linked `ciclo` command is what Claude or Codex will launch as an MCP stdio server.

## 2. Prepare The Target Project

In the project you want Ciclo to orchestrate:

```bash
cd /path/to/project
git status --short
bd prime
herdr --version
```

If the project does not use Beads yet, initialize Beads before giving Ciclo durable work:

```bash
bd init
bd create --title="Onboard project into Ciclo" --description="Create initial Ciclo loops, validation commands, and MCP-driven workflow for this repository." --type=task --priority=1
```

## 3. Install Ciclo MCP Config

For Claude-driven work:

```bash
ciclo mcp install --client claude --project "$(pwd)"
ciclo skill install --client claude --project "$(pwd)"
```

For Claude Code channel preview workflows, install the MCP config with channel mode:

```bash
ciclo mcp install --client claude --project "$(pwd)" --claude-channel
```

Use the launch selector returned by the command, for example `--dangerously-load-development-channels server:ciclo`, when starting Claude Code.

For Codex as well:

```bash
ciclo mcp install --client all --project "$(pwd)"
ciclo skill install --client all --project "$(pwd)"
```

The Claude install writes or updates:

```text
.mcp.json
```

The Codex install writes or updates:

```text
.codex/config.toml
```

Both configs launch:

```bash
ciclo mcp stdio
```

They also set `CICLO_PROJECT_ROOT` to the target repo, so Ciclo reads the correct Beads, Git, plugin, and loop state even if the MCP client starts the process from another directory.

Use a dry run to inspect the planned files first:

```bash
ciclo mcp install --client all --project "$(pwd)" --dry-run --compact
ciclo skill install --client all --project "$(pwd)" --dry-run --compact
```

## 4. Start Claude In The Project

Start a Claude Code session from the target repo after installing `.mcp.json`.

Use an opening instruction like:

```text
Use Ciclo MCP as the control plane for this repository. Start by reading Ciclo status and ready work. Claim Beads work through Ciclo, ask operator questions through Ciclo, launch worker sessions through Ciclo when useful, and report validation evidence before closing work.
```

The Claude session should use Ciclo tools for:

- `ciclo_status` to understand the current loop and session state.
- `ciclo_list_ready_work` and `ciclo_claim_work` to select Beads-backed work.
- `ciclo_update_work` for progress, blockers, and validation notes.
- `ciclo_ask_operator` when product, secret, approval, or scope questions arise.
- `ciclo_launch_worker_session` to start scoped Claude or Codex workers.
- `ciclo_list_worker_sessions` and `ciclo_stop_worker_session` for lifecycle control.
- `ciclo_close_work` only after acceptance evidence and validation are present.

## 5. Let Ciclo Launch Workers

Claude should act as the operator-facing session. When implementation work should run in a separate harness, ask Claude to call Ciclo's worker launch tool with `dry_run: true` first. Use `extra_args` for harness-specific CLI switches and `create_worktree` to let Ciclo launch the worker from an isolated git worktree.

Example intent:

```text
Ask Ciclo to dry-run a Codex worker for the highest-priority ready review-loop task. Show me the launch plan before starting it.
```

After approval, Claude can call the same tool without dry run. Ciclo tracks worker lifecycle, expected loop, Beads issue, model settings, cwd, prompt, and cleanup state.

## 6. Monitor Ciclo

Attach to the overall Herdr session:

```bash
ciclo attach --session "$(basename "$(pwd)")"
```

When Claude starts Ciclo MCP from inside an existing Herdr session, Ciclo reuses that Herdr session for attach plans, remote runner plans, and local worker launches. Every local Claude/Codex worker session is started with `herdr agent start` in a visible pane so the operator can watch it from `ciclo attach`. If no active session is detected, Ciclo falls back to the repository directory name. Set `CICLO_REUSE_HERDR_SESSION=false` before starting the MCP server when you want direct process launches and repo-name fallback even inside Herdr.

For remote sessions:

```bash
ciclo attach --remote ciclo@10.44.0.2:/workspace/$(basename "$(pwd)") --session "$(basename "$(pwd)")"
```

Use dry run when checking the attach command:

```bash
ciclo attach --session "$(basename "$(pwd)")" --dry-run --compact
```

## 7. Close The Loop

Before work is closed:

```bash
git status --short
bd show <task-id>
```

Claude should ask Ciclo to record:

- what changed
- validation commands and outcomes
- remaining risks or blockers
- follow-up Beads tasks
- whether remote tracker sync is configured through Beads

Then Claude should close the Beads work through Ciclo, not by editing Beads files directly.
