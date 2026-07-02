import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskReviewPrompt, launchTaskReviewSession } from "../src/task-review-session.js";
import {
  WorkerSessionSupervisor,
  type WorkerProcessHandle,
  type WorkerProcessLauncher
} from "../src/worker-session-supervisor.js";

class FakeWorkerHandle implements WorkerProcessHandle {
  readonly pid = 4242;
  onExit(): void {}
  stop(): boolean {
    return true;
  }
}

class FakeWorkerLauncher implements WorkerProcessLauncher {
  launch(): WorkerProcessHandle {
    return new FakeWorkerHandle();
  }
}

test("task review prompt is bounded to verification and Ciclo feedback", () => {
  const prompt = buildTaskReviewPrompt({
    loopId: "finish-board",
    beadId: "ciclo-demo.1",
    finalSummary: "Implemented event polling.",
    acceptanceEvidence: ["poll cursor returns worker state changes"],
    validationEvidence: [{ command: "npm test", passed: true, summary: "passed" }],
    cwd: "/repo"
  });

  assert.match(prompt, /Review finished Beads task ciclo-demo\.1/);
  assert.match(prompt, /Do not mutate implementation code/);
  assert.match(prompt, /ciclo_report_feedback/);
  assert.match(prompt, /ciclo_update_work with kind=validation/);
  assert.match(prompt, /npm test: passed - passed/);
});

test("task review launch records a dry-run worker session", () => {
  const supervisor = new WorkerSessionSupervisor("/repo", new FakeWorkerLauncher());
  const result = launchTaskReviewSession({
    supervisor,
    loopId: "finish-board",
    beadId: "ciclo-demo.1",
    finalSummary: "Implemented event polling.",
    acceptanceEvidence: ["poll cursor returns worker state changes"],
    validationEvidence: [{ command: "npm test", passed: true, summary: "passed" }],
    cwd: "/repo",
    harnessId: "codex",
    dryRun: true
  });

  assert.equal(result.launched, true);
  assert.equal(result.state, "planned");
  assert.equal(result.harnessId, "codex");
  assert.ok(result.sessionId);
  assert.equal(supervisor.list().length, 1);
  assert.ok(supervisor.list()[0]?.evidence.some((item) => item === "worker.session.launch:planned"));
});

test("task review launch normalizes Fable 5 for Claude review sessions", () => {
  const supervisor = new WorkerSessionSupervisor("/repo", new FakeWorkerLauncher());
  const result = launchTaskReviewSession({
    supervisor,
    loopId: "finish-board",
    beadId: "ciclo-demo.1",
    finalSummary: "Implemented event polling.",
    acceptanceEvidence: ["poll cursor returns worker state changes"],
    validationEvidence: [{ command: "npm test", passed: true, summary: "passed" }],
    cwd: "/repo",
    harnessId: "claude-code",
    model: "fable 5",
    dryRun: true
  });

  const session = supervisor.list()[0];
  assert.equal(result.harnessId, "claude-code");
  assert.equal(session?.model, "claude-fable-5");
  assert.ok(session?.args.includes("--model"));
  assert.ok(session?.args.includes("claude-fable-5"));
});
