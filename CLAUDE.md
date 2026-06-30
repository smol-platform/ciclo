# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

Use the repository `devenv` shell for all build and validation work.

```bash
devenv shell
ciclo-check
```

From outside the shell, use `just check`.

Useful narrower gates:

```bash
just hooks
just python
just typescript
just quint
```

## Architecture Overview

Ciclo is a spec-first agent supervisor. The intended runtime shape is:

```text
Herdr observations -> normalized events -> loop state -> policy -> response planner
                             |                 |             |
                             v                 v             v
                       harness plugins   Beads work DB   MCP/API/audit
                             |                 |             |
                             v                 v             v
                       Claude/Codex     remote DB sync   operator feedback
```

Read [docs/specs/SPEC-CICLO-001-agentic-babysitter.md](/Users/ztaylor/repos/workspaces/ciclo/docs/specs/SPEC-CICLO-001-agentic-babysitter.md) before implementing behavior. [claude/agent.md](/Users/ztaylor/repos/workspaces/ciclo/claude/agent.md) has the epic-by-epic implementation guide.

Use [docs/operator-workflows.md](/Users/ztaylor/repos/workspaces/ciclo/docs/operator-workflows.md) when changing or exercising review, deploy, benchmark, approval, remote, multi-user, recovery, or task closeout behavior.

The primary runtime decision is a standalone TypeScript Ciclo orchestrator agent declared in [package.json](/Users/ztaylor/repos/workspaces/ciclo/package.json). [cli.ts](/Users/ztaylor/repos/workspaces/ciclo/src/cli.ts) is the first Ciclo CLI surface; [pi-extension.ts](/Users/ztaylor/repos/workspaces/ciclo/src/pi-extension.ts) is an internal Pi brain adapter, not the product boundary. The Python package under `src/ciclo` is transitional support for Herdr/config fixtures while the TypeScript adapters are built out.

## Conventions & Patterns

- Specs come first. Link implementation work to `SPEC-CICLO-001` and the active Beads issue.
- Beads is the durable work source. Do not treat `.beads/issues.jsonl` as coordination state and do not use `bd import` during normal work.
- Herdr is the observation layer for local and remote sessions. Remote supervision must go through Herdr remote attach, not raw SSH polling.
- Ciclo is default-deny for mutating work, deploys, destructive commands, auto-close, remote registration, and external sync.
- Jira/Linear sync is Beads-native. Ciclo should trigger and audit Beads sync, not implement tracker providers in the MVP.
- Keep context durable by writing completion summaries, blockers, validation evidence, and follow-up work back to Beads.
- Update the Quint model when work touches Beads claims, multi-user auth, command approval, token handling, or remote-session ownership.

## Project Gates

Claude hooks in [.claude/settings.json](/Users/ztaylor/repos/workspaces/ciclo/.claude/settings.json) and Codex hooks in [.codex/hooks.json](/Users/ztaylor/repos/workspaces/ciclo/.codex/hooks.json) call [scripts/agent-gate.py](/Users/ztaylor/repos/workspaces/ciclo/scripts/agent-gate.py).

The gate blocks risky tool calls before they run:

- `git commit` unless `CICLO_ALLOW_GIT_COMMIT=1` is set for an explicitly approved commit command.
- `git push` unless `CICLO_ALLOW_GIT_PUSH=1` is set for an explicitly approved push command.
- `bd dolt pull` or `bd dolt push` unless `CICLO_ALLOW_BEADS_REMOTE_SYNC=1` is set for approved remote sync.
- Direct writes to `.env*`, `.git/`, `.devenv/`, `_apalache-out/`, `.beads/issues.jsonl`, and Beads internal storage.
- `bd edit`, `bd import`, dangerous Git reset/clean/checkout commands, shell redirection writes, and `bd close` without `--reason`.

Run `just hooks` after hook edits and `just check` before handoff.

## Remote Work

Codex remote setup scripts are versioned in the repository:

```bash
scripts/codex-remote-setup.sh
scripts/codex-remote-maintenance.sh
```

The remote setup installs or verifies Nix, `devenv`, Beads, and Herdr, then runs `ciclo-doctor`. Use [README.md](/Users/ztaylor/repos/workspaces/ciclo/.codex/remote/README.md) under `.codex/remote/` for Codex environment configuration.
