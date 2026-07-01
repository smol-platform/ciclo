import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkerLaunchPlan,
  WorkerSessionSupervisor,
  type WorkerProcessHandle,
  type WorkerProcessLauncher
} from "../src/worker-session-supervisor.js";

class FakeHandle implements WorkerProcessHandle {
  private exitListener?: (code: number | null, signal: NodeJS.Signals | null) => void;

  constructor(readonly pid = 4242) {}

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListener = listener;
  }

  stop(): boolean {
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitListener?.(code, signal);
  }
}

class FakeLauncher implements WorkerProcessLauncher {
  readonly launches: { command: string; args: readonly string[]; cwd?: string }[] = [];
  readonly handle = new FakeHandle();

  launch(command: string, args: readonly string[], options: { cwd?: string }): WorkerProcessHandle {
    this.launches.push({ command, args, cwd: options.cwd });
    return this.handle;
  }
}

test("Codex worker launch plan includes model cwd approval sandbox and prompt", () => {
  const plan = buildWorkerLaunchPlan(
    {
      harnessId: "codex",
      loopId: "loop-1",
      beadId: "ciclo-1",
      model: "gpt-5.5",
      cwd: "/repo",
      prompt: "Use Ciclo MCP and implement the task."
    },
    "/fallback",
    "worker-test"
  );

  assert.equal(plan.command, "codex");
  assert.deepEqual(plan.args, [
    "--model",
    "gpt-5.5",
    "--cd",
    "/repo",
    "--ask-for-approval",
    "on-request",
    "--sandbox",
    "workspace-write",
    "Use Ciclo MCP and implement the task."
  ]);
  assert.equal(plan.sessionName, "ciclo-loop-1-ciclo-1-codex");
});

test("Claude worker launch plan starts background named session with effort", () => {
  const plan = buildWorkerLaunchPlan(
    {
      harnessId: "claude-code",
      loopId: "loop-2",
      model: "claude-fable-5",
      effort: "high",
      sessionName: "review-worker",
      prompt: "Review through Ciclo."
    },
    "/repo",
    "worker-claude"
  );

  assert.equal(plan.command, "claude");
  assert.deepEqual(plan.args, [
    "--bg",
    "--name",
    "review-worker",
    "--model",
    "claude-fable-5",
    "--effort",
    "high",
    "--permission-mode",
    "default",
    "Review through Ciclo."
  ]);
});

test("worker session supervisor tracks launch stop and process exit", () => {
  const launcher = new FakeLauncher();
  const supervisor = new WorkerSessionSupervisor("/repo", launcher, {
    now: () => "2026-06-30T00:00:00.000Z"
  });

  const running = supervisor.launch({
    harnessId: "codex",
    loopId: "loop-1",
    prompt: "Work through Ciclo.",
    dryRun: false
  });

  assert.equal(running.state, "running");
  assert.equal(running.pid, 4242);
  assert.equal(launcher.launches.length, 1);

  const stopped = supervisor.stop(running.sessionId, "operator requested cleanup");
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.cleanupReason, "operator requested cleanup");
  assert.ok(stopped.evidence.includes("worker.session.stop:sent"));

  const dryRun = supervisor.launch({
    harnessId: "claude-code",
    loopId: "loop-2",
    prompt: "Plan only.",
    dryRun: true
  });
  assert.equal(dryRun.state, "planned");

  const stoppedDryRun = supervisor.stop(dryRun.sessionId, "dry-run cleanup");
  assert.equal(stoppedDryRun.state, "stopped");
  assert.equal(stoppedDryRun.stoppedAt, "2026-06-30T00:00:00.000Z");
  assert.equal(stoppedDryRun.cleanupReason, "dry-run cleanup");
  assert.ok(stoppedDryRun.evidence.includes("worker.session.stop:not_running"));
  assert.equal(supervisor.list().length, 2);
});

test("worker session supervisor records completed worker exits", () => {
  const launcher = new FakeLauncher();
  const supervisor = new WorkerSessionSupervisor("/repo", launcher, {
    now: () => "2026-06-30T00:00:00.000Z"
  });

  const running = supervisor.launch({
    harnessId: "codex",
    loopId: "loop-1",
    prompt: "Work through Ciclo."
  });
  launcher.handle.exit(0, null);

  const completed = supervisor.get(running.sessionId);
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.cleanupReason, "worker exited successfully");

  const cleanedUp = supervisor.stop(running.sessionId, "post-completion cleanup");
  assert.equal(cleanedUp.state, "completed");
  assert.equal(cleanedUp.cleanupReason, "post-completion cleanup");
  assert.ok(cleanedUp.evidence.includes("worker.session.stop:not_running"));
});
