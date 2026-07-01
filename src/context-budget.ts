import type { HarnessId } from "./ciclo-core.js";

export type ContextScopeKind = "harness_session" | "loop" | "remote_session" | "beads_issue";

export type ContextEstimateSource = "model_reported" | "tokenizer" | "character_heuristic";

export type ContextBudgetStatus = "ok" | "warn" | "compact_after_task" | "force_compact";

export interface ContextScope {
  readonly kind: ContextScopeKind;
  readonly id: string;
  readonly harness?: HarnessId;
  readonly loopId?: string;
  readonly remoteSessionId?: string;
  readonly beadsIssueId?: string;
}

export interface ContextReserve {
  readonly section: "system" | "developer" | "active_task" | "safety_policy" | "tool_output" | "response";
  readonly tokens: number;
}

export interface ContextThresholds {
  readonly warn: number;
  readonly compactAfterTask: number;
  readonly forceCompact: number;
}

export interface ContextUsageEstimate {
  readonly usedTokens: number;
  readonly source: ContextEstimateSource;
  readonly attributedTo: readonly string[];
}

export interface ContextBudgetState {
  readonly scope: ContextScope;
  readonly maxTokens: number;
  readonly estimate: ContextUsageEstimate;
  readonly reserves: readonly ContextReserve[];
  readonly thresholds: ContextThresholds;
  readonly reservedTokens: number;
  readonly availableTokens: number;
  readonly ratio: number;
  readonly status: ContextBudgetStatus;
}

export interface BuildContextBudgetInput {
  readonly scope: ContextScope;
  readonly maxTokens: number;
  readonly estimate: ContextUsageEstimate;
  readonly reserves?: readonly ContextReserve[];
  readonly thresholds?: Partial<ContextThresholds>;
}

export const defaultContextThresholds: ContextThresholds = {
  warn: 0.65,
  compactAfterTask: 0.8,
  forceCompact: 0.92
};

export const defaultContextReserves: readonly ContextReserve[] = [
  { section: "system", tokens: 1500 },
  { section: "developer", tokens: 1000 },
  { section: "active_task", tokens: 2500 },
  { section: "safety_policy", tokens: 1000 },
  { section: "tool_output", tokens: 3000 },
  { section: "response", tokens: 1500 }
];

export function estimateTokensFromText(
  text: string,
  attributedTo: readonly string[],
  charsPerToken = 4
): ContextUsageEstimate {
  return {
    usedTokens: Math.ceil(text.length / charsPerToken),
    source: "character_heuristic",
    attributedTo
  };
}

function sumReserves(reserves: readonly ContextReserve[]): number {
  return reserves.reduce((total, reserve) => total + reserve.tokens, 0);
}

function thresholdsWithDefaults(thresholds: Partial<ContextThresholds> | undefined): ContextThresholds {
  return {
    warn: thresholds?.warn ?? defaultContextThresholds.warn,
    compactAfterTask: thresholds?.compactAfterTask ?? defaultContextThresholds.compactAfterTask,
    forceCompact: thresholds?.forceCompact ?? defaultContextThresholds.forceCompact
  };
}

function statusForRatio(ratio: number, thresholds: ContextThresholds): ContextBudgetStatus {
  if (ratio >= thresholds.forceCompact) return "force_compact";
  if (ratio >= thresholds.compactAfterTask) return "compact_after_task";
  if (ratio >= thresholds.warn) return "warn";
  return "ok";
}

export function buildContextBudgetState(input: BuildContextBudgetInput): ContextBudgetState {
  if (input.maxTokens <= 0) {
    throw new Error("maxTokens must be positive");
  }
  if (input.estimate.usedTokens < 0) {
    throw new Error("usedTokens must not be negative");
  }
  const reserves = input.reserves ?? defaultContextReserves;
  const thresholds = thresholdsWithDefaults(input.thresholds);
  const reservedTokens = sumReserves(reserves);
  const consumed = input.estimate.usedTokens + reservedTokens;
  const ratio = consumed / input.maxTokens;
  return {
    scope: input.scope,
    maxTokens: input.maxTokens,
    estimate: input.estimate,
    reserves,
    thresholds,
    reservedTokens,
    availableTokens: Math.max(0, input.maxTokens - consumed),
    ratio,
    status: statusForRatio(ratio, thresholds)
  };
}

export function contextBudgetEvidence(state: ContextBudgetState): readonly string[] {
  return [
    `context.scope:${state.scope.kind}:${state.scope.id}`,
    `context.used:${state.estimate.usedTokens}`,
    `context.reserved:${state.reservedTokens}`,
    `context.max:${state.maxTokens}`,
    `context.status:${state.status}`,
    `context.source:${state.estimate.source}`,
    `context.attribution:${state.estimate.attributedTo.join(",") || "unknown"}`
  ];
}
