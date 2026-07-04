import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CicloEventStore } from "../src/ciclo-events.js";
import { CicloMemoryStore } from "../src/ciclo-memory.js";
import type { BeadsTaskSnapshot } from "../src/beads-adapter.js";
import type { BeadsWorkClaimClient } from "../src/beads-work-queue.js";
import { CicloInternalHeartbeat } from "../src/internal-heartbeat.js";
import type {
  OpenAiBrain,
  OpenAiBrainDecision,
  OpenAiBrainDecisionInput,
  OpenAiBrainToolResult,
  OpenAiBrainStatus,
  OpenAiControlAction
} from "../src/openai-brain.js";
import { openAiBrainIntelligence, openAiBrainModelFamily, openAiBrainPolicy } from "../src/openai-brain.js";
import {
  WorkerSessionSupervisor,
  type WorkerCommandRunResult,
  type WorkerCommandRunner,
  type WorkerProcessHandle,
  type WorkerProcessLauncher
} from "../src/worker-session-supervisor.js";

class FakeHandle implements WorkerProcessHandle {
  readonly pid = 777;
  onExit(): void {}
  stop(): boolean {
    return true;
  }
}

class FakeLauncher implements WorkerProcessLauncher {
  launch(): WorkerProcessHandle {
    return new FakeHandle();
  }
}

class FakeCommandRunner implements WorkerCommandRunner {
  readonly runs: { command: string; args: readonly string[]; cwd?: string }[] = [];
  private index = 0;

  constructor(private readonly result: WorkerCommandRunResult | WorkerCommandRunResult[] = { status: 0, stdout: "", stderr: "" }) {}

  run(command: string, args: readonly string[], options: { cwd?: string } = {}): WorkerCommandRunResult {
    this.runs.push({ command, args, cwd: options.cwd });
    if (Array.isArray(this.result)) {
      return this.result[Math.min(this.index++, this.result.length - 1)]!;
    }
    return this.result;
  }
}

class FakeBeadsClient implements BeadsWorkClaimClient {
  readonly claims: string[] = [];
  readonly notes: Array<{ id: string; message: string }> = [];

  constructor(private readonly tasks: readonly BeadsTaskSnapshot[]) {}

  async ready(): Promise<readonly BeadsTaskSnapshot[]> {
    return this.tasks.filter((task) => task.status === "open");
  }

  async show(id: string): Promise<BeadsTaskSnapshot> {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (task === undefined) throw new Error(`missing task ${id}`);
    return task;
  }

  async claim(id: string): Promise<BeadsTaskSnapshot> {
    const task = await this.show(id);
    this.claims.push(id);
    return { ...task, status: "in_progress" };
  }

  async note(id: string, message: string): Promise<void> {
    this.notes.push({ id, message });
  }
}

class FakeBrain implements OpenAiBrain {
  readonly inputs: OpenAiBrainDecisionInput[] = [];

  constructor(
    private readonly action?: OpenAiControlAction,
    private readonly toolResults: readonly OpenAiBrainToolResult[] = []
  ) {}

  status(): OpenAiBrainStatus {
    return openAiBrainPolicy;
  }

  async decide(input: OpenAiBrainDecisionInput): Promise<OpenAiBrainDecision> {
    this.inputs.push(input);
    return {
      provider: "openai",
      adapter: "pi-sdk",
      intelligence: openAiBrainIntelligence,
      modelFamily: openAiBrainModelFamily,
      model: openAiBrainPolicy.model,
      thinking: openAiBrainPolicy.thinking,
      purpose: input.purpose,
      text: "Add context and ask the operator if the worker remains silent.",
      ...(this.action === undefined ? {} : { action: this.action }),
      ...(this.toolResults.length === 0 ? {} : { toolResults: this.toolResults }),
      evidence: ["brain.provider:openai", `brain.purpose:${input.purpose}`]
    };
  }
}

class ToolUsingFakeBrain implements OpenAiBrain {
  readonly inputs: OpenAiBrainDecisionInput[] = [];

  status(): OpenAiBrainStatus {
    return openAiBrainPolicy;
  }

  async decide(input: OpenAiBrainDecisionInput): Promise<OpenAiBrainDecision> {
    this.inputs.push(input);
    const result = await input.toolExecutor?.execute({
      name: "ciclo_observe_worker",
      params: {
        worker_session_id: input.workerSessionId,
        lines: 20
      }
    });
    return {
      provider: "openai",
      adapter: "pi-sdk",
      intelligence: openAiBrainIntelligence,
      modelFamily: openAiBrainModelFamily,
      model: openAiBrainPolicy.model,
      thinking: openAiBrainPolicy.thinking,
      purpose: input.purpose,
      text: "Observed the worker through a Ciclo tool; wait for the next heartbeat.",
      ...(result === undefined ? {} : { toolResults: [result] }),
      evidence: ["brain.provider:openai", `brain.purpose:${input.purpose}`]
    };
  }
}

test("internal heartbeat marks stalled workers and asks OpenAI brain for follow-up", async () => {
  let now = "2026-07-02T00:00:00.000Z";
  const events = new CicloEventStore(() => now);
  const root = mkdtempSync(join(tmpdir(), "ciclo-heartbeat-stall-"));
  const commandRunner = new FakeCommandRunner([
    {
      status: 0,
      stdout: JSON.stringify({ result: { agent: { pane_id: "wA:p2", agent_status: "idle" } } }),
      stderr: ""
    },
    {
      status: 0,
      stdout: "• Worker transcript\n\n›\n",
      stderr: ""
    },
    {
      status: 0,
      stdout: JSON.stringify({ result: { agent: { pane_id: "wA:p2", agent_status: "idle" } } }),
      stderr: ""
    },
    {
      status: 0,
      stdout: "• Worker transcript\n\nthinking about next step\n",
      stderr: ""
    },
    {
      status: 0,
      stdout: JSON.stringify({ result: { agent: { pane_id: "wA:p2", agent_status: "idle" } } }),
      stderr: ""
    },
    { status: 0, stdout: "", stderr: "" }
  ]);
  const memory = new CicloMemoryStore({ projectRoot: root, now: () => now, eventSink: events });
  const supervisor = new WorkerSessionSupervisor("/repo", new FakeLauncher(), { now: () => now }, events, undefined, commandRunner);
  const brain = new FakeBrain();
  const beforeHerdr = process.env.HERDR_SESSION_NAME;
  process.env.HERDR_SESSION_NAME = "review-session";
  try {
    supervisor.launch({
      harnessId: "claude-code",
      loopId: "review-loop",
      beadId: "ciclo-1",
      prompt: "Work through Ciclo."
    });
  } finally {
    if (beforeHerdr === undefined) delete process.env.HERDR_SESSION_NAME;
    else process.env.HERDR_SESSION_NAME = beforeHerdr;
  }

  now = "2026-07-02T00:11:00.000Z";
  const heartbeat = new CicloInternalHeartbeat(
    {
      workerSupervisor: supervisor,
      openAiBrain: brain,
      eventStore: events,
      memoryStore: memory,
      claudeChannel: { enabled: true }
    },
    {
      workerStaleAfterMs: 10 * 60 * 1000,
      now: () => now
    }
  );

  const result = await heartbeat.tick();
  const status = heartbeat.status();
  assert.equal(result.firstWake, true);
  assert.equal(result.workersStalled.length, 1);
  assert.equal(result.workerChecked, 1);
  assert.deepEqual(result.workerRecoveryActions, [`nudged:${result.workersStalled[0]?.sessionId}`]);
  assert.equal(result.brainDecisions.length, 1);
  assert.equal(result.claudeChannel.enabled, true);
  assert.equal(result.claudeChannel.communicationReady, true);
  assert.equal(result.claudeChannel.connectedWorkers, 1);
  assert.equal(result.monologue.length, 4);
  assert.equal(status.lastTickAt, "2026-07-02T00:11:00.000Z");
  assert.ok(status.monologue.some((entry) => entry.evidence.includes("heartbeat.first_wake:true")));
  assert.ok(status.monologue.some((entry) => entry.evidence.includes("startup.first_work.selection:required")));
  assert.match(status.monologue.at(-1)?.message ?? "", /Claude channel communication is enabled/u);
  assert.ok(status.monologue.some((entry) => entry.message.includes("PR review needs")));
  assert.equal(brain.inputs[0]?.purpose, "remote_session_monitoring");
  assert.equal(brain.inputs[0]?.beadId, "ciclo-1");
    assert.match(brain.inputs[0]?.prompt ?? "", /project memory/u);
    assert.match(brain.inputs[0]?.prompt ?? "", /escalated to a stronger model/u);
    assert.ok((brain.inputs[0]?.context ?? []).includes("model=unspecified"));
    assert.ok((brain.inputs[0]?.context ?? []).includes("pane_id=wA:p2"));
    assert.ok((brain.inputs[0]?.context ?? []).includes("agent_status=idle"));
    assert.ok((brain.inputs[0]?.context ?? []).some((item) => item.includes("transcript_recent=• Worker transcript")));
    const poll = events.poll(0);
    assert.ok(poll.events.some((event) => event.type === "heartbeat.tick"));
    assert.ok(poll.events.some((event) => event.type === "heartbeat.monologue"));
    assert.ok(poll.events.some((event) => event.type === "brain.decision"));
    assert.ok(poll.events.some((event) => event.type === "brain.action" && event.data?.kind === "nudge"));
  assert.ok(poll.events.some((event) => event.type === "worker.nudged" && event.data?.delivered === true));
  assert.ok(poll.events.some((event) => event.type === "memory.recorded" && event.data?.kind === "decision"));
  assert.equal(commandRunner.runs.at(-1)?.command, "herdr");
  assert.ok(commandRunner.runs.at(-1)?.args.includes("run"));
  assert.ok(commandRunner.runs.at(-1)?.args.includes("wA:p2"));
  rmSync(root, { recursive: true, force: true });
});

test("internal heartbeat executes structured brain ask-operator actions", async () => {
  let now = "2026-07-02T00:30:00.000Z";
  const events = new CicloEventStore(() => now);
  const commandRunner = new FakeCommandRunner([
    {
      status: 0,
      stdout: JSON.stringify({ result: { agent: { pane_id: "wB:p3", agent_status: "idle" } } }),
      stderr: ""
    },
    {
      status: 0,
      stdout: "Need a deploy approval before continuing.\n",
      stderr: ""
    },
    {
      status: 0,
      stdout: JSON.stringify({ result: { agent: { pane_id: "wB:p3", agent_status: "idle" } } }),
      stderr: ""
    },
    {
      status: 0,
      stdout: "Need a deploy approval before continuing.\n",
      stderr: ""
    }
  ]);
  const supervisor = new WorkerSessionSupervisor("/repo", new FakeLauncher(), { now: () => now }, events, undefined, commandRunner);
  const brain = new FakeBrain({
    kind: "ask_operator",
    reason: "deploy approval is required",
    message: "Should the worker proceed with the deploy validation?"
  });
  const beforeHerdr = process.env.HERDR_SESSION_NAME;
  process.env.HERDR_SESSION_NAME = "deploy-session";
  try {
    supervisor.launch({
      harnessId: "claude-code",
      loopId: "deploy-loop",
      beadId: "ciclo-deploy",
      prompt: "Validate deploy."
    });
  } finally {
    if (beforeHerdr === undefined) delete process.env.HERDR_SESSION_NAME;
    else process.env.HERDR_SESSION_NAME = beforeHerdr;
  }

  now = "2026-07-02T00:41:00.000Z";
  const heartbeat = new CicloInternalHeartbeat(
    {
      workerSupervisor: supervisor,
      openAiBrain: brain,
      eventStore: events
    },
    {
      workerStaleAfterMs: 10 * 60 * 1000,
      now: () => now
    }
  );

  const result = await heartbeat.tick();
  const sessionId = result.workersStalled[0]?.sessionId;

  assert.equal(result.workersStalled.length, 1);
  assert.deepEqual(result.workerRecoveryActions, [`asked_operator:${sessionId}`]);
  assert.equal(sessionId === undefined ? undefined : supervisor.get(sessionId)?.state, "waiting_on_operator");
  assert.ok((brain.inputs[0]?.context ?? []).some((item) => item.includes("deploy approval")));
  const poll = events.poll(0);
  assert.ok(poll.events.some((event) => event.type === "brain.action" && event.data?.kind === "ask_operator"));
  assert.ok(poll.events.some((event) => event.type === "question.asked" && event.data?.question === "Should the worker proceed with the deploy validation?"));
  assert.equal(commandRunner.runs.length, 4);
});

test("internal heartbeat lets the brain call Ciclo tools and verifies results without duplicate fallback action", async () => {
  let now = "2026-07-02T00:50:00.000Z";
  const events = new CicloEventStore(() => now);
  const commandRunner = new FakeCommandRunner([
    {
      status: 0,
      stdout: JSON.stringify({ result: { agent: { pane_id: "wC:p4", agent_status: "idle" } } }),
      stderr: ""
    },
    {
      status: 0,
      stdout: "Worker has not printed a prompt yet.\n",
      stderr: ""
    },
    {
      status: 0,
      stdout: JSON.stringify({ result: { agent: { pane_id: "wC:p4", agent_status: "idle" } } }),
      stderr: ""
    },
    {
      status: 0,
      stdout: "Worker has not printed a prompt yet.\n",
      stderr: ""
    },
    {
      status: 0,
      stdout: JSON.stringify({ result: { agent: { pane_id: "wC:p4", agent_status: "idle" } } }),
      stderr: ""
    },
    {
      status: 0,
      stdout: "Worker observed by brain tool.\n",
      stderr: ""
    }
  ]);
  const supervisor = new WorkerSessionSupervisor("/repo", new FakeLauncher(), { now: () => now }, events, undefined, commandRunner);
  const brain = new ToolUsingFakeBrain();
  const beforeHerdr = process.env.HERDR_SESSION_NAME;
  process.env.HERDR_SESSION_NAME = "tool-session";
  try {
    supervisor.launch({
      harnessId: "claude-code",
      loopId: "tool-loop",
      beadId: "ciclo-tool",
      prompt: "Wait for Ciclo."
    });
  } finally {
    if (beforeHerdr === undefined) delete process.env.HERDR_SESSION_NAME;
    else process.env.HERDR_SESSION_NAME = beforeHerdr;
  }

  now = "2026-07-02T01:01:00.000Z";
  const heartbeat = new CicloInternalHeartbeat(
    {
      workerSupervisor: supervisor,
      openAiBrain: brain,
      eventStore: events
    },
    {
      workerStaleAfterMs: 10 * 60 * 1000,
      now: () => now
    }
  );

  const result = await heartbeat.tick();
  const sessionId = result.workersStalled[0]?.sessionId;

  assert.equal(result.workersStalled.length, 1);
  assert.deepEqual(result.workerRecoveryActions, [`verified_tools:${sessionId}`]);
  const poll = events.poll(0);
  assert.ok(poll.events.some((event) => event.type === "brain.tool_call" && event.data?.tool === "ciclo_observe_worker"));
  assert.ok(poll.events.some((event) => event.type === "brain.verification" && event.data?.results instanceof Array));
  assert.equal(poll.events.some((event) => event.type === "worker.nudged"), false);
});

test("internal heartbeat claims ready epic or feature work and launches an isolated worker when idle", async () => {
  const now = "2026-07-02T01:00:00.000Z";
  const events = new CicloEventStore(() => now);
  const supervisor = new WorkerSessionSupervisor("/repo", new FakeLauncher(), { now: () => now }, events);
  const brain = new FakeBrain();
  const beads = new FakeBeadsClient([
    {
      id: "ciclo-task",
      title: "Small task should not be preemptively selected",
      status: "open",
      priority: 1,
      issueType: "task",
      description: "",
      acceptanceCriteria: "",
      labels: [],
      dependencies: [],
      externalRefs: []
    },
    {
      id: "ciclo-feature",
      title: "Build the next orchestration feature",
      status: "open",
      priority: 2,
      issueType: "feature",
      description: "Add a useful project orchestration feature.",
      acceptanceCriteria: "Worker starts from the heartbeat and records trace events.",
      labels: ["orchestration"],
      dependencies: [],
      externalRefs: []
    }
  ]);
  const heartbeat = new CicloInternalHeartbeat(
    {
      auth: {
        session: {
          id: "mcp-session",
          projectRoot: "/repo",
          ownerPrincipalId: "user-1"
        }
      },
      projectConfig: {
        heartbeat: {
          preemptiveWork: {
            enabled: true,
            harnessId: "codex",
            loopId: "finish-ready-work",
            issueTypes: ["epic", "feature"],
            maxConcurrent: 1,
            dryRun: true,
            isolation: "worktree",
            configureMcp: true
          }
        }
      },
      workerSupervisor: supervisor,
      beadsClient: beads,
      openAiBrain: brain,
      eventStore: events
    },
    { now: () => now }
  );

  const result = await heartbeat.tick();

  assert.equal(result.readyWorkChecked, 2);
  assert.equal(result.idleWorkersLaunched.length, 1);
  assert.equal(result.idleWorkersLaunched[0]?.beadId, "ciclo-feature");
  assert.equal(result.idleWorkersLaunched[0]?.loopId, "finish-ready-work");
  assert.equal(result.idleWorkersLaunched[0]?.state, "planned");
  assert.deepEqual(beads.claims, ["ciclo-feature"]);
  assert.equal(beads.notes.length, 1);
  assert.equal(result.brainDecisions.length, 1);
    assert.match(brain.inputs[0]?.prompt ?? "", /ready Beads planning work/u);
  const poll = events.poll(0);
  assert.ok(poll.events.some((event) => event.type === "work.ready_listed" && event.beadId === "ciclo-feature"));
  assert.ok(poll.events.some((event) => event.type === "bead.claimed" && event.beadId === "ciclo-feature"));
  assert.ok(poll.events.some((event) => event.type === "work.started" && event.beadId === "ciclo-feature"));
  assert.ok(poll.events.some((event) => event.type === "worker.state_change" && event.beadId === "ciclo-feature"));
  assert.ok(poll.events.some((event) => event.type === "heartbeat.tick" && event.data?.idle_workers_launched === 1));
});

test("internal heartbeat falls back to concrete ready Beads work after planning work is exhausted", async () => {
  const now = "2026-07-02T01:15:00.000Z";
  const events = new CicloEventStore(() => now);
  const supervisor = new WorkerSessionSupervisor("/repo", new FakeLauncher(), { now: () => now }, events);
  const brain = new FakeBrain();
  const beads = new FakeBeadsClient([
    {
      id: "ciclo-task",
      title: "Fix the concrete automation bug",
      status: "open",
      priority: 1,
      issueType: "bug",
      description: "Automation should continue when only bug work is ready.",
      acceptanceCriteria: "Heartbeat launches a worker for concrete work.",
      labels: [],
      dependencies: [],
      externalRefs: []
    }
  ]);
  const heartbeat = new CicloInternalHeartbeat(
    {
      auth: {
        session: {
          id: "mcp-session",
          projectRoot: "/repo",
          ownerPrincipalId: "user-1"
        }
      },
      projectConfig: {
        heartbeat: {
          preemptiveWork: {
            enabled: true,
            harnessId: "codex",
            loopId: "finish-ready-work",
            issueTypes: ["epic", "feature"],
            fallbackIssueTypes: ["task", "bug", "decision"],
            maxConcurrent: 1,
            dryRun: true,
            isolation: "worktree",
            configureMcp: true
          }
        }
      },
      workerSupervisor: supervisor,
      beadsClient: beads,
      openAiBrain: brain,
      eventStore: events
    },
    { now: () => now }
  );

  const result = await heartbeat.tick();

  assert.equal(result.readyWorkChecked, 2);
  assert.equal(result.idleWorkersLaunched.length, 1);
  assert.equal(result.idleWorkersLaunched[0]?.beadId, "ciclo-task");
  assert.deepEqual(beads.claims, ["ciclo-task"]);
  assert.match(brain.inputs[0]?.prompt ?? "", /concrete ready Beads task, bug, or decision/u);
  assert.ok((brain.inputs[0]?.context ?? []).includes("selection_stage=fallback"));
  const poll = events.poll(0);
  assert.ok(poll.events.some((event) => event.type === "work.ready_listed" && event.data?.selection_stage === "primary" && event.data?.selected === null));
  assert.ok(poll.events.some((event) => event.type === "work.ready_listed" && event.data?.selection_stage === "fallback" && event.beadId === "ciclo-task"));
  assert.ok(poll.events.some((event) => event.type === "work.started" && event.data?.selection_stage === "fallback"));
});

test("internal heartbeat default preemptive pool can route ready work to Claude Fable", async () => {
  const now = "2026-07-02T01:30:00.000Z";
  const events = new CicloEventStore(() => now);
  const supervisor = new WorkerSessionSupervisor("/repo", new FakeLauncher(), { now: () => now }, events);
  const brain = new FakeBrain();
  const beads = new FakeBeadsClient([
    {
      id: "ciclo-feature",
      title: "Build a feature with the default harness pool",
      status: "open",
      priority: 1,
      issueType: "feature",
      description: "",
      acceptanceCriteria: "",
      labels: [],
      dependencies: [],
      externalRefs: []
    }
  ]);
  const heartbeat = new CicloInternalHeartbeat(
    {
      auth: {
        session: {
          id: "mcp-session",
          projectRoot: "/repo",
          ownerPrincipalId: "user-1"
        }
      },
      projectConfig: {
        heartbeat: {
          preemptiveWork: {
            dryRun: true
          }
        }
      },
      workerSupervisor: supervisor,
      beadsClient: beads,
      openAiBrain: brain,
      eventStore: events
    },
    { now: () => now }
  );

  const result = await heartbeat.tick();
  const launched = result.idleWorkersLaunched[0];

  assert.equal(launched?.harnessId, "claude-code");
  assert.equal(launched?.model, "claude-fable-5");
  assert.ok((brain.inputs[0]?.context ?? []).includes("harness_pool=codex,claude-code"));
  assert.ok((brain.inputs[0]?.context ?? []).includes("selected_harness=claude-code"));
  assert.deepEqual(beads.claims, ["ciclo-feature"]);
  assert.match(beads.notes[0]?.message ?? "", /harness=claude-code/u);
  assert.ok(events.poll(0).events.some((event) => event.type === "bead.claimed" && event.data?.harness_id === "claude-code"));
});

test("internal heartbeat does not launch preemptive work when worker capacity is full", async () => {
  const now = "2026-07-02T02:00:00.000Z";
  const events = new CicloEventStore(() => now);
  const supervisor = new WorkerSessionSupervisor("/repo", new FakeLauncher(), { now: () => now }, events);
  supervisor.launch({
    harnessId: "codex",
    loopId: "existing-work",
    beadId: "ciclo-existing",
    prompt: "Already working."
  });
  const beads = new FakeBeadsClient([
    {
      id: "ciclo-epic",
      title: "Ready epic",
      status: "open",
      priority: 1,
      issueType: "epic",
      description: "",
      acceptanceCriteria: "",
      labels: [],
      dependencies: [],
      externalRefs: []
    }
  ]);
  const heartbeat = new CicloInternalHeartbeat(
    {
      auth: {
        session: {
          id: "mcp-session",
          projectRoot: "/repo"
        }
      },
      projectConfig: {
        heartbeat: {
          preemptiveWork: {
            maxConcurrent: 1,
            dryRun: true
          }
        }
      },
      workerSupervisor: supervisor,
      beadsClient: beads,
      eventStore: events
    },
    { now: () => now }
  );

  const result = await heartbeat.tick();

  assert.equal(result.readyWorkChecked, 1);
  assert.equal(result.idleWorkersLaunched.length, 0);
  assert.deepEqual(beads.claims, []);
  assert.ok(result.evidence.includes("heartbeat.idle_workers.launched:0"));
  const readyEvent = events.poll(0).events.find((event) => event.type === "work.ready_listed");
  assert.equal(readyEvent?.data?.reason, "no eligible Beads work matched the selector");
});

test("internal heartbeat defaults preemptive worker capacity to ten sessions", async () => {
  const now = "2026-07-02T02:30:00.000Z";
  const events = new CicloEventStore(() => now);
  const supervisor = new WorkerSessionSupervisor("/repo", new FakeLauncher(), { now: () => now }, events);
  for (let index = 0; index < 10; index += 1) {
    supervisor.launch({
      harnessId: "codex",
      loopId: "existing-work",
      beadId: `ciclo-existing-${index}`,
      prompt: "Already working."
    });
  }
  const beads = new FakeBeadsClient([
    {
      id: "ciclo-default-cap",
      title: "Ready feature",
      status: "open",
      priority: 1,
      issueType: "feature",
      description: "",
      acceptanceCriteria: "",
      labels: [],
      dependencies: [],
      externalRefs: []
    }
  ]);
  const heartbeat = new CicloInternalHeartbeat(
    {
      auth: {
        session: {
          id: "mcp-session",
          projectRoot: "/repo"
        }
      },
      workerSupervisor: supervisor,
      beadsClient: beads,
      eventStore: events
    },
    { now: () => now }
  );

  const result = await heartbeat.tick();

  assert.equal(result.readyWorkChecked, 1);
  assert.equal(result.idleWorkersLaunched.length, 0);
  assert.deepEqual(beads.claims, []);
  const readyEvent = events.poll(0).events.find((event) => event.type === "work.ready_listed");
  assert.equal(readyEvent?.data?.active_workers, 10);
  assert.equal(readyEvent?.data?.max_concurrent, 10);
});

test("internal heartbeat releases capacity when a nudged stalled worker remains silent", async () => {
  let now = "2026-07-02T03:00:00.000Z";
  const root = mkdtempSync(join(tmpdir(), "ciclo-heartbeat-release-"));
  const events = new CicloEventStore(() => now);
  const supervisor = new WorkerSessionSupervisor(root, new FakeLauncher(), { now: () => now }, events);
  const brain = new FakeBrain();
  const memory = new CicloMemoryStore({ projectRoot: root, now: () => now, eventSink: events });
  const stalled = supervisor.launch({
    harnessId: "codex",
    loopId: "preemptive-beads",
    beadId: "ciclo-stalled",
    prompt: "Existing worker."
  });
  const beads = new FakeBeadsClient([
    {
      id: "ciclo-feature",
      title: "Ready feature after capacity is released",
      status: "open",
      priority: 1,
      issueType: "feature",
      description: "Launch once the old stalled worker no longer blocks capacity.",
      acceptanceCriteria: "A replacement worker starts.",
      labels: [],
      dependencies: [],
      externalRefs: []
    }
  ]);
  const heartbeat = new CicloInternalHeartbeat(
    {
      auth: {
        session: {
          id: "mcp-session",
          projectRoot: root
        }
      },
      projectConfig: {
        heartbeat: {
          preemptiveWork: {
            enabled: true,
            harnessId: "codex",
            loopId: "preemptive-beads",
            issueTypes: ["feature"],
            maxConcurrent: 1,
            dryRun: true,
            isolation: "worktree",
            configureMcp: true
          }
        }
      },
      workerSupervisor: supervisor,
      beadsClient: beads,
      openAiBrain: brain,
      eventStore: events,
      memoryStore: memory
    },
    {
      workerStaleAfterMs: 10 * 60 * 1000,
      workerRecoveryGraceMs: 10 * 60 * 1000,
      now: () => now
    }
  );

  now = "2026-07-02T03:11:00.000Z";
  const first = await heartbeat.tick();
  assert.equal(first.workersStalled.length, 1);
  assert.deepEqual(first.workerRecoveryActions, [`nudged:${stalled.sessionId}`]);
  assert.equal(first.idleWorkersLaunched.length, 0);
  assert.equal(supervisor.get(stalled.sessionId)?.state, "stalled");

  now = "2026-07-02T03:22:00.000Z";
  const second = await heartbeat.tick();
  assert.deepEqual(second.workerRecoveryActions, [`stopped:${stalled.sessionId}`]);
  assert.equal(supervisor.get(stalled.sessionId)?.state, "stopped");
  assert.equal(second.idleWorkersLaunched.length, 1);
  assert.equal(second.idleWorkersLaunched[0]?.beadId, "ciclo-feature");
  assert.deepEqual(beads.claims, ["ciclo-feature"]);

  const poll = events.poll(0);
  assert.ok(poll.events.some((event) => event.type === "worker.nudged" && event.workerSessionId === stalled.sessionId));
  assert.ok(poll.events.some((event) => event.type === "worker.capacity_released" && event.workerSessionId === stalled.sessionId));
  assert.ok(poll.events.some((event) => event.type === "memory.recorded" && event.data?.kind === "learning"));
  rmSync(root, { recursive: true, force: true });
});
