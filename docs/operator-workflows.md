# Ciclo Operator Workflows

This runbook is for the human operator responsible for running Ciclo loops, approving risky actions, and recovering work when an agent or remote session gets stuck.

Ciclo is default-deny. It may observe Herdr state, build plans, claim Beads work in dry-run, route questions, and prepare prompts, but it must not send prompts, run tests, deploy, approve permission prompts, close work, register remote sessions, or sync remote trackers unless policy and the active session allow that action.

## Operating Model

Use Beads as the source of truth for work:

```bash
bd ready
bd show <id>
bd update <id> --claim
bd close <id> --reason="Completed with validation ..."
```

Do not read `.beads/issues.jsonl` as coordination state and do not run `bd import` during normal operation.

Treat Ciclo as the operator interface. Do not start Claude Code or Codex manually for routine project work. Ask Ciclo to launch a worker session, then monitor and stop that worker through Ciclo:

1. Inspect ready work through Ciclo or Beads.
2. Ask Ciclo to launch a worker with `ciclo_launch_worker_session`.
3. Require the worker prompt to use Ciclo MCP for progress, questions, validation evidence, and closeout.
4. Monitor workers with `ciclo_list_worker_sessions` or `ciclo://worker-sessions`.
5. Stop or clean up workers with `ciclo_stop_worker_session` when work is complete, blocked, stale, or superseded.

Worker sessions are lifecycle objects. Ciclo records the harness, model, loop, Beads issue, command, pid when launched, state, cleanup reason, and evidence. Use `dry_run: true` before allowing a new worker profile or model.

Use these gates before closing implementation work:

```bash
npm run check
just check
node dist/src/cli.js benchmark --scenario-dir tests/fixtures/benchmarks
```

When the work touches Beads claims, multi-user auth, command approval, token handling, remote-session ownership, or context compaction, `just check` must include the Quint model run. Run `just quint` directly when you need a narrower formal check.

## Review Loop

A review loop watches a harness after implementation work and decides whether to summarize, ask for validation, create follow-up Beads tasks, or request operator input.

1. Confirm the target work item:

   ```bash
   bd show <id>
   ```

2. Confirm Ciclo has enough context: active Beads task, acceptance criteria, Herdr observation, repo status, and configured checks.
3. Let Ciclo build a bounded context pack for the selected harness.
4. Approve prompt sending only when the prompt is scoped to the loop, Beads ID, acceptance criteria, validation expectations, and stop conditions.
5. If review finds new work, create or approve Beads follow-up tasks instead of burying follow-ups in transcript text.
6. Before closing, require evidence for acceptance criteria and validation. The close note should name the checks run and any intentionally deferred follow-up work.

Expected safe responses:

- `wait` when Herdr reports the agent is working.
- `summarize` when Herdr reports done and validation evidence is available.
- `ask_operator` when the agent is blocked, a prompt would expand scope, or approval is required.
- `create_task` when review findings should become durable Beads work.

Unsafe responses to reject:

- Sending another prompt while Herdr says the agent is working.
- Closing work without validation evidence.
- Creating work outside the loop scope.
- Pushing tracker updates that include raw transcript or secrets.

## Deploy Loop

A deploy loop is intentionally stricter than review. Ciclo may gather state and prepare a plan, but deploy execution requires explicit operator approval.

1. Verify the Beads task acceptance criteria include deploy intent.
2. Verify the repository is on the intended branch and has no unrelated dirty changes.
3. Run the required checks before deployment:

   ```bash
   just check
   ```

4. Inspect the planned command, target environment, credentials boundary, rollback notes, and idempotency key.
5. Approve only the exact deploy command needed for the loop.
6. After deployment, record outcome evidence back to Beads and sync trackers only through Beads-native sync if configured.

Policy should deny by default:

- deploy commands not in the allowlist
- destructive commands
- permission prompt approval
- external side effects without explicit operator approval
- task closure before deploy evidence is recorded

## Benchmark Loop

Benchmark loops score Ciclo's responses to simulated scenarios. They are the regression suite for orchestration behavior and safety.

1. Add or update JSON fixtures under `tests/fixtures/benchmarks/`.
2. Ensure each scenario includes repo state, Beads state, Herdr events, loop config, policy, expected traits, disallowed traits, drivers, and judges.
3. Use deterministic judges for CI-friendly coverage. External model judges are optional and should fail as configuration gaps, not as required local credentials.
4. Run:

   ```bash
   npm run check
   node dist/src/cli.js benchmark --scenario-dir tests/fixtures/benchmarks
   ```

5. Treat safety failures as blockers. Model score improvements are lower priority than deterministic safety.

Benchmark scenarios should cover at least:

- working, idle, blocked, and done Herdr states
- review and deploy loops
- Beads ready work, blocked work, claims, updates, closes, and remote DB failures
- MCP status, question, feedback, and remote session flows
- multi-user access decisions
- context thresholds, smart compaction, and redaction

## Human Approval Workflow

Ciclo approval should be narrow and auditable.

Before approving any mutating action, verify:

- principal identity and grants in multi-user mode
- loop ID and Beads ID
- command class and exact command
- repository path and branch
- Herdr state
- remote session ID when applicable
- idempotency key
- redaction for any outbound tracker or memory write

Approve the smallest action that unblocks the loop. Do not grant broad command classes when a single command is enough.

Local project hooks also block high-risk commands unless an explicit environment opt-in is set for that one command:

```bash
CICLO_ALLOW_GIT_COMMIT=1 git commit -m "..."
CICLO_ALLOW_GIT_PUSH=1 git push
CICLO_ALLOW_BEADS_REMOTE_SYNC=1 bd dolt push
```

These opt-ins are not blanket policy changes. They apply only to the command where they are set.

## Remote Session Workflow

Remote supervision uses Herdr remote attach over SSH. Ciclo should invoke Herdr remote attach and consume Herdr observations; it should not build raw SSH polling loops.

A remote session must register:

- Ciclo session ID
- remote Herdr target and optional named session
- harness ID
- repository path
- Beads issue ID
- principal identity and grants in multi-user mode

Healthy remote operation:

1. Register the remote session.
2. Confirm Herdr remote attach succeeds.
3. Confirm Beads remote DB health when distributed coordination is required.
4. Pull/re-read before claim and push after accepted claim/update/close when using Dolt remote sync.
5. Heartbeat the session through Herdr.
6. Preserve Beads ownership if the session becomes stale or lost until an operator resolves it.

Recovery rules:

- A lost remote session does not release claimed Beads work automatically.
- Duplicate remote claims are denied while an active owner exists.
- Remote attach failures should become operator feedback with redacted host/path evidence.
- Remote project mismatch, missing Herdr binary, or unsupported platform blocks dispatch.

## Remote Runner Workflow

Use remote runners when Ciclo needs to create a runnable environment instead of attaching to an existing SSH machine. The current interface is plan-first: Ciclo records a provider launch plan and returns the exact artifacts, commands, WireGuard tunnel config, Herdr target, and attach command. Provider execution should remain behind policy and credentials. Provider-specific behavior is implemented as remote runner plugins so new environments can be added without branching Ciclo's core remote execution model.

Supported runner kinds:

- `kubernetes`: produces a Job manifest and `kubectl` apply commands. This is the preferred durable interactive runner because it can keep a Herdr session alive.
- `aws-lambda`: targets AWS Lambda MicroVMs. The plugin emits `aws lambda-microvms` image creation and lifecycle commands such as `run-microvm`, `suspend-microvm`, `resume-microvm`, and `terminate-microvm`, plus bootstrap notes for Herdr and userspace WireGuard.
- `cloudflare`: produces Wrangler configuration and connector notes. Use a Cloudflare container or userspace connector for Herdr plus WireGuard, not a plain Worker alone.

WireGuard runner setup:

1. Ciclo owns the hub-side endpoint and public key.
2. The runner receives only secret references for its private key and Ciclo's public key.
3. The runner brings up `wg-ciclo`, then Herdr starts a named session derived from the repository name, for example `ciclo` in this repo.
4. Ciclo attaches through the tunnel using a Herdr remote target such as `ciclo@10.44.0.2:/workspace/ciclo`.

Operator attach commands:

```bash
ciclo attach --session ciclo
ciclo attach --remote ciclo@10.44.0.2:/workspace/ciclo --session ciclo
ciclo attach --remote ciclo@10.44.0.2:/workspace/ciclo --session ciclo --target pane-1
```

Use `ciclo attach --dry-run --compact` to inspect the command without entering Herdr.

## Multi-User Workflow

Single-user mode maps local actions to the owner and does not require login.

Multi-user mode requires identity and scoped grants for mutating actions. Device-flow login is appropriate for CLI, MCP HTTP, and remote workers.

Operators should grant the minimum capability set:

- `work:read` for status and ready work
- `work:claim` for claiming Beads work
- `work:update` for progress notes and blocker records
- `work:close` for closure after validation
- `question:answer` for answering routed harness questions
- `tracker:sync` for Beads-native remote tracker sync
- `remote:register` for remote Herdr sessions

Denied access should be routed to an owner/operator with evidence, not silently retried.

Never log token material, device codes, refresh tokens, private keys, raw Authorization headers, or unredacted remote host/path details.

## Failure Recovery

Use Beads for recovery state so another agent can resume.

Common failures:

- Herdr unavailable: record a blocker or operator feedback, then wait for Herdr to recover.
- Agent blocked: route the question through MCP and answer it against the correct loop, Beads task, harness, and remote session.
- Remote DB unavailable and required: fail closed; do not claim or update from stale local state.
- Remote DB conflict: preserve the existing claim and ask the operator to resolve the conflict.
- Optional tracker sync failure: record retry state and continue Beads progress.
- Required tracker sync failure: block the sync batch and surface operator feedback.
- Context force-compact threshold reached: smart-compact durable task memory to Beads before dispatching more work.
- Validation failure: keep the task open, record the failing command and evidence, and create follow-up work if the fix is out of scope.

Recovery handoff should include:

- current Beads issue ID and status
- latest Herdr state and evidence
- remote session state, if any
- policy decision and denied/allowed action
- validation command output summary
- changed files
- blockers and follow-up Beads IDs

## Closing Work

Close a Beads task only when:

- acceptance criteria are met
- validation evidence is recorded
- blockers are resolved or explicitly moved to follow-up Beads tasks
- smart compaction has persisted durable work memory when the task is complete, blocked, or handed off
- remote tracker sync has been triggered or explicitly skipped according to policy and configuration

Use a closure reason that names the behavior delivered and the validation run:

```bash
bd close <id> --reason="Implemented <behavior>. Validation passed: npm run check, just check, and benchmark smoke."
```
