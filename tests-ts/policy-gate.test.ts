import assert from "node:assert/strict";
import test from "node:test";

import type { LoopConfig } from "../src/ciclo-core.js";
import type { PolicyConfig } from "../src/loop-config.js";
import { evaluatePolicy } from "../src/policy-gate.js";

const activeLoop: LoopConfig = {
  id: "review-demo",
  kind: "review",
  goal: "Review work",
  harnesses: ["codex"],
  dryRun: false
};

const dryRunLoop: LoopConfig = {
  ...activeLoop,
  dryRun: true
};

const policy: PolicyConfig = {
  mode: "supervised",
  requireApprovalFor: ["task_close", "prompt_send", "deploy"],
  allowCommands: ["just check"]
};

test("policy allows local Beads task creation outside dry-run mode", () => {
  const result = evaluatePolicy({ loop: activeLoop, policy, action: "create_beads_task" });
  assert.equal(result.decision, "allow");
});

test("policy keeps mutating actions dry-run only when loop is dry-run", () => {
  const result = evaluatePolicy({ loop: dryRunLoop, policy, action: "create_beads_task" });
  assert.equal(result.decision, "dry_run_only");
});

test("policy blocks prompt sending until configured", () => {
  const result = evaluatePolicy({ loop: activeLoop, policy, action: "send_prompt" });
  assert.equal(result.decision, "deny");
  assert.match(result.reason, /disabled until configured/);
});

test("policy asks operator for configured prompt sending when approval is required", () => {
  const result = evaluatePolicy({
    loop: activeLoop,
    policy,
    action: "send_prompt",
    promptSendConfigured: true
  });
  assert.equal(result.decision, "ask_operator");
});

test("policy blocks tests until configured and allowlisted", () => {
  assert.equal(evaluatePolicy({ loop: activeLoop, policy, action: "run_test" }).decision, "deny");
  assert.equal(
    evaluatePolicy({
      loop: activeLoop,
      policy,
      action: "run_test",
      testsConfigured: true,
      command: "npm test"
    }).decision,
    "deny"
  );
  assert.equal(
    evaluatePolicy({
      loop: activeLoop,
      policy,
      action: "run_test",
      testsConfigured: true,
      command: "just check"
    }).decision,
    "allow"
  );
});

test("policy blocks deploys and permission approvals by default", () => {
  assert.equal(evaluatePolicy({ loop: activeLoop, policy, action: "deploy" }).decision, "deny");
  assert.equal(
    evaluatePolicy({ loop: activeLoop, policy, action: "approve_permission" }).decision,
    "deny"
  );
});

test("policy allows remote tracker sync only when Beads integration is configured", () => {
  assert.equal(evaluatePolicy({ loop: activeLoop, policy, action: "remote_tracker_sync" }).decision, "deny");
  assert.equal(
    evaluatePolicy({
      loop: activeLoop,
      policy,
      action: "remote_tracker_sync",
      remoteTrackerSyncConfigured: true
    }).decision,
    "allow"
  );
  assert.equal(
    evaluatePolicy({
      loop: activeLoop,
      policy: { ...policy, requireApprovalFor: ["remote_tracker_sync"] },
      action: "remote_tracker_sync",
      remoteTrackerSyncConfigured: true
    }).decision,
    "ask_operator"
  );
});
