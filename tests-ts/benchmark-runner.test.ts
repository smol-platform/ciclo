import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFixtureCandidate,
  loadBenchmarkScenarioSuite,
  runBenchmarkScenario,
  runBenchmarkSuite
} from "../src/benchmark-runner.js";
import { loadBenchmarkScenarioFile } from "../src/benchmark-scenario.js";

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
    "codex_goal_answer_reasonable_question"
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
