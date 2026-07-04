import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFixtureCandidate,
  loadBenchmarkScenarioSuite,
  runBenchmarkScenario,
  runBenchmarkSuite
} from "../src/benchmark-runner.js";
import { loadBenchmarkScenarioFile } from "../src/benchmark-scenario.js";

const expandedOrchestrationScenarioIds = [
  "startup_first_wake_state_selection",
  "pr_review_bottleneck_prioritizes_risk",
  "flaky_ci_diagnosis",
  "stale_worktree_dirty_cleanup",
  "api_contract_drift_coordination",
  "ui_screenshot_regression_verification",
  "stuck_worker_turn_escalation",
  "conflicting_worker_edits_reconciliation",
  "risky_change_operator_approval",
  "remote_runner_lost_mid_task",
  "integration_secret_missing",
  "post_merge_cleanup",
  "review_followup_bugs_to_beads",
  "deploy_smoke_failure_blocks_release",
  "mixed_harness_model_routing",
  "context_budget_near_limit_compaction",
  "local_remote_worker_coordination",
  "beads_remote_conflict_resolution",
  "benchmark_regression_creates_task",
  "idle_monitor_session_recovery",
  "crash_recovery_reconstructs_board"
] as const;

test("benchmark runner loads the fixture suite in deterministic order", () => {
  const scenarios = loadBenchmarkScenarioSuite();
  const ids = scenarios.map((scenario) => scenario.id);

  assert.deepEqual(ids, [...ids].sort());
  for (const id of [
    "claude_blocked_permission",
    "codex_done_dirty_repo_review",
    "codex_idle_no_progress",
    "deploy_missing_secret",
    "review_findings_to_tasks",
    "context_warn_threshold",
    "smart_compact_after_bead_done",
    "smart_compact_redacts_sensitive",
    "force_compact_blocks_dispatch",
    "remote_runner_kubernetes_wireguard_attach",
    "worker_launch_codex_session",
    "worker_mcp_secret_env_launch",
    "worker_stop_completed_claude_session",
    "post_close_launches_review_session",
    "claude_loop_surfaces_blocker",
    "codex_goal_launches_worker",
    "codex_goal_answer_reasonable_question",
    "project_orchestrator_real_repo_adaptive",
    "heartbeat_project_memory_board_hygiene",
    "heartbeat_pr_review_model_selection",
    "heartbeat_stuck_session_model_escalation",
    ...expandedOrchestrationScenarioIds
  ]) {
    assert.ok(ids.includes(id), `missing benchmark scenario ${id}`);
  }
});

test("fixture candidate preserves harness control directives and question routing", () => {
  const claudeLoop = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/claude_loop_surfaces_blocker.json");
  const claudeCandidate = buildFixtureCandidate(claudeLoop);
  assert.ok(claudeCandidate.evidence.includes("harness.control.claude-code:/loop"));
  assert.ok(claudeCandidate.actions.some((action) => action.kind === "use_claude_loop_directive"));
  assert.ok(claudeCandidate.actions.some((action) => action.kind === "surface_problem_to_controlling_session"));
  assert.match(claudeCandidate.text, /Use \/loop for claude-code/);

  const codexGoal = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/codex_goal_launches_worker.json");
  const codexCandidate = buildFixtureCandidate(codexGoal);
  assert.ok(codexCandidate.evidence.includes("harness.control.codex:/goal"));
  assert.ok(codexCandidate.actions.some((action) => action.kind === "use_codex_goal_directive"));
  assert.match(codexCandidate.text, /Use \/goal for codex/);

  const answerable = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/codex_goal_answer_reasonable_question.json");
  const answerCandidate = buildFixtureCandidate(answerable);
  assert.ok(answerCandidate.evidence.includes("harness.question.route:answer_directly"));
  assert.ok(answerCandidate.actions.some((action) => action.kind === "answer_reasonable_harness_question"));
  assert.match(answerCandidate.text, /Run npm run check/);
});

test("fixture candidate satisfies expected traits without disallowed actions", () => {
  const scenario = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/review_findings_to_tasks.json");
  const candidate = buildFixtureCandidate(scenario);

  assert.equal(candidate.responseKind, "create_beads_tasks");
  assert.ok(candidate.evidence.some((item) => item.includes("review.findings:2")));
  assert.ok(candidate.actions.some((action) => action.kind === "create_scoped_followup_tasks"));
  assert.equal(candidate.actions.some((action) => action.kind === "scope_expansion"), false);
});

test("fixture candidate preserves access approval and remote session evidence", () => {
  const scenario = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/owner_grants_remote_register.json");
  const candidate = buildFixtureCandidate(scenario);

  assert.ok(candidate.evidence.includes("remote.session:registered"));
  assert.ok(candidate.evidence.includes("access.grant:owner"));
  assert.ok(candidate.actions.every((action) => action.approved === true));
});

test("fixture candidate preserves worker session evidence", () => {
  const scenario = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/worker_launch_codex_session.json");
  const candidate = buildFixtureCandidate(scenario);

  assert.equal(candidate.responseKind, "launch_worker_session");
  assert.ok(candidate.evidence.includes("worker.session.launch:planned"));
  assert.ok(candidate.evidence.includes("worker.session.harness:codex"));
  assert.ok(candidate.actions.some((action) => action.kind === "record_worker_session"));
});

test("fixture candidate requires post-close review launch", () => {
  const scenario = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/post_close_launches_review_session.json");
  const candidate = buildFixtureCandidate(scenario);

  assert.equal(candidate.responseKind, "close_work");
  assert.ok(candidate.evidence.includes("review.session.reason:task_finished"));
  assert.ok(candidate.evidence.includes("worker.session.launch:planned"));
  assert.ok(candidate.actions.some((action) => action.kind === "launch_post_close_review"));
  assert.ok(candidate.actions.some((action) => action.kind === "record_review_worker_session"));
});

test("fixture candidate requires MCP secret env resolution without prompt secrets", () => {
  const scenario = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/worker_mcp_secret_env_launch.json");
  const candidate = buildFixtureCandidate(scenario);

  assert.equal(candidate.responseKind, "launch_worker_session");
  assert.ok(candidate.evidence.includes("worker.mcp_config.secret_env:1"));
  assert.ok(candidate.evidence.includes("mcp.secret_env:runtime_exec"));
  assert.ok(candidate.actions.some((action) => action.kind === "configure_runtime_secret_exec"));
  assert.ok(candidate.actions.some((action) => action.kind === "redact_secret_env_outputs"));
  assert.doesNotMatch(candidate.text, /API_TOKEN=secret|raw secret value/);
});

test("fixture candidate benchmarks heartbeat project memory and model escalation", () => {
  const memory = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/heartbeat_project_memory_board_hygiene.json");
  const memoryCandidate = buildFixtureCandidate(memory);
  assert.equal(memoryCandidate.responseKind, "record_project_memory");
  assert.ok(memoryCandidate.evidence.includes("memory.project.open:ciclo-memory.2"));
  assert.ok(memoryCandidate.actions.some((action) => action.kind === "record_heartbeat_project_memory"));
  assert.ok(memoryCandidate.actions.some((action) => action.kind === "keep_unvalidated_work_open"));

  const review = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/heartbeat_pr_review_model_selection.json");
  const reviewCandidate = buildFixtureCandidate(review);
  assert.equal(reviewCandidate.responseKind, "launch_review_worker");
  assert.ok(reviewCandidate.evidence.includes("model.review.recommended:claude-fable-5"));
  assert.ok(reviewCandidate.evidence.includes("worker.mcp_config.clients:claude,codex"));
  assert.ok(reviewCandidate.actions.some((action) => action.kind === "select_review_model"));
  assert.ok(reviewCandidate.actions.some((action) => action.kind === "launch_pr_review_worker"));

  const stuck = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/heartbeat_stuck_session_model_escalation.json");
  const stuckCandidate = buildFixtureCandidate(stuck);
  assert.equal(stuckCandidate.responseKind, "ask_operator");
  assert.ok(stuckCandidate.evidence.includes("model.escalation.recommended:gpt-5.5"));
  assert.ok(stuckCandidate.actions.some((action) => action.kind === "build_bounded_context_pack"));
  assert.ok(stuckCandidate.actions.some((action) => action.kind === "escalate_model_effort"));
});

test("fixture candidate benchmarks project orchestrator adaptation", () => {
  const scenario = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/project_orchestrator_real_repo_adaptive.json");
  const candidate = buildFixtureCandidate(scenario);

  assert.equal(candidate.responseKind, "report_feedback");
  for (const evidence of [
    "repo.realistic_state:dirty_branch",
    "beads.ready:3",
    "ci.api:failed",
    "ci.ui:failed",
    "worker.session.turns:37",
    "model.escalation.recommended:configured_stronger_openai_model",
    "effort.escalation.recommended:high",
    "worktree.cleanup.plan:prune_after_evidence_preserved",
    "benchmark.iteration.goal:max_score"
  ]) {
    assert.ok(candidate.evidence.includes(evidence), `missing evidence ${evidence}`);
  }
  for (const action of [
    "record_brain_decision",
    "score_orchestration_response",
    "iterate_until_max_score",
    "launch_implementation_worker",
    "launch_review_worker",
    "launch_debug_worker",
    "launch_api_test_worker",
    "launch_ui_test_worker",
    "launch_monitor_worker",
    "route_session_feedback",
    "cleanup_completed_sessions",
    "record_cleanup_plan",
    "prune_stale_worktrees",
    "escalate_model_effort"
  ]) {
    assert.ok(candidate.actions.some((item) => item.kind === action), `missing action ${action}`);
  }
  assert.ok(candidate.actions.some((item) => item.kind === "use_claude_loop_directive"));
  assert.ok(candidate.actions.some((item) => item.kind === "use_codex_goal_directive"));
  assert.ok(candidate.actions.some((item) => item.kind === "answer_reasonable_harness_question"));
});

test("fixture candidate scores expanded project orchestration scenarios", async () => {
  for (const id of expandedOrchestrationScenarioIds) {
    const scenario = loadBenchmarkScenarioFile(`tests/fixtures/benchmarks/${id}.json`);
    const candidate = buildFixtureCandidate(scenario);

    assert.ok(scenario.judges.some((judge) => judge.kind === "deterministic"), `${id} missing deterministic judge`);
    assert.ok((scenario.judges[0]?.dimensions.length ?? 0) > 0, `${id} missing judge dimensions`);
    for (const action of scenario.expected.requiredActions) {
      assert.ok(candidate.actions.some((item) => item.kind === action), `${id} missing action ${action}`);
    }
    for (const evidence of scenario.expected.evidenceIncludes) {
      assert.ok(candidate.evidence.includes(evidence), `${id} missing evidence ${evidence}`);
    }

    const report = await runBenchmarkScenario(scenario);
    assert.equal(report.safety.passed, true, `${id} safety failed: ${report.failures.join(",")}`);
    assert.equal(report.score, 1, `${id} score`);
    assert.equal(report.recommendedAction, "accept", `${id} recommended action`);
  }
});

test("benchmark scenario report puts deterministic safety before judge scores", async () => {
  const scenario = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/deploy_missing_secret.json");
  const report = await runBenchmarkScenario(scenario);

  assert.equal(report.scenarioId, "deploy_missing_secret");
  assert.equal(report.safety.passed, true);
  assert.equal(report.judgeResults.length, 1);
  assert.equal(report.judgeResults[0]?.score, 1);
  assert.equal(report.score, 1);
  assert.equal(report.recommendedAction, "accept");
  assert.deepEqual(report.failures, []);
  assert.ok(report.evidence.indexOf("benchmark.safety.scenario:deploy_missing_secret") > -1);
});

test("benchmark suite runs at least five scenarios and emits scored reports", async () => {
  const report = await runBenchmarkSuite();

  assert.equal(report.ok, true);
  assert.ok(report.scenarioCount >= 9);
  assert.equal(report.failures.length, 0);
  assert.equal(report.reports.length, report.scenarioCount);
  for (const scenarioReport of report.reports) {
    assert.equal(scenarioReport.safety.passed, true);
    assert.equal(scenarioReport.score, 1);
    assert.equal(scenarioReport.recommendedAction, "accept");
    assert.ok(scenarioReport.plannerVersion.includes("benchmark-v1"));
  }
});
