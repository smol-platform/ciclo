---
name: ciclo-mcp
description: "Use when Claude, Codex, or another coding agent is working in a Ciclo-enabled project and should coordinate through Ciclo MCP: reading Ciclo status, selecting and claiming Beads work, asking or answering operator questions, launching Ciclo-managed Claude/Codex workers, monitoring Herdr/remote sessions, reporting feedback, syncing Beads-native trackers, or closing work with validation evidence."
---

# Ciclo MCP

Use Ciclo MCP as the control plane. Do not bypass Ciclo for claims, worker lifecycle, operator questions, remote runner planning, or task closeout when Ciclo MCP is available.

## First Moves

1. Read `ciclo_status` or `ciclo://status`.
2. Read `ciclo_whoami` or `ciclo://users/me` when access or identity affects the action.
3. For work selection, call `ciclo_list_ready_work`; do not infer ready work only from local files.
4. Claim work with `ciclo_claim_work` before implementation.
5. Record progress, blockers, validation, and final summaries with `ciclo_update_work`.

If MCP tools are not visible, check project MCP installation:

```bash
ciclo mcp install --client all --project "$(pwd)"
ciclo skill install --client all --project "$(pwd)"
```

## Operating Rules

- Use Beads IDs in every mutating Ciclo MCP call when work is tied to a task.
- Use `dry_run: true` before launching workers, remote runners, or any plan with unclear policy impact.
- Ask through `ciclo_ask_operator` for secrets, credentials, destructive commands, deploys, scope changes, unclear product intent, or blocked agent decisions.
- Report findings or warnings with `ciclo_report_feedback` instead of burying them in chat.
- Close work only through `ciclo_close_work`, with acceptance evidence and validation evidence.
- Do not write `.beads/issues.jsonl` or treat it as live coordination state.
- Do not push Jira/Linear directly; use `ciclo_sync_remote_trackers` only when Beads-native sync is configured and authorized.

## Worker Pattern

When the user wants Claude to drive work through Ciclo, keep the current session as the operator-facing session. Launch implementation or review workers through Ciclo:

1. Call `ciclo_launch_worker_session` with `dry_run: true`.
2. Show the command, cwd, model, session name, and prompt scope.
3. After approval, call `ciclo_launch_worker_session` without dry run.
4. Prefer `isolation: "worktree"` for bead fan-out so workers do not collide in the main checkout.
5. Monitor with `ciclo_poll_events`, `ciclo_board`, `ciclo_list_worker_sessions`, or `ciclo://worker-sessions`.
6. Have workers heartbeat with `ciclo_heartbeat_worker_session`; include token and cost deltas when available.
7. For PR-producing loops, call `ciclo_board` with `expected_pr_after_ms`; treat `expected_pr_missing` as a blocker requiring transcript inspection, stop, or relaunch.
8. Stop stale or superseded workers with `ciclo_stop_worker_session`.

Ciclo reuses the active Herdr session when detected. Local Claude/Codex workers launched through Ciclo then run as visible Herdr agent panes, so the operator can attach to the overall Ciclo session and watch them. If that is not wanted, start the MCP server with `CICLO_REUSE_HERDR_SESSION=false` to use direct process launches and repo-name fallback.

## Closeout Pattern

Before closeout:

1. Record validation with `ciclo_update_work` using `kind: "validation"`.
2. Record any remaining blocker or follow-up with `ciclo_update_work`, or create follow-up Beads work when needed.
3. Call `ciclo_close_work` with final summary, acceptance evidence, and validation evidence.
4. If tracker sync is configured and approved, call `ciclo_sync_remote_trackers`.

## Detailed Reference

Read `references/mcp-workflows.md` when you need tool payload examples, resource names, remote runner flow, device auth, or the recommended first prompt for a Claude/Codex session.
