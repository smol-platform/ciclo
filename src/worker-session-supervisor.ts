import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { HarnessId } from "./ciclo-core.js";

export type WorkerHarnessId = Extract<HarnessId, "claude-code" | "codex">;

export type WorkerSessionState = "planned" | "running" | "stopped" | "failed" | "completed";

export interface WorkerSessionLaunchRequest {
  readonly harnessId: WorkerHarnessId;
  readonly loopId: string;
  readonly prompt: string;
  readonly beadId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly cwd?: string;
  readonly sessionName?: string;
  readonly dryRun?: boolean;
  readonly permissionMode?: string;
  readonly sandbox?: string;
  readonly approvalPolicy?: string;
}

export interface WorkerLaunchPlan {
  readonly sessionId: string;
  readonly harnessId: WorkerHarnessId;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
  readonly loopId: string;
  readonly beadId?: string;
  readonly sessionName: string;
  readonly prompt: string;
  readonly evidence: readonly string[];
}

export interface WorkerSessionRecord {
  readonly sessionId: string;
  readonly harnessId: WorkerHarnessId;
  readonly state: WorkerSessionState;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly pid?: number;
  readonly loopId: string;
  readonly beadId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly sessionName: string;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
  readonly cleanupReason?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly evidence: readonly string[];
}

export interface WorkerProcessHandle {
  readonly pid?: number;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  stop(signal?: NodeJS.Signals): boolean;
}

export interface WorkerProcessLauncher {
  launch(command: string, args: readonly string[], options: SpawnOptions): WorkerProcessHandle;
}

export interface WorkerClock {
  now(): string;
}

const defaultClock: WorkerClock = {
  now: () => new Date().toISOString()
};

class NodeWorkerProcessHandle implements WorkerProcessHandle {
  constructor(private readonly child: ChildProcess) {}

  get pid(): number | undefined {
    return this.child.pid;
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.child.once("exit", listener);
  }

  stop(signal: NodeJS.Signals = "SIGTERM"): boolean {
    return this.child.kill(signal);
  }
}

export class NodeWorkerProcessLauncher implements WorkerProcessLauncher {
  launch(command: string, args: readonly string[], options: SpawnOptions): WorkerProcessHandle {
    const child = spawn(command, [...args], options);
    child.unref();
    return new NodeWorkerProcessHandle(child);
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function sessionName(input: WorkerSessionLaunchRequest): string {
  const explicit = clean(input.sessionName);
  if (explicit !== undefined) return explicit;
  return [
    "ciclo",
    input.loopId,
    input.beadId ?? "unassigned",
    input.harnessId
  ].join("-");
}

function appendIfValue(args: string[], flag: string, value: string | undefined): void {
  const cleaned = clean(value);
  if (cleaned !== undefined) args.push(flag, cleaned);
}

function codexArgs(input: WorkerSessionLaunchRequest, cwd: string): readonly string[] {
  const args: string[] = [];
  appendIfValue(args, "--model", input.model);
  args.push("--cd", cwd);
  args.push("--ask-for-approval", clean(input.approvalPolicy) ?? "on-request");
  args.push("--sandbox", clean(input.sandbox) ?? "workspace-write");
  args.push(input.prompt);
  return args;
}

function claudeArgs(input: WorkerSessionLaunchRequest, name: string): readonly string[] {
  const args: string[] = ["--bg", "--name", name];
  appendIfValue(args, "--model", input.model);
  appendIfValue(args, "--effort", input.effort);
  args.push("--permission-mode", clean(input.permissionMode) ?? "default");
  args.push(input.prompt);
  return args;
}

export function buildWorkerLaunchPlan(
  input: WorkerSessionLaunchRequest,
  root = process.cwd(),
  sessionId = `worker-${randomUUID()}`
): WorkerLaunchPlan {
  const cwd = clean(input.cwd) ?? root;
  const name = sessionName(input);
  const command = input.harnessId === "codex" ? "codex" : "claude";
  const args = input.harnessId === "codex" ? codexArgs(input, cwd) : claudeArgs(input, name);
  return {
    sessionId,
    harnessId: input.harnessId,
    command,
    args,
    cwd,
    model: clean(input.model),
    effort: clean(input.effort),
    loopId: input.loopId,
    beadId: clean(input.beadId),
    sessionName: name,
    prompt: input.prompt,
    evidence: [
      `worker.session.plan:${sessionId}`,
      `worker.session.harness:${input.harnessId}`,
      `worker.session.loop:${input.loopId}`,
      ...(input.beadId === undefined ? [] : [`worker.session.bead:${input.beadId}`]),
      input.dryRun === true ? "worker.session.dry_run:true" : "worker.session.dry_run:false"
    ]
  };
}

export class WorkerSessionSupervisor {
  private readonly sessions = new Map<string, WorkerSessionRecord>();
  private readonly handles = new Map<string, WorkerProcessHandle>();

  constructor(
    private readonly root = process.cwd(),
    private readonly launcher: WorkerProcessLauncher = new NodeWorkerProcessLauncher(),
    private readonly clock: WorkerClock = defaultClock
  ) {}

  launch(input: WorkerSessionLaunchRequest): WorkerSessionRecord {
    const plan = buildWorkerLaunchPlan(input, this.root);
    if (input.dryRun === true) {
      const record: WorkerSessionRecord = {
        ...plan,
        state: "planned",
        evidence: [...plan.evidence, "worker.session.launch:planned"]
      };
      this.sessions.set(plan.sessionId, record);
      return record;
    }

    const handle = this.launcher.launch(plan.command, plan.args, {
      cwd: plan.cwd,
      env: process.env,
      detached: true,
      stdio: "ignore"
    });
    const started: WorkerSessionRecord = {
      ...plan,
      state: "running",
      pid: handle.pid,
      startedAt: this.clock.now(),
      evidence: [...plan.evidence, "worker.session.launch:started", ...(handle.pid === undefined ? [] : [`worker.session.pid:${handle.pid}`])]
    };
    this.sessions.set(plan.sessionId, started);
    this.handles.set(plan.sessionId, handle);
    handle.onExit((exitCode, signal) => {
      const current = this.sessions.get(plan.sessionId);
      if (current === undefined || current.state !== "running") return;
      this.sessions.set(plan.sessionId, {
        ...current,
        state: exitCode === 0 ? "completed" : "failed",
        exitCode,
        signal,
        stoppedAt: this.clock.now(),
        cleanupReason: exitCode === 0 ? "worker exited successfully" : "worker process exited",
        evidence: [
          ...current.evidence,
          `worker.session.exit_code:${exitCode ?? "none"}`,
          `worker.session.signal:${signal ?? "none"}`
        ]
      });
      this.handles.delete(plan.sessionId);
    });
    return started;
  }

  list(): readonly WorkerSessionRecord[] {
    return [...this.sessions.values()];
  }

  get(sessionId: string): WorkerSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  stop(sessionId: string, reason: string, signal: NodeJS.Signals = "SIGTERM"): WorkerSessionRecord {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`worker session not found: ${sessionId}`);
    }
    if (session.state !== "running") {
      const shouldMarkStopped = session.state === "planned";
      const updated: WorkerSessionRecord = {
        ...session,
        state: shouldMarkStopped ? "stopped" : session.state,
        stoppedAt: shouldMarkStopped ? this.clock.now() : session.stoppedAt,
        cleanupReason: reason,
        evidence: [
          ...session.evidence,
          "worker.session.stop:not_running",
          `worker.session.stop.reason:${reason}`
        ]
      };
      this.sessions.set(sessionId, updated);
      return updated;
    }
    const stopped = this.handles.get(sessionId)?.stop(signal) ?? false;
    const updated: WorkerSessionRecord = {
      ...session,
      state: "stopped",
      stoppedAt: this.clock.now(),
      cleanupReason: reason,
      signal,
      evidence: [
        ...session.evidence,
        `worker.session.stop:${stopped ? "sent" : "missing_handle"}`,
        `worker.session.stop.reason:${reason}`
      ]
    };
    this.sessions.set(sessionId, updated);
    this.handles.delete(sessionId);
    return updated;
  }
}
