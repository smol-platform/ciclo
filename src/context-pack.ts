import type { HarnessId } from "./ciclo-core.js";
import type { ContextScope } from "./context-budget.js";
import {
  classifyContextItem,
  type ClassifiedContextItem,
  type ContextInput
} from "./context-classifier.js";

export interface ContextPackRequest {
  readonly harness: HarnessId;
  readonly scope: ContextScope;
  readonly maxTokens: number;
  readonly items: readonly ContextInput[];
  readonly includeSensitive?: boolean;
}

export interface ContextPackItem {
  readonly id: string;
  readonly source: ClassifiedContextItem["source"];
  readonly text: string;
  readonly priority: number;
  readonly tokenEstimate: number;
  readonly redacted: boolean;
  readonly tags: readonly string[];
}

export interface ContextPack {
  readonly harness: HarnessId;
  readonly scope: ContextScope;
  readonly maxTokens: number;
  readonly usedTokens: number;
  readonly included: readonly ContextPackItem[];
  readonly omitted: readonly { readonly id: string; readonly reason: string }[];
  readonly promptPrefix: string;
}

function promptPrefix(harness: HarnessId): string {
  switch (harness) {
    case "codex":
      return "Ciclo bounded context for Codex. Prefer scoped implementation, validation evidence, and blockers.";
    case "claude-code":
      return "Ciclo bounded context for Claude Code. Use this for review, deploy gates, summaries, and safe next actions.";
    case "pi":
      return "Ciclo bounded context for Pi. Coordinate through Ciclo tools and preserve durable work memory.";
    case "unknown":
      return "Ciclo bounded context for a generic harness. Observe only unless policy allows action.";
  }
}

function redactedText(item: ContextInput, classification: ClassifiedContextItem): string {
  if (!classification.redactBeforePersist) return item.text;
  return `[redacted ${classification.source} context: ${classification.reason}]`;
}

function shouldSkipLowValue(classification: ClassifiedContextItem): boolean {
  return (
    classification.tags.includes("discardable") ||
    (classification.tags.includes("redundant") && !classification.tags.includes("active"))
  );
}

function compareClassified(
  left: { readonly input: ContextInput; readonly classification: ClassifiedContextItem },
  right: { readonly input: ContextInput; readonly classification: ClassifiedContextItem }
): number {
  const priorityDelta = right.classification.priority - left.classification.priority;
  if (priorityDelta !== 0) return priorityDelta;
  return left.input.id.localeCompare(right.input.id);
}

export function buildContextPack(request: ContextPackRequest): ContextPack {
  const omitted: { id: string; reason: string }[] = [];
  const classified = request.items
    .map((input) => ({ input, classification: classifyContextItem(input) }))
    .sort(compareClassified);
  const included: ContextPackItem[] = [];
  let usedTokens = 0;

  for (const entry of classified) {
    const { input, classification } = entry;
    if (shouldSkipLowValue(classification)) {
      omitted.push({ id: input.id, reason: `omitted ${classification.tags.join(",")}` });
      continue;
    }
    const redacted = classification.redactBeforePersist && request.includeSensitive !== true;
    const text = redacted ? redactedText(input, classification) : input.text;
    const tokens = redacted ? Math.ceil(text.length / 4) : classification.tokenEstimate.usedTokens;
    if (usedTokens + tokens > request.maxTokens) {
      omitted.push({ id: input.id, reason: "token budget exceeded" });
      continue;
    }
    included.push({
      id: input.id,
      source: classification.source,
      text,
      priority: classification.priority,
      tokenEstimate: tokens,
      redacted,
      tags: classification.tags
    });
    usedTokens += tokens;
  }

  return {
    harness: request.harness,
    scope: request.scope,
    maxTokens: request.maxTokens,
    usedTokens,
    included,
    omitted,
    promptPrefix: promptPrefix(request.harness)
  };
}

export function renderContextPack(pack: ContextPack): string {
  const lines = [
    pack.promptPrefix,
    `Scope: ${pack.scope.kind}:${pack.scope.id}`,
    `Budget: ${pack.usedTokens}/${pack.maxTokens} tokens`,
    "Included context:"
  ];
  for (const item of pack.included) {
    lines.push(`## ${item.source}:${item.id}`);
    lines.push(item.text);
  }
  return lines.join("\n");
}
