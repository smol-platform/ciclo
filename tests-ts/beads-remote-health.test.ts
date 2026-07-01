import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBeadsRemoteHealth } from "../src/beads-remote-health.js";
import type { BeadsRemoteModeState } from "../src/beads-remote.js";

const healthyState: BeadsRemoteModeState = {
  mode: "dolt_remote_sync",
  databaseIdentity: "dolt-remote:origin",
  remoteName: "origin",
  health: "healthy",
  centralizedCoordinationRequired: true,
  evidence: ["beads.remote.mode:dolt_remote_sync"]
};

test("remote health allows dispatch for healthy centralized coordination", () => {
  const decision = evaluateBeadsRemoteHealth({ state: healthyState });
  assert.equal(decision.dispatchAllowed, true);
  assert.equal(decision.loopBlocked, false);
  assert.ok(decision.evidence.includes("beads.remote.dispatch:allow"));
});

test("remote health blocks dispatch when required DB is unavailable", () => {
  const decision = evaluateBeadsRemoteHealth({
    state: {
      ...healthyState,
      health: "unavailable",
      centralizedCoordinationRequired: true
    },
    createBeadsBlocker: true
  });
  assert.equal(decision.dispatchAllowed, false);
  assert.equal(decision.loopBlocked, true);
  assert.match(decision.operatorFeedback.join(" "), /required but unavailable/);
  assert.match(decision.beadsBlocker?.title ?? "", /Resolve Beads remote DB blocker/);
});

test("remote health blocks conflicts and schema skew with operator feedback", () => {
  const decision = evaluateBeadsRemoteHealth({
    state: healthyState,
    createBeadsBlocker: true,
    problems: [
      { kind: "conflict", summary: "claim conflict on ciclo-1", details: "two sessions claimed" },
      { kind: "schema_skew", summary: "forward schema drift" }
    ]
  });
  assert.equal(decision.dispatchAllowed, false);
  assert.equal(decision.loopBlocked, true);
  assert.ok(decision.operatorFeedback.some((item) => item.includes("claim conflict")));
  assert.match(decision.beadsBlocker?.description ?? "", /schema_skew/);
  assert.ok(decision.evidence.some((item) => item.includes("beads.remote.problem:conflict")));
});

test("remote health warns but allows degraded optional coordination", () => {
  const decision = evaluateBeadsRemoteHealth({
    state: {
      mode: "local",
      databaseIdentity: "local-beads",
      health: "degraded",
      centralizedCoordinationRequired: false,
      evidence: ["beads.remote.mode:local"]
    },
    problems: [{ kind: "divergence", summary: "local branch behind remote" }]
  });
  assert.equal(decision.dispatchAllowed, true);
  assert.equal(decision.loopBlocked, false);
  assert.match(decision.operatorFeedback.join(" "), /degraded/);
});
