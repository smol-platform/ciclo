import type { ContextScope, ContextUsageEstimate } from "./context-budget.js";
import { estimateTokensFromText } from "./context-budget.js";

export type ContextSourceKind =
  | "spec"
  | "beads"
  | "audit"
  | "repo"
  | "herdr"
  | "mcp"
  | "remote_session"
  | "transcript";

export type ContextTag = "active" | "durable" | "stale" | "redundant" | "sensitive" | "discardable";

export interface ContextInput {
  readonly id: string;
  readonly source: ContextSourceKind;
  readonly text: string;
  readonly scope: ContextScope;
  readonly ageMinutes?: number;
  readonly duplicateOf?: string;
  readonly explicitSensitive?: boolean;
}

export interface ClassifiedContextItem {
  readonly id: string;
  readonly source: ContextSourceKind;
  readonly tags: readonly ContextTag[];
  readonly priority: number;
  readonly tokenEstimate: ContextUsageEstimate;
  readonly scope: ContextScope;
  readonly redactBeforePersist: boolean;
  readonly reason: string;
}

const sensitivePattern =
  /\b(token|secret|password|credential|api[_-]?key|refresh[_-]?token|device[_-]?code|ssh key|private key)\b/i;

function uniqueTags(tags: readonly ContextTag[]): readonly ContextTag[] {
  return [...new Set(tags)];
}

function baseClassification(source: ContextSourceKind): {
  readonly tags: readonly ContextTag[];
  readonly priority: number;
  readonly reason: string;
} {
  switch (source) {
    case "spec":
      return { tags: ["durable"], priority: 70, reason: "spec material is durable guidance" };
    case "beads":
      return { tags: ["active", "durable"], priority: 95, reason: "Beads task state is durable work memory" };
    case "audit":
      return { tags: ["durable"], priority: 65, reason: "audit material explains recent decisions" };
    case "repo":
      return { tags: ["active"], priority: 80, reason: "repo snapshot describes current work state" };
    case "herdr":
      return { tags: ["active"], priority: 85, reason: "Herdr state is current agent liveness evidence" };
    case "mcp":
      return { tags: ["active"], priority: 75, reason: "MCP input may contain current coordination intent" };
    case "remote_session":
      return {
        tags: ["active", "sensitive"],
        priority: 75,
        reason: "remote session context is active and may expose remote details"
      };
    case "transcript":
      return { tags: ["stale"], priority: 35, reason: "raw transcript history is lower priority than durable task state" };
  }
}

function ageTags(ageMinutes: number | undefined): readonly ContextTag[] {
  if (ageMinutes === undefined) return [];
  if (ageMinutes >= 24 * 60) return ["stale", "discardable"];
  if (ageMinutes >= 8 * 60) return ["stale"];
  return [];
}

function priorityAdjustment(input: ContextInput, tags: readonly ContextTag[], basePriority: number): number {
  let priority = basePriority;
  if (tags.includes("active")) priority += 5;
  if (tags.includes("durable")) priority += 5;
  if (tags.includes("stale")) priority -= 20;
  if (tags.includes("redundant")) priority -= 30;
  if (tags.includes("discardable")) priority -= 30;
  if (input.source === "beads" && input.scope.beadsIssueId !== undefined) priority += 5;
  return Math.max(0, Math.min(100, priority));
}

export function classifyContextItem(input: ContextInput): ClassifiedContextItem {
  const base = baseClassification(input.source);
  const detectedSensitive = input.explicitSensitive === true || sensitivePattern.test(input.text);
  const tags = uniqueTags([
    ...base.tags,
    ...ageTags(input.ageMinutes),
    ...(input.duplicateOf === undefined ? [] : (["redundant"] as const)),
    ...(detectedSensitive ? (["sensitive"] as const) : [])
  ]);
  const redactBeforePersist =
    tags.includes("sensitive") || input.source === "remote_session" || input.source === "transcript";

  return {
    id: input.id,
    source: input.source,
    tags,
    priority: priorityAdjustment(input, tags, base.priority),
    tokenEstimate: estimateTokensFromText(input.text, [`${input.source}:${input.id}`]),
    scope: input.scope,
    redactBeforePersist,
    reason: base.reason
  };
}

export function classifyContextItems(inputs: readonly ContextInput[]): readonly ClassifiedContextItem[] {
  return inputs.map(classifyContextItem).sort((left, right) => right.priority - left.priority);
}
