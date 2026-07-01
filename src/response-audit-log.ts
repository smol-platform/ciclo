import { createHash } from "node:crypto";

import { redactContextMemory } from "./context-redaction.js";
import { planDryRunResponse, type DryRunPlan, type DryRunPlannerInput } from "./response-planner.js";
import { summarizeRepoProbe } from "./repo-probe.js";

export type AuditDecision = "allowed" | "denied" | "dry_run" | "failed" | "completed";

export interface ResponseAuditSources {
  readonly herdr?: {
    readonly source: string;
    readonly target: string;
    readonly harness: string;
    readonly state: string;
    readonly evidence: readonly string[];
  };
  readonly repo?: {
    readonly root: string;
    readonly isGitRepo: boolean;
    readonly branch?: string;
    readonly upstream?: string;
    readonly dirtyFiles: readonly string[];
    readonly stagedFiles: readonly string[];
    readonly beadsPresent: boolean;
    readonly configuredChecks: readonly string[];
    readonly errors: readonly string[];
    readonly summary: string;
  };
  readonly loop: DryRunPlannerInput["loop"];
  readonly event: DryRunPlannerInput["event"];
  readonly beadsSelection?: DryRunPlannerInput["beadsSelection"];
  readonly remoteHealth?: DryRunPlannerInput["remoteHealth"];
  readonly contextBudget?: DryRunPlannerInput["contextBudget"];
}

export interface ResponseAuditRecord {
  readonly id: string;
  readonly time: string;
  readonly actor?: string;
  readonly eventId: string;
  readonly responseId: string;
  readonly loopId: string;
  readonly action: DryRunPlan["response"];
  readonly decision: AuditDecision;
  readonly dryRun: true;
  readonly wouldExecute: false;
  readonly summary: string;
  readonly policy: DryRunPlan["policy"];
  readonly workId?: string;
  readonly evidence: readonly string[];
  readonly redactions: readonly string[];
  readonly trace: {
    readonly herdrEvent: boolean;
    readonly repoSnapshot: boolean;
    readonly loopConfig: true;
    readonly policyDecision: true;
  };
  readonly sources: ResponseAuditSources;
}

export interface ResponseAuditBuildOptions {
  readonly actor?: string;
  readonly now?: string;
}

export interface ResponseAuditLog {
  append(record: ResponseAuditRecord): void;
  list(): readonly ResponseAuditRecord[];
  findByResponseId(responseId: string): ResponseAuditRecord | undefined;
}

export class InMemoryResponseAuditLog implements ResponseAuditLog {
  private readonly records: ResponseAuditRecord[] = [];

  append(record: ResponseAuditRecord): void {
    this.records.push(record);
  }

  list(): readonly ResponseAuditRecord[] {
    return [...this.records];
  }

  findByResponseId(responseId: string): ResponseAuditRecord | undefined {
    return this.records.find((record) => record.responseId === responseId);
  }
}

function stableString(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
    }
    return item;
  });
}

function id(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256").update(stableString(value)).digest("hex").slice(0, 16)}`;
}

function auditDecision(plan: DryRunPlan): AuditDecision {
  if (plan.policy.decision === "deny" || plan.policy.decision === "ask_operator") return "denied";
  if (plan.dryRun) return "dry_run";
  return plan.wouldExecute ? "completed" : "allowed";
}

function redactedLines(lines: readonly string[]): {
  readonly evidence: readonly string[];
  readonly redactions: readonly string[];
} {
  const redactions = new Map<string, number>();
  const evidence = lines.map((line) => {
    const result = redactContextMemory({ text: line, source: "audit" });
    for (const item of result.metadata) {
      redactions.set(item.kind, (redactions.get(item.kind) ?? 0) + item.count);
    }
    return result.text;
  });
  return {
    evidence,
    redactions: [...redactions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => `audit.redaction.${kind}:${count}`)
  };
}

function redactedObservation(input: DryRunPlannerInput): ResponseAuditSources["herdr"] {
  const observation = input.observation;
  if (observation === undefined) return undefined;
  return {
    source: observation.source,
    target: redactContextMemory({ text: observation.target, source: "audit" }).text,
    harness: observation.harness,
    state: observation.state,
    evidence: redactedLines(observation.evidence).evidence
  };
}

function repoSource(input: DryRunPlannerInput): ResponseAuditSources["repo"] {
  const repo = input.repo;
  if (repo === undefined) return undefined;
  return {
    root: repo.root,
    isGitRepo: repo.isGitRepo,
    branch: repo.branch,
    upstream: repo.upstream,
    dirtyFiles: repo.dirtyFiles,
    stagedFiles: repo.stagedFiles,
    beadsPresent: repo.beadsPresent,
    configuredChecks: repo.configuredChecks,
    errors: repo.errors,
    summary: summarizeRepoProbe(repo)
  };
}

function eventSource(input: DryRunPlannerInput): DryRunPlannerInput["event"] {
  return {
    ...input.event,
    summary: redactContextMemory({ text: input.event.summary, source: "audit" }).text,
    evidence: input.event.evidence === undefined ? undefined : redactedLines(input.event.evidence).evidence
  };
}

export function buildDryRunResponseAuditRecord(
  input: DryRunPlannerInput,
  plan: DryRunPlan,
  options: ResponseAuditBuildOptions = {}
): ResponseAuditRecord {
  const sanitized = redactedLines(plan.evidence);
  const sources: ResponseAuditSources = {
    herdr: redactedObservation(input),
    repo: repoSource(input),
    loop: input.loop,
    event: eventSource(input),
    beadsSelection: input.beadsSelection,
    remoteHealth: input.remoteHealth,
    contextBudget: input.contextBudget
  };
  const eventId = id("event", {
    loopId: input.loop.id,
    event: input.event,
    observation: input.observation
  });
  const responseId = id("response", {
    loopId: plan.loopId,
    response: plan.response,
    workId: plan.workId,
    policy: plan.policy
  });
  return {
    id: id("audit", { eventId, responseId, evidence: sanitized.evidence }),
    time: options.now ?? new Date().toISOString(),
    actor: options.actor,
    eventId,
    responseId,
    loopId: plan.loopId,
    action: plan.response,
    decision: auditDecision(plan),
    dryRun: true,
    wouldExecute: false,
    summary: redactContextMemory({ text: plan.summary, source: "audit" }).text,
    policy: plan.policy,
    workId: plan.workId,
    evidence: sanitized.evidence,
    redactions: sanitized.redactions,
    trace: {
      herdrEvent: input.observation !== undefined,
      repoSnapshot: input.repo !== undefined,
      loopConfig: true,
      policyDecision: true
    },
    sources
  };
}

export function planDryRunResponseWithAudit(
  input: DryRunPlannerInput,
  log: ResponseAuditLog,
  options: ResponseAuditBuildOptions = {}
): { readonly plan: DryRunPlan; readonly audit: ResponseAuditRecord } {
  const plan = planDryRunResponse(input);
  const audit = buildDryRunResponseAuditRecord(input, plan, options);
  log.append(audit);
  return { plan, audit };
}
