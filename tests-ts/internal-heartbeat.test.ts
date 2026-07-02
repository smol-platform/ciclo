import assert from "node:assert/strict";
import test from "node:test";

import { CicloEventStore } from "../src/ciclo-events.js";
import { CicloInternalHeartbeat } from "../src/internal-heartbeat.js";
import type {
  OpenAiBrain,
  OpenAiBrainDecision,
  OpenAiBrainDecisionInput,
  OpenAiBrainStatus
} from "../src/openai-brain.js";
import { openAiBrainPolicy } from "../src/openai-brain.js";
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
    harnessId: "codex",
    loopId: "review-loop",
    beadId: "ciclo-1",
    prompt: "Work through Ciclo."
  });

  now = "2026-07-02T00:11:00.000Z";
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
  assert.equal(result.workersStalled.length, 1);
  assert.equal(result.brainDecisions.length, 1);
  assert.equal(brain.inputs[0]?.purpose, "remote_session_monitoring");
  assert.equal(brain.inputs[0]?.beadId, "ciclo-1");
  const poll = events.poll(0);
  assert.ok(poll.events.some((event) => event.type === "heartbeat.tick"));
  assert.ok(poll.events.some((event) => event.type === "brain.decision"));
});
