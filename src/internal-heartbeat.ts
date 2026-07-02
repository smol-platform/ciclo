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
  readonly workersRefreshed: number;
  readonly workersStalled: readonly WorkerSessionRecord[];
  readonly remoteChecked: number;
  readonly remoteChanged: readonly RemoteSessionRecord[];
  readonly brainDecisions: readonly string[];
  readonly evidence: readonly string[];
}

const defaultIntervalMs = 30_000;
const defaultWorkerStaleAfterMs = 10 * 60 * 1000;
const defaultRemoteStaleAfterMs = 2 * 60 * 1000;
const defaultRemoteLostAfterMs = 10 * 60 * 1000;

function activeRemote(session: RemoteSessionRecord): boolean {
  return session.state !== "detached" && session.state !== "lost" && session.state !== "done";
}

export class CicloInternalHeartbeat {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly runtime: CicloInternalHeartbeatRuntime,
    private readonly options: CicloInternalHeartbeatOptions = {}
  ) {}

  get intervalMs(): number {
    return this.options.intervalMs ?? defaultIntervalMs;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<CicloInternalHeartbeatTickResult> {
    const checkedAt = this.options.now?.() ?? new Date().toISOString();
    const workersRefreshed = this.runtime.workerSupervisor?.refreshDetachedAgents() ?? [];
    const workersStalled = this.runtime.workerSupervisor?.refreshStalled(
      this.options.workerStaleAfterMs ?? defaultWorkerStaleAfterMs,
      checkedAt
    ) ?? [];

    const remoteChanged = await this.checkRemoteSessions(checkedAt);
    const brainDecisions = await this.decideFollowUps([...workersStalled], remoteChanged);

    const evidence = [
      "heartbeat.internal:tick",
      `heartbeat.worker.refreshed:${workersRefreshed.length}`,
      `heartbeat.worker.stalled:${workersStalled.length}`,
      `heartbeat.remote.changed:${remoteChanged.length}`,
      `heartbeat.brain.decisions:${brainDecisions.length}`
    ];
    this.runtime.eventStore?.append({
      type: "heartbeat.tick",
      at: checkedAt,
      evidence,
      data: {
        workers_refreshed: workersRefreshed.length,
        workers_stalled: workersStalled.length,
        remote_changed: remoteChanged.length,
        brain_decisions: brainDecisions.length
      }
    });

    return {
      checkedAt,
      workersRefreshed: workersRefreshed.length,
      workersStalled,
      remoteChecked: this.runtime.remoteSessionRegistry?.list().filter(activeRemote).length ?? 0,
      remoteChanged,
      brainDecisions,
      evidence
    };
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
        prompt: "A Ciclo-managed worker session became stalled during internal heartbeat monitoring. Decide whether to nudge, add context, ask the operator, or wait.",
        context: [
          `state=${worker.state}`,
          `launch_mode=${worker.launchMode}`,
          `tracking_mode=${worker.trackingMode}`,
          `cwd=${worker.cwd}`
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
        data: { purpose: decision.purpose, decision: decision.text }
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
        prompt: "A Ciclo-managed remote session needs follow-up during internal heartbeat monitoring. Decide whether to reattach, add context, ask the operator, or reassign work.",
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
        data: { purpose: decision.purpose, remote_session_id: remote.id, decision: decision.text }
      });
    }
    return decisions;
  }
}
