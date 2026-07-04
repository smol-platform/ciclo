import type { CicloEventSink } from "./ciclo-events.js";
import type { OpenAiBrain } from "./openai-brain.js";
import type {
  RemoteHeartbeatClient,
  RemoteSessionRecord,
  RemoteSessionRegistry
} from "./remote-session-registry.js";
import type {
  WorkerSessionRecord,
  WorkerSessionSupervisor
} from "./worker-session-supervisor.js";

export interface CicloInternalHeartbeatRuntime {
  readonly workerSupervisor?: WorkerSessionSupervisor;
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

function activeRemote(session: RemoteSessionRecord): boolean {
  return session.state !== "detached" && session.state !== "lost" && session.state !== "done";
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
    const brainDecisions = await this.decideFollowUps([...workersStalled], remoteChanged);

    const evidence = [
      "heartbeat.internal:tick",
      `heartbeat.worker.checked:${workers.length}`,
      `heartbeat.worker.refreshed:${workersRefreshed.length}`,
      `heartbeat.worker.stalled:${workersStalled.length}`,
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
      `Heartbeat checked ${input.workerChecked} worker session(s); ${input.workersStalled} stalled, ${input.remoteChanged} remote update(s), ${input.brainDecisions} brain decision(s).`,
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
