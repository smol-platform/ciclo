---
name: ciclo-mcp
description: "Use Ciclo MCP as the control plane for Claude-driven repository work: status, ready Beads work, claims, progress notes, operator questions, worker launches, Herdr/remote monitoring, tracker sync, and closeout with validation evidence."
---

# Ciclo MCP

Use Ciclo MCP whenever this project asks Claude to drive work through Ciclo.

## Workflow

1. Read `ciclo_status` or `ciclo://status`.
2. Read `ciclo_whoami` or `ciclo://users/me` when identity or access matters.
3. Select work with `ciclo_list_ready_work`.
4. Claim with `ciclo_claim_work` before implementation.
5. Record progress, blockers, validation, and final summaries with `ciclo_update_work`.
6. Ask blocked questions with `ciclo_ask_operator`.
7. Launch Claude/Codex workers through `ciclo_launch_worker_session`; dry-run first.
8. Monitor with `ciclo_poll_events`, `ciclo_board`, `ciclo_list_worker_sessions`, or `ciclo://worker-sessions`.
9. Heartbeat active workers with `ciclo_heartbeat_worker_session` when operating as the worker.
10. For PR-producing fan-out loops, call `ciclo_board` with `expected_pr_after_ms` and treat `expected_pr_missing` as a blocker.
11. Close with `ciclo_close_work` only after acceptance and validation evidence.

## Rules

- Keep the current Claude session operator-facing; ask Ciclo to launch bounded workers for implementation.
- Dry-run worker launches first; include `extra_args` for harness-specific flags and prefer `isolation: "worktree"` when the worker should run in an isolated git worktree.
- When Ciclo MCP is running inside Herdr, local Claude/Codex workers launch as visible Herdr agent panes by default. Set `CICLO_REUSE_HERDR_SESSION=false` before starting MCP only when direct process launches are required.
- Use Beads IDs in mutating calls.
- Do not edit `.beads/issues.jsonl` or bypass Ciclo for claims/closeout.
- Use `ciclo_report_feedback` for findings and warnings.
- Use `ciclo_sync_remote_trackers` only when Beads-native tracker sync is configured and authorized.
- Ask the operator before secrets, destructive commands, deploys, permission prompts, or scope expansion.

See `.agents/skills/ciclo-mcp/SKILL.md` and `.agents/skills/ciclo-mcp/references/mcp-workflows.md` for the canonical Codex-compatible skill and payload examples.
