# Ciclo

Ciclo is a spec-driven agent supervisor: a thin Pimono wrapper around Herdr that watches coding agents, detects when they are working, idle, blocked, or done, and keeps project loops moving without taking unsafe actions by default.

The initial product target is an agentic babysitter for Claude Code and Codex. A user defines project loops, such as review, deploy, triage, benchmark, or Beads-backed work loops. Ciclo observes Herdr agent state, repository state, Beads work state, remote sessions, and harness-specific events, then decides whether to wait, claim ready work, nudge an agent, ask for human input, route a question, update a task, sync external trackers, or update the loop goal.

The first specification is [SPEC-CICLO-001: Agentic Babysitter Harness](/Users/ztaylor/repos/workspaces/ciclo/docs/specs/SPEC-CICLO-001-agentic-babysitter.md).

## Development Model

- Specs define behavior before implementation.
- Beads tracks epics, tasks, decisions, and benchmark work.
- Every implementation task should link back to a spec ID.
- Harness support is plugin-based; Claude Code and Codex are the first plugins.
- Beads is the durable work queue; Ciclo can use local Beads or a configured Beads remote database so agents centralize ready work, claims, progress, and closures through Beads.
- Jira and Linear are optional outbound sync targets when configured.
- Ciclo exposes an MCP control plane for Claude, Codex, and generic harnesses to query status, coordinate work, ask/answer questions, and report feedback to the operator session.
- Remote sessions use Herdr remote attach over SSH (`herdr --remote ...`) with explicit registration, heartbeat, scoped access, and stale/lost detection.
- Ciclo supports `single` mode without auth friction and `multiuser` mode with OAuth device-code login, scoped grants, and per-user authorization for work and commands.
- Benchmarks score Ciclo responses across simulated scenarios and multiple judge or driver models.
