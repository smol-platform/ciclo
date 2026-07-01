import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ConfigError, loadProjectLoopConfigText } from "../src/loop-config.js";

test("loads review loop YAML", () => {
  const config = loadProjectLoopConfigText(readFileSync("tests/fixtures/review_loop.yaml", "utf8"));
  assert.equal(config.loop.id, "review-demo");
  assert.equal(config.loop.kind, "review");
  assert.deepEqual(config.loop.harnesses, ["codex", "claude-code"]);
  assert.equal(config.policy.mode, "dry_run");
  assert.ok(config.policy.requireApprovalFor.includes("task_close"));
  assert.equal(config.exitCriteria.success.length, 2);
});

test("loads deploy loop YAML", () => {
  const config = loadProjectLoopConfigText(readFileSync("tests/fixtures/deploy_loop.yaml", "utf8"));
  assert.equal(config.loop.kind, "deploy");
  assert.equal(config.policy.mode, "supervised");
  assert.ok(config.policy.allowCommands.includes("just check"));
});

test("invalid loop config errors are actionable", () => {
  assert.throws(
    () =>
      loadProjectLoopConfigText(`
id: broken
kind: review
harnesses:
  - mystery
exit_criteria:
  success:
    - done
`),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /supported harness ids/);
      return true;
    }
  );
});
