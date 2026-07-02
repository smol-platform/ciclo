import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilitiesForRole,
  effectiveGrantCapabilities,
  evaluateAccessGrant,
  scopeMatches,
  type AccessGrant
} from "../src/access-grants.js";

test("roles expose expected default capabilities", () => {
  assert.ok(capabilitiesForRole("owner").includes("access.admin"));
  assert.ok(capabilitiesForRole("operator").includes("command.approve"));
  assert.ok(capabilitiesForRole("operator").includes("brain.decide"));
  assert.ok(capabilitiesForRole("maintainer").includes("work.close"));
  assert.ok(!capabilitiesForRole("contributor").includes("command.approve"));
  assert.deepEqual(capabilitiesForRole("viewer"), ["status.read"]);
  assert.ok(capabilitiesForRole("agent_service").includes("work.update"));
  assert.ok(capabilitiesForRole("agent_service").includes("brain.decide"));
});

test("grant capabilities combine role defaults and explicit capabilities", () => {
  const grant: AccessGrant = {
    principalId: "maintainer:ada",
    role: "maintainer",
    capabilities: ["remote.register"]
  };

  assert.ok(effectiveGrantCapabilities(grant).includes("work.claim"));
  assert.ok(effectiveGrantCapabilities(grant).includes("remote.register"));
});

test("scoped grant allows matching session repo loop bead labels harness remote and command class", () => {
  const grant: AccessGrant = {
    principalId: "operator:ada",
    role: "operator",
    scope: {
      sessionId: "session-1",
      repoIdentity: {
        root: "/repo",
        gitRemote: "origin",
        gitBranch: "main",
        beadsPrefix: "ciclo"
      },
      loopId: "deploy-loop",
      beadId: "ciclo-1",
      beadLabels: ["deploy", "safe"],
      harnessId: "codex",
      remoteSessionId: "remote-1",
      remoteHerdrTarget: "workbox",
      commandClasses: ["deploy"]
    }
  };

  const decision = evaluateAccessGrant([grant], {
    principalId: "operator:ada",
    capability: "command.approve",
    now: "2026-06-29T00:00:00Z",
    scope: {
      sessionId: "session-1",
      repoIdentity: {
        root: "/repo",
        gitRemote: "origin",
        gitBranch: "main",
        beadsPrefix: "ciclo"
      },
      loopId: "deploy-loop",
      beadId: "ciclo-1",
      beadLabels: ["safe", "deploy", "p1"],
      harnessId: "codex",
      remoteSessionId: "remote-1",
      remoteHerdrTarget: "workbox",
      commandClasses: ["deploy"]
    }
  });

  assert.equal(decision.allowed, true);
  assert.match(decision.reason, /matching scoped grant/);
});

test("grant evaluation denies missing capability scope mismatch and expired grants", () => {
  const grants: AccessGrant[] = [
    {
      principalId: "contributor:lin",
      role: "contributor",
      scope: { sessionId: "session-1", loopId: "review-loop" }
    },
    {
      principalId: "operator:old",
      role: "operator",
      expiresAt: "2026-06-28T00:00:00Z"
    }
  ];

  assert.equal(
    evaluateAccessGrant(grants, {
      principalId: "contributor:lin",
      capability: "command.approve",
      scope: { sessionId: "session-1", loopId: "review-loop" }
    }).allowed,
    false
  );
  assert.equal(
    evaluateAccessGrant(grants, {
      principalId: "contributor:lin",
      capability: "work.claim",
      scope: { sessionId: "session-1", loopId: "deploy-loop" }
    }).allowed,
    false
  );
  assert.equal(
    evaluateAccessGrant(grants, {
      principalId: "operator:old",
      capability: "command.approve",
      now: "2026-06-29T00:00:00Z"
    }).allowed,
    false
  );
});

test("scope matching supports partial grants and command allowlists", () => {
  assert.equal(scopeMatches({ beadLabels: ["p1"] }, { beadLabels: ["p0", "p1"] }), true);
  assert.equal(scopeMatches({ beadLabels: ["p1", "safe"] }, { beadLabels: ["p1"] }), false);
  assert.equal(scopeMatches({ commandClasses: ["test", "build"] }, { commandClasses: ["test"] }), true);
  assert.equal(scopeMatches({ commandClasses: ["test"] }, { commandClasses: ["deploy"] }), false);
  assert.equal(scopeMatches({ repoIdentity: { root: "/repo" } }, { repoIdentity: { root: "/repo" } }), true);
});
