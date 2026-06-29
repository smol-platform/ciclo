# Ciclo Agent Guide

This file is the working brief for Claude, Codex, and generic agents implementing Ciclo. The durable source of task state is Beads; start with `bd ready`, inspect with `bd show <id>`, and keep implementation work tied to `SPEC-CICLO-001`.

## Product Goal

Ciclo is a Pimono wrapper around Herdr that acts as an agentic babysitter. It watches Claude Code, Codex, and future harnesses through Herdr, coordinates project loops, pulls work from Beads, routes questions and feedback through MCP, supports remote Herdr sessions, and enforces policy before accepting risky work or commands.

Primary spec: `docs/specs/SPEC-CICLO-001-agentic-babysitter.md`.

## Agent Workflow

1. Run `bd ready` and choose a concrete task, not a container epic.
2. Run `bd show <id>` and read linked spec sections before editing.
3. Claim the bead before implementation when actively working it.
4. Keep changes scoped to the selected bead and its dependencies.
5. Add or update tests/fixtures with every behavior change.
6. Update Beads with blockers, discovered follow-up tasks, or completion evidence.
7. Do not close a bead unless acceptance criteria are met and validation is recorded.

## Architecture Map

```text
Herdr observations -> normalized events -> loop state -> policy -> response planner
                             |                 |             |
                             v                 v             v
                       harness plugins   Beads work DB   MCP/API/audit
                             |                 |             |
                             v                 v             v
                       Claude/Codex     remote DB sync   operator feedback
```

## Epic Implementation Details

### `ciclo-ns5.1` Spec-Driven Product Foundation

Choose the implementation runtime and package shape before building features. The first runtime should make CLI execution, MCP server support, JSON/YAML schema validation, subprocess management, and test fixtures straightforward. Deliver typed schemas for loop config, normalized events, responses, policy decisions, Beads work snapshots, remote session state, and auth grants.

Implementation should include:

- Package entrypoints for CLI, daemon/supervisor, MCP stdio server, benchmark runner, and test utilities.
- JSON Schema or equivalent typed validators for config and fixtures.
- Fixture-first test layout for Herdr output, Beads output, planner input, and benchmark scenarios.
- A spec traceability convention: each feature/task should reference `SPEC-CICLO-001` and a Beads ID in code comments only where useful, docs, or fixtures.

### `ciclo-ns5.2` Herdr Observation Adapter

Treat Herdr as the authoritative sensor for local and remote agent state. Start with CLI polling because it is scriptable and fixture-friendly; keep the adapter boundary stable enough to add Herdr socket support later.

Implementation should include:

- A Herdr client interface with `listTargets`, `readState`, `explain`, `start`, and attach metadata methods.
- CLI command runner with timeouts, structured errors, and redaction.
- Parsers for `--json` output where available and fixture-backed fallbacks for explain output.
- State normalization into `working`, `blocked`, `done`, `idle`, and `unknown`.
- Fixtures for Claude Code, Codex, unsupported agents, missing Herdr, malformed output, and state transitions.

### `ciclo-ns5.3` Harness Plugin System for Claude Code and Codex

Keep harness-specific detection, prompts, transcript classification, and permission behavior outside the loop engine. Plugins should translate generic Ciclo actions into bounded harness instructions and never bypass policy.

Implementation should include:

- Plugin registry with deterministic detection and match confidence.
- Unknown-harness fallback that can observe and escalate but cannot perform harness-specific actions.
- Claude Code plugin prompt builders for review, implementation, test, deploy-gate, and summary actions.
- Codex plugin prompt builders that include spec ID, Beads ID, acceptance criteria, validation request, and blocker reporting.
- Prompt idempotency keys so duplicate Herdr events do not resend the same instruction.

### `ciclo-ns5.4` Loop State and Response Planner

The planner is the core product. It combines Herdr state, Beads state, repository state, loop config, policy, remote session state, and prior audit events into one explainable response.

Implementation should include:

- Loop lifecycle states: `created`, `observing`, `active`, `blocked`, `ready_for_review`, `complete`, `paused`, and `failed`.
- Config loader with defaults and actionable validation errors.
- Repository probe for Git status, staged/dirty files, upstream, Beads presence, configured checks, and safe metadata.
- Dry-run planner that emits exactly one primary response per significant event.
- Goal evolution records with previous goal, new goal, reason, and evidence.
- No execution path that bypasses policy decisions.

### `ciclo-ns5.5` Benchmark Scenario and Scoring System

Benchmark Ciclo's response quality, not just agent output. Scenarios should be deterministic first, then optionally judged by model evaluators.

Implementation should include:

- Scenario fixture format containing repo snapshot, Herdr events, Beads state, MCP calls, remote sessions, auth grants, loop config, policy, expected traits, and disallowed traits.
- Deterministic checks that fail before model judging for safety violations.
- Driver interfaces for simulated agents, users, repo changes, and adversarial input.
- Judge interfaces with a fake/local implementation so CI does not require external model credentials.
- Reports with scenario ID, planner version, deterministic failures, scores, and recommended action.

### `ciclo-ns5.6` Safety Policy Audit and Operator Workflow

Policy is the boundary between useful supervision and unsafe automation. Every response should carry evidence, policy outcome, and audit context.

Implementation should include:

- Default-deny policy for prompt sending, test execution, deploys, destructive commands, remote session registration, and auto-closing work.
- Policy checks for idempotency, command class, credentials, external side effects, session mode, principal grants, and remote scope.
- Audit log for observations, decisions, policy outcomes, actions, denials, and execution results.
- Operator docs for review, deploy, benchmark, remote, multi-user, and recovery workflows.

### `ciclo-ns5.7` Beads Work Queue and Remote Tracker Sync

Beads is the durable work queue and coordination source. Ciclo must support local Beads, a shared Beads/Dolt SQL server, and Dolt remote pull/push coordination. Jira and Linear are outbound sync targets, not the work source for MVP.

Implementation should include:

- Beads adapter using `bd` CLI JSON output and Beads/Dolt commands, never `.beads/issues.jsonl` as source of truth.
- Remote DB mode detection: `local`, `shared_dolt_server`, and `dolt_remote_sync`.
- Health checks for shared Dolt server and Dolt remote sync.
- Pull-before-select and re-read-before-claim when distributed sync is configured.
- Push-after-claim/update/close when configured.
- Conflict/degraded health handling that blocks dispatch when centralized coordination is required.
- Standard Ciclo metadata on claims: session ID, principal, harness, loop ID, and remote Herdr session.
- Redacted outbound sync to Jira/Linear when configured.

### `ciclo-ns5.8` MCP Control Plane and Remote Sessions

MCP is the coordination interface for Claude, Codex, and generic harnesses. Remote execution and observation use Herdr remote attach over SSH, not a hand-rolled SSH command wrapper.

Implementation should include:

- MCP stdio server for local clients.
- Optional authenticated Streamable HTTP for remote MCP clients.
- Tools/resources/prompts for status, loop detail, ready work, claims, updates, questions, feedback, auth, and remote sessions.
- Question routing from harness to operator and answer routing back to the correct loop/work/session.
- Herdr remote attach adapter using `herdr --remote <target>` and optional `--session <name>`.
- Remote heartbeat, stale/lost detection, handoff summaries, and duplicate Beads claim prevention.
- Remote attach setup blockers for missing remote Herdr binary, unsupported platform, project mismatch, or attach failure.

### `ciclo-ns5.9` Multi-User Ciclo Sessions and Access Control

Single-user mode should stay frictionless. Multi-user mode must require identity and scoped grants before Ciclo accepts mutating work or command requests.

Implementation should include:

- Session modes: `single` and `multiuser`.
- OAuth 2.0 Device Authorization Grant flow for CLI, MCP HTTP, and remote workers.
- Token refresh, revoke, introspection, and current-principal APIs.
- Roles: `owner`, `operator`, `maintainer`, `contributor`, `viewer`, and `agent_service`.
- Grants scoped by session, repo, loop, Beads issue/label selector, harness, remote Herdr target, command allowlist, and time window.
- Enforcement for work claim/update/close, command approval, question answer, remote registration, and admin actions.
- Audit records for accepted, denied, delegated, and revoked actions without logging token material.

## Validation Expectations

Early tasks should rely on fixture tests. Once a runnable package exists, every behavioral change should include the narrowest relevant command in the Beads completion note, such as unit tests, fixture tests, benchmark scenarios, or schema validation.

## Commit Guidance

Use small commits tied to Beads tasks. Do not rewrite Beads history or Git history unless explicitly asked. When committing implementation work, include the Beads ID in the commit body when there is a concrete task ID.

