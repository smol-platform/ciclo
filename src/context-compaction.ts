import { createHash } from "node:crypto";

import type { AuthorizationResult } from "./access-enforcement.js";
import {
  recordBeadsProgress,
  type BeadsProgressClient,
  type BeadsProgressKind,
  type BeadsProgressSync,
  type ValidationEvidence
} from "./beads-progress.js";
import type { LoopConfig } from "./ciclo-core.js";
import { contextBudgetEvidence, type ContextBudgetState } from "./context-budget.js";
import type { ContextPack } from "./context-pack.js";
import {
  redactContextMemory,
  type ContextMemoryRedactionPolicy,
  type RedactionMetadata
} from "./context-redaction.js";
import type { PolicyConfig } from "./loop-config.js";

export type BeadsTaskTransition = "completed" | "blocked" | "handed_off";

export interface SmartCompactFacts {
  readonly decisions: readonly string[];
  readonly validation: readonly ValidationEvidence[];
  readonly blockers: readonly string[];
  readonly changedFiles: readonly string[];
  readonly followUps: readonly string[];
}

export interface IdempotencyStore {
  has(key: string): boolean;
  record(key: string): void;
}

export interface SmartCompactInput extends SmartCompactFacts {
  readonly id: string;
  readonly transition: BeadsTaskTransition;
  readonly loop: LoopConfig;
  readonly policy: PolicyConfig;
  readonly budget: ContextBudgetState;
  readonly contextPack: ContextPack;
  readonly idempotencyStore?: IdempotencyStore;
  readonly idempotencySalt?: string;
  readonly principalId?: string;
  readonly harnessId?: string;
  readonly authorization?: AuthorizationResult;
  readonly sync?: BeadsProgressSync;
  readonly redactionPolicy?: ContextMemoryRedactionPolicy;
}

export interface SmartCompactResult {
  readonly compacted: boolean;
  readonly idempotencyKey: string;
  readonly transition: BeadsTaskTransition;
  readonly continuationSummary: string;
  readonly memoryNote: string;
  readonly redactions: readonly RedactionMetadata[];
  readonly pushed: boolean;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly keys = new Set<string>();

  has(key: string): boolean {
    return this.keys.has(key);
  }

  record(key: string): void {
    this.keys.add(key);
  }
}

function normalizedLines(values: readonly string[]): readonly string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function smartCompactIdempotencyKey(input: Pick<SmartCompactInput, "id" | "transition" | "idempotencySalt"> & SmartCompactFacts): string {
  const payload = {
    id: input.id,
    transition: input.transition,
    salt: input.idempotencySalt ?? "",
    decisions: normalizedLines(input.decisions),
    validation: input.validation.map((item) => ({
      command: item.command,
      passed: item.passed,
      summary: item.summary
    })),
    blockers: normalizedLines(input.blockers),
    changedFiles: normalizedLines(input.changedFiles),
    followUps: normalizedLines(input.followUps)
  };
  const digest = createHash("sha256").update(stableJson(payload)).digest("hex").slice(0, 16);
  return `ciclo-compact:${input.id}:${input.transition}:${digest}`;
}

function bulletSection(title: string, values: readonly string[], fallback: string): readonly string[] {
  const lines = normalizedLines(values);
  if (lines.length === 0) return [`${title}: ${fallback}`];
  return [`${title}:`, ...lines.map((line) => `- ${line}`)];
}

function validationLines(validation: readonly ValidationEvidence[]): readonly string[] {
  if (validation.length === 0) return ["Validation: none recorded"];
  return [
    "Validation:",
    ...validation.map((item) => `- ${item.command}: ${item.passed ? "passed" : "failed"} - ${item.summary}`)
  ];
}

function compactKind(transition: BeadsTaskTransition): BeadsProgressKind {
  if (transition === "blocked") return "blocker";
  if (transition === "completed") return "final_summary";
  return "progress";
}

function transitionLabel(transition: BeadsTaskTransition): string {
  switch (transition) {
    case "completed":
      return "completed";
    case "blocked":
      return "blocked";
    case "handed_off":
      return "handed off";
  }
}

export function buildContinuationSummary(input: SmartCompactInput, idempotencyKey: string): string {
  const includedContext = input.contextPack.included.map((item) => `${item.source}:${item.id}`);
  const omittedContext = input.contextPack.omitted.map((item) => `${item.id} (${item.reason})`);
  return [
    `Continue Beads task ${input.id}; last transition: ${transitionLabel(input.transition)}.`,
    `Loop: ${input.loop.id}. Context budget: ${input.budget.status} (${input.budget.estimate.usedTokens}/${input.budget.maxTokens} used before reserves).`,
    `Idempotency key: ${idempotencyKey}.`,
    ...bulletSection("Decisions", input.decisions, "none recorded"),
    ...validationLines(input.validation),
    ...bulletSection("Blockers", input.blockers, "none recorded"),
    ...bulletSection("Changed files", input.changedFiles, "none recorded"),
    ...bulletSection("Follow-ups", input.followUps, "none recorded"),
    ...bulletSection("Included context", includedContext, "none"),
    ...bulletSection("Omitted context", omittedContext, "none")
  ].join("\n");
}

export async function smartCompactAfterBeadsTransition(
  client: BeadsProgressClient,
  input: SmartCompactInput
): Promise<SmartCompactResult> {
  const idempotencyKey = smartCompactIdempotencyKey(input);
  const rawContinuationSummary = buildContinuationSummary(input, idempotencyKey);
  const rawMemoryNote = [
    `Smart compact after Beads transition: ${transitionLabel(input.transition)}`,
    rawContinuationSummary
  ].join("\n\n");
  const redactedContinuation = redactContextMemory({
    text: rawContinuationSummary,
    policy: input.redactionPolicy
  });
  const redactedMemory = redactContextMemory({
    text: rawMemoryNote,
    policy: input.redactionPolicy
  });
  const redactedBlocker =
    input.transition === "blocked" && input.blockers[0] !== undefined
      ? redactContextMemory({ text: input.blockers[0], policy: input.redactionPolicy }).text
      : undefined;

  if (input.idempotencyStore?.has(idempotencyKey)) {
    return {
      compacted: false,
      idempotencyKey,
      transition: input.transition,
      continuationSummary: redactedContinuation.text,
      memoryNote: redactedMemory.text,
      redactions: redactedMemory.metadata,
      pushed: false,
      reason: "compaction skipped because idempotency key was already recorded",
      evidence: [`context.compact.idempotent:${idempotencyKey}`, ...redactedMemory.evidence]
    };
  }

  const result = await recordBeadsProgress(client, {
    id: input.id,
    kind: compactKind(input.transition),
    message: redactedMemory.text,
    loop: input.loop,
    policy: input.policy,
    authorization: input.authorization,
    principalId: input.principalId,
    harnessId: input.harnessId,
    blockerId: redactedBlocker,
    sync: input.sync
  });

  if (result.mutated) {
    input.idempotencyStore?.record(idempotencyKey);
  }

  return {
    compacted: result.mutated,
    idempotencyKey,
    transition: input.transition,
    continuationSummary: redactedContinuation.text,
    memoryNote: redactedMemory.text,
    redactions: redactedMemory.metadata,
    pushed: result.pushed,
    reason: result.reason,
    evidence: [
      `context.compact.transition:${input.transition}`,
      `context.compact.idempotency_key:${idempotencyKey}`,
      ...contextBudgetEvidence(input.budget),
      ...redactedMemory.evidence,
      ...result.evidence
    ]
  };
}
