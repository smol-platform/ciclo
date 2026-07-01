import assert from "node:assert/strict";
import test from "node:test";

import type { AccessGrant } from "../src/access-grants.js";
import { buildAuthorizationAuditRecord } from "../src/access-audit-log.js";
import { authorizeClientRequest, type ClientAuthContext } from "../src/client-auth.js";
import type { DeviceTokenSet } from "../src/auth-device-flow.js";
import type { CicloSession } from "../src/session-access.js";
import { TokenRegistry } from "../src/token-store.js";

const session: CicloSession = {
  id: "session-shared",
  mode: "multiuser",
  ownerPrincipalId: "owner:zach",
  projectRoot: "/repo"
};

const grants: readonly AccessGrant[] = [
  {
    principalId: "owner:zach",
    role: "owner",
    scope: { sessionId: "session-shared" }
  },
  {
    principalId: "maintainer:lin",
    role: "maintainer",
    scope: { sessionId: "session-shared", loopId: "review-loop", beadId: "ciclo-1" }
  }
];

const tokenSet: DeviceTokenSet = {
  tokenType: "Bearer",
  accessToken: "ciclo_at_sensitive_access",
  refreshToken: "ciclo_rt_sensitive_refresh",
  expiresAt: "1970-01-01T00:01:00.000Z",
  principalId: "maintainer:lin",
  sessionId: "session-shared",
  clientId: "mcp-http",
  scopes: ["work.claim"]
};

test("authorization audit records accepted principal grant and token metadata without token material", () => {
  const registry = new TokenRegistry({ nowMs: () => 30_000 });
  registry.store(tokenSet);
  const context: ClientAuthContext = {
    session,
    origin: "mcp_http",
    grants,
    authorizationHeader: `Bearer ${tokenSet.accessToken}`,
    tokenRegistry: registry
  };
  const request = { action: "claim_beads_task" as const, scope: { loopId: "review-loop", beadId: "ciclo-1" } };
  const result = authorizeClientRequest(context, request);
  const audit = buildAuthorizationAuditRecord(context, request, result, {
    now: "2026-06-29T00:00:00.000Z"
  });
  const serialized = JSON.stringify(audit);

  assert.equal(result.decision, "allow");
  assert.equal(audit.decision, "accepted");
  assert.equal(audit.principalId, "maintainer:lin");
  assert.equal(audit.grant?.role, "maintainer");
  assert.ok(audit.grant?.capabilities.includes("work.claim"));
  assert.equal(audit.token?.active, true);
  assert.equal(audit.token?.clientId, "mcp-http");
  assert.doesNotMatch(serialized, /sensitive_access|sensitive_refresh|Bearer ciclo_at/);
});

test("authorization audit records delegated denials with safe reason and operator routes", () => {
  const context: ClientAuthContext = {
    session,
    origin: "mcp_stdio",
    grants,
    principalId: "maintainer:lin"
  };
  const request = { action: "claim_beads_task" as const, scope: { loopId: "review-loop", beadId: "ciclo-2" } };
  const result = authorizeClientRequest(context, request);
  const audit = buildAuthorizationAuditRecord(context, request, result);

  assert.equal(result.decision, "deny");
  assert.equal(audit.decision, "delegated");
  assert.equal(audit.principalId, "maintainer:lin");
  assert.deepEqual(audit.operatorRoutePrincipalIds, ["owner:zach"]);
  assert.match(audit.reason, /lacks an unexpired grant/);
});

test("authorization audit redacts sensitive denial evidence", () => {
  const context: ClientAuthContext = {
    session,
    origin: "mcp_http",
    grants,
    authorizationHeader: "Bearer ciclo_at_unknown_secret",
    tokenRegistry: new TokenRegistry({ nowMs: () => 30_000 })
  };
  const request = { action: "claim_beads_task" as const, scope: { loopId: "review-loop", beadId: "ciclo-1" } };
  const result = authorizeClientRequest(context, request);
  const audit = buildAuthorizationAuditRecord(context, request, {
    ...result,
    evidence: [...result.evidence, "Authorization: Bearer should_not_leak"]
  });
  const serialized = JSON.stringify(audit);

  assert.equal(audit.decision, "denied");
  assert.doesNotMatch(serialized, /should_not_leak|unknown_secret/);
  assert.ok(audit.redactions.some((item) => item.startsWith("access.audit.redaction.token")));
});
