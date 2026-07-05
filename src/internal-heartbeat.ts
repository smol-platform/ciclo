import type { CicloEventSink } from "./ciclo-events.js";
import type { BeadsTaskSnapshot } from "./beads-adapter.js";
import { selectAndClaimBeadsWork, type BeadsWorkClaimClient } from "./beads-work-queue.js";
import { CicloCronScheduler, type CicloCronDueJob, type CicloCronRunRecord } from "./ciclo-cron.js";
import { CicloMemoryStore, type CicloMemoryCompactResult } from "./ciclo-memory.js";
import { mergeWorkerLaunchWithConfig, type CicloProjectConfig } from "./ciclo-config.js";
import type {
  OpenAiBrain,
  OpenAiBrainDecision,
  OpenAiBrainToolExecutor,
  OpenAiBrainToolName,
  OpenAiBrainToolRequest,
  OpenAiBrainToolResult,
  OpenAiControlAction
} from "./openai-brain.js";
import type {
  RemoteHeartbeatClient,
  RemoteSessionRecord,
  RemoteSessionRegistry
} from "./remote-session-registry.js";
import type {
  WorkerHarnessId,
  WorkerIsolationMode,
  WorkerSessionLaunchRequest,
  WorkerSessionRecord,
  WorkerSessionSupervisor,
  WorkerWorktreeRequest
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
  readonly cronScheduler?: CicloCronScheduler;
  readonly memoryStore?: CicloMemoryStore;
  readonly claudeChannel?: {
    readonly enabled: boolean;
  };
}

export interface CicloInternalHeartbeatOptions {
  readonly intervalMs?: number;
  readonly workerStaleAfterMs?: number;
  readonly workerRecoveryGraceMs?: number;
  readonly remoteStaleAfterMs?: number;
  readonly remoteLostAfterMs?: number;
  readonly now?: () => string;
}

export interface CicloInternalHeartbeatTickResult {
  readonly checkedAt: string;
  readonly firstWake: boolean;
  readonly workersRefreshed: number;
  readonly workerPromptSubmissions: number;
  readonly workersCleanedUp: readonly WorkerSessionRecord[];
  readonly workersStalled: readonly WorkerSessionRecord[];
  readonly workerRecoveryActions: readonly string[];
  readonly workerChecked: number;
  readonly claudeCodeWorkers: number;
  readonly remoteChecked: number;
  readonly remoteChanged: readonly RemoteSessionRecord[];
  readonly readyWorkChecked: number;
  readonly idleWorkersLaunched: readonly WorkerSessionRecord[];
  readonly brainDecisions: readonly string[];
  readonly cronDue: readonly CicloCronDueJob[];
  readonly cronRuns: readonly CicloCronRunRecord[];
  readonly memoryCompactions: readonly CicloMemoryCompactResult[];
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

function cronStringParam(params: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function cronBooleanParam(params: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function cronStringListParam(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function cronStringRecordParam(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") output[key] = entry;
  }
  return Object.keys(output).length === 0 ? undefined : output;
}

function cronWorkerHarnessId(value: string | undefined): WorkerHarnessId {
  return value === "claude-code" ? "claude-code" : "codex";
}

function cronIsolationMode(value: string | undefined): WorkerIsolationMode | undefined {
  if (value === "none" || value === "worktree") return value;
  return undefined;
}

function cronWorktreeRequest(value: unknown): WorkerWorktreeRequest | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const create = typeof record.create === "boolean" ? record.create : undefined;
  const path = typeof record.path === "string" && record.path.trim().length > 0 ? record.path.trim() : undefined;
  const branch = typeof record.branch === "string" && record.branch.trim().length > 0 ? record.branch.trim() : undefined;
  const base = typeof record.base === "string" && record.base.trim().length > 0 ? record.base.trim() : undefined;
  const force = typeof record.force === "boolean" ? record.force : undefined;
  if (create === undefined && path === undefined && branch === undefined && base === undefined && force === undefined) return undefined;
  return {
    ...(create === undefined ? {} : { create }),
    ...(path === undefined ? {} : { path }),
    ...(branch === undefined ? {} : { branch }),
    ...(base === undefined ? {} : { base }),
    ...(force === undefined ? {} : { force })
  };
}

export interface CicloInternalHeartbeatStatus {
  readonly running: boolean;
  readonly intervalMs: number;
  readonly lastTickAt?: string;
  readonly cron?: Record<string, unknown>;
  readonly memory?: Record<string, unknown>;
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
const defaultWorkerRecoveryGraceMs = 10 * 60 * 1000;
const defaultRemoteStaleAfterMs = 2 * 60 * 1000;
const defaultRemoteLostAfterMs = 10 * 60 * 1000;
const maxMonologueEntries = 50;

interface PreemptiveWorkPolicy {
  readonly enabled: boolean;
  readonly loopId: string;
  readonly harnesses: readonly PreemptiveHarnessProfile[];
  readonly issueTypes: readonly string[];
  readonly fallbackIssueTypes: readonly string[];
  readonly maxConcurrent: number;
  readonly dryRun: boolean;
  readonly isolation: WorkerIsolationMode;
  readonly configureMcp: boolean;
  readonly model?: string;
  readonly effort?: string;
}

interface PreemptiveHarnessProfile {
  readonly harnessId: WorkerHarnessId;
  readonly model?: string;
  readonly effort?: string;
}

const defaultPreemptiveWork: PreemptiveWorkPolicy = {
  enabled: true,
  loopId: "preemptive-beads",
  harnesses: [
    { harnessId: "codex" },
    { harnessId: "claude-code", model: "claude-fable-5" }
  ],
  issueTypes: ["epic", "feature"],
  fallbackIssueTypes: ["task", "bug", "decision"],
  maxConcurrent: 10,
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

function elapsedMs(fromIso: string | undefined, toIso: string): number | undefined {
  if (fromIso === undefined) return undefined;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  return Math.max(0, to - from);
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

function paramString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function paramNumber(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function paramBoolean(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}

function toolResultData(result: OpenAiBrainToolResult): Record<string, unknown> {
  return {
    name: result.name,
    ok: result.ok,
    summary: result.summary,
    evidence: result.evidence
  };
}

function stableHash(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function uniqueHarnessProfiles(input: readonly PreemptiveHarnessProfile[]): readonly PreemptiveHarnessProfile[] {
  const seen = new Set<WorkerHarnessId>();
  const output: PreemptiveHarnessProfile[] = [];
  for (const profile of input) {
    if (seen.has(profile.harnessId)) continue;
    seen.add(profile.harnessId);
    output.push(profile);
  }
  return output;
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
      ...(this.runtime.cronScheduler === undefined ? {} : { cron: this.runtime.cronScheduler.status(this.runtime.projectConfig?.cron?.jobs ?? [], this.options.now?.() ?? new Date().toISOString()) }),
      ...(this.runtime.memoryStore === undefined ? {} : { memory: this.runtime.memoryStore.status() }),
      claudeChannel,
      monologue: [...this.monologueEntries],
      evidence
    };
  }

  async tick(): Promise<CicloInternalHeartbeatTickResult> {
    const checkedAt = this.options.now?.() ?? new Date().toISOString();
    const firstWake = this.lastTickAt === undefined;
    const workersRefreshed = this.runtime.workerSupervisor?.refreshDetachedAgents() ?? [];
    const workerPromptSubmissions = this.runtime.workerSupervisor?.recoverPendingHerdrInputs() ?? [];
    const workersStalled = this.runtime.workerSupervisor?.refreshStalled(
      this.options.workerStaleAfterMs ?? defaultWorkerStaleAfterMs,
      checkedAt
    ) ?? [];
    const workersCleanedUp = this.runtime.workerSupervisor?.cleanupCompleted("heartbeat cleaned up completed worker session") ?? [];

    const workersBeforeRecovery = this.runtime.workerSupervisor?.list() ?? [];
    const claudeCodeWorkers = workersBeforeRecovery.filter((worker) => worker.harnessId === "claude-code").length;
    const claudeChannel = this.claudeChannelSnapshot();
    this.lastClaudeChannel = claudeChannel;
    const remoteChanged = await this.checkRemoteSessions(checkedAt);
    const followUps = await this.decideFollowUps(workersBeforeRecovery, remoteChanged, checkedAt);
    const workersAfterRecovery = this.runtime.workerSupervisor?.list() ?? workersBeforeRecovery;
    const idleDispatch = await this.dispatchReadyBeadsWork(checkedAt, workersAfterRecovery);
    const cron = await this.runDueCronJobs(checkedAt);
    const brainDecisions = [...followUps.brainDecisions, ...idleDispatch.brainDecisions, ...cron.brainDecisions];

    const evidence = [
      "heartbeat.internal:tick",
      `heartbeat.worker.checked:${workersBeforeRecovery.length}`,
      `heartbeat.worker.refreshed:${workersRefreshed.length}`,
      `heartbeat.worker.prompt_submissions:${workerPromptSubmissions.length}`,
      `heartbeat.worker.cleaned_up:${workersCleanedUp.length}`,
      `heartbeat.worker.stalled:${workersStalled.length}`,
      `heartbeat.worker.recovery_actions:${followUps.recoveryActions.length}`,
      `heartbeat.ready_work.checked:${idleDispatch.readyWorkChecked}`,
      `heartbeat.idle_workers.launched:${idleDispatch.launched.length}`,
      claudeChannel.enabled ? "heartbeat.claude_channel:enabled" : "heartbeat.claude_channel:disabled",
      `heartbeat.claude_channel.connected_workers:${claudeChannel.connectedWorkers}`,
      `heartbeat.remote.changed:${remoteChanged.length}`,
      `heartbeat.brain.decisions:${brainDecisions.length}`,
      `heartbeat.cron.due:${cron.due.length}`,
      `heartbeat.cron.ran:${cron.runs.length}`,
      `heartbeat.memory.compactions:${cron.memoryCompactions.length}`,
      `heartbeat.first_wake:${firstWake}`
    ];
    const monologue = this.tickMonologue(checkedAt, {
      firstWake,
      workerChecked: workersBeforeRecovery.length,
      workersCleanedUp: workersCleanedUp.length,
      workersStalled: workersStalled.length,
      workerPromptSubmissions: workerPromptSubmissions.length,
      remoteChanged: remoteChanged.length,
      readyWorkChecked: idleDispatch.readyWorkChecked,
      idleWorkersLaunched: idleDispatch.launched.length,
      brainDecisions: brainDecisions.length,
      cronRuns: cron.runs.length,
      memoryCompactions: cron.memoryCompactions.length,
      claudeChannel
    });
    this.lastTickAt = checkedAt;
    this.runtime.eventStore?.append({
      type: "heartbeat.tick",
      at: checkedAt,
      evidence,
      data: {
        workers_checked: workersBeforeRecovery.length,
        workers_refreshed: workersRefreshed.length,
        worker_prompt_submissions: workerPromptSubmissions.length,
        workers_cleaned_up: workersCleanedUp.length,
        workers_stalled: workersStalled.length,
        worker_recovery_actions: followUps.recoveryActions.length,
        ready_work_checked: idleDispatch.readyWorkChecked,
        idle_workers_launched: idleDispatch.launched.length,
        claude_channel: claudeChannel,
        remote_changed: remoteChanged.length,
        brain_decisions: brainDecisions.length,
        cron_due: cron.due.length,
        cron_runs: cron.runs.length,
        memory_compactions: cron.memoryCompactions.length,
        first_wake: firstWake
      }
    });

    return {
      checkedAt,
      firstWake,
      workersRefreshed: workersRefreshed.length,
      workerPromptSubmissions: workerPromptSubmissions.length,
      workersCleanedUp,
      workersStalled,
      workerRecoveryActions: followUps.recoveryActions,
      workerChecked: workersBeforeRecovery.length,
      claudeCodeWorkers,
      remoteChecked: this.runtime.remoteSessionRegistry?.list().filter(activeRemote).length ?? 0,
      remoteChanged,
      readyWorkChecked: idleDispatch.readyWorkChecked,
      idleWorkersLaunched: idleDispatch.launched,
      brainDecisions,
      cronDue: cron.due,
      cronRuns: cron.runs,
      memoryCompactions: cron.memoryCompactions,
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
      readonly workersCleanedUp: number;
      readonly workersStalled: number;
      readonly workerPromptSubmissions: number;
      readonly remoteChanged: number;
      readonly readyWorkChecked: number;
      readonly idleWorkersLaunched: number;
      readonly brainDecisions: number;
      readonly cronRuns: number;
      readonly memoryCompactions: number;
      readonly claudeChannel: CicloInternalHeartbeatTickResult["claudeChannel"];
    }
  ): readonly CicloInternalHeartbeatMonologueEntry[] {
    const messages = [
      ...(input.firstWake
        ? [
            "First wake should analyze repo, Beads, Herdr, PR/CI, remote, context, and worker state before choosing the first work to start."
          ]
        : []),
      `Heartbeat checked ${input.workerChecked} worker session(s); ${input.workersCleanedUp} completed session cleanup(s), ${input.workersStalled} stalled, ${input.workerPromptSubmissions} pending prompt submission(s), ${input.remoteChanged} remote update(s), ${input.readyWorkChecked} ready Beads candidate(s), ${input.idleWorkersLaunched} worker launch(es), ${input.brainDecisions} brain decision(s), ${input.cronRuns} cron run(s).`,
      `Heartbeat memory pass should keep Beads open/closed state, PR review needs, model fit or escalation decisions current, and compact durable memory when needed; ${input.memoryCompactions} memory compaction(s) ran.`,
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
    const configuredHarnesses = config?.harnessId !== undefined
      ? [{
          harnessId: config.harnessId,
          ...(config.model === undefined ? {} : { model: config.model }),
          ...(config.effort === undefined ? {} : { effort: config.effort })
        }]
      : uniqueHarnessProfiles(config?.harnesses ?? defaultPreemptiveWork.harnesses);
    return {
      enabled: config?.enabled ?? defaultPreemptiveWork.enabled,
      loopId: config?.loopId ?? defaultPreemptiveWork.loopId,
      harnesses: configuredHarnesses.length === 0 ? defaultPreemptiveWork.harnesses : configuredHarnesses,
      issueTypes: [...(config?.issueTypes ?? defaultPreemptiveWork.issueTypes)],
      fallbackIssueTypes: [...(config?.fallbackIssueTypes ?? defaultPreemptiveWork.fallbackIssueTypes)],
      maxConcurrent: config?.maxConcurrent ?? defaultPreemptiveWork.maxConcurrent,
      dryRun: config?.dryRun ?? defaultPreemptiveWork.dryRun,
      isolation: config?.isolation ?? defaultPreemptiveWork.isolation,
      configureMcp: config?.configureMcp ?? defaultPreemptiveWork.configureMcp,
      ...(config?.model === undefined ? {} : { model: config.model }),
      ...(config?.effort === undefined ? {} : { effort: config.effort })
    };
  }

  private preemptiveSelectionStages(policy: PreemptiveWorkPolicy): readonly {
    readonly stage: "primary" | "fallback";
    readonly issueTypes: readonly string[];
  }[] {
    const sameTypes = policy.issueTypes.length === policy.fallbackIssueTypes.length &&
      policy.issueTypes.every((item, index) => item === policy.fallbackIssueTypes[index]);
    return [
      { stage: "primary", issueTypes: policy.issueTypes },
      ...(policy.fallbackIssueTypes.length === 0 || sameTypes
        ? []
        : [{ stage: "fallback" as const, issueTypes: policy.fallbackIssueTypes }])
    ];
  }

  private selectPreemptiveHarness(
    policy: PreemptiveWorkPolicy,
    workers: readonly WorkerSessionRecord[],
    beadId: string
  ): PreemptiveHarnessProfile {
    const activeCounts = new Map<WorkerHarnessId, number>();
    for (const worker of workers.filter(activeWorker)) {
      activeCounts.set(worker.harnessId, (activeCounts.get(worker.harnessId) ?? 0) + 1);
    }
    const minCount = Math.min(...policy.harnesses.map((profile) => activeCounts.get(profile.harnessId) ?? 0));
    const leastBusy = policy.harnesses.filter((profile) => (activeCounts.get(profile.harnessId) ?? 0) === minCount);
    return leastBusy[stableHash(beadId) % leastBusy.length] ?? policy.harnesses[0]!;
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
      goal: "Discover ready Beads work and start an appropriate Ciclo-managed worker.",
      harnesses: policy.harnesses.map((profile) => profile.harnessId),
      dryRun: policy.dryRun
    };
    let readyWorkChecked = 0;
    let claimedResult: Awaited<ReturnType<typeof selectAndClaimBeadsWork>> | undefined;
    let claimedStage: "primary" | "fallback" = "primary";
    for (const stage of this.preemptiveSelectionStages(policy)) {
      const result = await selectAndClaimBeadsWork(beadsClient, {
        selector: {
          loop,
          issueTypes: stage.issueTypes,
          capacity: {
            activeCount,
            maxConcurrent: policy.maxConcurrent
          }
        },
        limit: 20,
        harnessForTask: (task) => this.selectPreemptiveHarness(policy, workers, task.id).harnessId,
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
            reason,
            selection_stage: stage.stage,
            issue_types: stage.issueTypes
          }
        });
        return undefined;
      });

      if (result === undefined) {
        return { readyWorkChecked, launched: [], brainDecisions: [] };
      }

      const checked = result.selection.skipped.length + (result.selection.selected === undefined ? 0 : 1);
      readyWorkChecked += checked;
      this.runtime.eventStore?.append({
        type: "work.ready_listed",
        at: checkedAt,
        loopId: policy.loopId,
        beadId: result.selection.selected?.id,
        evidence: result.evidence,
        data: {
          checked,
          total_checked: readyWorkChecked,
          selected: result.selection.selected?.id ?? null,
          skipped: result.selection.skipped,
          reason: result.reason,
          selection_stage: stage.stage,
          issue_types: stage.issueTypes,
          fallback_issue_types: policy.fallbackIssueTypes,
          active_workers: activeCount,
          max_concurrent: policy.maxConcurrent,
          harness_pool: policy.harnesses.map((profile) => profile.harnessId)
        }
      });

      if (result.claimed && result.after !== undefined) {
        claimedResult = result;
        claimedStage = stage.stage;
        break;
      }
      if (result.evidence.includes("beads.select:none:capacity_full")) break;
    }

      if (claimedResult === undefined || claimedResult.after === undefined) {
        return { readyWorkChecked, launched: [], brainDecisions: [] };
      }
      const result = claimedResult;
      const claimedTask = claimedResult.after;

      this.runtime.eventStore?.append({
      type: "bead.claimed",
      at: checkedAt,
      loopId: policy.loopId,
        beadId: claimedTask.id,
        evidence: result.evidence,
        data: {
          title: claimedTask.title,
          issue_type: claimedTask.issueType,
          harness_id: result.selectedHarness,
          harness_pool: policy.harnesses.map((profile) => profile.harnessId),
          selection_stage: claimedStage,
          preemptive: true
        }
      });

      const selectedHarness = this.selectPreemptiveHarness(policy, workers, claimedTask.id);
      const selectedModel = selectedHarness.model ?? policy.model;
      const selectedEffort = selectedHarness.effort ?? policy.effort;
    const brainDecision = await this.decideReadyWorkLaunch(claimedTask, policy, selectedHarness, claimedStage, checkedAt);
      const prompt = this.readyWorkPrompt(claimedTask, brainDecision, claimedStage);
    const launchRequest = mergeWorkerLaunchWithConfig(
      {
        harnessId: selectedHarness.harnessId,
        loopId: policy.loopId,
          beadId: claimedTask.id,
        prompt,
        cwd: this.runtime.auth?.session.projectRoot,
        dryRun: policy.dryRun,
        isolation: policy.isolation,
        configureMcp: policy.configureMcp,
        ...(selectedModel === undefined ? {} : { model: selectedModel }),
        ...(selectedEffort === undefined ? {} : { effort: selectedEffort })
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
            beadId: claimedTask.id,
          evidence: ["heartbeat.preemptive_work:launch_failed", ...result.evidence],
          data: {
            reason,
            harness_id: selectedHarness.harnessId,
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
      beadId: claimedTask.id,
      workerSessionId: launched.sessionId,
      state: launched.state,
      evidence: [...result.evidence, ...launched.evidence],
      data: {
        title: claimedTask.title,
        issue_type: claimedTask.issueType,
        harness_id: launched.harnessId,
        model: launched.model,
        effort: launched.effort,
        harness_pool: policy.harnesses.map((profile) => profile.harnessId),
        selection_stage: claimedStage,
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
    policy: PreemptiveWorkPolicy,
    selectedHarness: PreemptiveHarnessProfile,
    selectionStage: "primary" | "fallback",
    checkedAt: string
  ): Promise<string | undefined> {
    const brain = this.runtime.openAiBrain;
    if (brain === undefined) return undefined;
    const decision = await brain.decide({
      purpose: "remote_session_monitoring",
      loopId: policy.loopId,
      beadId: task.id,
      harnessId: selectedHarness.harnessId,
      prompt: selectionStage === "primary"
        ? "Ciclo discovered ready Beads planning work while idle. Decide whether launching a worker is appropriate, what context that worker needs first, what model/effort is suitable, what should be kept in Beads memory, and what operator feedback should be surfaced before risky actions."
        : "Ciclo found no primary planning work and discovered concrete ready Beads task, bug, or decision work while idle. Decide whether launching a worker is appropriate, what context that worker needs first, what model/effort is suitable, what should be kept in Beads memory, and what operator feedback should be surfaced before risky actions.",
      context: [
        `id=${task.id}`,
        `title=${task.title}`,
        `issue_type=${task.issueType}`,
        `priority=${task.priority}`,
        `labels=${task.labels.join(",") || "none"}`,
        `description=${compactText(task.description, 600) || "none"}`,
        `acceptance=${compactText(task.acceptanceCriteria, 600) || "none"}`,
        `harness_pool=${policy.harnesses.map((profile) => profile.harnessId).join(",")}`,
        `selected_harness=${selectedHarness.harnessId}`,
        `selection_stage=${selectionStage}`,
        `configured_model=${selectedHarness.model ?? policy.model ?? "unspecified"}`,
        `configured_effort=${selectedHarness.effort ?? policy.effort ?? "unspecified"}`
      ],
      evidence: [`beads.ready.selected:${task.id}`, "heartbeat.preemptive_work:brain_decision"],
      toolExecutor: this.brainToolExecutor(checkedAt)
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
    this.recordBrainVerification(decision, checkedAt, {
      loopId: policy.loopId,
      beadId: task.id
    });
    this.remember({
      kind: "decision",
      content: `Ready work ${task.id} selected for ${selectedHarness.harnessId}. Brain guidance: ${compactText(decision.text, 1000)}`,
      tags: ["ready-work", "brain-decision", selectedHarness.harnessId],
      importance: "normal",
      confidence: 0.8,
      loopId: policy.loopId,
      beadId: task.id,
      evidence: ["heartbeat.preemptive_work:brain_decision"]
    });
    return decision.text;
  }

  private readyWorkPrompt(task: BeadsTaskSnapshot, brainDecision: string | undefined, selectionStage: "primary" | "fallback"): string {
    return [
      `Work Beads ${task.id}: ${task.title}`,
      "",
      selectionStage === "primary"
        ? "You are a Ciclo-managed worker launched by the internal heartbeat because the project had ready planning work and idle capacity."
        : "You are a Ciclo-managed worker launched by the internal heartbeat because primary planning work was exhausted and the project had concrete ready task, bug, or decision work.",
      "Use the Ciclo MCP and Beads as the shared control plane. Inspect the Bead before editing, keep Beads notes current, create or claim child tasks when decomposition is needed, and surface blockers or risky changes back to the controller instead of guessing.",
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

  private async runDueCronJobs(now: string): Promise<{
    readonly due: readonly CicloCronDueJob[];
    readonly runs: readonly CicloCronRunRecord[];
    readonly brainDecisions: readonly string[];
    readonly memoryCompactions: readonly CicloMemoryCompactResult[];
  }> {
    const scheduler = this.runtime.cronScheduler;
    const jobs = this.runtime.projectConfig?.cron?.jobs ?? [];
    if (scheduler === undefined || jobs.length === 0) {
      return { due: [], runs: [], brainDecisions: [], memoryCompactions: [] };
    }
    const due = scheduler.dueJobs(jobs, now);
    const runs: CicloCronRunRecord[] = [];
    const brainDecisions: string[] = [];
    const memoryCompactions: CicloMemoryCompactResult[] = [];
    for (const dueJob of due) {
      this.runtime.eventStore?.append({
        type: "cron.due",
        at: now,
        evidence: dueJob.evidence,
        data: {
          job_id: dueJob.job.id,
          task_kind: dueJob.job.task.kind,
          reason: dueJob.reason
        }
      });
      try {
        const result = await this.runCronTask(dueJob, now);
        if (result.brainDecision !== undefined) brainDecisions.push(result.brainDecision);
        if (result.memoryCompaction !== undefined) memoryCompactions.push(result.memoryCompaction);
        const run = scheduler.recordRun({
          jobId: dueJob.job.id,
          startedAt: now,
          status: result.status,
          reason: result.reason,
          evidence: [...dueJob.evidence, ...result.evidence]
        });
        runs.push(run);
        this.runtime.eventStore?.append({
          type: "cron.ran",
          at: now,
          evidence: run.evidence,
          data: {
            job_id: run.jobId,
            status: run.status,
            reason: run.reason,
            task_kind: dueJob.job.task.kind
          }
        });
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : "unknown cron task error";
        const run = scheduler.recordRun({
          jobId: dueJob.job.id,
          startedAt: now,
          status: "failed",
          reason,
          evidence: [...dueJob.evidence, "cron.task:failed"]
        });
        runs.push(run);
        this.runtime.eventStore?.append({
          type: "cron.ran",
          at: now,
          evidence: run.evidence,
          data: { job_id: run.jobId, status: run.status, reason, task_kind: dueJob.job.task.kind }
        });
      }
    }
    return { due, runs, brainDecisions, memoryCompactions };
  }

  private async runCronTask(
    dueJob: CicloCronDueJob,
    now: string
  ): Promise<{
    readonly status: "ran" | "skipped";
    readonly reason: string;
    readonly evidence: readonly string[];
    readonly brainDecision?: string;
    readonly memoryCompaction?: CicloMemoryCompactResult;
  }> {
    const task = dueJob.job.task;
    if (task.kind === "memory_compact") {
      const store = this.runtime.memoryStore;
      if (store === undefined || this.runtime.projectConfig?.memory?.enabled === false) {
        return { status: "skipped", reason: "memory store disabled", evidence: ["cron.task.memory_compact:skipped"] };
      }
      const result = store.compact({
        now,
        compactAfterDays: this.runtime.projectConfig?.memory?.compactAfterDays,
        archiveAfterDays: this.runtime.projectConfig?.memory?.archiveAfterDays,
        minCompoundEntries: this.runtime.projectConfig?.memory?.minCompoundEntries,
        maxSummaryCharacters: this.runtime.projectConfig?.memory?.maxSummaryCharacters
      });
      return {
        status: "ran",
        reason: "memory compacted",
        evidence: ["cron.task.memory_compact:ran", ...result.evidence],
        memoryCompaction: result
      };
    }
    if (task.kind === "worker_launch") {
      const supervisor = this.runtime.workerSupervisor;
      if (supervisor === undefined) return { status: "skipped", reason: "worker supervisor unavailable", evidence: ["cron.task.worker_launch:skipped"] };
      const params = task.params ?? {};
      const workerEnv = cronStringRecordParam(params.worker_env ?? params.workerEnv);
      const mcpEnv = cronStringRecordParam(params.mcp_env ?? params.mcpEnv);
      const launchRequest: WorkerSessionLaunchRequest = {
        harnessId: cronWorkerHarnessId(cronStringParam(params, ["harness_id", "harnessId"])),
        loopId: cronStringParam(params, ["loop_id", "loopId"]) ?? dueJob.job.id,
        prompt: cronStringParam(params, ["prompt"]) ?? `Run scheduled Ciclo task ${dueJob.job.id}.`,
        cwd: cronStringParam(params, ["cwd"]) ?? this.runtime.auth?.session.projectRoot,
        dryRun: cronBooleanParam(params, ["dry_run", "dryRun"]) ?? true,
        configureMcp: cronBooleanParam(params, ["configure_mcp", "configureMcp"]) ?? true,
        ...(cronStringParam(params, ["bead_id", "beadId"]) === undefined ? {} : { beadId: cronStringParam(params, ["bead_id", "beadId"]) }),
        ...(cronStringParam(params, ["model"]) === undefined ? {} : { model: cronStringParam(params, ["model"]) }),
        ...(cronStringParam(params, ["effort"]) === undefined ? {} : { effort: cronStringParam(params, ["effort"]) }),
        ...(cronStringParam(params, ["session_name", "sessionName"]) === undefined ? {} : { sessionName: cronStringParam(params, ["session_name", "sessionName"]) }),
        ...(cronStringParam(params, ["permission_mode", "permissionMode"]) === undefined ? {} : { permissionMode: cronStringParam(params, ["permission_mode", "permissionMode"]) }),
        ...(cronStringParam(params, ["approval_policy", "approvalPolicy"]) === undefined ? {} : { approvalPolicy: cronStringParam(params, ["approval_policy", "approvalPolicy"]) }),
        ...(cronStringParam(params, ["sandbox"]) === undefined ? {} : { sandbox: cronStringParam(params, ["sandbox"]) }),
        ...(cronIsolationMode(cronStringParam(params, ["isolation"])) === undefined ? {} : { isolation: cronIsolationMode(cronStringParam(params, ["isolation"])) }),
        ...(cronWorktreeRequest(params.worktree) === undefined ? {} : { worktree: cronWorktreeRequest(params.worktree) }),
        ...(cronStringListParam(params.extra_args ?? params.extraArgs) === undefined ? {} : { extraArgs: cronStringListParam(params.extra_args ?? params.extraArgs) }),
        ...(workerEnv === undefined ? {} : { workerEnv }),
        ...(mcpEnv === undefined ? {} : { mcpEnv })
      };
      const launched = supervisor.launch(mergeWorkerLaunchWithConfig(launchRequest, this.runtime.projectConfig ?? {}));
      return {
        status: "ran",
        reason: `worker launched:${launched.sessionId}`,
        evidence: ["cron.task.worker_launch:ran", ...launched.evidence]
      };
    }
    if (task.kind === "brain_decision") {
      const brain = this.runtime.openAiBrain;
      if (brain === undefined) return { status: "skipped", reason: "OpenAI brain unavailable", evidence: ["cron.task.brain_decision:skipped"] };
      const params = task.params ?? {};
      const decision = await brain.decide({
        purpose: "remote_session_monitoring",
        prompt: typeof params.prompt === "string" ? params.prompt : `Scheduled Ciclo brain decision for ${dueJob.job.id}.`,
        context: Array.isArray(params.context) ? params.context.filter((item): item is string => typeof item === "string") : [],
        evidence: ["cron.task.brain_decision"],
        loopId: typeof params.loop_id === "string" ? params.loop_id : undefined,
        toolExecutor: this.brainToolExecutor(now)
      });
      this.runtime.eventStore?.append({
        type: "brain.decision",
        at: now,
        loopId: typeof params.loop_id === "string" ? params.loop_id : undefined,
        evidence: decision.evidence,
        data: {
          purpose: decision.purpose,
          intelligence: decision.intelligence,
          model_family: decision.modelFamily,
          model: decision.model,
          decision: decision.text,
          tool_results: decision.toolResults?.map(toolResultData) ?? []
        }
      });
      this.recordBrainVerification(decision, now, {
        loopId: typeof params.loop_id === "string" ? params.loop_id : undefined
      });
      return {
        status: "ran",
        reason: "brain decision recorded",
        evidence: ["cron.task.brain_decision:ran", ...decision.evidence],
        brainDecision: decision.text
      };
    }
    if (task.kind === "dispatch_ready_work") {
      return {
        status: "ran",
        reason: "ready Beads dispatch is handled by heartbeat preemptive work in the same tick",
        evidence: ["cron.task.dispatch_ready_work:heartbeat_preemptive"]
      };
    }
    return {
      status: "ran",
      reason: "heartbeat tick acknowledged",
      evidence: ["cron.task.heartbeat_tick:ran"]
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

  private remember(input: Parameters<CicloMemoryStore["record"]>[0]): void {
    try {
      this.runtime.memoryStore?.record(input);
    } catch {
      // Memory should improve orchestration, not break heartbeat liveness.
    }
  }

  private brainToolExecutor(now: string): OpenAiBrainToolExecutor | undefined {
    if (
      this.runtime.workerSupervisor === undefined &&
      this.runtime.eventStore === undefined &&
      this.runtime.cronScheduler === undefined &&
      this.runtime.memoryStore === undefined
    ) {
      return undefined;
    }
    return {
      availableTools: () => [
        {
          name: "ciclo_observe_worker",
          description: "Read normalized state, Herdr pane id, agent status, and recent transcript for a Ciclo worker session.",
          mutates: false
        },
        {
          name: "ciclo_nudge_worker",
          description: "Send a bounded prompt/context nudge into a Ciclo worker session through its managed Herdr pane.",
          mutates: true
        },
        {
          name: "ciclo_ask_operator",
          description: "Mark a worker waiting on operator input and raise a Ciclo question event.",
          mutates: true
        },
        {
          name: "ciclo_stop_worker",
          description: "Stop a Ciclo worker session to free capacity when it is hung, unsafe, or superseded.",
          mutates: true
        },
        {
          name: "ciclo_launch_worker",
          description: "Launch a Ciclo-managed Claude Code or Codex worker using project defaults and worktree isolation.",
          mutates: true
        },
        {
          name: "ciclo_poll_events",
          description: "Poll recent Ciclo events for verification after a control-plane action.",
          mutates: false
        },
        {
          name: "ciclo_heartbeat_status",
          description: "Read the current Ciclo heartbeat status, monologue, cron, memory, and Claude-channel summary.",
          mutates: false
        }
      ],
      execute: async (request) => this.executeBrainTool(request, now)
    };
  }

  private async executeBrainTool(request: OpenAiBrainToolRequest, now: string): Promise<OpenAiBrainToolResult> {
    const finish = (result: OpenAiBrainToolResult): OpenAiBrainToolResult => {
      this.runtime.eventStore?.append({
        type: "brain.tool_call",
        at: now,
        evidence: result.evidence,
        data: {
          tool: request.name,
          ok: result.ok,
          summary: result.summary
        }
      });
      return result;
    };

    const supervisor = this.runtime.workerSupervisor;
    const params = request.params;
    const workerSessionId = paramString(params, "worker_session_id");
    try {
      if (request.name === "ciclo_observe_worker") {
        if (supervisor === undefined || workerSessionId === undefined) {
          return finish({
            name: request.name,
            ok: false,
            summary: "worker supervisor or worker_session_id unavailable",
            evidence: ["brain.tool.observe_worker:unavailable"]
          });
        }
        const observation = supervisor.observe(workerSessionId, paramNumber(params, "lines", 80));
        return finish({
          name: request.name,
          ok: observation.observed,
          summary: observation.reason,
          data: {
            worker_session_id: observation.sessionId,
            pane_id: observation.paneId,
            herdr_session: observation.herdrSession,
            agent_status: observation.agentStatus,
            transcript_source: observation.transcriptSource,
            transcript: observation.transcript
          },
          evidence: ["brain.tool.observe_worker", ...observation.evidence]
        });
      }

      if (request.name === "ciclo_nudge_worker") {
        if (supervisor === undefined || workerSessionId === undefined) {
          return finish({
            name: request.name,
            ok: false,
            summary: "worker supervisor or worker_session_id unavailable",
            evidence: ["brain.tool.nudge_worker:unavailable"]
          });
        }
        const worker = supervisor.nudge(workerSessionId, paramString(params, "message") ?? "Ciclo brain requested a status update.", [
          "brain.tool:nudge_worker"
        ]);
        const delivered = worker.evidence.includes("worker.session.nudge:delivered");
        return finish({
          name: request.name,
          ok: delivered,
          summary: delivered ? "worker nudge delivered" : "worker nudge was recorded but delivery was not confirmed",
          data: {
            worker_session_id: worker.sessionId,
            state: worker.state,
            recovery_attempts: worker.recoveryAttempts ?? 0
          },
          evidence: ["brain.tool.nudge_worker", ...worker.evidence.slice(-8)]
        });
      }

      if (request.name === "ciclo_ask_operator") {
        if (workerSessionId !== undefined) {
          supervisor?.markWaitingOnOperator({ sessionId: workerSessionId }, ["brain.tool:ask_operator"]);
        }
        const questionId = `brain-tool-${workerSessionId ?? "session"}-${Date.parse(now) || now}`;
        this.runtime.eventStore?.append({
          type: "question.asked",
          at: now,
          workerSessionId,
          loopId: paramString(params, "loop_id"),
          beadId: paramString(params, "bead_id"),
          state: workerSessionId === undefined ? undefined : "waiting_on_operator",
          evidence: ["brain.tool:ask_operator"],
          data: {
            question_id: questionId,
            question: paramString(params, "message") ?? "Ciclo brain needs operator input before continuing.",
            reason: paramString(params, "reason")
          }
        });
        return finish({
          name: request.name,
          ok: true,
          summary: "operator question raised",
          data: { question_id: questionId, worker_session_id: workerSessionId },
          evidence: ["brain.tool.ask_operator", "question.asked"]
        });
      }

      if (request.name === "ciclo_stop_worker") {
        if (supervisor === undefined || workerSessionId === undefined) {
          return finish({
            name: request.name,
            ok: false,
            summary: "worker supervisor or worker_session_id unavailable",
            evidence: ["brain.tool.stop_worker:unavailable"]
          });
        }
        const stopped = supervisor.stop(workerSessionId, paramString(params, "reason") ?? "Ciclo brain tool requested stop.");
        return finish({
          name: request.name,
          ok: stopped.state === "stopped",
          summary: `worker state is ${stopped.state}`,
          data: { worker_session_id: stopped.sessionId, state: stopped.state },
          evidence: ["brain.tool.stop_worker", ...stopped.evidence.slice(-8)]
        });
      }

      if (request.name === "ciclo_launch_worker") {
        if (supervisor === undefined) {
          return finish({
            name: request.name,
            ok: false,
            summary: "worker supervisor unavailable",
            evidence: ["brain.tool.launch_worker:unavailable"]
          });
        }
        const rawHarness = paramString(params, "harness_id");
        const harnessId: WorkerHarnessId = rawHarness === "claude-code" ? "claude-code" : "codex";
        const loopId = paramString(params, "loop_id") ?? "brain-tool";
        const prompt = paramString(params, "prompt") ?? paramString(params, "message") ?? "Continue this Ciclo-managed work and report status through Ciclo MCP.";
        const launched = supervisor.launch(mergeWorkerLaunchWithConfig({
          harnessId,
          loopId,
          beadId: paramString(params, "bead_id"),
          prompt,
          cwd: this.runtime.auth?.session.projectRoot,
          dryRun: paramBoolean(params, "dry_run", false),
          isolation: "worktree",
          configureMcp: true,
          ...(paramString(params, "model") === undefined ? {} : { model: paramString(params, "model") }),
          ...(paramString(params, "effort") === undefined ? {} : { effort: paramString(params, "effort") })
        }, this.runtime.projectConfig ?? {}));
        this.runtime.eventStore?.append({
          type: "work.started",
          at: now,
          loopId: launched.loopId,
          beadId: launched.beadId,
          workerSessionId: launched.sessionId,
          state: launched.state,
          evidence: ["brain.tool.launch_worker", ...launched.evidence],
          data: {
            harness_id: launched.harnessId,
            model: launched.model,
            effort: launched.effort,
            launch_mode: launched.launchMode,
            tracking_mode: launched.trackingMode,
            preemptive: false
          }
        });
        return finish({
          name: request.name,
          ok: true,
          summary: `worker launched:${launched.sessionId}`,
          data: {
            worker_session_id: launched.sessionId,
            state: launched.state,
            harness_id: launched.harnessId
          },
          evidence: ["brain.tool.launch_worker", ...launched.evidence.slice(-8)]
        });
      }

      if (request.name === "ciclo_poll_events") {
        const cursor = paramNumber(params, "cursor", 0);
        const limit = Math.max(1, Math.min(100, paramNumber(params, "limit", 25)));
        const pollableEventStore = this.runtime.eventStore as {
          poll?: (cursor: number, limit?: number) => {
            readonly cursor: number;
            readonly nextCursor: number;
            readonly events: readonly {
              readonly type: string;
              readonly cursor: number;
              readonly evidence: readonly string[];
            }[];
          };
        } | undefined;
        const poll = pollableEventStore?.poll?.(cursor, limit) ?? supervisor?.pollEvents(cursor, limit) ?? {
          cursor,
          nextCursor: cursor,
          events: []
        };
        return finish({
          name: request.name,
          ok: true,
          summary: `polled ${poll.events.length} Ciclo event(s)`,
          data: {
            cursor: poll.cursor,
            next_cursor: poll.nextCursor,
            events: poll.events.map((event) => ({
              type: event.type,
              cursor: event.cursor,
              evidence: event.evidence
            }))
          },
          evidence: ["brain.tool.poll_events"]
        });
      }

      if (request.name === "ciclo_heartbeat_status") {
        const status = this.status();
        return finish({
          name: request.name,
          ok: true,
          summary: status.running ? "heartbeat is running" : "heartbeat is stopped",
          data: {
            running: status.running,
            last_tick_at: status.lastTickAt,
            claude_channel: status.claudeChannel,
            monologue_count: status.monologue.length
          },
          evidence: ["brain.tool.heartbeat_status", ...status.evidence]
        });
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "unknown brain tool failure";
      return finish({
        name: request.name,
        ok: false,
        summary: compactText(reason, 500),
        evidence: [`brain.tool.${request.name}:failed`]
      });
    }

    return finish({
      name: request.name,
      ok: false,
      summary: "unknown brain tool",
      evidence: [`brain.tool.${request.name}:unknown`]
    });
  }

  private recordBrainVerification(
    decision: Pick<OpenAiBrainDecision, "toolResults" | "evidence" | "purpose">,
    now: string,
    route: {
      readonly loopId?: string;
      readonly beadId?: string;
      readonly workerSessionId?: string;
      readonly remoteSessionId?: string;
    }
  ): void {
    const results = decision.toolResults ?? [];
    if (results.length === 0) return;
    this.runtime.eventStore?.append({
      type: "brain.verification",
      at: now,
      loopId: route.loopId,
      beadId: route.beadId,
      workerSessionId: route.workerSessionId,
      evidence: [
        "brain.verification:tool_results",
        `brain.tools.used:${results.length}`,
        `brain.tools.ok:${results.filter((result) => result.ok).length}`,
        `brain.tools.failed:${results.filter((result) => !result.ok).length}`,
        ...decision.evidence
      ],
      data: {
        purpose: decision.purpose,
        remote_session_id: route.remoteSessionId,
        results: results.map(toolResultData)
      }
    });
  }

  private stalledWorkerNudge(worker: WorkerSessionRecord, decision: string): string {
    return [
      "Ciclo heartbeat detected this worker has stalled.",
      "",
      "Please stop any hung command and report through Ciclo MCP:",
      "1. current objective",
      "2. current cwd and git status",
      "3. files changed and diff summary",
      "4. last command run and whether it is blocked",
      "5. validation run so far",
      "6. whether operator input, secrets, deploy approval, or stronger model escalation is needed",
      "",
      `Ciclo brain guidance: ${compactText(decision, 1200)}`,
      "",
      `Worker session: ${worker.sessionId}`,
      worker.beadId === undefined ? undefined : `Beads task: ${worker.beadId}`
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  private workerObservationContext(worker: WorkerSessionRecord): {
    readonly context: readonly string[];
    readonly evidence: readonly string[];
  } {
    const supervisor = this.runtime.workerSupervisor;
    if (supervisor === undefined) return { context: ["observation=unavailable"], evidence: [] };
    try {
      const observation = supervisor.observe(worker.sessionId, 80);
      return {
        context: [
          `observation.available=${observation.observed}`,
          `observation.reason=${observation.reason}`,
          observation.paneId === undefined ? "pane_id=unavailable" : `pane_id=${observation.paneId}`,
          observation.herdrSession === undefined ? "herdr_session=unavailable" : `herdr_session=${observation.herdrSession}`,
          observation.agentStatus === undefined ? "agent_status=unknown" : `agent_status=${observation.agentStatus}`,
          observation.transcript === undefined ? "transcript_recent=unavailable" : `transcript_recent=${observation.transcript}`
        ],
        evidence: observation.evidence
      };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "unknown observation failure";
      return {
        context: [`observation.available=false`, `observation.reason=${compactText(reason, 400)}`],
        evidence: ["worker.session.observe:failed"]
      };
    }
  }

  private defaultWorkerAction(worker: WorkerSessionRecord, decision: string): OpenAiControlAction {
    return {
      kind: "nudge",
      reason: "OpenAI brain returned prose without a structured action; Ciclo used the safe stalled-worker nudge fallback.",
      message: this.stalledWorkerNudge(worker, decision)
    };
  }

  private workerActionPrompt(worker: WorkerSessionRecord, action: OpenAiControlAction): string {
    return [
      `Ciclo brain action: ${action.kind}`,
      action.reason === undefined ? undefined : `Reason: ${action.reason}`,
      action.message === undefined ? undefined : action.message,
      "",
      `Original worker session: ${worker.sessionId}`,
      worker.beadId === undefined ? undefined : `Beads task: ${worker.beadId}`,
      "Use Ciclo MCP and Beads to continue the work, report blockers, and request review before risky changes."
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  private escalationModel(harnessId: WorkerHarnessId, current: string | undefined): string | undefined {
    if (harnessId === "claude-code") return current ?? "claude-fable-5";
    return current;
  }

  private executeWorkerBrainAction(
    worker: WorkerSessionRecord,
    decision: {
      readonly text: string;
      readonly action?: OpenAiControlAction;
      readonly toolResults?: readonly OpenAiBrainToolResult[];
      readonly evidence: readonly string[];
    },
    now: string
  ): string | undefined {
    const supervisor = this.runtime.workerSupervisor;
    if (supervisor === undefined) return undefined;
    if (decision.action === undefined && (decision.toolResults?.length ?? 0) > 0) {
      return `verified_tools:${worker.sessionId}`;
    }
    const action = decision.action ?? this.defaultWorkerAction(worker, decision.text);
    this.runtime.eventStore?.append({
      type: "brain.action",
      at: now,
      loopId: worker.loopId,
      beadId: worker.beadId,
      workerSessionId: worker.sessionId,
      state: worker.state,
      evidence: ["brain.action:selected", ...decision.evidence],
      data: {
        kind: action.kind,
        reason: action.reason,
        harness_id: action.harnessId ?? worker.harnessId,
        model: action.model,
        effort: action.effort,
        message: action.message
      }
    });

    if (action.kind === "wait") return `waited:${worker.sessionId}`;

    if (action.kind === "ask_operator") {
      supervisor.markWaitingOnOperator({ sessionId: worker.sessionId }, [
        "brain.action:ask_operator",
        ...decision.evidence
      ]);
      const questionId = `heartbeat-${worker.sessionId}-${Date.parse(now) || now}`;
      this.runtime.eventStore?.append({
        type: "question.asked",
        at: now,
        loopId: worker.loopId,
        beadId: worker.beadId,
        workerSessionId: worker.sessionId,
        state: "waiting_on_operator",
        evidence: ["brain.action:ask_operator", ...decision.evidence],
        data: {
          question_id: questionId,
          question: action.message ?? "Ciclo brain needs operator input before continuing this stalled worker.",
          reason: action.reason,
          harness_id: worker.harnessId,
          session_name: worker.sessionName
        }
      });
      return `asked_operator:${worker.sessionId}`;
    }

    if (action.kind === "nudge" || action.kind === "inject_context") {
      const nudged = supervisor.nudge(worker.sessionId, action.message ?? this.stalledWorkerNudge(worker, decision.text), [
        action.kind === "inject_context" ? "brain.action:inject_context" : "brain.action:nudge",
        ...decision.evidence
      ]);
      this.remember({
        kind: "observation",
        content: `Ciclo ${action.kind === "inject_context" ? "injected context into" : "nudged"} stalled worker ${worker.sessionName}; delivered=${nudged.evidence.includes("worker.session.nudge:delivered")}.`,
        tags: ["worker-stall", action.kind, worker.harnessId],
        importance: nudged.evidence.includes("worker.session.nudge:delivered") ? "normal" : "high",
        confidence: 0.8,
        loopId: worker.loopId,
        beadId: worker.beadId,
        workerSessionId: worker.sessionId,
        evidence: [`brain.action:${action.kind}`]
      });
      return action.kind === "inject_context" ? `context_injected:${worker.sessionId}` : `nudged:${worker.sessionId}`;
    }

    if (action.kind === "stop") {
      supervisor.stop(worker.sessionId, action.reason ?? "Ciclo brain requested worker stop.");
      return `stopped:${worker.sessionId}`;
    }

    const launchKinds = new Set<OpenAiControlAction["kind"]>([
      "relaunch_stronger_model",
      "launch_review_worker",
      "launch_debug_worker",
      "launch_test_worker"
    ]);
    if (!launchKinds.has(action.kind)) return undefined;

    if (action.kind === "relaunch_stronger_model") {
      supervisor.stop(worker.sessionId, action.reason ?? "Ciclo brain requested relaunch with stronger model.");
    }
    const harnessId = action.harnessId ?? worker.harnessId;
    const model = action.model ?? (action.kind === "relaunch_stronger_model" ? this.escalationModel(harnessId, worker.model) : worker.model);
    const launched = supervisor.launch(mergeWorkerLaunchWithConfig({
      harnessId,
      loopId: worker.loopId,
      beadId: worker.beadId,
      prompt: this.workerActionPrompt(worker, action),
      cwd: this.runtime.auth?.session.projectRoot ?? worker.cwd,
      isolation: "worktree",
      configureMcp: true,
      ...(model === undefined ? {} : { model }),
      effort: action.effort ?? "high"
    }, this.runtime.projectConfig ?? {}));
    this.runtime.eventStore?.append({
      type: "work.started",
      at: now,
      loopId: launched.loopId,
      beadId: launched.beadId,
      workerSessionId: launched.sessionId,
      state: launched.state,
      evidence: ["brain.action:worker_launch", ...launched.evidence],
      data: {
        brain_action: action.kind,
        source_worker_session_id: worker.sessionId,
        harness_id: launched.harnessId,
        model: launched.model,
        effort: launched.effort,
        launch_mode: launched.launchMode,
        tracking_mode: launched.trackingMode,
        preemptive: false
      }
    });
    return `${action.kind}:${launched.sessionId}`;
  }

  private async decideFollowUps(
    workers: readonly WorkerSessionRecord[],
    remotes: readonly RemoteSessionRecord[],
    now: string
  ): Promise<{
    readonly brainDecisions: readonly string[];
    readonly recoveryActions: readonly string[];
  }> {
    const brain = this.runtime.openAiBrain;
    const decisions: string[] = [];
    const recoveryActions: string[] = [];
    const supervisor = this.runtime.workerSupervisor;
    for (const worker of workers.filter((candidate) => candidate.state === "stalled")) {
      const recoveryAgeMs = elapsedMs(worker.lastRecoveryAt, now);
      const recoveryGraceMs = this.options.workerRecoveryGraceMs ?? defaultWorkerRecoveryGraceMs;
      if ((worker.recoveryAttempts ?? 0) > 0 && recoveryAgeMs !== undefined && recoveryAgeMs >= recoveryGraceMs) {
        if (supervisor !== undefined) {
          const reason = `stalled after Ciclo nudge for ${recoveryAgeMs}ms; freeing preemptive capacity`;
          const stopped = supervisor.stop(worker.sessionId, reason);
          recoveryActions.push(`stopped:${worker.sessionId}`);
          this.runtime.eventStore?.append({
            type: "worker.capacity_released",
            at: now,
            loopId: stopped.loopId,
            beadId: stopped.beadId,
            workerSessionId: stopped.sessionId,
            state: stopped.state,
            evidence: [
              "worker.recovery:capacity_released",
              `worker.recovery.age_ms:${recoveryAgeMs}`,
              `worker.recovery.grace_ms:${recoveryGraceMs}`
            ],
            data: {
              harness_id: stopped.harnessId,
              session_name: stopped.sessionName,
              reason,
              recovery_attempts: stopped.recoveryAttempts ?? 0
            }
          });
          this.remember({
            kind: "learning",
            content: `Worker ${worker.sessionName} stayed stalled after a Ciclo nudge and was stopped to free orchestration capacity. Relaunch with stronger context or model if ${worker.beadId ?? "the task"} is still needed.`,
            tags: ["worker-stall", "capacity-release", worker.harnessId],
            importance: "high",
            confidence: 0.85,
            loopId: worker.loopId,
            beadId: worker.beadId,
            workerSessionId: worker.sessionId,
            evidence: ["worker.recovery:capacity_released"]
          });
        }
        continue;
      }
      if ((worker.recoveryAttempts ?? 0) > 0) continue;
      if (brain === undefined) continue;
      const observation = this.workerObservationContext(worker);
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
          `effort=${worker.effort ?? "unspecified"}`,
          ...observation.context
        ],
        evidence: [...worker.evidence, ...observation.evidence],
        toolExecutor: this.brainToolExecutor(now)
      });
      decisions.push(decision.text);
      this.remember({
        kind: "decision",
        content: `Stalled worker ${worker.sessionName} follow-up decision: ${compactText(decision.text, 1000)}`,
        tags: ["worker-stall", "brain-decision", worker.harnessId],
        importance: "high",
        confidence: 0.8,
        loopId: worker.loopId,
        beadId: worker.beadId,
        workerSessionId: worker.sessionId,
        evidence: ["heartbeat.worker_stall:brain_decision"]
      });
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
          decision: decision.text,
          action: decision.action,
          tool_results: decision.toolResults?.map(toolResultData) ?? []
        }
      });
      this.recordBrainVerification(decision, now, {
        loopId: worker.loopId,
        beadId: worker.beadId,
        workerSessionId: worker.sessionId
      });
      const actionResult = this.executeWorkerBrainAction(worker, decision, now);
      if (actionResult !== undefined) recoveryActions.push(actionResult);
    }
    for (const remote of remotes) {
      if (remote.state !== "stale" && remote.state !== "lost" && remote.state !== "blocked") continue;
      if (brain === undefined) continue;
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
        evidence: remote.evidence,
        toolExecutor: this.brainToolExecutor(now)
      });
      decisions.push(decision.text);
      this.remember({
        kind: "decision",
        content: `Remote session ${remote.id} follow-up decision: ${compactText(decision.text, 1000)}`,
        tags: ["remote-session", "brain-decision"],
        importance: "high",
        confidence: 0.8,
        loopId: remote.activeLoopId,
        beadId: remote.activeBeadId,
        remoteSessionId: remote.id,
        evidence: ["heartbeat.remote:brain_decision"]
      });
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
          decision: decision.text,
          tool_results: decision.toolResults?.map(toolResultData) ?? []
        }
      });
      this.recordBrainVerification(decision, now, {
        loopId: remote.activeLoopId,
        beadId: remote.activeBeadId,
        remoteSessionId: remote.id
      });
    }
    return { brainDecisions: decisions, recoveryActions };
  }
}
