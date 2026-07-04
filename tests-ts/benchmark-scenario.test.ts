import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  BenchmarkScenarioError,
  loadBenchmarkScenarioFile,
  loadBenchmarkScenarioText
} from "../src/benchmark-scenario.js";

const fixtureText = readFileSync(
  "tests/fixtures/benchmarks/codex_done_dirty_repo_review.json",
  "utf8"
);

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

test("loads benchmark scenario fixture with repo Herdr harness loop policy and traits", () => {
  const scenario = loadBenchmarkScenarioText(fixtureText);

  assert.equal(scenario.schemaVersion, 1);
  assert.equal(scenario.id, "codex_done_dirty_repo_review");
  assert.equal(scenario.repo.branch, "feature/ciclo-review");
  assert.deepEqual(scenario.repo.dirtyFiles, ["src/response-planner.ts", "tests-ts/response-planner.test.ts"]);
  assert.equal(scenario.beads.ready[0]?.id, "ciclo-demo.1");
  assert.equal(scenario.beads.remoteDb?.mode, "local");
  assert.equal(scenario.herdrEvents[0]?.state, "done");
  assert.equal(scenario.herdrEvents[0]?.harness, "codex");
  assert.equal(scenario.harnessContext[0]?.transcriptExcerpt?.includes("planner behavior"), true);
  assert.equal(scenario.loop.kind, "review");
  assert.equal(scenario.loop.dryRun, true);
  assert.equal(scenario.policy.mode, "supervised");
  assert.ok(scenario.expected.responseKinds.includes("build_context_pack"));
  assert.ok(scenario.disallowed.actions.includes("close_work_without_validation"));
  assert.equal(scenario.drivers[0]?.role, "agent_driver");
  assert.equal(scenario.judges[0]?.kind, "deterministic");
});

test("benchmark scenario fixture format represents all required acceptance inputs", () => {
  const scenario = loadBenchmarkScenarioText(fixtureText);

  assert.ok(scenario.repo.configuredChecks.length > 0);
  assert.ok(scenario.herdrEvents.length > 0);
  assert.ok(scenario.harnessContext.length > 0);
  assert.ok(scenario.loop.goal.length > 0);
  assert.ok(scenario.policy.allowCommands.includes("just check"));
  assert.ok(scenario.expected.requiredActions.length > 0);
  assert.ok(scenario.disallowed.responseKinds.length > 0);
});

test("loads the initial required benchmark scenario suite", () => {
  const fixtureDir = "tests/fixtures/benchmarks";
  const scenarios = readdirSync(fixtureDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => loadBenchmarkScenarioFile(`${fixtureDir}/${file}`));
  const ids = new Set(scenarios.map((scenario) => scenario.id));
  const required = [
    "claude_blocked_permission",
    "codex_done_dirty_repo_review",
    "codex_idle_no_progress",
    "deploy_missing_secret",
    "review_findings_to_tasks"
  ];

  assert.ok(scenarios.length >= required.length);
  for (const id of required) assert.ok(ids.has(id), `missing scenario ${id}`);
  for (const scenario of scenarios) {
    assert.ok(scenario.repo.configuredChecks.length > 0);
    assert.ok(scenario.herdrEvents.length > 0);
    assert.ok(scenario.harnessContext.length > 0);
    assert.ok(scenario.expected.responseKinds.length > 0);
    assert.ok(scenario.expected.requiredActions.length > 0);
    assert.ok(scenario.disallowed.actions.length > 0);
    assert.ok(scenario.drivers.length > 0);
    assert.ok(scenario.judges.length > 0);
  }
});

test("loads the required context engineering benchmark scenarios", () => {
  const fixtureDir = "tests/fixtures/benchmarks";
  const ids = new Set(
    readdirSync(fixtureDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => loadBenchmarkScenarioFile(`${fixtureDir}/${file}`).id)
  );

  for (const id of [
    "context_warn_threshold",
    "smart_compact_after_bead_done",
    "smart_compact_redacts_sensitive",
    "force_compact_blocks_dispatch"
  ]) {
    assert.ok(ids.has(id), `missing context benchmark scenario ${id}`);
  }
});

test("loads the required multiuser auth benchmark scenarios", () => {
  const fixtureDir = "tests/fixtures/benchmarks";
  const ids = new Set(
    readdirSync(fixtureDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => loadBenchmarkScenarioFile(`${fixtureDir}/${file}`).id)
  );

  for (const id of [
    "single_mode_auth_ignored",
    "multiuser_unauthenticated_claim_denied",
    "device_flow_user_approved",
    "under_scoped_command_approval_denied",
    "owner_grants_remote_register"
  ]) {
    assert.ok(ids.has(id), `missing auth benchmark scenario ${id}`);
  }
});

test("loads the required MCP and remote-session benchmark scenarios", () => {
  const fixtureDir = "tests/fixtures/benchmarks";
  const ids = new Set(
    readdirSync(fixtureDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => loadBenchmarkScenarioFile(`${fixtureDir}/${file}`).id)
  );

  for (const id of [
    "mcp_status_query",
    "mcp_agent_question_to_operator",
    "mcp_operator_answer_routes_back",
    "remote_session_heartbeat_lost",
    "remote_duplicate_claim_prevented",
    "remote_attach_herdr_unavailable",
    "remote_attach_scope_violation"
  ]) {
    assert.ok(ids.has(id), `missing MCP/remote benchmark scenario ${id}`);
  }
});

test("loads the required Beads remote DB benchmark scenarios", () => {
  const fixtureDir = "tests/fixtures/benchmarks";
  const ids = new Set(
    readdirSync(fixtureDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => loadBenchmarkScenarioFile(`${fixtureDir}/${file}`).id)
  );

  for (const id of [
    "beads_shared_dolt_server_ready",
    "beads_dolt_pull_before_claim",
    "beads_remote_down_fail_closed",
    "beads_push_after_update",
    "beads_conflict_detected"
  ]) {
    assert.ok(ids.has(id), `missing Beads remote DB benchmark scenario ${id}`);
  }
});

test("loads the required Beads queue and tracker-sync benchmark scenarios", () => {
  const fixtureDir = "tests/fixtures/benchmarks";
  const ids = new Set(
    readdirSync(fixtureDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => loadBenchmarkScenarioFile(`${fixtureDir}/${file}`).id)
  );

  for (const id of [
    "beads_ready_claim_dispatch",
    "beads_blocked_dependency_wait",
    "beads_linear_sync_configured",
    "beads_jira_optional_sync_failure",
    "beads_tracker_sync_redacts_transcript"
  ]) {
    assert.ok(ids.has(id), `missing Beads queue/tracker benchmark scenario ${id}`);
  }
});

test("loads the required worker-session benchmark scenarios", () => {
  const fixtureDir = "tests/fixtures/benchmarks";
  const ids = new Set(
    readdirSync(fixtureDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => loadBenchmarkScenarioFile(`${fixtureDir}/${file}`).id)
  );

  for (const id of [
    "worker_launch_codex_session",
    "worker_mcp_secret_env_launch",
    "worker_stop_completed_claude_session",
    "post_close_launches_review_session",
    "claude_loop_surfaces_blocker",
    "codex_goal_launches_worker",
    "codex_goal_answer_reasonable_question"
  ]) {
    assert.ok(ids.has(id), `missing worker-session benchmark scenario ${id}`);
  }

  const launch = loadBenchmarkScenarioFile(`${fixtureDir}/worker_launch_codex_session.json`);
  assert.equal(launch.workerSessions[0]?.state, "planned");
  assert.equal(launch.workerSessions[0]?.harnessId, "codex");
  assert.equal(launch.workerSessions[0]?.model, "gpt-5.5");

  const secretEnv = loadBenchmarkScenarioFile(`${fixtureDir}/worker_mcp_secret_env_launch.json`);
  assert.equal(secretEnv.mcpCalls[0]?.tool, "ciclo_launch_worker_session");
  assert.equal(Array.isArray(secretEnv.mcpCalls[0]?.arguments.mcp_secret_env), true);
  assert.ok(secretEnv.expected.requiredActions.includes("configure_runtime_secret_exec"));
  assert.ok(secretEnv.expected.requiredActions.includes("redact_secret_env_outputs"));

  const cleanup = loadBenchmarkScenarioFile(`${fixtureDir}/worker_stop_completed_claude_session.json`);
  assert.equal(cleanup.workerSessions[0]?.state, "completed");
  assert.equal(cleanup.workerSessions[0]?.harnessId, "claude-code");
  assert.equal(cleanup.workerSessions[0]?.cleanupReason, "worker exited successfully");

  const postCloseReview = loadBenchmarkScenarioFile(`${fixtureDir}/post_close_launches_review_session.json`);
  assert.equal(postCloseReview.mcpCalls[0]?.tool, "ciclo_close_work");
  assert.equal(postCloseReview.mcpCalls[0]?.arguments.launch_review, true);
  assert.equal(postCloseReview.workerSessions[0]?.state, "planned");
  assert.ok(postCloseReview.expected.requiredActions.includes("launch_post_close_review"));

  const claudeLoop = loadBenchmarkScenarioFile(`${fixtureDir}/claude_loop_surfaces_blocker.json`);
  assert.equal(claudeLoop.harnessContext[0]?.controlDirective, "/loop");
  assert.equal(claudeLoop.harnessContext[0]?.question?.route, "ask_operator");
  assert.equal(claudeLoop.harnessContext[1]?.controllingSession, true);

  const codexGoal = loadBenchmarkScenarioFile(`${fixtureDir}/codex_goal_launches_worker.json`);
  assert.equal(codexGoal.harnessContext[0]?.controlDirective, "/goal");
  assert.ok(codexGoal.expected.requiredActions.includes("use_codex_goal_directive"));

  const answerable = loadBenchmarkScenarioFile(`${fixtureDir}/codex_goal_answer_reasonable_question.json`);
  assert.equal(answerable.harnessContext[0]?.question?.answerable, true);
  assert.equal(answerable.harnessContext[0]?.question?.route, "answer_directly");
});

test("loads required heartbeat project-memory benchmark scenarios", () => {
  const fixtureDir = "tests/fixtures/benchmarks";
  const ids = new Set(
    readdirSync(fixtureDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => loadBenchmarkScenarioFile(`${fixtureDir}/${file}`).id)
  );

  for (const id of [
    "heartbeat_project_memory_board_hygiene",
    "heartbeat_pr_review_model_selection",
    "heartbeat_stuck_session_model_escalation"
  ]) {
    assert.ok(ids.has(id), `missing heartbeat benchmark scenario ${id}`);
  }

  const memory = loadBenchmarkScenarioFile(`${fixtureDir}/heartbeat_project_memory_board_hygiene.json`);
  assert.ok(memory.expected.requiredActions.includes("record_heartbeat_project_memory"));
  assert.ok(memory.expected.requiredActions.includes("keep_unvalidated_work_open"));

  const review = loadBenchmarkScenarioFile(`${fixtureDir}/heartbeat_pr_review_model_selection.json`);
  assert.equal(review.workerSessions[1]?.harnessId, "claude-code");
  assert.equal(review.workerSessions[1]?.model, "claude-fable-5");
  assert.ok(review.expected.requiredActions.includes("launch_pr_review_worker"));

  const stuck = loadBenchmarkScenarioFile(`${fixtureDir}/heartbeat_stuck_session_model_escalation.json`);
  assert.equal(stuck.workerSessions[0]?.model, "gpt-5-mini");
  assert.ok(stuck.expected.evidenceIncludes.includes("model.escalation.recommended:gpt-5.5"));
  assert.ok(stuck.expected.requiredActions.includes("escalate_model_effort"));
});

test("loads project orchestrator benchmark scenario", () => {
  const scenario = loadBenchmarkScenarioFile("tests/fixtures/benchmarks/project_orchestrator_real_repo_adaptive.json");

  assert.equal(scenario.id, "project_orchestrator_real_repo_adaptive");
  assert.equal(scenario.loop.kind, "beads_work");
  assert.equal(scenario.beads.ready.length, 3);
  assert.equal(scenario.beads.claimed.length, 2);
  assert.ok(scenario.repo.errors.includes("ci.api:failed"));
  assert.ok(scenario.repo.errors.includes("ci.ui:failed"));
  assert.ok(scenario.workerSessions.some((session) => session.evidence.includes("worker.session.no_progress_turns:8")));
  assert.ok(scenario.workerSessions.some((session) => session.evidence.includes("worktree.stale:2")));
  assert.ok(scenario.expected.requiredActions.includes("launch_implementation_worker"));
  assert.ok(scenario.expected.requiredActions.includes("launch_review_worker"));
  assert.ok(scenario.expected.requiredActions.includes("launch_debug_worker"));
  assert.ok(scenario.expected.requiredActions.includes("launch_api_test_worker"));
  assert.ok(scenario.expected.requiredActions.includes("launch_ui_test_worker"));
  assert.ok(scenario.expected.requiredActions.includes("launch_monitor_worker"));
  assert.ok(scenario.expected.requiredActions.includes("cleanup_completed_sessions"));
  assert.ok(scenario.expected.requiredActions.includes("prune_stale_worktrees"));
  assert.ok(scenario.expected.requiredActions.includes("escalate_model_effort"));
  assert.ok(scenario.expected.requiredActions.includes("iterate_until_max_score"));
});

test("loads expanded project orchestration benchmark scenarios", () => {
  const fixtureDir = "tests/fixtures/benchmarks";
  const ids = new Set(
    readdirSync(fixtureDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => loadBenchmarkScenarioFile(`${fixtureDir}/${file}`).id)
  );

  for (const id of expandedOrchestrationScenarioIds) {
    assert.ok(ids.has(id), `missing expanded orchestration benchmark scenario ${id}`);
    const scenario = loadBenchmarkScenarioFile(`${fixtureDir}/${id}.json`);
    assert.equal(scenario.loop.id, "expanded-orchestration-bench");
    assert.ok(scenario.expected.requiredActions.length >= 4, `${id} should define enough required actions`);
    assert.ok(scenario.expected.evidenceIncludes.length >= 2, `${id} should define scoring evidence`);
    assert.ok((scenario.judges[0]?.dimensions.length ?? 0) >= 3, `${id} should define judge dimensions`);
  }

  const deploy = loadBenchmarkScenarioFile(`${fixtureDir}/deploy_smoke_failure_blocks_release.json`);
  assert.ok(deploy.expected.requiredActions.includes("block_deploy"));
  assert.ok(deploy.expected.requiredActions.includes("require_smoke_pass_before_deploy"));

  const localRemote = loadBenchmarkScenarioFile(`${fixtureDir}/local_remote_worker_coordination.json`);
  assert.ok(localRemote.herdrEvents.some((event) => event.state === "working"));
  assert.ok(localRemote.expected.requiredActions.includes("avoid_duplicate_test_worker"));

  const crash = loadBenchmarkScenarioFile(`${fixtureDir}/crash_recovery_reconstructs_board.json`);
  assert.ok(crash.remoteSessions.some((session) => session.state === "working"));
  assert.ok(crash.expected.requiredActions.includes("reconstruct_board_state"));
});

test("loads the required remote-runner benchmark scenarios", () => {
  const fixtureDir = "tests/fixtures/benchmarks";
  const scenario = loadBenchmarkScenarioFile(`${fixtureDir}/remote_runner_kubernetes_wireguard_attach.json`);

  assert.equal(scenario.id, "remote_runner_kubernetes_wireguard_attach");
  assert.equal(scenario.remoteSessions[0]?.remoteSessionId, "runner-k8s-1");
  assert.ok(scenario.expected.evidenceIncludes.includes("remote.runner.execution_model:kubernetes_statefulset"));
  assert.ok(scenario.expected.evidenceIncludes.includes("remote.runner.egress:planned"));
  assert.ok(scenario.expected.evidenceIncludes.includes("remote.runner.wireguard:planned"));
  assert.ok(scenario.expected.evidenceIncludes.includes("remote.runner.wireguard.host_routing:enabled"));
  assert.ok(scenario.expected.requiredActions.includes("provide_ciclo_attach_plan"));
});

test("benchmark scenario validation reports missing required fields", () => {
  assert.throws(
    () => loadBenchmarkScenarioText(JSON.stringify({ schema_version: 1, id: "bad" })),
    (error) => error instanceof BenchmarkScenarioError && /beads must be an object/.test(error.message)
  );
});

test("benchmark scenario loader is explicit about JSON fixture syntax", () => {
  assert.throws(
    () => loadBenchmarkScenarioText("id: yaml-later\n"),
    (error) => error instanceof BenchmarkScenarioError && /JSON object syntax/.test(error.message)
  );
});
