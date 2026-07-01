# Ciclo MCP Workflows

## Operator Session Prompt

Use this when starting Claude or Codex in a project that has Ciclo MCP installed:

```text
Use Ciclo MCP as the control plane for this repository. Start by reading Ciclo status and ready work. Claim Beads work through Ciclo, ask operator questions through Ciclo, launch worker sessions through Ciclo when useful, report progress and validation evidence through Ciclo, and close work only through Ciclo after acceptance evidence is present.
```

## Common Tool Order

1. `ciclo_status` or `ciclo://status`
2. `ciclo_whoami` or `ciclo://users/me`
3. `ciclo_list_ready_work`
4. `ciclo_claim_work`
5. `ciclo_update_work`
6. `ciclo_launch_worker_session` when another Claude/Codex process should do bounded work
7. `ciclo_heartbeat_worker_session` from active workers with liveness, token, and cost deltas
8. `ciclo_poll_events` and `ciclo_board` while monitoring active work
9. `ciclo_board` with `expected_pr_after_ms` for PR-producing fan-out loops
10. `ciclo_ask_operator` when blocked
11. `ciclo_report_feedback` for review findings and warnings
12. `ciclo_close_work`
13. `ciclo_sync_remote_trackers` only when configured and approved

## Status And Context Resources

- `ciclo://status`: overall loops, Beads, Herdr, remotes, sync, and access state.
- `ciclo://loops`: loop summaries.
- `ciclo://loops/{loop_id}`: detailed loop state.
- `ciclo://work/ready`: ready Beads work.
- `ciclo://work/{bead_id}`: work context and Ciclo audit state.
- `ciclo://questions`: pending operator or agent questions.
- `ciclo://feedback`: queued feedback.
- `ciclo://worker-sessions`: Ciclo-managed worker lifecycle state.
- `ciclo://remote-sessions`: registered remote sessions.
- `ciclo://remote-runners`: remote runner plans.
- `ciclo://session/access`: access mode and grants.
- `ciclo://users/me`: current principal.

## Work Claim Example

```json
{
  "loop_id": "review-loop",
  "bead_id": "project-123",
  "harness_id": "claude-code"
}
```

After claiming, use `ciclo_update_work` for progress:

```json
{
  "bead_id": "project-123",
  "kind": "progress",
  "message": "Inspected the failing tests and narrowed the issue to the scheduler retry path."
}
```

Validation update:

```json
{
  "bead_id": "project-123",
  "kind": "validation",
  "message": "Full TypeScript gate passed.",
  "validation_command": "npm run check",
  "validation_passed": true
}
```

## Worker Launch Example

Always dry-run first:

```json
{
  "harness_id": "codex",
  "loop_id": "review-loop",
  "bead_id": "project-123",
  "model": "gpt-5.5",
  "extra_args": ["--profile", "review"],
  "isolation": "worktree",
  "prompt": "Use Ciclo MCP as the control plane. Work only on project-123. Report progress, blockers, validation, and final summary through Ciclo.",
  "dry_run": true
}
```

After operator approval, send the same payload with `dry_run: false`. Use `extra_args` for harness-specific CLI flags and `isolation: "worktree"` when the worker should run in an isolated git worktree. Ciclo resolves a default sibling worktree path unless `worktree_path` is provided and defaults bead branches to `ciclo/<bead-id>`.

Heartbeat while working:

```json
{
  "worker_session_id": "worker-123",
  "state": "running",
  "input_tokens": 1200,
  "output_tokens": 450,
  "cost_usd": 0.06,
  "evidence": ["validation:unit-tests-pending"]
}
```

## Operator Question Example

```json
{
  "loop_id": "deploy-loop",
  "bead_id": "project-456",
  "urgency": "blocking",
  "question": "Deployment needs a production token. Which secret reference should this loop use?"
}
```

Use `ciclo_answer_question` only when answering a pending question as the operator or with explicit authorization.

## Remote Runner Example

Use this for planning remote runnable environments. Provider execution remains policy-gated.

```json
{
  "runner_kind": "kubernetes",
  "runner_id": "runner-k8s-1",
  "loop_id": "review-loop",
  "bead_id": "project-remote-1",
  "harness_id": "codex",
  "image": "ghcr.io/example/ciclo-runner:latest",
  "repo_path": "/workspace/project",
  "prompt": "Use Ciclo MCP and report progress.",
  "dry_run": true
}
```

Review the returned provider commands, WireGuard config, Herdr target, and `attach` plan before proceeding.

## Close Work Example

```json
{
  "bead_id": "project-123",
  "final_summary": "Implemented retry backoff fix and updated scheduler tests.",
  "acceptance_evidence": [
    "Retry backoff now caps at the configured maximum.",
    "Scheduler resumes after transient failure."
  ],
  "validation_evidence": [
    {
      "command": "npm run check",
      "passed": true
    }
  ]
}
```

## Fallback When MCP Is Missing

If Ciclo MCP tools are unavailable:

1. Verify Ciclo is installed: `ciclo --version`.
2. Dry-run project config and skill installs: `ciclo mcp install --client all --project "$(pwd)" --dry-run --compact` and `ciclo skill install --client all --project "$(pwd)" --dry-run --compact`.
3. Install for the active client:
   - Claude: `ciclo mcp install --client claude --project "$(pwd)" && ciclo skill install --client claude --project "$(pwd)"`
   - Codex: `ciclo mcp install --client codex --project "$(pwd)" && ciclo skill install --client codex --project "$(pwd)"`
4. Restart the client session if it does not hot-reload MCP config or project skills.

Do not emulate Ciclo MCP by editing Ciclo state files directly.
