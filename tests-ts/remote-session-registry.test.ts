import assert from "node:assert/strict";
import test from "node:test";

import type { AuthorizationResult } from "../src/access-enforcement.js";
import type { HerdrObservation } from "../src/ciclo-core.js";
import { HerdrError, type HerdrRemoteAttachConfig } from "../src/herdr-adapter.js";
import {
  RemoteSessionRegistry,
  type RemoteHeartbeatClient,
  type RegisterRemoteSessionInput
} from "../src/remote-session-registry.js";

const baseRegistration: RegisterRemoteSessionInput = {
  id: "remote-1",
  herdrRemote: "deploy@prod.example.com:/srv/ciclo",
  herdrSession: "review-loop",
  herdrAgentTarget: "pane-1",
  projectPath: "/srv/ciclo",
  repoIdentity: { root: "git:abc123", branch: "main", gitRemote: "origin" },
  ownerPrincipalId: "user:zach",
  harnesses: ["codex"],
  capabilities: ["work.claim"],
  activeBeadId: "ciclo-1",
  activeLoopId: "loop-1",
  now: "2026-06-29T12:00:00.000Z"
};

function observation(state: HerdrObservation["state"]): HerdrObservation {
  return {
    source: "herdr",
    target: "pane-1",
    harness: "codex",
    state,
    cwd: "/srv/ciclo",
    evidence: [`herdr:${state}`]
  };
}

test("remote sessions register configured Herdr target named session owner capabilities and redacted evidence", () => {
  const registry = new RemoteSessionRegistry();
  const result = registry.register(baseRegistration);

  assert.equal(result.accepted, true);
  assert.equal(result.session?.state, "connected");
  assert.equal(result.session?.transport, "herdr_remote_ssh");
  assert.equal(result.session?.herdrSession, "review-loop");
  assert.equal(result.session?.activeBeadId, "ciclo-1");
  assert.doesNotMatch(result.evidence.join("\n"), /deploy@prod\.example\.com|\/srv\/ciclo/);
  assert.equal(registry.get("remote-1")?.ownerPrincipalId, "user:zach");
});

test("remote heartbeat uses Herdr remote attach and updates liveness state", async () => {
  const registry = new RemoteSessionRegistry();
  registry.register(baseRegistration);
  const calls: string[] = [];
  const client: RemoteHeartbeatClient = {
    async explainRemote(config: HerdrRemoteAttachConfig, target: string) {
      calls.push(`${config.target}|${config.session}|${target}`);
      return observation("working");
    }
  };

  const result = await registry.heartbeat("remote-1", client, "2026-06-29T12:01:00.000Z");

  assert.equal(result.accepted, true);
  assert.equal(result.session?.state, "working");
  assert.equal(result.session?.lastHeartbeatAt, "2026-06-29T12:01:00.000Z");
  assert.deepEqual(calls, ["deploy@prod.example.com:/srv/ciclo|review-loop|pane-1"]);
  assert.equal(result.session?.activeBeadId, "ciclo-1");
});

test("remote heartbeat failure marks session lost while preserving Beads ownership", async () => {
  const registry = new RemoteSessionRegistry();
  registry.register(baseRegistration);
  const client: RemoteHeartbeatClient = {
    async explainRemote() {
      throw new HerdrError("ssh target: herdr: command not found", "command_failed");
    }
  };

  const result = await registry.heartbeat("remote-1", client, "2026-06-29T12:01:00.000Z");

  assert.equal(result.accepted, false);
  assert.equal(result.session?.state, "lost");
  assert.equal(result.session?.activeBeadId, "ciclo-1");
  assert.match(result.reason, /Remote Herdr is not installed/);
  assert.ok(result.evidence.includes("remote.session.lost:remote-1"));
  assert.ok(result.evidence.includes("herdr.remote.blocker:missing_remote_herdr"));
});

test("remote sessions become stale and lost after heartbeat timeouts without releasing active work", () => {
  const registry = new RemoteSessionRegistry();
  registry.register(baseRegistration);

  const stale = registry.markExpired("2026-06-29T12:03:00.000Z", 60_000, 300_000);
  const lost = registry.markExpired("2026-06-29T12:06:00.000Z", 60_000, 300_000);

  assert.equal(stale[0]?.state, "stale");
  assert.equal(stale[0]?.activeBeadId, "ciclo-1");
  assert.equal(lost[0]?.state, "lost");
  assert.equal(lost[0]?.activeBeadId, "ciclo-1");
});

test("detaching a remote session preserves Beads ownership", () => {
  const registry = new RemoteSessionRegistry();
  registry.register(baseRegistration);

  const result = registry.detach("remote-1", "operator paused work", "2026-06-29T12:02:00.000Z");

  assert.equal(result.accepted, true);
  assert.equal(result.session?.state, "detached");
  assert.equal(result.session?.activeBeadId, "ciclo-1");
  assert.equal(result.session?.lastAttachError, "operator paused work");
});

test("registry reports active owners for a Beads issue and ignores detached or lost sessions", () => {
  const registry = new RemoteSessionRegistry();
  registry.register(baseRegistration);
  registry.register({ ...baseRegistration, id: "remote-2", activeBeadId: "ciclo-2" });
  registry.register({ ...baseRegistration, id: "remote-3", activeBeadId: "ciclo-1" });
  registry.detach("remote-3", "paused", "2026-06-29T12:02:00.000Z");

  const owners = registry.activeOwnersForBead("ciclo-1");

  assert.deepEqual(
    owners.map((owner) => owner.id),
    ["remote-1"]
  );
});

test("registry records work assignment for a remote session", () => {
  const registry = new RemoteSessionRegistry();
  registry.register({ ...baseRegistration, activeBeadId: undefined, activeLoopId: undefined });

  const result = registry.assignWork({ sessionId: "remote-1", beadId: "ciclo-9", loopId: "loop-2" });

  assert.equal(result.accepted, true);
  assert.equal(result.session?.activeBeadId, "ciclo-9");
  assert.equal(result.session?.activeLoopId, "loop-2");
  assert.ok(result.evidence.includes("remote.session.assigned:remote-1:ciclo-9"));
});

test("registration denies missing configuration and failed authorization", () => {
  const registry = new RemoteSessionRegistry();
  const denyAuth: AuthorizationResult = {
    decision: "deny",
    reason: "principal lacks remote register grant",
    evidence: ["access.denied"],
    operatorRoutePrincipalIds: [],
    audit: {
      event: "access.denied",
      action: "register_remote_session",
      sessionId: "session-1",
      reason: "principal lacks remote register grant",
      evidence: ["access.denied"]
    }
  };

  assert.equal(registry.register({ ...baseRegistration, herdrRemote: "" }).accepted, false);
  const denied = registry.register({ ...baseRegistration, id: "remote-2", authorization: denyAuth });
  assert.equal(denied.accepted, false);
  assert.match(denied.reason, /lacks remote register/);
});
