import type { CicloEventSink } from "./ciclo-events.js";
import type { BeadsTaskSnapshot } from "./beads-adapter.js";
import { selectAndClaimBeadsWork, type BeadsWorkClaimClient } from "./beads-work-queue.js";
import { mergeWorkerLaunchWithConfig, type CicloProjectConfig } from "./ciclo-config.js";
import type { OpenAiBrain } from "./openai-brain.js";
import type {
  RemoteHeartbeatClient,
  RemoteSessionRecord,
  RemoteSessionRegistry
} from "./remote-session-registry.js";
import type {
  WorkerHarnessId,
  WorkerIsolationMode,
  WorkerSessionRecord,
  WorkerSessionSupervisor
} from "./worker-session-supervisor.js";

export interface CicloInternalHeartbeatRuntime {
  readonly auth?: {
    readonly session: {
      readonly id: string;
      readonly projectRoot: string;
      readonly ownerPrincipalId?: string;
    };
  };
  readonly projectConfig?: CicloProjectConfig;
  readonly workerSupervisor?: WorkerSessionSupervisor;
  readonly beadsClient?: BeadsWorkClaimClient;
  readonly remoteSessionRegistry?: RemoteSessionRegistry;
  readonly remoteHeartbeatClient?: RemoteHeartbeatClient;
  readonly openAiBrain?: OpenAiBrain;
  readonly eventStore?: CicloEventSink;
  readonly claudeChannel?: {
    readonly enabled: boolean;
  };
}

export interface CicloInternalHeartbeatOptions {
  readonly intervalMs?: number;
  readonly workerStaleAfterMs?: number;
  readonly remoteStaleAfterMs?: number;
  readonly remoteLostAfterMs?: number;
  readonly now?: () => string;
}

export interface CicloInternalHeartbeatTickResult {
  readonly checkedAt: string;
  readonly firstWake: boolean;
  readonly workersRefreshed: number;
  readonly workersStalled: readonly WorkerSessionRecord[];
  readonly workerChecked: number;
  readonly claudeCodeWorkers: number;
  readonly remoteChecked: number;
  readonly remoteChanged: readonly RemoteSessionRecord[];
  readonly readyWorkChecked: number;
  readonly idleWorkersLaunched: readonly WorkerSessionRecord[];
  readonly brainDecisions: readonly string[];
  readonly claudeChannel: {
    readonly enabled: boolean;
    readonly communicationReady: boolean;
    readonly connectedWorkers: number;
  };
  readonly monologue: readonly CicloInternalHeartbeatMonologueEntry[];
  readonly evidence: readonly string[];
}

export interface CicloInternalHeartbeatMonologueEntry {
  readonly at: string;
  readonly message: string;
  readonly evidence: readonly string[];
}

export interface CicloInternalHeartbeatStatus {
  readonly running: boolean;
  readonly intervalMs: number;
  readonly lastTickAt?: string;
  readonly claudeChannel: {
    readonly enabled: boolean;
    readonly communicationReady: boolean;
    readonly connectedWorkers: number;
  };
  readonly monologue: readonly CicloInternalHeartbeatMonologueEntry[];
  readonly evidence: readonly string[];
}

const defaultIntervalMs = 30_000;
const defaultWorkerStaleAfterMs = 10 * 60 * 1000;
const defaultRemoteStaleAfterMs = 2 * 60 * 1000;
const defaultRemoteLostAfterMs = 10 * 60 * 1000;
const maxMonologueEntries = 50;

interface PreemptiveWorkPolicy {
  readonly enabled: boolean;
  readonly loopId: string;
  readonly harnessId: WorkerHarnessId;
  readonly issueTypes: readonly string[];
  readonly maxConcurrent: number;
  readonly dryRun: boolean;
  readonly isolation: WorkerIsolationMode;
  readonly configureMcp: boolean;
  readonly model?: string;
  readonly effort?: string;
}

const defaultPreemptiveWork: PreemptiveWorkPolicy = {
  enabled: true,
  loopId: "preemptive-beads",
  harnessId: "codex",
  issueTypes: ["epic", "feature"],
  maxConcurrent: 1,
  dryRun: false,
  isolation: "worktree",
  configureMcp: true
};

function activeRemote(session: RemoteSessionRecord): boolean {
  return session.state !== "detached" && session.state !== "lost" && session.state !== "done";
}

function activeWorker(session: WorkerSessionRecord): boolean {
  return session.state === "planned" || session.state === "running" || session.state === "waiting_on_operator" || session.state === "stalled";
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

export class CicloInternalHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private lastTickAt: string | undefined;
  private lastClaudeChannel = {
    enabled: false,
    communicationReady: false,
    connectedWorkers: 0
  };
  private readonly monologueEntries: CicloInternalHeartbeatMonologueEntry[] = [];

  constructor(
    private readonly runtime: CicloInternalHeartbeatRuntime,
    private readonly options: CicloInternalHeartbeatOptions = {}
  ) {}

  get intervalMs(): number {
    return this.options.intervalMs ?? defaultIntervalMs;
  }

  start(): void {
    if (this.timer !== undefined) return;
    const at = this.options.now?.() ?? new Date().toISOString();
    this.appendMonologue(at, "Ciclo internal heartbeat started.", ["heartbeat.internal:started"]);
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    const at = this.options.now?.() ?? new Date().toISOString();
    this.appendMonologue(at, "Ciclo internal heartbeat stopped.", ["heartbeat.internal:stopped"]);
  }

  status(): CicloInternalHeartbeatStatus {
    const claudeChannel = this.claudeChannelSnapshot();
    const evidence = [
      this.timer === undefined ? "heartbeat.internal:stopped" : "heartbeat.internal:running",
      `heartbeat.interval_ms:${this.intervalMs}`,
      claudeChannel.enabled ? "heartbeat.claude_channel:enabled" : "heartbeat.claude_channel:disabled",
      `heartbeat.claude_channel.connected_workers:${claudeChannel.connectedWorkers}`
    ];
    return {
      running: this.timer !== undefined,
      intervalMs: this.intervalMs,
      ...(this.lastTickAt === undefined ? {} : { lastTickAt: this.lastTickAt }),
      claudeChannel,
      monologue: [...this.monologueEntries],
      evidence
    };
  }

  async tick(): Promise<CicloInternalHeartbeatTickResult> {
    const checkedAt = this.options.now?.() ?? new Date().toISOString();
    const firstWake = this.lastTickAt === undefined;
    const workersRefreshed = this.runtime.workerSupervisor?.refreshDetachedAgents() ?? [];
    const workersStalled = this.runtime.workerSupervisor?.refreshStalled(
      this.options.workerStaleAfterMs ?? defaultWorkerStaleAfterMs,
      checkedAt
    ) ?? [];

    const workers = this.runtime.workerSupervisor?.list() ?? [];
    const claudeCodeWorkers = workers.filter((worker) => worker.harnessId === "claude-code").length;
    const claudeChannel = this.claudeChannelSnapshot();
    this.lastClaudeChannel = claudeChannel;
    const remoteChanged = await this.checkRemoteSessions(checkedAt);
    const idleDispatch = await this.dispatchReadyBeadsWork(checkedAt, workers);
    const followUpBrainDecisions = await this.decideFollowUps([...workersStalled], remoteChanged);
    const brainDecisions = [...idleDispatch.brainDecisions, ...followUpBrainDecisions];

    const evidence = [
      "heartbeat.internal:tick",
      `heartbeat.worker.checked:${workers.length}`,
      `heartbeat.worker.refreshed:${workersRefreshed.length}`,
      `heartbeat.worker.stalled:${workersStalled.length}`,
      `heartbeat.ready_work.checked:${idleDispatch.readyWorkChecked}`,
      `heartbeat.idle_workers.launched:${idleDispatch.launched.length}`,
      claudeChannel.enabled ? "heartbeat.claude_channel:enabled" : "heartbeat.claude_channel:disabled",
      `heartbeat.claude_channel.connected_workers:${claudeChannel.connectedWorkers}`,
      `heartbeat.remote.changed:${remoteChanged.length}`,
      `heartbeat.brain.decisions:${brainDecisions.length}`,
      `heartbeat.first_wake:${firstWake}`
    ];
    const monologue = this.tickMonologue(checkedAt, {
      firstWake,
      workerChecked: workers.length,
      workersStalled: workersStalled.length,
      remoteChanged: remoteChanged.length,
      readyWorkChecked: idleDispatch.readyWorkChecked,
      idleWorkersLaunched: idleDispatch.launched.length,
      brainDecisions: brainDecisions.length,
      claudeChannel
    });
    this.lastTickAt = checkedAt;
    this.runtime.eventStore?.append({
      type: "heartbeat.tick",
      at: checkedAt,
      evidence,
      data: {
        workers_checked: workers.length,
        workers_refreshed: workersRefreshed.length,
        workers_stalled: workersStalled.length,
        ready_work_checked: idleDispatch.readyWorkChecked,
        idle_workers_launched: idleDispatch.launched.length,
        claude_channel: claudeChannel,
        remote_changed: remoteChanged.length,
        brain_decisions: brainDecisions.length,
        first_wake: firstWake
      }
    });

    return {
      checkedAt,
      firstWake,
      workersRefreshed: workersRefreshed.length,
      workersStalled,
      workerChecked: workers.length,
      claudeCodeWorkers,
      remoteChecked: this.runtime.remoteSessionRegistry?.list().filter(activeRemote).length ?? 0,
      remoteChanged,
      readyWorkChecked: idleDispatch.readyWorkChecked,
      idleWorkersLaunched: idleDispatch.launched,
      brainDecisions,
      claudeChannel,
      monologue,
      evidence
    };
  }

  private appendMonologue(
    at: string,
    message: string,
    evidence: readonly string[]
  ): CicloInternalHeartbeatMonologueEntry {
    const entry = { at, message, evidence };
    this.monologueEntries.push(entry);
    if (this.monologueEntries.length > maxMonologueEntries) {
      this.monologueEntries.splice(0, this.monologueEntries.length - maxMonologueEntries);
    }
    this.runtime.eventStore?.append({
      type: "heartbeat.monologue",
      at,
      evidence,
      data: { message }
    });
    return entry;
  }

  private claudeChannelSnapshot(): CicloInternalHeartbeatTickResult["claudeChannel"] {
    const claudeCodeWorkers = this.runtime.workerSupervisor?.list().filter((worker) => worker.harnessId === "claude-code").length ?? 0;
    const enabled = this.runtime.claudeChannel?.enabled === true;
    return {
      enabled,
      communicationReady: enabled && claudeCodeWorkers > 0,
      connectedWorkers: enabled ? claudeCodeWorkers : 0
    };
  }

  private tickMonologue(
    at: string,
    input: {
      readonly firstWake: boolean;
      readonly workerChecked: number;
      readonly workersStalled: number;
      readonly remoteChanged: number;
      readonly readyWorkChecked: number;
      readonly idleWorkersLaunched: number;
      readonly brainDecisions: number;
      readonly claudeChannel: CicloInternalHeartbeatTickResult["claudeChannel"];
    }
  ): readonly CicloInternalHeartbeatMonologueEntry[] {
    const messages = [
      ...(input.firstWake
        ? [
            "First wake should analyze repo, Beads, Herdr, PR/CI, remote, context, and worker state before choosing the first work to start."
          ]
        : []),
      `Heartbeat checked ${input.workerChecked} worker session(s); ${input.workersStalled} stalled, ${input.remoteChanged} remote update(s), ${input.readyWorkChecked} ready Beads candidate(s), ${input.idleWorkersLaunched} worker launch(es), ${input.brainDecisions} brain decision(s).`,
      "Heartbeat memory pass should keep Beads open/closed state, PR review needs, and model fit or escalation decisions current.",
      input.claudeChannel.enabled
        ? `Claude channel communication is enabled for ${input.claudeChannel.connectedWorkers} Claude Code worker session(s).`
        : "Claude channel communication is disabled for this Ciclo MCP runtime."
    ];
    return messages.map((message, index) =>
      this.appendMonologue(at, message, [
        "heartbeat.internal:monologue",
        ...(input.firstWake && index === 0
          ? [
              "heartbeat.first_wake:true",
              "startup.state_analysis:required",
              "startup.first_work.selection:required"
            ]
          : []),
        input.claudeChannel.enabled ? "heartbeat.claude_channel:enabled" : "heartbeat.claude_channel:disabled"
      ])
    );
  }

  private preemptiveWorkPolicy(): PreemptiveWorkPolicy {
    const config = this.runtime.projectConfig?.heartbeat?.preemptiveWork;
    return {
      enabled: config?.enabled ?? defaultPreemptiveWork.enabled,
      loopId: config?.loopId ?? defaultPreemptiveWork.loopId,
      harnessId: config?.harnessId ?? defaultPreemptiveWork.harnessId,
      issueTypes: [...(config?.issueTypes ?? defaultPreemptiveWork.issueTypes)],
      maxConcurrent: config?.maxConcurrent ?? defaultPreemptiveWork.maxConcurrent,
      dryRun: config?.dryRun ?? defaultPreemptiveWork.dryRun,
      isolation: config?.isolation ?? defaultPreemptiveWork.isolation,
      configureMcp: config?.configureMcp ?? defaultPreemptiveWork.configureMcp,
      ...(config?.model === undefined ? {} : { model: config.model }),
      ...(config?.effort === undefined ? {} : { effort: config.effort })
    };
  }

  private async dispatchReadyBeadsWork(
    checkedAt: string,
    workers: readonly WorkerSessionRecord[]
  ): Promise<{
    readonly readyWorkChecked: number;
    readonly launched: readonly WorkerSessionRecord[];
    readonly brainDecisions: readonly string[];
  }> {
    const supervisor = this.runtime.workerSupervisor;
    const beadsClient = this.runtime.beadsClient;
    if (supervisor === undefined || beadsClient === undefined) {
      return { readyWorkChecked: 0, launched: [], brainDecisions: [] };
    }

    const policy = this.preemptiveWorkPolicy();
    if (!policy.enabled) {
      this.runtime.eventStore?.append({
        type: "work.ready_listed",
        at: checkedAt,
        loopId: policy.loopId,
        evidence: ["heartbeat.preemptive_work:disabled"],
        data: { checked: 0, selected: null, skipped: [] }
      });
      return { readyWorkChecked: 0, launched: [], brainDecisions: [] };
    }

    const activeCount = workers.filter(activeWorker).length;
    const loop = {
      id: policy.loopId,
      kind: "beads_work" as const,
      goal: "Discover ready Beads epic/feature work and start an appropriate Ciclo-managed worker.",
      harnesses: [policy.harnessId],
      dryRun: policy.dryRun
    };
    const result = await selectAndClaimBeadsWork(beadsClient, {
      selector: {
        loop,
        issueTypes: policy.issueTypes,
        capacity: {
          activeCount,
          maxConcurrent: policy.maxConcurrent
        }
      },
      limit: 20,
      harnessId: policy.harnessId,
      principalId: this.runtime.auth?.session.ownerPrincipalId,
      sessionId: this.runtime.auth?.session.id
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : "unknown Beads error";
      this.runtime.eventStore?.append({
        type: "work.ready_listed",
        at: checkedAt,
        loopId: policy.loopId,
        evidence: ["beads.ready:unavailable", "heartbeat.preemptive_work:skipped"],
        data: {
          checked: 0,
          selected: null,
          skipped: [],
          reason
        }
      });
      return undefined;
    });

    if (result === undefined) {
      return { readyWorkChecked: 0, launched: [], brainDecisions: [] };
    }

    const readyWorkChecked = result.selection.skipped.length + (result.selection.selected === undefined ? 0 : 1);
    this.runtime.eventStore?.append({
      type: "work.ready_listed",
      at: checkedAt,
      loopId: policy.loopId,
      beadId: result.selection.selected?.id,
      evidence: result.evidence,
      data: {
        checked: readyWorkChecked,
        selected: result.selection.selected?.id ?? null,
        skipped: result.selection.skipped,
        reason: result.reason,
        issue_types: policy.issueTypes,
        active_workers: activeCount,
        max_concurrent: policy.maxConcurrent
      }
    });

    if (!result.claimed || result.after === undefined) {
      return { readyWorkChecked, launched: [], brainDecisions: [] };
    }

    this.runtime.eventStore?.append({
      type: "bead.claimed",
      at: checkedAt,
      loopId: policy.loopId,
      beadId: result.after.id,
      evidence: result.evidence,
      data: {
        title: result.after.title,
        issue_type: result.after.issueType,
        harness_id: policy.harnessId,
        preemptive: true
      }
    });

    const brainDecision = await this.decideReadyWorkLaunch(result.after, policy);
    const prompt = this.readyWorkPrompt(result.after, brainDecision);
    const launchRequest = mergeWorkerLaunchWithConfig(
      {
        harnessId: policy.harnessId,
        loopId: policy.loopId,
        beadId: result.after.id,
        prompt,
        cwd: this.runtime.auth?.session.projectRoot,
        dryRun: policy.dryRun,
        isolation: policy.isolation,
        configureMcp: policy.configureMcp,
        ...(policy.model === undefined ? {} : { model: policy.model }),
        ...(policy.effort === undefined ? {} : { effort: policy.effort })
      },
      this.runtime.projectConfig ?? {}
    );
    const launched = (() => {
      try {
        return supervisor.launch(launchRequest);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : "unknown worker launch failure";
        this.runtime.eventStore?.append({
          type: "blocker.raised",
          at: checkedAt,
          loopId: policy.loopId,
          beadId: result.after.id,
          evidence: ["heartbeat.preemptive_work:launch_failed", ...result.evidence],
          data: {
            reason,
            harness_id: policy.harnessId,
            preemptive: true
          }
        });
        return undefined;
      }
    })();
    if (launched === undefined) {
      return {
        readyWorkChecked,
        launched: [],
        brainDecisions: brainDecision === undefined ? [] : [brainDecision]
      };
    }
    this.runtime.eventStore?.append({
      type: "work.started",
      at: checkedAt,
      loopId: policy.loopId,
      beadId: result.after.id,
      workerSessionId: launched.sessionId,
      state: launched.state,
      evidence: [...result.evidence, ...launched.evidence],
      data: {
        title: result.after.title,
        issue_type: result.after.issueType,
        harness_id: launched.harnessId,
        launch_mode: launched.launchMode,
        tracking_mode: launched.trackingMode,
        preemptive: true,
        dry_run: policy.dryRun
      }
    });

    return {
      readyWorkChecked,
      launched: [launched],
      brainDecisions: brainDecision === undefined ? [] : [brainDecision]
    };
  }

  private async decideReadyWorkLaunch(
    task: BeadsTaskSnapshot,
    policy: PreemptiveWorkPolicy
  ): Promise<string | undefined> {
    const brain = this.runtime.openAiBrain;
    if (brain === undefined) return undefined;
    const decision = await brain.decide({
      purpose: "remote_session_monitoring",
      loopId: policy.loopId,
      beadId: task.id,
      harnessId: policy.harnessId,
      prompt: "Ciclo discovered ready Beads epic or feature work while idle. Decide whether launching a worker is appropriate, what context that worker needs first, what model/effort is suitable, what should be kept in Beads memory, and what operator feedback should be surfaced before risky actions.",
      context: [
        `id=${task.id}`,
        `title=${task.title}`,
        `issue_type=${task.issueType}`,
        `priority=${task.priority}`,
        `labels=${task.labels.join(",") || "none"}`,
        `description=${compactText(task.description, 600) || "none"}`,
        `acceptance=${compactText(task.acceptanceCriteria, 600) || "none"}`,
        `configured_harness=${policy.harnessId}`,
        `configured_model=${policy.model ?? "unspecified"}`,
        `configured_effort=${policy.effort ?? "unspecified"}`
      ],
      evidence: [`beads.ready.selected:${task.id}`, "heartbeat.preemptive_work:brain_decision"]
    });
    this.runtime.eventStore?.append({
      type: "brain.decision",
      loopId: policy.loopId,
      beadId: task.id,
      evidence: decision.evidence,
      data: {
        purpose: decision.purpose,
        intelligence: decision.intelligence,
        model_family: decision.modelFamily,
        model: decision.model,
        decision: decision.text
      }
    });
    return decision.text;
  }

  private readyWorkPrompt(task: BeadsTaskSnapshot, brainDecision: string | undefined): string {
    return [
      `Work Beads ${task.id}: ${task.title}`,
      "",
      "You are a Ciclo-managed worker launched by the internal heartbeat because the project had ready epic/feature work and idle capacity.",
      "Use the Ciclo MCP and Beads as the shared control plane. Inspect the Bead before editing, keep Beads notes current, create or claim child tasks when the epic/feature needs decomposition, and surface blockers or risky changes back to the controller instead of guessing.",
      "Prefer a small demoable slice with validation. Launch or request review work when code is ready, and do not close the Bead until acceptance criteria are met.",
      "",
      `Issue type: ${task.issueType}`,
      `Priority: ${task.priority}`,
      `Labels: ${task.labels.join(", ") || "none"}`,
      task.description.trim().length === 0 ? undefined : `Description: ${compactText(task.description, 1200)}`,
      task.acceptanceCriteria.trim().length === 0 ? undefined : `Acceptance criteria: ${compactText(task.acceptanceCriteria, 1200)}`,
      brainDecision === undefined ? undefined : `Ciclo brain guidance: ${compactText(brainDecision, 1200)}`
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  private async checkRemoteSessions(now: string): Promise<readonly RemoteSessionRecord[]> {
    const registry = this.runtime.remoteSessionRegistry;
    if (registry === undefined) return [];
    const client = this.runtime.remoteHeartbeatClient;
    if (client === undefined) {
      const changed = registry.markExpired(
        now,
        this.options.remoteStaleAfterMs ?? defaultRemoteStaleAfterMs,
        this.options.remoteLostAfterMs ?? defaultRemoteLostAfterMs
      );
      for (const session of changed) {
        this.runtime.eventStore?.append({
          type: session.state === "lost" ? "remote_session.lost" : "remote_session.stale",
          at: now,
          loopId: session.activeLoopId,
          beadId: session.activeBeadId,
          evidence: session.evidence,
          data: { remote_session_id: session.id, state: session.state }
        });
      }
      return changed;
    }

    const changed: RemoteSessionRecord[] = [];
    for (const session of registry.list().filter(activeRemote)) {
      const result = await registry.heartbeat(session.id, client, now);
      if (result.session !== undefined) {
        changed.push(result.session);
        this.runtime.eventStore?.append({
          type: "remote_session.heartbeat",
          at: now,
          loopId: result.session.activeLoopId,
          beadId: result.session.activeBeadId,
          evidence: result.evidence,
          data: { remote_session_id: result.session.id, state: result.session.state }
        });
      }
    }
    return changed;
  }

  private async decideFollowUps(
    workers: readonly WorkerSessionRecord[],
    remotes: readonly RemoteSessionRecord[]
  ): Promise<readonly string[]> {
    const brain = this.runtime.openAiBrain;
    if (brain === undefined) return [];
    const decisions: string[] = [];
    for (const worker of workers) {
      const decision = await brain.decide({
        purpose: "remote_session_monitoring",
        loopId: worker.loopId,
        beadId: worker.beadId,
        harnessId: worker.harnessId,
        workerSessionId: worker.sessionId,
        prompt: "A Ciclo-managed worker session became stalled during internal heartbeat monitoring. Build or update project memory first: what work should remain open, what can close only with acceptance and validation, what needs PR review, which model/effort fits this kind of work, and whether the stuck session should be escalated to a stronger model or relaunched. Decide whether to nudge, add context, ask the operator, launch review, escalate model, or wait.",
        context: [
          `state=${worker.state}`,
          `launch_mode=${worker.launchMode}`,
          `tracking_mode=${worker.trackingMode}`,
          `cwd=${worker.cwd}`,
          `model=${worker.model ?? "unspecified"}`,
          `effort=${worker.effort ?? "unspecified"}`
        ],
        evidence: worker.evidence
      });
      decisions.push(decision.text);
      this.runtime.eventStore?.append({
        type: "brain.decision",
        loopId: worker.loopId,
        beadId: worker.beadId,
        workerSessionId: worker.sessionId,
        evidence: decision.evidence,
        data: {
          purpose: decision.purpose,
          intelligence: decision.intelligence,
          model_family: decision.modelFamily,
          model: decision.model,
          decision: decision.text
        }
      });
    }
    for (const remote of remotes) {
      if (remote.state !== "stale" && remote.state !== "lost" && remote.state !== "blocked") continue;
      const decision = await brain.decide({
        purpose: "remote_session_monitoring",
        loopId: remote.activeLoopId,
        beadId: remote.activeBeadId,
        harnessId: remote.harnesses[0],
        remoteSessionId: remote.id,
        prompt: "A Ciclo-managed remote session needs follow-up during internal heartbeat monitoring. Build or update project memory first: ownership, open/closed Beads state, pending PR review, model fit, and whether the work should be reassigned or escalated to a stronger model. Decide whether to reattach, add context, ask the operator, escalate model, or reassign work.",
        context: [
          `state=${remote.state}`,
          `transport=${remote.transport}`,
          `project_path=${remote.projectPath}`
        ],
        evidence: remote.evidence
      });
      decisions.push(decision.text);
      this.runtime.eventStore?.append({
        type: "brain.decision",
        loopId: remote.activeLoopId,
        beadId: remote.activeBeadId,
        evidence: decision.evidence,
        data: {
          purpose: decision.purpose,
          remote_session_id: remote.id,
          intelligence: decision.intelligence,
          model_family: decision.modelFamily,
          model: decision.model,
          decision: decision.text
        }
      });
    }
    return decisions;
  }
}
