import { existsSync } from "node:fs";
import { join } from "node:path";

import { defaultBeadsRunner, type BeadsRunner, type BeadsTaskSnapshot } from "./beads-adapter.js";
import { redactContextMemory, type RedactionMetadata } from "./context-redaction.js";

export type RemoteTrackerKind = "jira" | "linear" | "generic";

export interface BeadsRemoteTrackerTarget {
  readonly id: string;
  readonly kind: RemoteTrackerKind;
  readonly required: boolean;
  readonly syncArgs?: readonly string[];
  readonly statusArgs?: readonly string[];
}

export interface BeadsTrackerSyncStateEntry {
  readonly targetId: string;
  readonly lastCursor?: string;
  readonly retryCount: number;
  readonly lastError?: string;
  readonly completedIdempotencyKeys: readonly string[];
}

export interface BeadsTrackerSyncStateStore {
  get(targetId: string): BeadsTrackerSyncStateEntry | undefined;
  set(entry: BeadsTrackerSyncStateEntry): void;
}

export interface BeadsRemoteTrackerSyncConfig {
  readonly root: string;
  readonly targets: readonly BeadsRemoteTrackerTarget[];
  readonly timeoutMs?: number;
}

export interface BeadsRemoteTrackerSyncInput {
  readonly beadId?: string;
  readonly loopId?: string;
  readonly dryRun: boolean;
  readonly force?: boolean;
  readonly idempotencyKey?: string;
}

export interface BeadsRemoteTrackerTargetResult {
  readonly targetId: string;
  readonly kind: RemoteTrackerKind;
  readonly required: boolean;
  readonly operation: "status" | "sync" | "preview";
  readonly synced: boolean;
  readonly skipped: boolean;
  readonly ok: boolean;
  readonly reason: string;
  readonly previousCursor?: string;
  readonly cursor?: string;
  readonly retryCount: number;
  readonly evidence: readonly string[];
  readonly redactions: readonly RedactionMetadata[];
}

export interface BeadsRemoteTrackerSyncResult {
  readonly synced: boolean;
  readonly provider: "beads-native";
  readonly dry_run: boolean;
  readonly required_failed: boolean;
  readonly targets: readonly BeadsRemoteTrackerTargetResult[];
  readonly evidence: readonly string[];
}

export interface BeadsTrackerIntegrationDetection {
  readonly kind: RemoteTrackerKind;
  readonly configured: boolean;
  readonly target?: BeadsRemoteTrackerTarget;
  readonly refs: readonly string[];
  readonly configKeys: readonly string[];
  readonly evidence: readonly string[];
}

export interface DetectBeadsJiraSyncInput {
  readonly root: string;
  readonly tasks?: readonly BeadsTaskSnapshot[];
  readonly runner?: BeadsRunner;
  readonly timeoutMs?: number;
  readonly required?: boolean;
  readonly syncArgs?: readonly string[];
  readonly statusArgs?: readonly string[];
}

export interface DetectBeadsLinearSyncInput {
  readonly root: string;
  readonly tasks?: readonly BeadsTaskSnapshot[];
  readonly runner?: BeadsRunner;
  readonly timeoutMs?: number;
  readonly required?: boolean;
  readonly syncArgs?: readonly string[];
  readonly statusArgs?: readonly string[];
}

export class InMemoryBeadsTrackerSyncStateStore implements BeadsTrackerSyncStateStore {
  private readonly entries = new Map<string, BeadsTrackerSyncStateEntry>();

  get(targetId: string): BeadsTrackerSyncStateEntry | undefined {
    return this.entries.get(targetId);
  }

  set(entry: BeadsTrackerSyncStateEntry): void {
    this.entries.set(entry.targetId, entry);
  }
}

function stateFor(store: BeadsTrackerSyncStateStore, targetId: string): BeadsTrackerSyncStateEntry {
  return store.get(targetId) ?? {
    targetId,
    retryCount: 0,
    completedIdempotencyKeys: []
  };
}

function hasCompletedKey(entry: BeadsTrackerSyncStateEntry, key: string | undefined): boolean {
  return key !== undefined && entry.completedIdempotencyKeys.includes(key);
}

function withCompletedKey(entry: BeadsTrackerSyncStateEntry, key: string | undefined): readonly string[] {
  if (key === undefined || entry.completedIdempotencyKeys.includes(key)) return entry.completedIdempotencyKeys;
  return [...entry.completedIdempotencyKeys, key].slice(-50);
}

function sanitized(value: string): { readonly text: string; readonly evidence: readonly string[]; readonly redactions: readonly RedactionMetadata[] } {
  const result = redactContextMemory({ text: value, source: "audit" });
  return {
    text: result.text,
    evidence: result.evidence,
    redactions: result.metadata
  };
}

function jiraRefs(tasks: readonly BeadsTaskSnapshot[]): readonly string[] {
  const refs = new Set<string>();
  for (const task of tasks) {
    for (const ref of task.externalRefs) {
      if (
        ref.startsWith("jira:") ||
        /(?:^|\/browse\/)[A-Z][A-Z0-9]+-\d+\b/u.test(ref)
      ) {
        refs.add(ref);
      }
    }
  }
  return [...refs].sort();
}

function linearRefs(tasks: readonly BeadsTaskSnapshot[]): readonly string[] {
  const refs = new Set<string>();
  for (const task of tasks) {
    for (const ref of task.externalRefs) {
      if (
        ref.startsWith("linear:") ||
        /^LIN-\d+\b/u.test(ref) ||
        /linear\.app\/[^/\s]+\/issue\/[A-Z][A-Z0-9]+-\d+\b/u.test(ref)
      ) {
        refs.add(ref);
      }
    }
  }
  return [...refs].sort();
}

async function readBeadsConfigValue(input: {
  readonly root: string;
  readonly runner: BeadsRunner;
  readonly timeoutMs: number;
  readonly key: string;
}): Promise<string | undefined> {
  try {
    const result = await input.runner(input.root, ["bd", "config", "get", input.key], input.timeoutMs);
    if (result.code !== 0) return undefined;
    const value = result.stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function detectBeadsJiraSyncTarget(
  input: DetectBeadsJiraSyncInput
): Promise<BeadsTrackerIntegrationDetection> {
  const runner = input.runner ?? defaultBeadsRunner;
  const timeoutMs = input.timeoutMs ?? 3000;
  const refs = jiraRefs(input.tasks ?? []);
  const [url, project] = await Promise.all([
    readBeadsConfigValue({ root: input.root, runner, timeoutMs, key: "jira.url" }),
    readBeadsConfigValue({ root: input.root, runner, timeoutMs, key: "jira.project" })
  ]);
  const configKeys = [
    url === undefined ? undefined : "jira.url",
    project === undefined ? undefined : "jira.project"
  ].filter((key): key is string => key !== undefined);
  const configured = configKeys.length > 0;
  const target = configured
    ? {
        id: project === undefined ? "jira" : `jira:${project}`,
        kind: "jira" as const,
        required: input.required ?? false,
        syncArgs: input.syncArgs ?? ["trackers", "sync", "--target", "jira"],
        statusArgs: input.statusArgs ?? ["trackers", "status", "--target", "jira"]
      }
    : undefined;

  return {
    kind: "jira",
    configured,
    target,
    refs,
    configKeys,
    evidence: [
      `beads.tracker.jira.configured:${configured}`,
      `beads.tracker.jira.config_keys:${configKeys.join(",") || "none"}`,
      `beads.tracker.jira.refs:${refs.length}`
    ]
  };
}

export async function detectBeadsLinearSyncTarget(
  input: DetectBeadsLinearSyncInput
): Promise<BeadsTrackerIntegrationDetection> {
  const runner = input.runner ?? defaultBeadsRunner;
  const timeoutMs = input.timeoutMs ?? 3000;
  const refs = linearRefs(input.tasks ?? []);
  const teamId = await readBeadsConfigValue({ root: input.root, runner, timeoutMs, key: "linear.team_id" });
  const configKeys = teamId === undefined ? [] : ["linear.team_id"];
  const configured = configKeys.length > 0;
  const target = configured
    ? {
        id: `linear:${teamId}`,
        kind: "linear" as const,
        required: input.required ?? false,
        syncArgs: input.syncArgs ?? ["trackers", "sync", "--target", "linear"],
        statusArgs: input.statusArgs ?? ["trackers", "status", "--target", "linear"]
      }
    : undefined;

  return {
    kind: "linear",
    configured,
    target,
    refs,
    configKeys,
    evidence: [
      `beads.tracker.linear.configured:${configured}`,
      `beads.tracker.linear.config_keys:${configKeys.join(",") || "none"}`,
      `beads.tracker.linear.refs:${refs.length}`
    ]
  };
}

function cursorFrom(stdout: string): string | undefined {
  const start = stdout.search(/[\[{]/u);
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as unknown;
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    if (record !== null && typeof record === "object" && !Array.isArray(record)) {
      const cursor = (record as Record<string, unknown>).cursor ?? (record as Record<string, unknown>).last_cursor;
      return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resultWithFailure(input: {
  readonly target: BeadsRemoteTrackerTarget;
  readonly operation: BeadsRemoteTrackerTargetResult["operation"];
  readonly reason: string;
  readonly previous: BeadsTrackerSyncStateEntry;
  readonly evidence: readonly string[];
  readonly redactions?: readonly RedactionMetadata[];
}): BeadsRemoteTrackerTargetResult {
  return {
    targetId: input.target.id,
    kind: input.target.kind,
    required: input.target.required,
    operation: input.operation,
    synced: false,
    skipped: false,
    ok: false,
    reason: input.reason,
    previousCursor: input.previous.lastCursor,
    retryCount: input.previous.retryCount + 1,
    evidence: input.evidence,
    redactions: input.redactions ?? []
  };
}

export class BeadsRemoteTrackerSync {
  constructor(
    readonly config: BeadsRemoteTrackerSyncConfig,
    readonly runner: BeadsRunner = defaultBeadsRunner,
    readonly state: BeadsTrackerSyncStateStore = new InMemoryBeadsTrackerSyncStateStore()
  ) {}

  isConfigured(): boolean {
    return this.config.targets.length > 0;
  }

  async trigger(input: BeadsRemoteTrackerSyncInput): Promise<BeadsRemoteTrackerSyncResult> {
    const targets = await Promise.all(this.config.targets.map((target) => this.triggerTarget(target, input)));
    const requiredFailed = targets.some((target) => target.required && !target.ok);
    const synced = targets.some((target) => target.synced) && !requiredFailed;
    return {
      synced,
      provider: "beads-native",
      dry_run: input.dryRun,
      required_failed: requiredFailed,
      targets,
      evidence: [
        "beads.tracker_sync.provider:beads-native",
        `beads.tracker_sync.dry_run:${input.dryRun}`,
        `beads.tracker_sync.targets:${targets.length}`,
        `beads.tracker_sync.required_failed:${requiredFailed}`,
        ...targets.flatMap((target) => target.evidence)
      ]
    };
  }

  private async triggerTarget(
    target: BeadsRemoteTrackerTarget,
    input: BeadsRemoteTrackerSyncInput
  ): Promise<BeadsRemoteTrackerTargetResult> {
    const previous = stateFor(this.state, target.id);
    const operation: BeadsRemoteTrackerTargetResult["operation"] = input.dryRun
      ? target.statusArgs === undefined
        ? "preview"
        : "status"
      : "sync";

    if (!input.force && hasCompletedKey(previous, input.idempotencyKey)) {
      return {
        targetId: target.id,
        kind: target.kind,
        required: target.required,
        operation,
        synced: false,
        skipped: true,
        ok: true,
        reason: "tracker sync skipped by idempotency key",
        previousCursor: previous.lastCursor,
        cursor: previous.lastCursor,
        retryCount: previous.retryCount,
        evidence: [`beads.tracker_sync.deduplicated:${target.id}`],
        redactions: []
      };
    }

    if (operation === "preview") {
      return {
        targetId: target.id,
        kind: target.kind,
        required: target.required,
        operation,
        synced: false,
        skipped: true,
        ok: true,
        reason: "dry-run preview only; target has no status command configured",
        previousCursor: previous.lastCursor,
        cursor: previous.lastCursor,
        retryCount: previous.retryCount,
        evidence: [
          `beads.tracker_sync.preview:${target.id}`,
          `beads.tracker_sync.previous_cursor:${previous.lastCursor ?? "none"}`
        ],
        redactions: []
      };
    }

    const args = operation === "status" ? target.statusArgs : target.syncArgs;
    if (args === undefined || args.length === 0) {
      const failure = resultWithFailure({
        target,
        operation,
        previous,
        reason: `target ${target.id} has no ${operation} command configured`,
        evidence: [`beads.tracker_sync.command_missing:${target.id}`]
      });
      this.state.set({ ...previous, retryCount: failure.retryCount, lastError: failure.reason });
      return failure;
    }

    if (!existsSync(join(this.config.root, ".beads"))) {
      const failure = resultWithFailure({
        target,
        operation,
        previous,
        reason: "Beads workspace not present",
        evidence: [`beads.tracker_sync.workspace_absent:${target.id}`]
      });
      this.state.set({ ...previous, retryCount: failure.retryCount, lastError: failure.reason });
      return failure;
    }

    try {
      const command = ["bd", ...args];
      const output = await this.runner(this.config.root, command, this.config.timeoutMs ?? 3000);
      const stdout = sanitized(output.stdout.trim());
      const stderr = sanitized(output.stderr.trim());
      const cursor = cursorFrom(output.stdout) ?? previous.lastCursor;
      const ok = output.code === 0;
      const redactions = [...stdout.redactions, ...stderr.redactions];
      const evidence = [
        `beads.tracker_sync.target:${target.id}`,
        `beads.tracker_sync.operation:${operation}`,
        `beads.tracker_sync.exit_code:${output.code}`,
        `beads.tracker_sync.previous_cursor:${previous.lastCursor ?? "none"}`,
        `beads.tracker_sync.cursor:${cursor ?? "none"}`,
        ...stdout.evidence,
        ...stderr.evidence
      ];

      if (!ok) {
        const safeError = stderr.text.length > 0 ? stderr.text : stdout.text;
        this.state.set({
          ...previous,
          retryCount: previous.retryCount + 1,
          lastError: safeError || `bd ${operation} failed`
        });
        return resultWithFailure({
          target,
          operation,
          previous,
          reason: safeError || `bd ${operation} failed`,
          evidence,
          redactions
        });
      }

      this.state.set({
        targetId: target.id,
        lastCursor: cursor,
        retryCount: 0,
        completedIdempotencyKeys: withCompletedKey(previous, input.idempotencyKey)
      });
      return {
        targetId: target.id,
        kind: target.kind,
        required: target.required,
        operation,
        synced: operation === "sync",
        skipped: false,
        ok: true,
        reason: operation === "sync" ? "Beads tracker sync completed" : "Beads tracker sync status completed",
        previousCursor: previous.lastCursor,
        cursor,
        retryCount: 0,
        evidence,
        redactions
      };
    } catch (error) {
      const safe = sanitized(error instanceof Error ? error.message : String(error));
      const failure = resultWithFailure({
        target,
        operation,
        previous,
        reason: safe.text,
        evidence: [`beads.tracker_sync.error:${target.id}`, ...safe.evidence],
        redactions: safe.redactions
      });
      this.state.set({ ...previous, retryCount: failure.retryCount, lastError: failure.reason });
      return failure;
    }
  }
}
