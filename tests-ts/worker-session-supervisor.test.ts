import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildWorkerLaunchPlan,
  WorkerSessionSupervisor,
  type WorkerProcessHandle,
  type WorkerProcessLauncher
} from "../src/worker-session-supervisor.js";
import type {
  ClaudeBackgroundAgentLookup,
  ClaudeBackgroundAgentRecord,
  ClaudeBackgroundAgentResolver
} from "../src/claude-background-agent.js";

function withHerdrSessionEnv(sessionName: string, run: () => void): void {
  const before = {
    CICLO_SESSION_NAME: process.env.CICLO_SESSION_NAME,
    HERDR_SESSION_NAME: process.env.HERDR_SESSION_NAME,
    CICLO_REUSE_HERDR_SESSION: process.env.CICLO_REUSE_HERDR_SESSION
  };
  delete process.env.CICLO_SESSION_NAME;
  process.env.HERDR_SESSION_NAME = sessionName;
  delete process.env.CICLO_REUSE_HERDR_SESSION;
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withHerdrReuseDisabled(run: () => void): void {
  const before = process.env.CICLO_REUSE_HERDR_SESSION;
  process.env.CICLO_REUSE_HERDR_SESSION = "false";
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.CICLO_REUSE_HERDR_SESSION;
    else process.env.CICLO_REUSE_HERDR_SESSION = before;
  }
}

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

class FakeClaudeResolver implements ClaudeBackgroundAgentResolver {
  record?: ClaudeBackgroundAgentRecord;
  lookups: ClaudeBackgroundAgentLookup[] = [];

  resolve(input: ClaudeBackgroundAgentLookup): ClaudeBackgroundAgentRecord | undefined {
    this.lookups.push(input);
    return this.record;
  }
}

test("Codex worker launch plan includes model cwd approval sandbox and prompt", () => {
  withHerdrReuseDisabled(() => {
    const plan = buildWorkerLaunchPlan(
      {
        harnessId: "codex",
        loopId: "loop-1",
        beadId: "ciclo-1",
        model: "gpt-5.5",
        cwd: "/repo",
        extraArgs: ["--profile", "review"],
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
      "--profile",
      "review",
      "Use Ciclo MCP and implement the task."
    ]);
    assert.deepEqual(plan.extraArgs, ["--profile", "review"]);
    assert.equal(plan.sessionName, "repo-loop-1-ciclo-1-codex");
  });
});

test("Claude worker launch plan starts background named session with effort", () => {
  withHerdrReuseDisabled(() => {
    const plan = buildWorkerLaunchPlan(
      {
        harnessId: "claude-code",
        loopId: "loop-2",
        model: "claude-fable-5",
        effort: "high",
        sessionName: "review-worker",
        extraArgs: ["--allowedTools", "mcp__ciclo__ciclo_status"],
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
      "--allowedTools",
      "mcp__ciclo__ciclo_status",
      "Review through Ciclo."
    ]);
  });
});

test("worker launch plan can create an isolated worktree cwd", () => {
  withHerdrReuseDisabled(() => {
    const root = mkdtempSync(join(tmpdir(), "ciclo-root-"));
    const plan = buildWorkerLaunchPlan(
      {
        harnessId: "codex",
        loopId: "loop-1",
        beadId: "ciclo-1",
        prompt: "Work in an isolated tree.",
        worktree: {
          path: "../ciclo-worker-tree",
          branch: "ciclo-worker",
          base: "main"
        }
      },
      root,
      "worker-tree"
    );

    assert.equal(plan.worktree?.create, true);
    assert.equal(plan.worktree?.path, join(tmpdir(), "ciclo-worker-tree"));
    assert.equal(plan.worktree?.branch, "ciclo-worker");
    assert.equal(plan.worktree?.base, "main");
    assert.equal(plan.cwd, plan.worktree?.path);
    assert.deepEqual(plan.args.slice(0, 4), ["--cd", plan.worktree?.path, "--ask-for-approval", "on-request"]);
    assert.ok(plan.evidence.includes(`worker.worktree.path:${plan.worktree?.path}`));
  });
});

test("worker launch isolation worktree defaults to bead branch", () => {
  withHerdrReuseDisabled(() => {
    const root = mkdtempSync(join(tmpdir(), "ciclo-root-"));
    const plan = buildWorkerLaunchPlan(
      {
        harnessId: "codex",
        loopId: "loop-1",
        beadId: "ciclo-ABC.12",
        prompt: "Work in an isolated tree.",
        isolation: "worktree"
      },
      root,
      "worker-tree"
    );

    assert.equal(plan.worktree?.create, true);
    assert.equal(plan.worktree?.branch, "ciclo/ciclo-abc.12");
    assert.equal(plan.cwd, plan.worktree?.path);
    assert.ok(plan.evidence.includes(`worker.worktree.branch:${plan.worktree?.branch}`));
  });
});


test("worker session supervisor creates requested git worktree before launch", () => {
  withHerdrReuseDisabled(() => {
    const root = mkdtempSync(join(tmpdir(), "ciclo-git-root-"));
    const worktreePath = join(tmpdir(), `ciclo-git-worktree-${Date.now()}`);
    spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" });
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "init"], {
      cwd: root,
      encoding: "utf8"
    });
    const launcher = new FakeLauncher();
    const supervisor = new WorkerSessionSupervisor(root, launcher, {
      now: () => "2026-06-30T00:00:00.000Z"
    });

    const running = supervisor.launch({
      harnessId: "codex",
      loopId: "loop-1",
      prompt: "Work through Ciclo.",
      worktree: {
        path: worktreePath,
        branch: `ciclo-test-${Date.now()}`
      }
    });

    assert.equal(running.state, "running");
    assert.equal(running.cwd, worktreePath);
    assert.equal(launcher.launches[0]?.cwd, worktreePath);
    assert.equal(existsSync(join(worktreePath, ".git")), true);
    assert.ok(running.evidence.includes("worker.worktree:created"));
  });
});

test("worker launch defaults to Herdr pane inside active Herdr session", () => {
  withHerdrSessionEnv("operator-main", () => {
    const claudePlan = buildWorkerLaunchPlan(
      {
        harnessId: "claude-code",
        loopId: "review-loop",
        beadId: "ciclo-9l0",
        prompt: "Work through Ciclo."
      },
      "/repo",
      "worker-herdr"
    );

    assert.equal(claudePlan.sessionName, "operator-main-review-loop-ciclo-9l0-claude-code");
    assert.equal(claudePlan.command, "herdr");
    assert.equal(claudePlan.launchMode, "herdr_pane");
    assert.equal(claudePlan.trackingMode, "herdr_agent");
    assert.equal(claudePlan.agentRef?.kind, "herdr_agent");
    assert.deepEqual(claudePlan.args.slice(0, 10), [
      "--session",
      "operator-main",
      "agent",
      "start",
      "operator-main-review-loop-ciclo-9l0-claude-code",
      "--cwd",
      "/repo",
      "--no-focus",
      "--",
      "claude"
    ]);
    assert.ok(claudePlan.args.includes("--name"));
    assert.ok(!claudePlan.args.includes("--bg"));
    assert.ok(claudePlan.evidence.includes("worker.session.launch_mode:herdr_pane"));

    const codexPlan = buildWorkerLaunchPlan(
      {
        harnessId: "codex",
        loopId: "review-loop",
        beadId: "ciclo-9l0",
        prompt: "Work through Ciclo."
      },
      "/repo",
      "worker-herdr-codex"
    );

    assert.equal(codexPlan.sessionName, "operator-main-review-loop-ciclo-9l0-codex");
    assert.equal(codexPlan.command, "herdr");
    assert.equal(codexPlan.launchMode, "herdr_pane");
    assert.equal(codexPlan.trackingMode, "herdr_agent");
    assert.equal(codexPlan.agentRef?.kind, "herdr_agent");
    assert.deepEqual(codexPlan.args.slice(0, 10), [
      "--session",
      "operator-main",
      "agent",
      "start",
      "operator-main-review-loop-ciclo-9l0-codex",
      "--cwd",
      "/repo",
      "--no-focus",
      "--",
      "codex"
    ]);
    assert.ok(codexPlan.args.includes("--cd"));
    assert.ok(codexPlan.evidence.includes("worker.session.launch_mode:herdr_pane"));
  });
});

test("worker launch can disable Herdr pane reuse for direct Claude background mode", () => {
  const before = {
    HERDR_SESSION_NAME: process.env.HERDR_SESSION_NAME,
    CICLO_REUSE_HERDR_SESSION: process.env.CICLO_REUSE_HERDR_SESSION
  };
  process.env.HERDR_SESSION_NAME = "operator-main";
  process.env.CICLO_REUSE_HERDR_SESSION = "false";
  try {
    const plan = buildWorkerLaunchPlan(
      {
        harnessId: "claude-code",
        loopId: "review-loop",
        beadId: "ciclo-9l0",
        prompt: "Work through Ciclo."
      },
      "/repo",
      "worker-herdr-disabled"
    );

    assert.equal(plan.command, "claude");
    assert.equal(plan.launchMode, "process");
    assert.deepEqual(plan.args.slice(0, 3), ["--bg", "--name", "repo-review-loop-ciclo-9l0-claude-code"]);
  } finally {
    if (before.HERDR_SESSION_NAME === undefined) delete process.env.HERDR_SESSION_NAME;
    else process.env.HERDR_SESSION_NAME = before.HERDR_SESSION_NAME;
    if (before.CICLO_REUSE_HERDR_SESSION === undefined) delete process.env.CICLO_REUSE_HERDR_SESSION;
    else process.env.CICLO_REUSE_HERDR_SESSION = before.CICLO_REUSE_HERDR_SESSION;
  }
});

test("worker session supervisor tracks launch stop and process exit", () => {
  withHerdrReuseDisabled(() => {
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
});

test("worker session supervisor records completed worker exits", () => {
  withHerdrReuseDisabled(() => {
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
});

test("Claude background launcher exit does not complete detached worker", () => {
  withHerdrReuseDisabled(() => {
    const launcher = new FakeLauncher();
    const supervisor = new WorkerSessionSupervisor("/repo", launcher, {
      now: () => "2026-06-30T00:00:00.000Z"
    });

    const running = supervisor.launch({
      harnessId: "claude-code",
      loopId: "finish-board",
      prompt: "Work through Ciclo."
    });
    launcher.handle.exit(0, null);

    const afterLauncherExit = supervisor.get(running.sessionId);
    assert.equal(afterLauncherExit?.state, "running");
    assert.equal(afterLauncherExit?.trackingMode, "detached_agent");
    assert.equal(afterLauncherExit?.agentRef?.kind, "claude_background_session");
    assert.equal(afterLauncherExit?.cleanupReason, "launcher exited; detached agent is still tracked");
    assert.ok(afterLauncherExit?.evidence.includes("worker.session.launcher_exit:detached_agent_still_running"));

    const completed = supervisor.recordAgentExit(running.sessionId, 0, null);
    assert.equal(completed.state, "completed");
    assert.equal(completed.cleanupReason, "detached agent exited");
  });
});

test("Herdr pane launcher exit does not complete visible pane worker", () => {
  withHerdrSessionEnv("operator-main", () => {
    const launcher = new FakeLauncher();
    const supervisor = new WorkerSessionSupervisor("/repo", launcher, {
      now: () => "2026-06-30T00:00:00.000Z"
    });

    const running = supervisor.launch({
      harnessId: "codex",
      loopId: "pane-loop",
      prompt: "Work through Ciclo."
    });

    assert.equal(running.launchMode, "herdr_pane");
    assert.equal(running.trackingMode, "herdr_agent");
    assert.equal(launcher.launches[0]?.command, "herdr");
    launcher.handle.exit(0, null);

    const afterLauncherExit = supervisor.get(running.sessionId);
    assert.equal(afterLauncherExit?.state, "running");
    assert.equal(afterLauncherExit?.trackingMode, "herdr_agent");
    assert.equal(afterLauncherExit?.agentRef?.kind, "herdr_agent");
    assert.equal(afterLauncherExit?.cleanupReason, "herdr pane launcher exited; pane agent is still tracked");
    assert.ok(afterLauncherExit?.evidence.includes("worker.session.launcher_exit:herdr_pane_still_running"));
  });
});

test("Claude background registry updates detached worker lifecycle and pty host", () => {
  withHerdrReuseDisabled(() => {
    const launcher = new FakeLauncher();
    const resolver = new FakeClaudeResolver();
    const supervisor = new WorkerSessionSupervisor("/repo", launcher, {
      now: () => "2026-06-30T00:00:00.000Z"
    }, undefined, resolver);

    const running = supervisor.launch({
      harnessId: "claude-code",
      loopId: "finish-board",
      sessionName: "finish-board-worker",
      prompt: "Work through Ciclo."
    });
    launcher.handle.exit(0, null);

    resolver.record = {
      id: "claude-session-1",
      sessionId: "claude-session-1",
      jobId: "abc12345",
      name: "finish-board-worker",
      cwd: "/repo",
      pid: 777,
      status: "waiting",
      waitingFor: "permission prompt",
      ptySock: "/tmp/cc-daemon/pty/abc12345.sock",
      rendezvousSock: "/tmp/cc-daemon/rv/abc12345.sock",
      updatedAt: "2026-06-30T00:01:00.000Z",
      statusUpdatedAt: "2026-06-30T00:01:00.000Z",
      source: "merged"
    };

    const waiting = supervisor.get(running.sessionId);
    assert.equal(waiting?.state, "waiting_on_operator");
    assert.equal(waiting?.agentRef?.sessionId, "claude-session-1");
    assert.equal(waiting?.agentRef?.jobId, "abc12345");
    assert.equal(waiting?.agentRef?.ptyHost, "/tmp/cc-daemon/pty/abc12345.sock");
    assert.equal(waiting?.lastHeartbeatAt, "2026-06-30T00:01:00.000Z");
    assert.deepEqual(resolver.lookups[0], { name: "finish-board-worker", cwd: "/repo" });

    resolver.record = {
      ...resolver.record,
      status: "completed",
      waitingFor: undefined,
      updatedAt: "2026-06-30T00:02:00.000Z",
      statusUpdatedAt: "2026-06-30T00:02:00.000Z"
    };

    const completed = supervisor.get(running.sessionId);
    assert.equal(completed?.state, "completed");
    assert.equal(completed?.cleanupReason, "claude background agent completed");
  });
});

test("worker session supervisor exposes cursor based worker events", () => {
  withHerdrReuseDisabled(() => {
    const launcher = new FakeLauncher();
    const supervisor = new WorkerSessionSupervisor("/repo", launcher, {
      now: () => "2026-06-30T00:00:00.000Z"
    });

    const running = supervisor.launch({
      harnessId: "codex",
      loopId: "loop-events",
      prompt: "Work through Ciclo."
    });
    const firstPoll = supervisor.pollEvents(0);
    assert.ok(firstPoll.events.some((event) => event.type === "worker.state_change" && event.workerSessionId === running.sessionId));

    const stopped = supervisor.stop(running.sessionId, "done");
    const secondPoll = supervisor.pollEvents(firstPoll.nextCursor);
    assert.ok(secondPoll.events.some((event) => event.state === stopped.state && event.workerSessionId === running.sessionId));
  });
});

test("worker session supervisor records waiting resume heartbeat usage and stalled state", () => {
  withHerdrReuseDisabled(() => {
    let now = "2026-06-30T00:00:00.000Z";
    const launcher = new FakeLauncher();
    const supervisor = new WorkerSessionSupervisor("/repo", launcher, {
      now: () => now
    });

    const running = supervisor.launch({
      harnessId: "codex",
      loopId: "loop-liveness",
      beadId: "ciclo-live",
      prompt: "Work through Ciclo."
    });

    now = "2026-06-30T00:01:00.000Z";
    const waiting = supervisor.markWaitingOnOperator({ sessionId: running.sessionId }, ["question:q-1"]);
    assert.equal(waiting[0]?.state, "waiting_on_operator");
    assert.equal(waiting[0]?.stateEnteredAt, now);

    now = "2026-06-30T00:02:00.000Z";
    const resumed = supervisor.resumeAfterOperator({ sessionId: running.sessionId }, ["answer:q-1"]);
    assert.equal(resumed[0]?.state, "running");
    assert.equal(resumed[0]?.lastHeartbeatAt, now);

    now = "2026-06-30T00:03:00.000Z";
    const heartbeat = supervisor.heartbeat(running.sessionId, {
      evidence: ["worker.output:progress"],
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02 }
    });
    assert.equal(heartbeat.state, "running");
    assert.deepEqual(heartbeat.usage, { inputTokens: 10, outputTokens: 5, costUsd: 0.02 });

    now = "2026-06-30T00:20:00.000Z";
    const stalled = supervisor.refreshStalled(5 * 60 * 1000);
    assert.equal(stalled[0]?.state, "stalled");

    const poll = supervisor.pollEvents(0);
    assert.ok(poll.events.some((event) => event.type === "worker.stalled" && event.workerSessionId === running.sessionId));

    const metrics = supervisor.metrics(now);
    assert.equal(metrics.byState.stalled, 1);
    assert.equal(metrics.usage.inputTokens, 10);
    assert.equal(metrics.usage.outputTokens, 5);
    assert.equal(metrics.usage.costUsd, 0.02);
    assert.ok((metrics.timeInStateMs.stalled ?? 0) >= 0);
  });
});
