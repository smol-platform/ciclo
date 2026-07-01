import assert from "node:assert/strict";
import test from "node:test";

import type { BeadsWorkSelection } from "../src/beads-work-queue.js";
import type { BeadsRemoteHealthDecision } from "../src/beads-remote-health.js";
import type { BeadsTaskSnapshot } from "../src/beads-adapter.js";
import type { HerdrObservation, LoopConfig } from "../src/ciclo-core.js";
import {
  buildContextBudgetState,
  estimateTokensFromText,
  type ContextBudgetState
} from "../src/context-budget.js";
import type { PolicyConfig } from "../src/loop-config.js";
import { evaluateGoalEvolution, planDryRunResponse } from "../src/response-planner.js";
import type { RepoProbe } from "../src/repo-probe.js";

const loop: LoopConfig = {
  id: "review-loop",
  kind: "review",
  goal: "Review work",
  harnesses: ["codex"],
  dryRun: true
};

const policy: PolicyConfig = {
  mode: "supervised",
  requireApprovalFor: ["prompt_send"],
  allowCommands: ["just check"]
};

const observation: HerdrObservation = {
  source: "fixture",
  target: "pane-1",
  harness: "codex",
  state: "working",
  evidence: ["herdr:working"]
};

function task(id: string): BeadsTaskSnapshot {
  return {
    id,
    title: id,
    status: "open",
    priority: 1,
    issueType: "task",
    description: "",
    acceptanceCriteria: "",
    labels: ["mvp"],
    dependencies: [],
    externalRefs: []
  };
}

function contextBudget(usedTokens: number): ContextBudgetState {
  return buildContextBudgetState({
    scope: { kind: "loop", id: "review-loop", loopId: "review-loop" },
    maxTokens: 1000,
    estimate: { usedTokens, source: "tokenizer", attributedTo: ["test"] },
    reserves: [],
    thresholds: { warn: 0.6, compactAfterTask: 0.75, forceCompact: 0.9 }
  });
}

test("planner returns wait for active work with policy and evidence", () => {
  const plan = planDryRunResponse({
    loop,
    policy,
    event: { kind: "agent_working", summary: "agent is still busy", evidence: ["event:working"] },
    observation
  });

  assert.equal(plan.response, "wait");
  assert.equal(plan.dryRun, true);
  assert.equal(plan.wouldExecute, false);
  assert.equal(plan.policy.decision, "allow");
  assert.ok(plan.evidence.includes("herdr:working"));
});

test("planner returns summarize for done work and carries repo and context evidence", () => {
  const repo: RepoProbe = {
    root: "/repo",
    isGitRepo: true,
    branch: "main",
    upstream: "origin/main",
    dirtyFiles: ["src/app.ts"],
    stagedFiles: [],
    beadsPresent: true,
    configuredChecks: ["just check"],
    errors: []
  };
  const contextBudget = buildContextBudgetState({
    scope: { kind: "loop", id: "review-loop", loopId: "review-loop" },
    maxTokens: 20_000,
    estimate: estimateTokensFromText("validation evidence", ["test"])
  });

  const plan = planDryRunResponse({
    loop,
    policy,
    repo,
    contextBudget,
    event: { kind: "agent_done", summary: "agent finished" },
    observation: { ...observation, state: "done" }
  });

  assert.equal(plan.response, "summarize");
  assert.match(plan.summary, /preserve status/);
  assert.ok(plan.evidence.some((item) => item.startsWith("planner.repo:")));
  assert.ok(plan.evidence.some((item) => item.startsWith("context.status:")));
});

test("planner returns nudge for idle work but keeps dry-run policy boundary", () => {
  const plan = planDryRunResponse({
    loop,
    policy,
    event: { kind: "agent_idle", summary: "agent idle" },
    observation: { ...observation, state: "idle" },
    contextBudget: contextBudget(100),
    promptSendConfigured: true
  });

  assert.equal(plan.response, "nudge");
  assert.equal(plan.policy.decision, "dry_run_only");
  assert.match(plan.summary, /without sending/);
});

test("planner asks user for blocked work", () => {
  const plan = planDryRunResponse({
    loop,
    policy,
    event: { kind: "agent_blocked", summary: "needs product answer" },
    observation: { ...observation, state: "blocked", evidence: ["herdr:needs-input"] }
  });

  assert.equal(plan.response, "ask_user");
  assert.equal(plan.policy.decision, "dry_run_only");
  assert.ok(plan.evidence.includes("herdr:needs-input"));
});

test("planner creates task updates goals and claims selected Beads work in dry-run", () => {
  const selection: BeadsWorkSelection = {
    selected: task("ciclo-1"),
    skipped: [],
    evidence: ["beads.select.selected:ciclo-1"]
  };

  const claim = planDryRunResponse({
    loop,
    policy,
    beadsSelection: selection,
    contextBudget: contextBudget(100),
    event: { kind: "beads_ready", summary: "ready work exists" }
  });
  const create = planDryRunResponse({
    loop,
    policy,
    contextBudget: contextBudget(100),
    event: { kind: "repo_dirty_without_task", summary: "dirty changes lack task" }
  });
  const updateGoal = planDryRunResponse({
    loop,
    policy,
    contextBudget: contextBudget(100),
    event: { kind: "goal_drift_detected", summary: "repo state changed goal" }
  });

  assert.equal(claim.response, "claim_task");
  assert.equal(claim.workId, "ciclo-1");
  assert.equal(claim.policy.decision, "dry_run_only");
  assert.equal(create.response, "create_task");
  assert.equal(updateGoal.response, "update_loop_goal");
});

test("goal evolution records allowed scoped refinements with reason and evidence", () => {
  const proposal = {
    newGoal: "Validate fixes for ciclo-1 and rerun targeted tests",
    reason: "Agent completed implementation and repo has test changes",
    evidence: ["herdr:done", "git:tests-modified", "beads:ciclo-1"]
  };
  const decision = evaluateGoalEvolution(loop, proposal);
  const plan = planDryRunResponse({
    loop,
    policy,
    contextBudget: contextBudget(100),
    event: { kind: "goal_drift_detected", summary: "repo state changed goal" },
    goalEvolution: proposal
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.record?.loopId, "review-loop");
  assert.equal(decision.record?.previousGoal, "Review work");
  assert.equal(decision.record?.newGoal, proposal.newGoal);
  assert.deepEqual(decision.record?.evidence, proposal.evidence);
  assert.equal(plan.response, "update_loop_goal");
  assert.equal(plan.goalEvolution?.allowed, true);
  assert.ok(plan.evidence.includes("goal.evolution.decision:allow"));
});

test("goal evolution rejects scope expansion and routes to operator", () => {
  const plan = planDryRunResponse({
    loop,
    policy,
    contextBudget: contextBudget(100),
    event: { kind: "goal_drift_detected", summary: "repo state changed goal" },
    goalEvolution: {
      newGoal: "Deploy to production and also rewrite unrelated services",
      reason: "The branch looks close enough",
      evidence: ["git:dirty"]
    }
  });

  assert.equal(plan.response, "ask_user");
  assert.equal(plan.goalEvolution?.allowed, false);
  assert.equal(plan.goalEvolution?.record, undefined);
  assert.match(plan.goalEvolution?.denialReason ?? "", /unrelated|risky|deploy/);
  assert.ok(plan.evidence.includes("goal.evolution.decision:deny"));
  assert.ok(
    plan.evidence.some((item) =>
      item === "goal.evolution.reason:risky_scope" || item === "goal.evolution.reason:deploy_scope"
    )
  );
});

test("planner stops loop when remote health blocks dispatch", () => {
  const remoteHealth: BeadsRemoteHealthDecision = {
    dispatchAllowed: false,
    loopBlocked: true,
    operatorFeedback: ["remote DB unavailable"],
    evidence: ["beads.remote.dispatch:block"]
  };

  const plan = planDryRunResponse({
    loop,
    policy,
    remoteHealth,
    event: { kind: "beads_ready", summary: "ready work exists" }
  });

  assert.equal(plan.response, "stop_loop");
  assert.match(plan.summary, /blocking condition/);
  assert.ok(plan.evidence.includes("beads.remote.dispatch:block"));
});

test("planner measures context before context-heavy dispatch without a budget", () => {
  const plan = planDryRunResponse({
    loop,
    policy,
    event: { kind: "agent_idle", summary: "agent idle" },
    observation: { ...observation, state: "idle" },
    promptSendConfigured: true
  });

  assert.equal(plan.response, "measure_context");
  assert.match(plan.summary, /measure context usage/);
  assert.ok(plan.evidence.includes("context.measure:required"));
});

test("planner builds context pack and warns when context usage is high", () => {
  const plan = planDryRunResponse({
    loop,
    policy,
    event: { kind: "agent_idle", summary: "agent idle" },
    observation: { ...observation, state: "idle" },
    contextBudget: contextBudget(650),
    promptSendConfigured: true
  });

  assert.equal(plan.response, "build_context_pack");
  assert.match(plan.summary, /bounded context pack/);
  assert.ok(plan.evidence.includes("context.status:warn"));
  assert.ok(plan.evidence.includes("context.warning:high_usage"));
});

test("planner emits smart compact for compact and force compact thresholds", () => {
  const compact = planDryRunResponse({
    loop,
    policy,
    event: { kind: "agent_done", summary: "agent done" },
    observation: { ...observation, state: "done" },
    contextBudget: contextBudget(760)
  });
  const force = planDryRunResponse({
    loop,
    policy,
    event: { kind: "agent_idle", summary: "agent idle" },
    observation: { ...observation, state: "idle" },
    contextBudget: contextBudget(950),
    promptSendConfigured: true
  });

  assert.equal(compact.response, "smart_compact");
  assert.equal(force.response, "smart_compact");
  assert.match(force.summary, /compact durable Beads memory/);
  assert.ok(force.evidence.includes("context.status:force_compact"));
});

test("planner allows force compact override for context-heavy dispatch", () => {
  const plan = planDryRunResponse({
    loop,
    policy,
    event: { kind: "agent_idle", summary: "agent idle" },
    observation: { ...observation, state: "idle" },
    contextBudget: contextBudget(950),
    contextForceCompactOverride: true,
    promptSendConfigured: true
  });

  assert.equal(plan.response, "nudge");
  assert.ok(plan.evidence.includes("context.force_compact.override:true"));
});
