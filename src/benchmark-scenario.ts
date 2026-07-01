import { readFileSync } from "node:fs";

import type { BeadsTaskSnapshot } from "./beads-adapter.js";
import type { HarnessId, HerdrObservation, LoopConfig } from "./ciclo-core.js";
import type { PolicyConfig } from "./loop-config.js";
import type { RepoProbe } from "./repo-probe.js";

export type BenchmarkScenarioVersion = 1;

export interface BenchmarkHarnessContext {
  readonly harnessId: HarnessId;
  readonly target: string;
  readonly transcriptExcerpt?: string;
  readonly prompt?: string;
  readonly artifacts: readonly string[];
}

export interface BenchmarkRemoteSessionSnapshot {
  readonly remoteSessionId: string;
  readonly harnessId?: HarnessId;
  readonly beadId?: string;
  readonly state: "registered" | "attached" | "working" | "blocked" | "stale" | "lost" | "detached" | "done";
  readonly evidence: readonly string[];
}

export interface BenchmarkWorkerSessionSnapshot {
  readonly workerSessionId: string;
  readonly harnessId: HarnessId;
  readonly beadId?: string;
  readonly loopId?: string;
  readonly state: "planned" | "running" | "stopped" | "failed" | "completed";
  readonly model?: string;
  readonly effort?: string;
  readonly cleanupReason?: string;
  readonly evidence: readonly string[];
}

export interface BenchmarkMcpCall {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly expectMutation: boolean;
}

export interface BenchmarkContextSnapshot {
  readonly usedTokens: number;
  readonly maxTokens: number;
  readonly memorySummary?: string;
  readonly items: readonly {
    readonly source: string;
    readonly text: string;
    readonly sensitive: boolean;
  }[];
}

export interface BenchmarkExpectedTraits {
  readonly responseKinds: readonly string[];
  readonly evidenceIncludes: readonly string[];
  readonly requiredActions: readonly string[];
}

export interface BenchmarkDisallowedTraits {
  readonly responseKinds: readonly string[];
  readonly textIncludes: readonly string[];
  readonly actions: readonly string[];
}

export interface BenchmarkJudgeConfig {
  readonly id: string;
  readonly kind: "deterministic" | "model";
  readonly model?: string;
  readonly dimensions: readonly string[];
}

export interface BenchmarkDriverConfig {
  readonly role: "agent_driver" | "user_driver" | "repo_driver" | "adversarial_driver";
  readonly model?: string;
  readonly fixture?: string;
}

export interface BenchmarkScenarioFixture {
  readonly schemaVersion: BenchmarkScenarioVersion;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly repo: RepoProbe;
  readonly beads: {
    readonly ready: readonly BeadsTaskSnapshot[];
    readonly claimed: readonly BeadsTaskSnapshot[];
    readonly blocked: readonly BeadsTaskSnapshot[];
    readonly remoteDb?: Record<string, unknown>;
    readonly trackerSync?: Record<string, unknown>;
  };
  readonly herdrEvents: readonly HerdrObservation[];
  readonly harnessContext: readonly BenchmarkHarnessContext[];
  readonly loop: LoopConfig;
  readonly policy: PolicyConfig;
  readonly mcpCalls: readonly BenchmarkMcpCall[];
  readonly remoteSessions: readonly BenchmarkRemoteSessionSnapshot[];
  readonly workerSessions: readonly BenchmarkWorkerSessionSnapshot[];
  readonly auth?: Record<string, unknown>;
  readonly context?: BenchmarkContextSnapshot;
  readonly expected: BenchmarkExpectedTraits;
  readonly disallowed: BenchmarkDisallowedTraits;
  readonly drivers: readonly BenchmarkDriverConfig[];
  readonly judges: readonly BenchmarkJudgeConfig[];
}

export class BenchmarkScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkScenarioError";
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BenchmarkScenarioError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return asRecord(value, path);
}

function stringValue(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BenchmarkScenarioError(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalStringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function booleanValue(record: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringList(value: unknown, path: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BenchmarkScenarioError(`${path} must be a list of strings`);
  }
  return value as readonly string[];
}

function recordList(value: unknown, path: string): readonly Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BenchmarkScenarioError(`${path} must be a list`);
  return value.map((item, index) => asRecord(item, `${path}[${index}]`));
}

function harnessId(value: string, path: string): HarnessId {
  if (value === "claude-code" || value === "codex" || value === "pi" || value === "unknown") return value;
  throw new BenchmarkScenarioError(`${path} must be claude-code, codex, pi, or unknown`);
}

function taskSnapshot(record: Record<string, unknown>, path: string): BeadsTaskSnapshot {
  return {
    id: stringValue(record, "id", path),
    title: optionalStringValue(record, "title") ?? stringValue(record, "id", path),
    status: optionalStringValue(record, "status") ?? "open",
    priority: numberValue(record, "priority", 0),
    issueType: optionalStringValue(record, "issue_type") ?? "task",
    description: optionalStringValue(record, "description") ?? "",
    acceptanceCriteria: optionalStringValue(record, "acceptance_criteria") ?? "",
    specId: optionalStringValue(record, "spec_id"),
    labels: stringList(record.labels, `${path}.labels`),
    dependencies: [],
    externalRefs: stringList(record.external_refs, `${path}.external_refs`)
  };
}

function repoProbe(record: Record<string, unknown>): RepoProbe {
  return {
    root: optionalStringValue(record, "root") ?? ".",
    isGitRepo: booleanValue(record, "is_git_repo", true),
    branch: optionalStringValue(record, "branch"),
    upstream: optionalStringValue(record, "upstream"),
    dirtyFiles: stringList(record.dirty_files, "repo.dirty_files"),
    stagedFiles: stringList(record.staged_files, "repo.staged_files"),
    beadsPresent: booleanValue(record, "beads_present", true),
    configuredChecks: stringList(record.configured_checks, "repo.configured_checks"),
    errors: stringList(record.errors, "repo.errors")
  };
}

function herdrObservation(record: Record<string, unknown>, path: string): HerdrObservation {
  const source = optionalStringValue(record, "source") ?? "fixture";
  if (source !== "fixture" && source !== "herdr") {
    throw new BenchmarkScenarioError(`${path}.source must be fixture or herdr`);
  }
  const state = stringValue(record, "state", path);
  if (state !== "working" && state !== "blocked" && state !== "done" && state !== "idle" && state !== "unknown") {
    throw new BenchmarkScenarioError(`${path}.state is unsupported`);
  }
  return {
    source,
    target: stringValue(record, "target", path),
    harness: harnessId(stringValue(record, "harness", path), `${path}.harness`),
    state,
    cwd: optionalStringValue(record, "cwd"),
    agentLabel: optionalStringValue(record, "agent_label"),
    evidence: stringList(record.evidence, `${path}.evidence`)
  };
}

function loopConfig(record: Record<string, unknown>): LoopConfig {
  const kind = stringValue(record, "kind", "loop");
  if (kind !== "review" && kind !== "deploy" && kind !== "triage" && kind !== "benchmark" && kind !== "beads_work") {
    throw new BenchmarkScenarioError("loop.kind is unsupported");
  }
  return {
    id: stringValue(record, "id", "loop"),
    kind,
    goal: stringValue(record, "goal", "loop"),
    harnesses: stringList(record.harnesses, "loop.harnesses").map((item, index) => harnessId(item, `loop.harnesses[${index}]`)),
    dryRun: booleanValue(record, "dry_run", true)
  };
}

function policyConfig(record: Record<string, unknown>): PolicyConfig {
  const mode = optionalStringValue(record, "mode") ?? "dry_run";
  if (mode !== "dry_run" && mode !== "supervised" && mode !== "autonomous") {
    throw new BenchmarkScenarioError("policy.mode is unsupported");
  }
  return {
    mode,
    requireApprovalFor: stringList(record.require_approval_for, "policy.require_approval_for"),
    allowCommands: stringList(record.allow_commands, "policy.allow_commands")
  };
}

function expectedTraits(record: Record<string, unknown>): BenchmarkExpectedTraits {
  return {
    responseKinds: stringList(record.response_kinds, "expected.response_kinds"),
    evidenceIncludes: stringList(record.evidence_includes, "expected.evidence_includes"),
    requiredActions: stringList(record.required_actions, "expected.required_actions")
  };
}

function disallowedTraits(record: Record<string, unknown>): BenchmarkDisallowedTraits {
  return {
    responseKinds: stringList(record.response_kinds, "disallowed.response_kinds"),
    textIncludes: stringList(record.text_includes, "disallowed.text_includes"),
    actions: stringList(record.actions, "disallowed.actions")
  };
}

function workerSessionState(value: string, path: string): BenchmarkWorkerSessionSnapshot["state"] {
  if (value === "planned" || value === "running" || value === "stopped" || value === "failed" || value === "completed") {
    return value;
  }
  throw new BenchmarkScenarioError(`${path}.state is unsupported`);
}

export function benchmarkScenarioFromObject(raw: Record<string, unknown>): BenchmarkScenarioFixture {
  if (raw.schema_version !== 1) throw new BenchmarkScenarioError("schema_version must be 1");
  const beads = asRecord(raw.beads, "beads");
  return {
    schemaVersion: 1,
    id: stringValue(raw, "id", "scenario"),
    title: stringValue(raw, "title", "scenario"),
    description: stringValue(raw, "description", "scenario"),
    tags: stringList(raw.tags, "tags"),
    repo: repoProbe(asRecord(raw.repo, "repo")),
    beads: {
      ready: recordList(beads.ready, "beads.ready").map((item, index) => taskSnapshot(item, `beads.ready[${index}]`)),
      claimed: recordList(beads.claimed, "beads.claimed").map((item, index) => taskSnapshot(item, `beads.claimed[${index}]`)),
      blocked: recordList(beads.blocked, "beads.blocked").map((item, index) => taskSnapshot(item, `beads.blocked[${index}]`)),
      remoteDb: optionalRecord(beads.remote_db, "beads.remote_db"),
      trackerSync: optionalRecord(beads.tracker_sync, "beads.tracker_sync")
    },
    herdrEvents: recordList(raw.herdr_events, "herdr_events").map((item, index) =>
      herdrObservation(item, `herdr_events[${index}]`)
    ),
    harnessContext: recordList(raw.harness_context, "harness_context").map((item, index) => ({
      harnessId: harnessId(stringValue(item, "harness_id", `harness_context[${index}]`), `harness_context[${index}].harness_id`),
      target: stringValue(item, "target", `harness_context[${index}]`),
      transcriptExcerpt: optionalStringValue(item, "transcript_excerpt"),
      prompt: optionalStringValue(item, "prompt"),
      artifacts: stringList(item.artifacts, `harness_context[${index}].artifacts`)
    })),
    loop: loopConfig(asRecord(raw.loop, "loop")),
    policy: policyConfig(asRecord(raw.policy, "policy")),
    mcpCalls: recordList(raw.mcp_calls, "mcp_calls").map((item) => ({
      tool: stringValue(item, "tool", "mcp_call"),
      arguments: optionalRecord(item.arguments, "mcp_call.arguments") ?? {},
      expectMutation: booleanValue(item, "expect_mutation", false)
    })),
    remoteSessions: recordList(raw.remote_sessions, "remote_sessions").map((item) => ({
      remoteSessionId: stringValue(item, "remote_session_id", "remote_session"),
      harnessId: optionalStringValue(item, "harness_id") === undefined ? undefined : harnessId(optionalStringValue(item, "harness_id")!, "remote_session.harness_id"),
      beadId: optionalStringValue(item, "bead_id"),
      state: stringValue(item, "state", "remote_session") as BenchmarkRemoteSessionSnapshot["state"],
      evidence: stringList(item.evidence, "remote_session.evidence")
    })),
    workerSessions: recordList(raw.worker_sessions, "worker_sessions").map((item) => ({
      workerSessionId: stringValue(item, "worker_session_id", "worker_session"),
      harnessId: harnessId(stringValue(item, "harness_id", "worker_session"), "worker_session.harness_id"),
      beadId: optionalStringValue(item, "bead_id"),
      loopId: optionalStringValue(item, "loop_id"),
      state: workerSessionState(stringValue(item, "state", "worker_session"), "worker_session"),
      model: optionalStringValue(item, "model"),
      effort: optionalStringValue(item, "effort"),
      cleanupReason: optionalStringValue(item, "cleanup_reason"),
      evidence: stringList(item.evidence, "worker_session.evidence")
    })),
    auth: optionalRecord(raw.auth, "auth"),
    context: optionalRecord(raw.context, "context") === undefined
      ? undefined
      : {
          usedTokens: numberValue(asRecord(raw.context, "context"), "used_tokens", 0),
          maxTokens: numberValue(asRecord(raw.context, "context"), "max_tokens", 0),
          memorySummary: optionalStringValue(asRecord(raw.context, "context"), "memory_summary"),
          items: recordList(asRecord(raw.context, "context").items, "context.items").map((item) => ({
            source: stringValue(item, "source", "context.item"),
            text: stringValue(item, "text", "context.item"),
            sensitive: booleanValue(item, "sensitive", false)
          }))
        },
    expected: expectedTraits(asRecord(raw.expected, "expected")),
    disallowed: disallowedTraits(asRecord(raw.disallowed, "disallowed")),
    drivers: recordList(raw.drivers, "drivers").map((item) => ({
      role: stringValue(item, "role", "driver") as BenchmarkDriverConfig["role"],
      model: optionalStringValue(item, "model"),
      fixture: optionalStringValue(item, "fixture")
    })),
    judges: recordList(raw.judges, "judges").map((item) => ({
      id: stringValue(item, "id", "judge"),
      kind: stringValue(item, "kind", "judge") as BenchmarkJudgeConfig["kind"],
      model: optionalStringValue(item, "model"),
      dimensions: stringList(item.dimensions, "judge.dimensions")
    }))
  };
}

export function loadBenchmarkScenarioText(text: string): BenchmarkScenarioFixture {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) {
    throw new BenchmarkScenarioError("benchmark scenario fixtures currently use JSON object syntax");
  }
  return benchmarkScenarioFromObject(asRecord(JSON.parse(text) as unknown, "scenario"));
}

export function loadBenchmarkScenarioFile(path: string): BenchmarkScenarioFixture {
  return loadBenchmarkScenarioText(readFileSync(path, "utf8"));
}
