import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildWorkerLaunchPlan,
  WorkerSessionSupervisor,
  type WorkerCommandRunResult,
  type WorkerCommandRunner,
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
  readonly launches: { command: string; args: readonly string[]; cwd?: string; environment?: NodeJS.ProcessEnv }[] = [];
  readonly handle = new FakeHandle();

  launch(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }): WorkerProcessHandle {
    this.launches.push({ command, args, cwd: options.cwd, environment: options["env"] });
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

class FakeCommandRunner implements WorkerCommandRunner {
  readonly runs: { command: string; args: readonly string[]; cwd?: string }[] = [];
  private index = 0;

  constructor(private readonly result: WorkerCommandRunResult | readonly WorkerCommandRunResult[] = {
    status: 0,
    stdout: JSON.stringify({ workspace_id: "workspace-123" }),
    stderr: ""
  }) {}

  run(command: string, args: readonly string[], options: { cwd?: string } = {}): WorkerCommandRunResult {
    this.runs.push({ command, args, cwd: options.cwd });
    if (Array.isArray(this.result)) {
      return this.result[Math.min(this.index++, this.result.length - 1)]!;
    }
    return this.result as WorkerCommandRunResult;
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
      "never",
      "--sandbox",
      "danger-full-access",
      "--profile",
      "review",
      "Use Ciclo MCP and implement the task."
    ]);
    assert.deepEqual(plan.extraArgs, ["--profile", "review"]);
    assert.equal(plan.sessionName, "repo-loop-1-ciclo-1-codex");
  });
});

test("worker launch plan appends configured guidance to harness prompt", () => {
  withHerdrReuseDisabled(() => {
    const plan = buildWorkerLaunchPlan(
      {
        harnessId: "codex",
        loopId: "loop-1",
        cwd: "/repo",
        prompt: "Use Ciclo MCP and implement the task.",
        promptInjections: [
          {
            id: "worker-help",
            scope: "worker",
            text: "Run the repository validation command before reporting done."
          },
          {
            id: "brain-only",
            scope: "brain",
            text: "This belongs to the brain only."
          }
        ]
      },
      "/fallback",
      "worker-prompt-test"
    );

    assert.match(plan.prompt, /Configured Ciclo guidance:/);
    assert.match(plan.prompt, /\[worker-help\] Run the repository validation command/);
    assert.doesNotMatch(plan.prompt, /brain-only/);
    assert.equal(plan.args.at(-1), plan.prompt);
    assert.ok(plan.evidence.includes("prompt.injections.worker:1"));
    assert.ok(plan.evidence.includes("prompt.injection.worker:worker-help"));
  });
});

test("Claude worker launch plan starts background named session with effort", () => {
  withHerdrReuseDisabled(() => {
    const plan = buildWorkerLaunchPlan(
      {
        harnessId: "claude-code",
        loopId: "loop-2",
        model: "Fable 5",
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
      "bypassPermissions",
      "--allowedTools",
      "mcp__ciclo__ciclo_status",
      "Review through Ciclo."
    ]);
    assert.equal(plan.model, "claude-fable-5");
    assert.ok(plan.evidence.includes("worker.session.model:claude-fable-5"));
    assert.ok(plan.evidence.includes("worker.session.permission_mode:bypassPermissions"));
  });
});

test("Claude worker launch plan passes only explicit valid permission mode", () => {
  withHerdrReuseDisabled(() => {
    const plan = buildWorkerLaunchPlan(
      {
        harnessId: "claude-code",
        loopId: "loop-permissions",
        permissionMode: "manual",
        prompt: "Review through Ciclo."
      },
      "/repo",
      "worker-claude-permissions"
    );

    assert.ok(plan.args.includes("--permission-mode"));
    assert.ok(plan.args.includes("manual"));
    assert.ok(!plan.args.includes("default"));
    assert.ok(plan.evidence.includes("worker.session.permission_mode:manual"));
  });
});

test("Claude worker launch plan can explicitly omit permission mode", () => {
  withHerdrReuseDisabled(() => {
    const plan = buildWorkerLaunchPlan(
      {
        harnessId: "claude-code",
        loopId: "loop-permissions",
        permissionMode: "default",
        prompt: "Review through Ciclo."
      },
      "/repo",
      "worker-claude-default-permissions"
    );

    assert.ok(!plan.args.includes("--permission-mode"));
    assert.ok(plan.evidence.includes("worker.session.permission_mode:default"));
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
    assert.deepEqual(plan.args.slice(0, 6), ["--cd", plan.worktree?.path, "--ask-for-approval", "never", "--sandbox", "danger-full-access"]);
    assert.ok(plan.evidence.includes(`worker.worktree.path:${plan.worktree?.path}`));
  });
});

test("worker launch plan can configure MCP clients in the worker cwd", () => {
  withHerdrReuseDisabled(() => {
    const root = mkdtempSync(join(tmpdir(), "ciclo-mcp-worker-root-"));
    const plan = buildWorkerLaunchPlan(
      {
        harnessId: "codex",
        loopId: "loop-mcp",
        prompt: "Work with Ciclo MCP.",
        configureMcp: true,
        mcpServerName: "ciclo_local",
        mcpCommand: "ciclo-dev",
        mcpAdditionalServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
            env: { MCP_FS_MODE: "worker" }
          }
        }
      },
      root,
      "worker-mcp"
    );

    assert.equal(plan.mcpConfig?.enabled, true);
    assert.deepEqual(plan.mcpConfig?.clients, ["claude", "codex"]);
    assert.equal(plan.mcpConfig?.serverName, "ciclo_local");
    assert.equal(plan.mcpConfig?.command, "ciclo-dev");
    assert.deepEqual(plan.mcpConfig?.additionalServerNames, ["filesystem"]);
    assert.deepEqual(plan.mcpConfig?.install.targets.map((target) => target.client), ["claude", "codex"]);
    assert.equal(plan.args[0], "-c");
    const codexMcpOverride = plan.args[1] ?? "";
    assert.match(codexMcpOverride, /^mcp_servers=/u);
    assert.match(codexMcpOverride, /ciclo_local/u);
    assert.match(codexMcpOverride, /filesystem/u);
    assert.doesNotMatch(codexMcpOverride, /user_profile/u);
    assert.equal(existsSync(join(root, ".mcp.json")), false);
    assert.equal(existsSync(join(root, ".codex", "config.toml")), false);
    assert.ok(plan.evidence.includes("worker.mcp_config:planned"));
  });
});

test("worker launch plan keeps the launched harness MCP client when config narrows clients", () => {
  withHerdrReuseDisabled(() => {
    const root = mkdtempSync(join(tmpdir(), "ciclo-mcp-worker-narrow-root-"));
    const plan = buildWorkerLaunchPlan(
      {
        harnessId: "codex",
        loopId: "loop-mcp",
        prompt: "Work with Ciclo MCP.",
        configureMcp: true,
        mcpClients: ["claude"]
      },
      root,
      "worker-mcp-narrow"
    );

    assert.deepEqual(plan.mcpConfig?.clients, ["claude", "codex"]);
    assert.deepEqual(plan.mcpConfig?.install.targets.map((target) => target.client), ["claude", "codex"]);
    const codexMcpOverride = plan.args[1] ?? "";
    assert.match(codexMcpOverride, /^mcp_servers=/u);
  });
});

test("worker supervisor nudges Herdr tracked workers through pane run so Enter is submitted", () => {
  withHerdrSessionEnv("infra-blocks", () => {
    const root = mkdtempSync(join(tmpdir(), "ciclo-nudge-root-"));
    const launcher = new FakeLauncher();
    const runner = new FakeCommandRunner([
      {
        status: 0,
        stdout: JSON.stringify({ result: { agent: { pane_id: "wF:p2", agent_status: "idle" } } }),
        stderr: ""
      },
      { status: 0, stdout: "", stderr: "" }
    ]);
    const supervisor = new WorkerSessionSupervisor(root, launcher, { now: () => "2026-07-04T00:00:00.000Z" }, undefined, undefined, runner);
    const running = supervisor.launch({
      harnessId: "codex",
      loopId: "loop-1",
      beadId: "infra-1",
      prompt: "Work through Ciclo."
    });

    const nudged = supervisor.nudge(running.sessionId, "Report status.");

    assert.equal(nudged.recoveryAttempts, 1);
    assert.equal(nudged.lastRecoveryAt, "2026-07-04T00:00:00.000Z");
    assert.deepEqual(runner.runs.at(0)?.args, [
      "--session",
      "infra-blocks",
      "agent",
      "get",
      running.sessionName
    ]);
    assert.deepEqual(runner.runs.at(1)?.args, [
      "--session",
      "infra-blocks",
      "pane",
      "run",
      "wF:p2",
      "Report status."
    ]);
    assert.ok(nudged.evidence.includes("worker.session.nudge.submit:pane_run"));
  });
});

test("worker supervisor reads visible Herdr pane and submits pending Codex prompt", () => {
  withHerdrSessionEnv("infra-blocks", () => {
    const root = mkdtempSync(join(tmpdir(), "ciclo-pending-prompt-root-"));
    const launcher = new FakeLauncher();
    const runner = new FakeCommandRunner([
      {
        status: 0,
        stdout: JSON.stringify({ result: { agent: { pane_id: "wF:p2", agent_status: "idle" } } }),
        stderr: ""
      },
      {
        status: 0,
        stdout: "• Previous worker output\n\n› Summarize recent commits\n\n  gpt-5.5 high · ~/repo\n",
        stderr: ""
      },
      { status: 0, stdout: "", stderr: "" }
    ]);
    const supervisor = new WorkerSessionSupervisor(root, launcher, { now: () => "2026-07-04T00:00:00.000Z" }, undefined, undefined, runner);
    const running = supervisor.launch({
      harnessId: "codex",
      loopId: "loop-1",
      beadId: "infra-1",
      prompt: "Work through Ciclo."
    });

    const recovered = supervisor.recoverPendingHerdrInputs();
    const updated = supervisor.get(running.sessionId);

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.submitted, true);
    assert.equal(recovered[0]?.pendingPrompt, "Summarize recent commits");
    assert.equal(updated?.lastHeartbeatAt, "2026-07-04T00:00:00.000Z");
    assert.deepEqual(runner.runs.at(2)?.args, [
      "--session",
      "infra-blocks",
      "pane",
      "run",
      "wF:p2",
      ""
    ]);
    const events = supervisor.pollEvents(0).events;
    assert.ok(events.some((event) => event.type === "worker.prompt_submitted" && event.data?.submitted === true));
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

test("Herdr pane worktree launches use Herdr worktree workspace support", () => {
  withHerdrSessionEnv("operator-main", () => {
    const root = mkdtempSync(join(tmpdir(), "ciclo-herdr-worktree-root-"));
    const worktreePath = join(tmpdir(), `ciclo-herdr-worktree-${Date.now()}`);
    const launcher = new FakeLauncher();
    const commandRunner = new FakeCommandRunner([
      {
        status: 0,
        stdout: JSON.stringify({ id: "cli:worktree:create", result: { id: "cli:worktree:create" } }),
        stderr: ""
      },
      {
        status: 0,
        stdout: JSON.stringify({
          result: {
            worktrees: [
              {
                path: worktreePath,
                branch: "ciclo/ciclo-9l0",
                open_workspace_id: "workspace-123"
              }
            ]
          }
        }),
        stderr: ""
      }
    ]);
    const supervisor = new WorkerSessionSupervisor(
      root,
      launcher,
      { now: () => "2026-06-30T00:00:00.000Z" },
      undefined,
      undefined,
      commandRunner
    );

    const running = supervisor.launch({
      harnessId: "codex",
      loopId: "review-loop",
      beadId: "ciclo-9l0",
      prompt: "Work through Ciclo.",
      isolation: "worktree",
      worktree: {
        path: worktreePath,
        branch: "ciclo/ciclo-9l0",
        base: "main"
      }
    });

    assert.equal(running.state, "running");
    assert.equal(running.launchMode, "herdr_pane");
    assert.equal(running.worktree?.herdrWorkspaceId, "workspace-123");
    assert.deepEqual(commandRunner.runs[0], {
      command: "herdr",
      cwd: root,
      args: [
        "--session",
        "operator-main",
        "worktree",
        "create",
        "--cwd",
        root,
        "--branch",
        "ciclo/ciclo-9l0",
        "--base",
        "main",
        "--path",
        worktreePath,
        "--label",
        "operator-main-review-loop-ciclo-9l0-codex",
        "--no-focus",
        "--json"
      ]
    });
    assert.deepEqual(commandRunner.runs[1], {
      command: "herdr",
      cwd: root,
      args: [
        "--session",
        "operator-main",
        "worktree",
        "list",
        "--cwd",
        worktreePath,
        "--json"
      ]
    });
    assert.deepEqual(launcher.launches[0]?.args.slice(0, 11), [
      "--session",
      "operator-main",
      "agent",
      "start",
      "operator-main-review-loop-ciclo-9l0-codex",
      "--workspace",
      "workspace-123",
      "--cwd",
      worktreePath,
      "--no-focus",
      "--"
    ]);
    assert.ok(!launcher.launches[0]?.args.includes("cli:worktree:create"));
    assert.ok(running.evidence.includes("worker.worktree:herdr_create"));
    assert.ok(running.evidence.includes("worker.worktree.herdr_workspace:workspace-123"));
  });
});

test("Herdr pane worktree launches always create a fresh workspace", () => {
  withHerdrSessionEnv("operator-main", () => {
    const root = mkdtempSync(join(tmpdir(), "ciclo-herdr-fresh-root-"));
    const worktreePath = join(tmpdir(), `ciclo-herdr-existing-${Date.now()}`);
    mkdirSync(worktreePath, { recursive: true });
    const launcher = new FakeLauncher();
    const commandRunner = new FakeCommandRunner();
    const supervisor = new WorkerSessionSupervisor(
      root,
      launcher,
      { now: () => "2026-06-30T00:00:00.000Z" },
      undefined,
      undefined,
      commandRunner
    );

    const running = supervisor.launch({
      harnessId: "codex",
      loopId: "review-loop",
      beadId: "ciclo-9l0",
      prompt: "Work through Ciclo.",
      isolation: "worktree",
      worktree: {
        path: worktreePath,
        branch: "ciclo/ciclo-9l0"
      }
    });

    assert.equal(running.state, "running");
    assert.equal(commandRunner.runs[0]?.command, "herdr");
    assert.equal(commandRunner.runs[0]?.args[2], "worktree");
    assert.equal(commandRunner.runs[0]?.args[3], "create");
    assert.ok(!commandRunner.runs[0]?.args.includes("open"));
    assert.ok(running.evidence.includes("worker.worktree:herdr_create"));
  });
});

test("Herdr pane worktree launch fails closed when Herdr omits workspace id", () => {
  withHerdrSessionEnv("operator-main", () => {
    const root = mkdtempSync(join(tmpdir(), "ciclo-herdr-missing-workspace-root-"));
    const launcher = new FakeLauncher();
    const commandRunner = new FakeCommandRunner({ status: 0, stdout: "{}", stderr: "" });
    const supervisor = new WorkerSessionSupervisor(
      root,
      launcher,
      { now: () => "2026-06-30T00:00:00.000Z" },
      undefined,
      undefined,
      commandRunner
    );

    const failed = supervisor.launch({
      harnessId: "claude-code",
      loopId: "review-loop",
      beadId: "ciclo-1mt",
      prompt: "Work through Ciclo.",
      isolation: "worktree"
    });

    assert.equal(failed.state, "failed");
    assert.equal(failed.cleanupReason, "herdr worktree create did not return a workspace id");
    assert.equal(launcher.launches.length, 0);
    assert.ok(failed.evidence.includes("worker.worktree:failed"));
  });
});

test("worker session supervisor installs MCP config before launching", () => {
  withHerdrReuseDisabled(() => {
    const root = mkdtempSync(join(tmpdir(), "ciclo-mcp-launch-root-"));
    const launcher = new FakeLauncher();
    const supervisor = new WorkerSessionSupervisor(root, launcher, {
      now: () => "2026-06-30T00:00:00.000Z"
    });

    const running = supervisor.launch({
      harnessId: "codex",
      loopId: "loop-mcp",
      prompt: "Use configured MCP.",
      configureMcp: true,
      mcpServerName: "ciclo_local",
      mcpCommand: "ciclo-dev"
    });

    assert.equal(running.state, "running");
    assert.equal(running.mcpConfig?.install.installed, true);
    assert.deepEqual(running.mcpConfig?.clients, ["claude", "codex"]);
    assert.ok(running.evidence.includes("worker.mcp_config:installed"));
    const claudeConfig = readFileSync(join(root, ".mcp.json"), "utf8");
    assert.match(claudeConfig, /"ciclo_local"/u);
    assert.match(claudeConfig, /"ciclo-dev"/u);
    const config = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    assert.match(config, /\[mcp_servers\.ciclo_local\]/u);
    assert.match(config, /command = "ciclo-dev"/u);
    assert.match(config, /CICLO_PROJECT_ROOT = /u);
    assert.equal(launcher.launches[0]?.cwd, root);
  });
});

test("worker launch defaults to Herdr pane inside active Herdr session", () => {
  withHerdrSessionEnv("operator-main", () => {
    const claudePlan = buildWorkerLaunchPlan(
      {
        harnessId: "claude-code",
        loopId: "review-loop",
        beadId: "ciclo-9l0",
        model: "claude fable 5",
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
    assert.ok(claudePlan.args.includes("--model"));
    assert.ok(claudePlan.args.includes("claude-fable-5"));
    assert.ok(claudePlan.args.includes("--permission-mode"));
    assert.ok(claudePlan.args.includes("bypassPermissions"));
    assert.ok(!claudePlan.args.includes("--bg"));
    assert.equal(claudePlan.model, "claude-fable-5");
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
    assert.ok(codexPlan.args.includes("--ask-for-approval"));
    assert.ok(codexPlan.args.includes("never"));
    assert.ok(codexPlan.args.includes("--sandbox"));
    assert.ok(codexPlan.args.includes("danger-full-access"));
    assert.ok(codexPlan.evidence.includes("worker.session.approval_policy:never"));
    assert.ok(codexPlan.evidence.includes("worker.session.sandbox:danger-full-access"));
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

test("worker launch passes non-secret values to the worker process", () => {
  withHerdrReuseDisabled(() => {
    const launcher = new FakeLauncher();
    const supervisor = new WorkerSessionSupervisor("/repo", launcher, {
      now: () => "2026-06-30T00:00:00.000Z"
    });

    const running = supervisor.launch({
      harnessId: "codex",
      loopId: "values-loop",
      prompt: "Use configured values.",
      workerEnv: {
        GRAFANA_URL: "https://grafana.example.test"
      }
    });
    const plan = running["workerEnv"];

    assert.deepEqual(plan?.["envNames"], ["GRAFANA_URL"]);
    assert.equal(launcher.launches[0]?.["environment"]?.GRAFANA_URL, "https://grafana.example.test");
    assert.ok(running.evidence.includes("worker_environment.names:GRAFANA_URL"));
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

test("Herdr pane worker launch passes non-secret values with agent start env flags", () => {
  withHerdrSessionEnv("operator-main", () => {
    const plan = buildWorkerLaunchPlan({
      harnessId: "codex",
      loopId: "pane-loop",
      prompt: "Work through Ciclo.",
      workerEnv: {
        GRAFANA_URL: "https://grafana.example.test"
      }
    }, "/repo", "worker-herdr-values");

    assert.equal(plan.launchMode, "herdr_pane");
    assert.deepEqual(plan.args.slice(5, 11), [
      "--cwd",
      "/repo",
      "--env",
      "GRAFANA_URL=https://grafana.example.test",
      "--no-focus",
      "--"
    ]);
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
