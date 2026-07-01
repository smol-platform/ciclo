import assert from "node:assert/strict";
import test from "node:test";

import type { DeviceTokenSet } from "../src/auth-device-flow.js";
import { TokenRegistry } from "../src/token-store.js";

const tokenSet: DeviceTokenSet = {
  tokenType: "Bearer",
  accessToken: "ciclo_at_secret_access",
  refreshToken: "ciclo_rt_secret_refresh",
  expiresAt: "1970-01-01T00:01:00.000Z",
  principalId: "operator:ada",
  sessionId: "session-1",
  clientId: "cli-local",
  scopes: ["work.claim", "work.claim", "question.answer"],
  targetConstraints: { remoteTarget: "workbox" }
};

test("token registry stores metadata without exposing token material", () => {
  const registry = new TokenRegistry({ nowMs: () => 0 });
  const metadata = registry.store(tokenSet);
  const redacted = registry.redactedMetadata(metadata.tokenId);
  const serialized = JSON.stringify(redacted);

  assert.equal(metadata.principalId, "operator:ada");
  assert.equal(metadata.sessionId, "session-1");
  assert.equal(metadata.clientId, "cli-local");
  assert.deepEqual(metadata.scopes, ["work.claim", "question.answer"]);
  assert.deepEqual(metadata.targetConstraints, { remoteTarget: "workbox" });
  assert.doesNotMatch(serialized, /secret_access/);
  assert.doesNotMatch(serialized, /secret_refresh/);
});

test("token registry introspects active access tokens and current principal", () => {
  const registry = new TokenRegistry({ nowMs: () => 30_000 });
  registry.store(tokenSet);

  const introspection = registry.introspect(tokenSet.accessToken);
  const principal = registry.whoami(tokenSet.accessToken);

  assert.equal(introspection.active, true);
  assert.equal(introspection.principalId, "operator:ada");
  assert.deepEqual(introspection.scopes, ["work.claim", "question.answer"]);
  assert.equal(principal?.principalId, "operator:ada");
  assert.equal(principal?.sessionId, "session-1");
});

test("token registry reports expired and unknown access tokens", () => {
  const registry = new TokenRegistry({ nowMs: () => 90_000 });
  registry.store(tokenSet);

  assert.equal(registry.introspect(tokenSet.accessToken).outcome, "expired");
  assert.equal(registry.introspect("missing").outcome, "not_found");
  assert.equal(registry.whoami(tokenSet.accessToken), undefined);
});

test("token registry refreshes tokens and revokes old token set", () => {
  const now = { value: 30_000 };
  const registry = new TokenRegistry({
    nowMs: () => now.value,
    accessTokenTtlSeconds: 60,
    refreshTokenTtlSeconds: 120
  });
  registry.store(tokenSet);

  const refreshed = registry.refresh(tokenSet.refreshToken);

  assert.equal(refreshed.outcome, "refreshed");
  assert.ok(refreshed.token?.accessToken.startsWith("ciclo_at_"));
  assert.ok(refreshed.token?.refreshToken.startsWith("ciclo_rt_"));
  assert.notEqual(refreshed.token?.accessToken, tokenSet.accessToken);
  assert.equal(registry.introspect(tokenSet.accessToken).outcome, "revoked");
  assert.equal(registry.introspect(refreshed.token?.accessToken ?? "").active, true);
});

test("token registry revokes access or refresh tokens and redacts evidence", () => {
  const registry = new TokenRegistry({ nowMs: () => 0 });
  registry.store(tokenSet);

  const revoked = registry.revoke(tokenSet.refreshToken);
  const evidence = revoked.evidence.join("\n");

  assert.equal(revoked.outcome, "revoked");
  assert.equal(registry.introspect(tokenSet.accessToken).outcome, "revoked");
  assert.doesNotMatch(evidence, /secret_access/);
  assert.doesNotMatch(evidence, /secret_refresh/);
  assert.match(evidence, /auth\.token\.id:/);
});
