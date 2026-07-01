import assert from "node:assert/strict";
import test from "node:test";

import {
  createSingleUserSession,
  isMutatingSessionAction,
  resolveSessionPrincipal,
  type CicloSession
} from "../src/session-access.js";

const single = createSingleUserSession({
  id: "session-local",
  ownerPrincipalId: "owner:zach",
  projectRoot: "/repo",
  now: "2026-06-29T00:00:00Z"
});

const multiuser: CicloSession = {
  id: "session-shared",
  mode: "multiuser",
  ownerPrincipalId: "owner:zach",
  projectRoot: "/repo"
};

test("single mode maps local actions to the owner principal without login", () => {
  const resolution = resolveSessionPrincipal({
    session: single,
    request: { origin: "mcp_stdio" },
    action: "claim_beads_task"
  });

  assert.equal(resolution.decision, "allow");
  assert.equal(resolution.principalId, "owner:zach");
  assert.match(resolution.reason, /owner principal/);
});

test("single mode ignores supplied principals and preserves owner authority", () => {
  const resolution = resolveSessionPrincipal({
    session: single,
    request: { origin: "cli", principalId: "someone-else" },
    action: "register_remote_session"
  });

  assert.equal(resolution.decision, "allow");
  assert.equal(resolution.principalId, "owner:zach");
});

test("multiuser mode denies mutating actions without an authenticated principal", () => {
  const resolution = resolveSessionPrincipal({
    session: multiuser,
    request: { origin: "mcp_http" },
    action: "claim_beads_task"
  });

  assert.equal(resolution.decision, "deny");
  assert.equal(resolution.principalId, undefined);
  assert.match(resolution.reason, /requires an authenticated principal/);
  assert.ok(resolution.evidence.includes("principal:missing"));
});

test("multiuser mode accepts identified mutating API and remote actions", () => {
  const apiResolution = resolveSessionPrincipal({
    session: multiuser,
    request: { origin: "api", principalId: "operator:ada" },
    action: "answer_agent_question"
  });
  const remoteResolution = resolveSessionPrincipal({
    session: multiuser,
    request: {
      origin: "remote_session",
      principalId: "agent:codex",
      remoteSessionId: "remote-1"
    },
    action: "update_beads_progress"
  });

  assert.equal(apiResolution.decision, "allow");
  assert.equal(apiResolution.principalId, "operator:ada");
  assert.equal(remoteResolution.decision, "allow");
  assert.equal(remoteResolution.principalId, "agent:codex");
});

test("multiuser mode permits anonymous read-only status at the session layer", () => {
  const resolution = resolveSessionPrincipal({
    session: multiuser,
    request: { origin: "mcp_stdio" },
    action: "read_status"
  });

  assert.equal(resolution.decision, "allow");
  assert.equal(resolution.principalId, undefined);
  assert.ok(resolution.evidence.includes("principal:anonymous"));
});

test("session action mutation classification covers work command and remote operations", () => {
  assert.equal(isMutatingSessionAction("read_status"), false);
  assert.equal(isMutatingSessionAction("claim_beads_task"), true);
  assert.equal(isMutatingSessionAction("register_remote_session"), true);
  assert.equal(isMutatingSessionAction("remote_tracker_sync"), true);
});
