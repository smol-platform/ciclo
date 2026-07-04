import assert from "node:assert/strict";
import test from "node:test";

import { CicloEventStore } from "../src/ciclo-events.js";
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
  const supervisor = new WorkerSessionSupervisor("/repo", new FakeLauncher(), { now: () => now }, events);
  const brain = new FakeBrain();
  supervisor.launch({
    harnessId: "claude-code",
    loopId: "review-loop",
    beadId: "ciclo-1",
    prompt: "Work through Ciclo."
  });

  now = "2026-07-02T00:11:00.000Z";
  const heartbeat = new CicloInternalHeartbeat(
    {
      workerSupervisor: supervisor,
      openAiBrain: brain,
      eventStore: events,
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
