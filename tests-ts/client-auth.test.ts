import assert from "node:assert/strict";
import test from "node:test";

import type { AccessGrant } from "../src/access-grants.js";
import {
  authorizeClientRequest,
  bearerTokenFromAuthorizationHeader,
  clientAccessView,
  clientWhoami,
  type ClientAuthContext
} from "../src/client-auth.js";
import { createSingleUserSession, type CicloSession } from "../src/session-access.js";
import { TokenRegistry } from "../src/token-store.js";
import type { DeviceTokenSet } from "../src/auth-device-flow.js";

const single = createSingleUserSession({
  id: "session-local",
  ownerPrincipalId: "owner:zach",
  projectRoot: "/repo"
});

const multiuser: CicloSession = {
  id: "session-shared",
  mode: "multiuser",
  ownerPrincipalId: "owner:zach",
  projectRoot: "/repo"
};

const grants: readonly AccessGrant[] = [
  {
    principalId: "maintainer:lin",
    role: "maintainer",
    scope: { sessionId: "session-shared", loopId: "review-loop" }
  }
];

const tokenSet: DeviceTokenSet = {
  tokenType: "Bearer",
  accessToken: "ciclo_at_http_client",
  refreshToken: "ciclo_rt_http_client",
  expiresAt: "1970-01-01T00:01:00.000Z",
  principalId: "maintainer:lin",
  sessionId: "session-shared",
  clientId: "mcp-http",
  scopes: ["status.read", "work.claim"]
};

test("client auth extracts bearer tokens only from bearer authorization headers", () => {
  assert.equal(bearerTokenFromAuthorizationHeader("Bearer ciclo_at_secret"), "ciclo_at_secret");
  assert.equal(bearerTokenFromAuthorizationHeader("bearer token-with-case"), "token-with-case");
  assert.equal(bearerTokenFromAuthorizationHeader("Basic nope"), undefined);
});

test("stdio single mode reports the owner principal and owner capabilities", () => {
  const context: ClientAuthContext = {
    session: single,
    origin: "mcp_stdio",
    grants: []
  };

  const whoami = clientWhoami(context);
  const access = clientAccessView(context);

  assert.equal(whoami.principal_id, "owner:zach");
  assert.equal(whoami.authenticated, true);
  assert.ok(whoami.capabilities.includes("access.admin"));
  assert.equal(access.effective_grants[0]?.role, "owner");
});

test("stdio multiuser mode can receive an explicit launcher principal and report scoped grants", () => {
  const context: ClientAuthContext = {
    session: multiuser,
    origin: "mcp_stdio",
    grants,
    principalId: "maintainer:lin"
  };

  const access = clientAccessView(context);

  assert.equal(access.principal_id, "maintainer:lin");
  assert.equal(access.authenticated, true);
  assert.ok(access.capabilities.includes("work.claim"));
  assert.equal(access.effective_grants[0]?.scope?.loopId, "review-loop");
});

test("multiuser MCP HTTP and API clients require bearer tokens", () => {
  const context: ClientAuthContext = {
    session: multiuser,
    origin: "mcp_http",
    grants
  };

  const decision = authorizeClientRequest(context, { action: "read_status" });

  assert.equal(decision.decision, "deny");
  assert.match(decision.reason, /bearer token/);
  assert.ok(decision.evidence.includes("auth.token:missing"));
});

test("multiuser MCP HTTP bearer tokens resolve the active principal", () => {
  const registry = new TokenRegistry({ nowMs: () => 30_000 });
  registry.store(tokenSet);
  const context: ClientAuthContext = {
    session: multiuser,
    origin: "mcp_http",
    grants,
    authorizationHeader: `Bearer ${tokenSet.accessToken}`,
    tokenRegistry: registry
  };

  const decision = authorizeClientRequest(context, { action: "read_status" });
  const whoami = clientWhoami(context);

  assert.equal(decision.decision, "allow");
  assert.equal(decision.principalId, "maintainer:lin");
  assert.equal(whoami.principal_id, "maintainer:lin");
  assert.equal(whoami.token?.active, true);
});
