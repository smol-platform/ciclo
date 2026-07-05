import type { BeadsTaskSnapshot } from "./beads-adapter.js";
import type { WorkerHarnessId } from "./worker-session-supervisor.js";

export type ProblemComplexity = "small" | "standard" | "hard";

export interface WorkerModelProfile {
  readonly harnessId: WorkerHarnessId;
  readonly model?: string;
  readonly effort?: string;
}

export interface WorkerProblemClassification {
  readonly complexity: ProblemComplexity;
  readonly traits: readonly string[];
  readonly evidence: readonly string[];
}

export interface WorkerProblemModelSelection {
  readonly harness: WorkerModelProfile;
  readonly model?: string;
  readonly effort?: string;
  readonly classification: WorkerProblemClassification;
  readonly reason: string;
  readonly evidence: readonly string[];
}

const hardSignals = [
  "architecture",
  "auth",
  "authorization",
  "benchmark",
  "claude",
  "codex",
  "context",
  "deploy",
  "distributed",
  "heartbeat",
  "infra",
  "kubernetes",
  "migration",
  "mcp",
  "oauth",
  "orchestration",
  "permission",
  "policy",
  "remote",
  "review",
  "secret",
  "security",
  "session",
  "wireguard"
];

const standardSignals = [
  "bug",
  "debug",
  "failure",
  "failing",
  "fix",
  "integration",
  "regression",
  "stalled",
  "test",
  "typescript"
];

const smallSignals = [
  "chore",
  "doc",
  "docs",
  "example",
  "format",
  "guide",
  "readme",
  "skill",
  "typo"
];

function taskText(task: BeadsTaskSnapshot): string {
  return [
    task.id,
    task.title,
    task.issueType,
    task.description,
    task.acceptanceCriteria,
    task.labels.join(" ")
  ]
    .join(" ")
    .toLowerCase();
}

function matchingSignals(text: string, signals: readonly string[]): readonly string[] {
  return signals.filter((signal) => new RegExp(`\\b${signal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u").test(text));
}

export function classifyWorkerProblem(task: BeadsTaskSnapshot): WorkerProblemClassification {
  const text = taskText(task);
  const hard = matchingSignals(text, hardSignals);
  const standard = matchingSignals(text, standardSignals);
  const small = matchingSignals(text, smallSignals);
  const traits = [
    ...hard.map((signal) => `hard:${signal}`),
    ...standard.map((signal) => `standard:${signal}`),
    ...small.map((signal) => `small:${signal}`),
    `issue_type:${task.issueType}`,
    `priority:${task.priority}`
  ];

  const hardIssue = task.issueType === "epic" || task.issueType === "feature";
  const smallIssue = task.issueType === "task" && small.length > 0 && hard.length === 0 && standard.length === 0;
  const critical = task.priority <= 0;
  const complexity: ProblemComplexity = hard.length > 0 || hardIssue || critical
    ? "hard"
    : smallIssue || small.length > 0
      ? "small"
      : standard.length > 0 || task.priority <= 1
        ? "standard"
        : "standard";

  return {
    complexity,
    traits,
    evidence: [
      `model.problem.complexity:${complexity}`,
      ...hard.map((signal) => `model.problem.hard:${signal}`),
      ...standard.map((signal) => `model.problem.standard:${signal}`),
      ...small.map((signal) => `model.problem.small:${signal}`),
      `model.problem.issue_type:${task.issueType}`,
      `model.problem.priority:${task.priority}`
    ]
  };
}

function defaultModelFor(harnessId: WorkerHarnessId, complexity: ProblemComplexity): string | undefined {
  if (harnessId === "claude-code") {
    return complexity === "small" ? undefined : "claude-fable-5";
  }
  if (complexity === "small") return "gpt-5-mini";
  if (complexity === "hard") return "gpt-5.5";
  return "gpt-5";
}

function defaultEffortFor(harnessId: WorkerHarnessId, complexity: ProblemComplexity): string | undefined {
  if (complexity === "small") return undefined;
  if (harnessId === "claude-code") return "high";
  return complexity === "hard" ? "high" : "medium";
}

function activeCountFor(activeCounts: ReadonlyMap<WorkerHarnessId, number>, harnessId: WorkerHarnessId): number {
  return activeCounts.get(harnessId) ?? 0;
}

function leastBusy(
  profiles: readonly WorkerModelProfile[],
  activeCounts: ReadonlyMap<WorkerHarnessId, number>,
  preferred?: WorkerHarnessId
): WorkerModelProfile {
  const candidates = preferred === undefined
    ? profiles
    : profiles.filter((profile) => profile.harnessId === preferred);
  const pool = candidates.length === 0 ? profiles : candidates;
  return [...pool].sort((left, right) => {
    const countDelta = activeCountFor(activeCounts, left.harnessId) - activeCountFor(activeCounts, right.harnessId);
    return countDelta === 0 ? left.harnessId.localeCompare(right.harnessId) : countDelta;
  })[0] ?? profiles[0]!;
}

function preferredHarness(
  classification: WorkerProblemClassification,
  profiles: readonly WorkerModelProfile[]
): WorkerHarnessId | undefined {
  const hasClaude = profiles.some((profile) => profile.harnessId === "claude-code");
  const hasCodex = profiles.some((profile) => profile.harnessId === "codex");
  const traits = new Set(classification.traits);
  if (classification.complexity === "hard" && hasClaude) return "claude-code";
  if ([...traits].some((trait) => trait.startsWith("hard:")) && hasClaude) return "claude-code";
  if ([...traits].some((trait) => trait.startsWith("small:")) && hasCodex) return "codex";
  if ([...traits].some((trait) => trait.startsWith("standard:")) && hasCodex) return "codex";
  return undefined;
}

export function selectWorkerModelForProblem(input: {
  readonly task: BeadsTaskSnapshot;
  readonly profiles: readonly WorkerModelProfile[];
  readonly activeCounts?: ReadonlyMap<WorkerHarnessId, number>;
  readonly fallbackModel?: string;
  readonly fallbackEffort?: string;
}): WorkerProblemModelSelection {
  if (input.profiles.length === 0) {
    throw new Error("worker model selection requires at least one harness profile");
  }
  const classification = classifyWorkerProblem(input.task);
  const activeCounts = input.activeCounts ?? new Map<WorkerHarnessId, number>();
  const preferred = preferredHarness(classification, input.profiles);
  const harness = leastBusy(input.profiles, activeCounts, preferred);
  const model = harness.model ?? input.fallbackModel ?? defaultModelFor(harness.harnessId, classification.complexity);
  const effort = harness.effort ?? input.fallbackEffort ?? defaultEffortFor(harness.harnessId, classification.complexity);
  const reason = [
    `${classification.complexity} problem`,
    preferred === undefined ? "load-balanced harness" : `preferred ${preferred}`,
    model === undefined ? "default harness model" : `model ${model}`,
    effort === undefined ? "default effort" : `effort ${effort}`
  ].join("; ");
  return {
    harness,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    classification,
    reason,
    evidence: [
      ...classification.evidence,
      `model.selection.harness:${harness.harnessId}`,
      ...(model === undefined ? ["model.selection.model:default"] : [`model.selection.model:${model}`]),
      ...(effort === undefined ? ["model.selection.effort:default"] : [`model.selection.effort:${effort}`]),
      preferred === undefined ? "model.selection.reason:least_busy" : `model.selection.reason:preferred_${preferred}`
    ]
  };
}
