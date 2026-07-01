import assert from "node:assert/strict";
import test from "node:test";

import { OperatorRoutingStore } from "../src/operator-routing.js";
import {
  buildRemoteSessionHandoff,
  reportRemoteSessionHandoff
} from "../src/remote-session-handoff.js";
import type { RemoteSessionRecord } from "../src/remote-session-registry.js";

function session(input: Partial<RemoteSessionRecord> = {}): RemoteSessionRecord {
  return {
    id: "remote-1",
    transport: "herdr_remote_ssh",
    herdrRemote: "deploy@example.com:/srv/ciclo",
    herdrSession: "review-loop",
    herdrAgentTarget: "pane-1",
    projectPath: "/srv/ciclo",
    repoIdentity: { root: "git:abc123", branch: "main", gitRemote: "origin" },
    ownerPrincipalId: "user:zach",
    harnesses: ["codex"],
    capabilities: ["work.claim"],
    state: "done",
    activeBeadId: "ciclo-1",
    activeLoopId: "loop-1",
    evidence: ["remote.session.registered:remote-1"],
    ...input
  };
}

test("builds done remote session handoff summary with loop bead harness state and requested action", () => {
  const result = buildRemoteSessionHandoff({
    session: session({
      lastObservation: {
        source: "herdr",
        target: "pane-1",
        harness: "codex",
        state: "done",
        evidence: ["herdr:done"]
      }
    }),
    finalSummary: "Implementation is complete.",
    artifacts: ["dist/report.json"],
    requestedNextAction: "Run just check and close ciclo-1."
  });

  assert.equal(result.handedOff, true);
  assert.equal(result.summary?.loopId, "loop-1");
  assert.equal(result.summary?.beadId, "ciclo-1");
  assert.equal(result.summary?.harnessId, "codex");
  assert.equal(result.summary?.state, "done");
  assert.deepEqual(result.summary?.artifacts, ["dist/report.json"]);
  assert.equal(result.summary?.requestedNextAction, "Run just check and close ciclo-1.");
  assert.ok(result.evidence.includes("remote.handoff.state:done"));
  assert.ok(result.evidence.includes("herdr:done"));
});

test("builds lost remote handoff with blocker and recovery action", () => {
  const result = buildRemoteSessionHandoff({
    session: session({
      state: "lost",
      lastAttachError: "Remote Herdr is not installed or not on PATH.",
      evidence: ["remote.session.lost:remote-1", "herdr.remote.blocker:missing_remote_herdr"]
    })
  });

  assert.equal(result.handedOff, true);
  assert.equal(result.summary?.state, "lost");
  assert.equal(result.summary?.severity, "error");
  assert.deepEqual(result.summary?.blockers, ["Remote Herdr is not installed or not on PATH."]);
  assert.match(result.summary?.requestedNextAction ?? "", /restore Herdr connectivity/);
});

test("queues structured handoff feedback to the operator route and deduplicates repeats", () => {
  const routing = new OperatorRoutingStore();
  const input = {
    session: session({ state: "detached", lastAttachError: "operator paused work" }),
    finalSummary: "Paused after collecting logs.",
    blockers: ["operator paused work"],
    now: "2026-06-29T00:00:00.000Z",
    principalId: "agent:codex"
  };

  const first = reportRemoteSessionHandoff(routing, input);
  const second = reportRemoteSessionHandoff(routing, {
    ...input,
    now: "2026-06-29T00:01:00.000Z"
  });
  const feedback = routing.listFeedback()[0];
  const message = JSON.parse(feedback?.message ?? "{}") as Record<string, unknown>;

  assert.equal(first.handedOff, true);
  assert.equal(second.feedback?.duplicateCount, 1);
  assert.equal(feedback?.remoteSessionId, "remote-1");
  assert.equal(feedback?.loopId, "loop-1");
  assert.equal(feedback?.beadId, "ciclo-1");
  assert.equal(message.type, "remote_session_handoff");
  assert.equal(message.final_summary, "Paused after collecting logs.");
  assert.deepEqual(message.blockers, ["operator paused work"]);
});

test("skips handoff for non-terminal active remote states", () => {
  const result = buildRemoteSessionHandoff({ session: session({ state: "working" }) });

  assert.equal(result.handedOff, false);
  assert.match(result.reason, /does not require handoff/);
});
