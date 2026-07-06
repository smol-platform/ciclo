import assert from "node:assert/strict";
import test from "node:test";

import { cicloMcpPrompts, cicloMcpResources, cicloMcpTools } from "../src/mcp-contract.js";

const expectedTools = [
  "ciclo_status",
  "ciclo_loop_status",
  "ciclo_decide",
  "ciclo_poll_events",
  "ciclo_remember",
  "ciclo_list_memories",
  "ciclo_compact_memories",
  "ciclo_list_cron_jobs",
  "ciclo_run_due_cron",
  "ciclo_board",
  "ciclo_list_ready_work",
  "ciclo_claim_work",
  "ciclo_start_work",
  "ciclo_update_work",
  "ciclo_close_work",
  "ciclo_ask_operator",
  "ciclo_answer_question",
  "ciclo_report_feedback",
  "ciclo_sync_remote_trackers",
  "ciclo_register_remote_session",
  "ciclo_heartbeat_remote_session",
  "ciclo_detach_remote_session",
  "ciclo_launch_remote_runner",
  "ciclo_list_remote_runners",
  "ciclo_list_secret_providers",
  "ciclo_request_secret",
  "ciclo_attach_plan",
  "ciclo_launch_worker_session",
  "ciclo_heartbeat_worker_session",
  "ciclo_list_worker_sessions",
  "ciclo_stop_worker_session",
  "ciclo_gc_worker_workspaces",
  "ciclo_auth_device_start",
  "ciclo_auth_device_poll",
  "ciclo_whoami",
  "ciclo_grant_access",
  "ciclo_revoke_access"
];

const expectedResources = [
  "ciclo://status",
  "ciclo://loops",
  "ciclo://loops/{loop_id}",
  "ciclo://events",
  "ciclo://heartbeat",
  "ciclo://cron",
  "ciclo://memory",
  "ciclo://board",
  "ciclo://work/ready",
  "ciclo://work/{bead_id}",
  "ciclo://questions",
  "ciclo://feedback",
  "ciclo://remote-sessions",
  "ciclo://remote-runners",
  "ciclo://secret-providers",
  "ciclo://worker-sessions",
  "ciclo://session/access",
  "ciclo://users/me",
  "ciclo://benchmarks/latest"
];

const expectedPrompts = [
  "ciclo_continue_work",
  "ciclo_review_loop",
  "ciclo_deploy_gate",
  "ciclo_answer_operator_question",
  "ciclo_report_feedback"
];

test("MCP tool catalog covers required control-plane tools", () => {
  assert.deepEqual(
    cicloMcpTools.map((tool) => tool.name),
    expectedTools
  );
});

test("MCP tools declare schemas permissions side effects and audit requirements", () => {
  for (const tool of cicloMcpTools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(tool.outputSchema.type, "object", tool.name);
    assert.ok(tool.description.length > 10, tool.name);
    assert.ok(tool.permission.action.length > 0, tool.name);
    assert.ok(tool.permission.capability.length > 0, tool.name);
    assert.ok(tool.sideEffects.length > 0, tool.name);
    assert.ok(tool.audit.event.startsWith("mcp."), tool.name);
    assert.ok(tool.audit.includeFields.length > 0, tool.name);
  }
});

test("mutating MCP tools are not marked read-only and have side effects", () => {
  const mutating = cicloMcpTools.filter((tool) => !tool.permission.readOnly);
  assert.ok(mutating.length > 0);
  for (const tool of mutating) {
    assert.notDeepEqual(tool.sideEffects, ["none"], tool.name);
    assert.notEqual(tool.permission.authentication, "none_in_single_mode", tool.name);
  }
  assert.equal(cicloMcpTools.find((tool) => tool.name === "ciclo_claim_work")?.permission.capability, "work.claim");
  assert.equal(cicloMcpTools.find((tool) => tool.name === "ciclo_close_work")?.permission.capability, "work.close");
  assert.equal(cicloMcpTools.find((tool) => tool.name === "ciclo_register_remote_session")?.permission.capability, "remote.register");
  assert.equal(cicloMcpTools.find((tool) => tool.name === "ciclo_launch_remote_runner")?.permission.capability, "remote.register");
  assert.equal(cicloMcpTools.find((tool) => tool.name === "ciclo_request_secret")?.permission.capability, "secret.read");
  assert.equal(cicloMcpTools.find((tool) => tool.name === "ciclo_decide")?.permission.capability, "brain.decide");
  assert.deepEqual(cicloMcpTools.find((tool) => tool.name === "ciclo_decide")?.sideEffects, ["model_call"]);
  assert.equal(cicloMcpTools.find((tool) => tool.name === "ciclo_launch_worker_session")?.permission.action, "send_prompt");
});

test("sensitive MCP tools require audit redaction", () => {
  const redactedTools = [
    "ciclo_start_work",
    "ciclo_update_work",
    "ciclo_close_work",
    "ciclo_ask_operator",
    "ciclo_answer_question",
    "ciclo_decide",
    "ciclo_remember",
    "ciclo_report_feedback",
    "ciclo_register_remote_session",
    "ciclo_launch_remote_runner",
    "ciclo_request_secret",
    "ciclo_launch_worker_session",
    "ciclo_heartbeat_worker_session",
    "ciclo_stop_worker_session",
    "ciclo_auth_device_start",
    "ciclo_auth_device_poll"
  ];
  for (const name of redactedTools) {
    const tool = cicloMcpTools.find((entry) => entry.name === name);
    assert.ok(tool, name);
    assert.ok(tool.audit.redactFields.length > 0, name);
  }
});

test("MCP resources and prompts cover required status work question feedback remote and benchmark surfaces", () => {
  assert.deepEqual(
    cicloMcpResources.map((resource) => resource.uriTemplate),
    expectedResources
  );
  assert.deepEqual(
    cicloMcpPrompts.map((prompt) => prompt.name),
    expectedPrompts
  );
  assert.ok(cicloMcpResources.every((resource) => resource.outputSchema.type === "object"));
  assert.ok(cicloMcpResources.every((resource) => resource.permission.readOnly));
  assert.ok(cicloMcpPrompts.every((prompt) => prompt.argumentsSchema.type === "object"));
});
