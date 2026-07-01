import type { BeadsWorkSelection } from "./beads-work-queue.js";
import type { BeadsRemoteHealthDecision } from "./beads-remote-health.js";
import type { HerdrObservation, LoopConfig } from "./ciclo-core.js";
import { contextBudgetEvidence, type ContextBudgetState } from "./context-budget.js";
import type { PolicyConfig } from "./loop-config.js";
import { evaluatePolicy, type PolicyAction, type PolicyOutcome } from "./policy-gate.js";
import { summarizeRepoProbe, type RepoProbe } from "./repo-probe.js";

export type DryRunPlannerEventKind =
  | "agent_working"
  | "agent_done"
  | "agent_idle"
  | "agent_blocked"
  | "beads_ready"
  | "repo_dirty_without_task"
  | "goal_drift_detected"
  | "loop_exit_success"
  | "loop_exit_failure";

export type DryRunResponseKind =
  | "wait"
  | "measure_context"
  | "build_context_pack"
  | "smart_compact"
  | "summarize"
  | "nudge"
  | "ask_user"
  | "claim_task"
  | "create_task"
  | "update_loop_goal"
  | "stop_loop";

export interface DryRunPlannerEvent {
  readonly kind: DryRunPlannerEventKind;
  readonly summary: string;
  readonly evidence?: readonly string[];
}

export interface GoalEvolutionProposal {
  readonly newGoal: string;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface GoalEvolutionRecord {
  readonly loopId: string;
  readonly previousGoal: string;
  readonly newGoal: string;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface GoalEvolutionDecision {
  readonly allowed: boolean;
  readonly record?: GoalEvolutionRecord;
  readonly denialReason?: string;
  readonly evidence: readonly string[];
}

export interface DryRunPlannerInput {
  readonly loop: LoopConfig;
  readonly policy: PolicyConfig;
  readonly event: DryRunPlannerEvent;
  readonly observation?: HerdrObservation;
  readonly repo?: RepoProbe;
  readonly beadsSelection?: BeadsWorkSelection;
  readonly remoteHealth?: BeadsRemoteHealthDecision;
  readonly contextBudget?: ContextBudgetState;
  readonly promptSendConfigured?: boolean;
  readonly hasAcceptanceEvidence?: boolean;
  readonly contextForceCompactOverride?: boolean;
  readonly goalEvolution?: GoalEvolutionProposal;
}

export interface DryRunPlan {
  readonly loopId: string;
  readonly response: DryRunResponseKind;
  readonly summary: string;
  readonly policy: PolicyOutcome;
  readonly dryRun: true;
  readonly wouldExecute: false;
  readonly evidence: readonly string[];
  readonly workId?: string;
  readonly goalEvolution?: GoalEvolutionDecision;
}

const blockedGoalTerms = [
  "unrelated",
  "also rewrite",
  "rewrite unrelated",
  "all services",
  "billing",
  "purchase",
  "secret",
  "destructive",
  "approve permission",
  "auto-approve"
];

const loopIntentTerms: Record<LoopConfig["kind"], readonly string[]> = {
  review: ["review", "validate", "test", "fix", "diagnose", "inspect", "summarize", "follow-up"],
  deploy: ["deploy", "release", "rollback", "validate", "smoke", "diagnose"],
  triage: ["triage", "classify", "prioritize", "route", "diagnose", "follow-up"],
  benchmark: ["benchmark", "scenario", "score", "judge", "driver", "fixture", "regression"],
  beads_work: ["bead", "beads", "task", "issue", "work", "validate", "diagnose", "follow-up"]
};

function normalizedTerms(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9.-]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4);
}

function includesAny(text: string, terms: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function sharesSignificantGoalTerm(previousGoal: string, newGoal: string): boolean {
  const previous = new Set(normalizedTerms(previousGoal));
  return normalizedTerms(newGoal).some((term) => previous.has(term));
}

export function evaluateGoalEvolution(
  loop: LoopConfig,
  proposal: GoalEvolutionProposal
): GoalEvolutionDecision {
  const evidence = [
    `goal.evolution.loop:${loop.id}`,
    `goal.evolution.previous:${loop.goal}`,
    `goal.evolution.proposed:${proposal.newGoal}`,
    ...proposal.evidence
  ];
  const trimmedGoal = proposal.newGoal.trim();
  const trimmedReason = proposal.reason.trim();

  if (trimmedGoal.length === 0 || trimmedReason.length === 0 || proposal.evidence.length === 0) {
    return {
      allowed: false,
      denialReason: "goal evolution requires a proposed goal, reason, and evidence",
      evidence: [...evidence, "goal.evolution.decision:deny", "goal.evolution.reason:missing_fields"]
    };
  }

  if (includesAny(trimmedGoal, blockedGoalTerms)) {
    return {
      allowed: false,
      denialReason: "proposed goal requests unrelated or risky work",
      evidence: [...evidence, "goal.evolution.decision:deny", "goal.evolution.reason:risky_scope"]
    };
  }

  if (loop.kind !== "deploy" && includesAny(trimmedGoal, ["deploy", "release to production", "production deploy"])) {
    return {
      allowed: false,
      denialReason: "non-deploy loop cannot evolve into a deploy goal",
      evidence: [...evidence, "goal.evolution.decision:deny", "goal.evolution.reason:deploy_scope"]
    };
  }

  const withinLoopIntent =
    includesAny(trimmedGoal, loopIntentTerms[loop.kind]) ||
    sharesSignificantGoalTerm(loop.goal, trimmedGoal);

  if (!withinLoopIntent) {
    return {
      allowed: false,
      denialReason: "proposed goal does not match the loop intent",
      evidence: [...evidence, "goal.evolution.decision:deny", "goal.evolution.reason:outside_loop_intent"]
    };
  }

  return {
    allowed: true,
    record: {
      loopId: loop.id,
      previousGoal: loop.goal,
      newGoal: trimmedGoal,
      reason: trimmedReason,
      evidence: proposal.evidence
    },
    evidence: [...evidence, "goal.evolution.decision:allow"]
  };
}

function policyActionFor(response: DryRunResponseKind): PolicyAction {
  switch (response) {
    case "wait":
    case "measure_context":
    case "build_context_pack":
    case "summarize":
    case "stop_loop":
      return "pull_beads_ready";
    case "smart_compact":
      return "update_beads_progress";
    case "nudge":
      return "send_prompt";
    case "ask_user":
      return "answer_agent_question";
    case "claim_task":
      return "claim_beads_task";
    case "create_task":
      return "create_beads_task";
    case "update_loop_goal":
      return "update_beads_progress";
  }
}

function contextHeavyResponse(response: DryRunResponseKind): boolean {
  return (
    response === "summarize" ||
    response === "nudge" ||
    response === "claim_task" ||
    response === "create_task" ||
    response === "update_loop_goal"
  );
}

function baseResponseFor(
  input: DryRunPlannerInput,
  goalEvolution?: GoalEvolutionDecision
): DryRunResponseKind {
  if (input.remoteHealth !== undefined && !input.remoteHealth.dispatchAllowed) {
    return "stop_loop";
  }

  switch (input.event.kind) {
    case "agent_working":
      return "wait";
    case "agent_done":
    case "loop_exit_success":
      return "summarize";
    case "agent_idle":
      return "nudge";
    case "agent_blocked":
      return "ask_user";
    case "beads_ready":
      return input.beadsSelection?.selected === undefined ? "wait" : "claim_task";
    case "repo_dirty_without_task":
      return "create_task";
    case "goal_drift_detected":
      if (goalEvolution?.allowed === false) return "ask_user";
      return "update_loop_goal";
    case "loop_exit_failure":
      return "stop_loop";
  }
}

function responseFor(
  input: DryRunPlannerInput,
  goalEvolution?: GoalEvolutionDecision
): DryRunResponseKind {
  const base = baseResponseFor(input, goalEvolution);
  if (base === "stop_loop" || base === "wait" || base === "ask_user") {
    return base;
  }

  if (input.contextBudget === undefined && contextHeavyResponse(base)) {
    return "measure_context";
  }

  switch (input.contextBudget?.status) {
    case "force_compact":
      return input.contextForceCompactOverride === true ? base : "smart_compact";
    case "compact_after_task":
      return "smart_compact";
    case "warn":
      return "build_context_pack";
    case "ok":
    case undefined:
      return base;
  }
}

function responseSummary(response: DryRunResponseKind, input: DryRunPlannerInput): string {
  const prefix = `Dry-run ${response} for loop ${input.loop.id}`;
  switch (response) {
    case "wait":
      return `${prefix}: ${input.event.summary}`;
    case "measure_context":
      return `${prefix}: measure context usage before planning context-heavy dispatch.`;
    case "build_context_pack":
      return `${prefix}: context usage is high; build a bounded context pack before dispatch.`;
    case "smart_compact":
      return `${prefix}: compact durable Beads memory before context-heavy dispatch.`;
    case "summarize":
      return `${prefix}: preserve status and validation evidence before further action.`;
    case "nudge":
      return `${prefix}: prepare a bounded harness instruction without sending it.`;
    case "ask_user":
      return `${prefix}: route the blocker or question to the operator.`;
    case "claim_task":
      return `${prefix}: selected ${input.beadsSelection?.selected?.id ?? "unknown work"} for claim.`;
    case "create_task":
      return `${prefix}: create follow-up Beads work for untracked repository state.`;
    case "update_loop_goal":
      return `${prefix}: propose a loop goal update from current repository/work evidence.`;
    case "stop_loop":
      return `${prefix}: stop dispatch until the blocking condition is resolved.`;
  }
}

function collectEvidence(
  input: DryRunPlannerInput,
  policy: PolicyOutcome,
  goalEvolution?: GoalEvolutionDecision
): readonly string[] {
  return [
    `planner.event:${input.event.kind}`,
    `planner.loop:${input.loop.id}`,
    ...input.event.evidence ?? [],
    ...input.observation?.evidence ?? [],
    ...(input.observation === undefined ? [] : [`planner.observation:${input.observation.state}:${input.observation.harness}`]),
    ...(input.repo === undefined ? [] : [`planner.repo:${summarizeRepoProbe(input.repo)}`]),
    ...input.beadsSelection?.evidence ?? [],
    ...input.remoteHealth?.evidence ?? [],
    ...(input.contextBudget === undefined ? [] : contextBudgetEvidence(input.contextBudget)),
    ...(input.contextBudget === undefined ? ["context.measure:required"] : []),
    ...(input.contextBudget?.status === "warn" ? ["context.warning:high_usage"] : []),
    ...(input.contextBudget?.status === "force_compact" && input.contextForceCompactOverride === true
      ? ["context.force_compact.override:true"]
      : []),
    ...goalEvolution?.evidence ?? [],
    ...policy.evidence
  ];
}

export function planDryRunResponse(input: DryRunPlannerInput): DryRunPlan {
  const goalEvolution = input.goalEvolution === undefined
    ? undefined
    : evaluateGoalEvolution(input.loop, input.goalEvolution);
  const response = responseFor(input, goalEvolution);
  const action = policyActionFor(response);
  const policy = evaluatePolicy({
    loop: input.loop,
    policy: input.policy,
    action,
    promptSendConfigured: input.promptSendConfigured,
    deterministicAnswer: false,
    hasAcceptanceEvidence: input.hasAcceptanceEvidence
  });

  return {
    loopId: input.loop.id,
    response,
    summary: responseSummary(response, input),
    policy,
    dryRun: true,
    wouldExecute: false,
    workId: input.beadsSelection?.selected?.id,
    goalEvolution,
    evidence: collectEvidence(input, policy, goalEvolution)
  };
}
