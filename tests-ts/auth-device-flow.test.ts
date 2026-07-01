import assert from "node:assert/strict";
import test from "node:test";

import { DeviceAuthorizationFlow } from "../src/auth-device-flow.js";

function codeGenerator(): () => Buffer {
  let value = 1;
  return () => Buffer.alloc(24, value++);
}

function tokenGenerator(values: readonly string[]): () => Buffer {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    assert.ok(value, "test token generator exhausted");
    return Buffer.from(value);
  };
}

function createFlow(now: { value: number }): DeviceAuthorizationFlow {
  return new DeviceAuthorizationFlow({
    verificationUri: "https://ciclo.example/device",
    nowMs: () => now.value,
    codeBytes: codeGenerator(),
    ttlSeconds: 60,
    intervalSeconds: 5,
    accessTokenTtlSeconds: 120
  });
}

test("device authorization start returns user-facing device flow fields", () => {
  const now = { value: 0 };
  const flow = createFlow(now);
  const start = flow.start({
    sessionId: "session-1",
    clientId: "cli-local",
    clientKind: "cli",
    scopes: ["work.claim", "work.claim", "question.answer"]
  });

  assert.ok(start.deviceCode.length > 20);
  assert.match(start.userCode, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.equal(start.verificationUri, "https://ciclo.example/device");
  assert.match(start.verificationUriComplete, /user_code=/);
  assert.equal(start.intervalSeconds, 5);
  assert.equal(start.expiresAt, "1970-01-01T00:01:00.000Z");
});

test("device authorization poll respects interval and slows down early clients", () => {
  const now = { value: 0 };
  const flow = createFlow(now);
  const start = flow.start({
    sessionId: "session-1",
    clientId: "mcp-client",
    clientKind: "mcp_http",
    scopes: ["status.read"]
  });

  assert.equal(flow.poll(start.deviceCode).outcome, "authorization_pending");
  now.value = 1000;
  const early = flow.poll(start.deviceCode);
  assert.equal(early.outcome, "slow_down");
  assert.equal(early.intervalSeconds, 10);
});

test("device authorization approval returns token set bound to principal session client and scopes", () => {
  const now = { value: 0 };
  const flow = createFlow(now);
  const start = flow.start({
    sessionId: "session-1",
    clientId: "remote-worker-1",
    clientKind: "remote_worker",
    scopes: ["work.update", "remote.register"],
    remoteTarget: "workbox"
  });

  assert.equal(flow.approve(start.deviceCode, "operator:ada"), true);
  now.value = 5000;
  const result = flow.poll(start.deviceCode);

  assert.equal(result.outcome, "approved");
  assert.equal(result.token?.tokenType, "Bearer");
  assert.match(result.token?.accessToken ?? "", /^ciclo_at_/);
  assert.match(result.token?.refreshToken ?? "", /^ciclo_rt_/);
  assert.equal(result.token?.principalId, "operator:ada");
  assert.equal(result.token?.sessionId, "session-1");
  assert.equal(result.token?.clientId, "remote-worker-1");
  assert.deepEqual(result.token?.scopes, ["work.update", "remote.register"]);
  assert.equal(result.token?.expiresAt, "1970-01-01T00:02:05.000Z");
});

test("device authorization approved codes are exchanged once with token byte material", () => {
  const now = { value: 0 };
  const flow = new DeviceAuthorizationFlow({
    verificationUri: "https://ciclo.example/device",
    nowMs: () => now.value,
    codeBytes: codeGenerator(),
    tokenBytes: tokenGenerator(["access-token-material", "refresh-token-material"]),
    ttlSeconds: 60,
    intervalSeconds: 5,
    accessTokenTtlSeconds: 120
  });
  const start = flow.start({
    sessionId: "session-1",
    clientId: "mcp-client",
    clientKind: "mcp_http",
    scopes: ["status.read"]
  });

  assert.equal(flow.approve(start.deviceCode, "operator:ada"), true);
  now.value = 5000;
  const approved = flow.poll(start.deviceCode);
  now.value = 10_000;
  const replay = flow.poll(start.deviceCode);

  assert.equal(approved.outcome, "approved");
  assert.equal(approved.token?.accessToken, `ciclo_at_${Buffer.from("access-token-material").toString("base64url")}`);
  assert.equal(approved.token?.refreshToken, `ciclo_rt_${Buffer.from("refresh-token-material").toString("base64url")}`);
  assert.equal(replay.outcome, "expired_token");
  assert.equal(replay.token, undefined);
});

test("device authorization handles denied expired and missing flows", () => {
  const now = { value: 0 };
  const flow = createFlow(now);
  const denied = flow.start({
    sessionId: "session-1",
    clientId: "cli-local",
    clientKind: "cli",
    scopes: ["work.claim"]
  });
  const expired = flow.start({
    sessionId: "session-1",
    clientId: "mcp-client",
    clientKind: "mcp_http",
    scopes: ["work.claim"]
  });

  assert.equal(flow.deny(denied.deviceCode, "operator rejected"), true);
  assert.equal(flow.poll(denied.deviceCode).outcome, "access_denied");

  now.value = 60_000;
  assert.equal(flow.poll(expired.deviceCode).outcome, "expired_token");
  assert.equal(flow.poll("missing").outcome, "expired_token");
});

test("device authorization evidence redacts device code user code and tokens", () => {
  const now = { value: 0 };
  const flow = createFlow(now);
  const start = flow.start({
    sessionId: "session-1",
    clientId: "cli-local",
    clientKind: "cli",
    scopes: ["work.claim"]
  });
  flow.approve(start.deviceCode, "operator:ada");
  const result = flow.poll(start.deviceCode);
  const evidence = [...result.evidence, ...flow.redactedAuditEvidence(start.deviceCode)].join("\n");

  assert.ok(result.token?.accessToken);
  assert.ok(result.token?.refreshToken);
  assert.doesNotMatch(evidence, new RegExp(start.deviceCode));
  assert.doesNotMatch(evidence, new RegExp(start.userCode));
  assert.doesNotMatch(evidence, new RegExp(result.token?.accessToken ?? "unreachable"));
  assert.doesNotMatch(evidence, new RegExp(result.token?.refreshToken ?? "unreachable"));
  assert.match(evidence, /auth\.device\.code_hash:/);
  assert.match(evidence, /auth\.device\.user_code_hash:/);
});
