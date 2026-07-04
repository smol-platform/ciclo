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
  OpenAiBrainStatus
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

  constructor(private readonly result: WorkerCommandRunResult = { status: 0, stdout: "", stderr: "" }) {}

  run(command: string, args: readonly string[], options: { cwd?: string } = {}): WorkerCommandRunResult {
    this.runs.push({ command, args, cwd: options.cwd });
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
      evidence: ["brain.provider:openai", `brain.purpose:${input.purpose}`]
    };
  }
}

test("internal heartbeat marks stalled workers and asks OpenAI brain for follow-up", async () => {
  let now = "2026-07-02T00:00:00.000Z";
  const events = new CicloEventStore(() => now);
  const root = mkdtempSync(join(tmpdir(), "ciclo-heartbeat-stall-"));
  const commandRunner = new FakeCommandRunner();
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
  const poll = events.poll(0);
  assert.ok(poll.events.some((event) => event.type === "heartbeat.tick"));
  assert.ok(poll.events.some((event) => event.type === "heartbeat.monologue"));
  assert.ok(poll.events.some((event) => event.type === "brain.decision"));
  assert.ok(poll.events.some((event) => event.type === "worker.nudged" && event.data?.delivered === true));
  assert.ok(poll.events.some((event) => event.type === "memory.recorded" && event.data?.kind === "decision"));
  assert.equal(commandRunner.runs.at(-1)?.command, "herdr");
  assert.ok(commandRunner.runs.at(-1)?.args.includes("send"));
  rmSync(root, { recursive: true, force: true });
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
  assert.match(brain.inputs[0]?.prompt ?? "", /ready Beads epic or feature/u);
  const poll = events.poll(0);
  assert.ok(poll.events.some((event) => event.type === "work.ready_listed" && event.beadId === "ciclo-feature"));
  assert.ok(poll.events.some((event) => event.type === "bead.claimed" && event.beadId === "ciclo-feature"));
  assert.ok(poll.events.some((event) => event.type === "work.started" && event.beadId === "ciclo-feature"));
  assert.ok(poll.events.some((event) => event.type === "worker.state_change" && event.beadId === "ciclo-feature"));
  assert.ok(poll.events.some((event) => event.type === "heartbeat.tick" && event.data?.idle_workers_launched === 1));
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
