import assert from "node:assert/strict";
import test from "node:test";

import { authorizeCicloAction } from "../src/access-enforcement.js";
import type { AccessGrant } from "../src/access-grants.js";
import { createSingleUserSession, type CicloSession } from "../src/session-access.js";
import type { TokenIntrospection } from "../src/token-store.js";

const single = createSingleUserSession({
  id: "session-1",
  ownerPrincipalId: "owner:zach",
  projectRoot: "/repo"
});

const multiuser: CicloSession = {
  id: "session-1",
  mode: "multiuser",
  ownerPrincipalId: "owner:zach",
  projectRoot: "/repo"
};

const grants: AccessGrant[] = [
  {
    principalId: "owner:zach",
    role: "owner",
    scope: { sessionId: "session-1" }
  },
  {
    principalId: "operator:ada",
    role: "operator",
    scope: { sessionId: "session-1", loopId: "deploy-loop", commandClasses: ["deploy"] }
  },
  {
    principalId: "maintainer:lin",
    role: "maintainer",
    scope: { sessionId: "session-1", loopId: "review-loop", beadId: "ciclo-1" }
  },
  {
    principalId: "agent:codex",
    role: "agent_service",
    scope: { sessionId: "session-1", remoteSessionId: "remote-1" }
  }
];

const activeToken: TokenIntrospection = {
  active: true,
  outcome: "active",
  principalId: "maintainer:lin",
  sessionId: "session-1",
  clientId: "cli",
  scopes: ["work.claim"],
  reason: "active",
  evidence: ["auth.token:active", "auth.token.id:redacted"]
};

test("single mode authorizes owner without grant checks and audits acceptance", () => {
  const result = authorizeCicloAction({
    session: single,
    request: { origin: "mcp_stdio" },
    action: "claim_beads_task",
    grants: []
  });

  assert.equal(result.decision, "allow");
  assert.equal(result.principalId, "owner:zach");
  assert.equal(result.audit.event, "access.accepted");
  assert.match(result.reason, /single mode/);
});

test("multiuser denies unauthenticated mutating requests with operator route", () => {
  const result = authorizeCicloAction({
    session: multiuser,
    request: { origin: "mcp_http" },
    action: "deploy",
    grants,
    scope: { loopId: "deploy-loop", commandClasses: ["deploy"] }
  });

  assert.equal(result.decision, "deny");
  assert.equal(result.audit.event, "access.denied");
  assert.match(result.reason, /authenticated principal/);
  assert.deepEqual(result.operatorRoutePrincipalIds, ["owner:zach", "operator:ada"]);
});

test("multiuser allows scoped work claims with active token principal", () => {
  const result = authorizeCicloAction({
    session: multiuser,
    request: { origin: "api" },
    token: activeToken,
    action: "claim_beads_task",
    grants,
    scope: { loopId: "review-loop", beadId: "ciclo-1" }
  });

  assert.equal(result.decision, "allow");
  assert.equal(result.principalId, "maintainer:lin");
  assert.equal(result.capability, "work.claim");
  assert.equal(result.audit.event, "access.accepted");
});

test("multiuser denies under-scoped work and routes to owner when available", () => {
  const result = authorizeCicloAction({
    session: multiuser,
    request: { origin: "api", principalId: "maintainer:lin" },
    action: "claim_beads_task",
    grants,
    scope: { loopId: "review-loop", beadId: "ciclo-2" }
  });

  assert.equal(result.decision, "deny");
  assert.match(result.reason, /lacks an unexpired grant/);
  assert.deepEqual(result.operatorRoutePrincipalIds, ["owner:zach"]);
  assert.ok(result.evidence.includes("access.decision:deny"));
});

test("multiuser denies inactive tokens and principal token mismatch", () => {
  const inactive: TokenIntrospection = {
    active: false,
    outcome: "revoked",
    reason: "revoked",
    evidence: ["auth.token:revoked"]
  };

  assert.equal(
    authorizeCicloAction({
      session: multiuser,
      request: { origin: "api", principalId: "maintainer:lin" },
      token: inactive,
      action: "claim_beads_task",
      grants,
      scope: { loopId: "review-loop", beadId: "ciclo-1" }
    }).decision,
    "deny"
  );

  assert.equal(
    authorizeCicloAction({
      session: multiuser,
      request: { origin: "api", principalId: "contributor:sam" },
      token: activeToken,
      action: "claim_beads_task",
      grants,
      scope: { loopId: "review-loop", beadId: "ciclo-1" }
    }).decision,
    "deny"
  );
});

test("multiuser enforces command question remote and admin capabilities", () => {
  assert.equal(
    authorizeCicloAction({
      session: multiuser,
      request: { origin: "mcp_http", principalId: "operator:ada" },
      action: "approve_permission",
      grants,
      scope: { loopId: "deploy-loop", commandClasses: ["deploy"] }
    }).decision,
    "allow"
  );
  assert.equal(
    authorizeCicloAction({
      session: multiuser,
      request: { origin: "remote_session", principalId: "agent:codex" },
      action: "update_beads_progress",
      grants,
      scope: { remoteSessionId: "remote-1" }
    }).decision,
    "allow"
  );
  assert.equal(
    authorizeCicloAction({
      session: multiuser,
      request: { origin: "api", principalId: "operator:ada" },
      action: "grant_access",
      grants,
      scope: { sessionId: "session-1" }
    }).decision,
    "deny"
  );
});
