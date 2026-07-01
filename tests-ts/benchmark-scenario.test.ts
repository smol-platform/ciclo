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
    "worker_stop_completed_claude_session",
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

  const cleanup = loadBenchmarkScenarioFile(`${fixtureDir}/worker_stop_completed_claude_session.json`);
  assert.equal(cleanup.workerSessions[0]?.state, "completed");
  assert.equal(cleanup.workerSessions[0]?.harnessId, "claude-code");
  assert.equal(cleanup.workerSessions[0]?.cleanupReason, "worker exited successfully");

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

test("loads the required remote-runner benchmark scenarios", () => {
  const fixtureDir = "tests/fixtures/benchmarks";
  const scenario = loadBenchmarkScenarioFile(`${fixtureDir}/remote_runner_kubernetes_wireguard_attach.json`);

  assert.equal(scenario.id, "remote_runner_kubernetes_wireguard_attach");
  assert.equal(scenario.remoteSessions[0]?.remoteSessionId, "runner-k8s-1");
  assert.ok(scenario.expected.evidenceIncludes.includes("remote.runner.wireguard:planned"));
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
