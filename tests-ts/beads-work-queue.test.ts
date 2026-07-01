import assert from "node:assert/strict";
import test from "node:test";

import {
  selectAndClaimBeadsWork,
  selectBeadsWork,
  type BeadsWorkClaimClient
} from "../src/beads-work-queue.js";
import type { BeadsTaskSnapshot } from "../src/beads-adapter.js";
import type { LoopConfig } from "../src/ciclo-core.js";
import type { RemoteSessionRecord } from "../src/remote-session-registry.js";

function task(input: Partial<BeadsTaskSnapshot> & Pick<BeadsTaskSnapshot, "id">): BeadsTaskSnapshot {
  return {
    id: input.id,
    title: input.title ?? input.id,
    status: input.status ?? "open",
    priority: input.priority ?? 2,
    issueType: input.issueType ?? "task",
    description: input.description ?? "",
    acceptanceCriteria: input.acceptanceCriteria ?? "",
    specId: input.specId,
    labels: input.labels ?? [],
    dependencies: input.dependencies ?? [],
    externalRefs: input.externalRefs ?? []
  };
}

const loop: LoopConfig = {
  id: "review-loop",
  kind: "beads_work",
  goal: "Work ready Beads tasks",
  harnesses: ["codex", "claude-code"],
  dryRun: false
};

function remoteOwner(input: Partial<RemoteSessionRecord> & Pick<RemoteSessionRecord, "id" | "activeBeadId">): RemoteSessionRecord {
  return {
    id: input.id,
    transport: "herdr_remote_ssh",
    herdrRemote: "deploy@example.com",
    herdrSession: input.herdrSession,
    herdrAgentTarget: input.herdrAgentTarget,
    projectPath: "/repo",
    repoIdentity: { root: "git:abc" },
    ownerPrincipalId: "user:zach",
    harnesses: ["codex"],
    capabilities: ["work.claim"],
    state: input.state ?? "working",
    activeBeadId: input.activeBeadId,
    activeLoopId: input.activeLoopId,
    evidence: input.evidence ?? []
  };
}

test("selects eligible ready work by labels spec issue type and priority", () => {
  const selection = selectBeadsWork(
    [
      task({ id: "ciclo-3", priority: 3, labels: ["mvp"], specId: "SPEC-CICLO-001" }),
      task({ id: "ciclo-1", priority: 1, labels: ["mvp"], specId: "SPEC-CICLO-001" }),
      task({ id: "ciclo-2", priority: 0, labels: ["later"], specId: "SPEC-CICLO-001" }),
      task({ id: "ciclo-4", priority: 0, labels: ["mvp"], specId: "OTHER" })
    ],
    {
      loop,
      requiredLabels: ["mvp"],
      issueTypes: ["task"],
      specId: "SPEC-CICLO-001"
    }
  );

  assert.equal(selection.selected?.id, "ciclo-1");
  assert.deepEqual(
    selection.skipped.map((item) => item.id),
    ["ciclo-2", "ciclo-4"]
  );
});

test("selector respects loop concurrency capacity", () => {
  const selection = selectBeadsWork(
    [task({ id: "ciclo-1" })],
    {
      loop,
      capacity: { activeCount: 1, maxConcurrent: 1 }
    }
  );

  assert.equal(selection.selected, undefined);
  assert.equal(selection.skipped[0]?.reason, "loop capacity is full");
  assert.ok(selection.evidence.includes("beads.select:none:capacity_full"));
});

test("claim flow rechecks selected work claims and records selected harness metadata", async () => {
  const calls: string[] = [];
  const ready = [task({ id: "ciclo-1", labels: ["mvp"], priority: 1 })];
  const client: BeadsWorkClaimClient = {
    async ready() {
      calls.push("ready");
      return ready;
    },
    async show(id) {
      calls.push(`show:${id}`);
      return task({ id, labels: ["mvp"], priority: 1 });
    },
    async claim(id) {
      calls.push(`claim:${id}`);
      return task({ id, labels: ["mvp"], priority: 1, status: "in_progress" });
    },
    async note(id, message) {
      calls.push(`note:${id}:${message}`);
    }
  };

  const result = await selectAndClaimBeadsWork(client, {
    selector: { loop, requiredLabels: ["mvp"] },
    harnessId: "claude-code",
    principalId: "maintainer:lin"
  });

  assert.equal(result.claimed, true);
  assert.equal(result.before?.id, "ciclo-1");
  assert.equal(result.after?.status, "in_progress");
  assert.equal(result.selectedHarness, "claude-code");
  assert.deepEqual(calls.slice(0, 3), ["ready", "show:ciclo-1", "claim:ciclo-1"]);
  assert.match(calls[3] ?? "", /harness=claude-code/);
  assert.match(calls[3] ?? "", /principal=maintainer:lin/);
  assert.match(
    calls[3] ?? "",
    /ciclo\.metadata action=claim bead=ciclo-1 loop=review-loop harness=claude-code principal=maintainer:lin/
  );
  assert.ok(result.evidence.includes("beads.claim.metadata:standard"));
});

test("claim flow rejects duplicate active remote session ownership before claiming", async () => {
  const calls: string[] = [];
  const client: BeadsWorkClaimClient = {
    async ready() {
      calls.push("ready");
      return [task({ id: "ciclo-1", labels: ["mvp"], priority: 1 })];
    },
    async show(id) {
      calls.push(`show:${id}`);
      return task({ id, labels: ["mvp"], priority: 1 });
    },
    async claim(id) {
      calls.push(`claim:${id}`);
      return task({ id, status: "in_progress" });
    },
    async note(id, message) {
      calls.push(`note:${id}:${message}`);
    }
  };

  const result = await selectAndClaimBeadsWork(client, {
    selector: { loop, requiredLabels: ["mvp"] },
    sessionId: "remote-2",
    activeOwners: [remoteOwner({ id: "remote-1", activeBeadId: "ciclo-1", state: "working" })]
  });

  assert.equal(result.claimed, false);
  assert.deepEqual(calls, ["ready", "show:ciclo-1"]);
  assert.match(result.reason, /already owned/);
  assert.ok(result.evidence.includes("beads.claim:block:duplicate_active_session"));
  assert.ok(result.evidence.includes("operator.feedback:duplicate_claim:ciclo-1"));
});

test("claim flow permits the same session owner and records session ownership metadata", async () => {
  const calls: string[] = [];
  const ownershipCalls: string[] = [];
  const client: BeadsWorkClaimClient = {
    async ready() {
      calls.push("ready");
      return [task({ id: "ciclo-1", labels: ["mvp"], priority: 1 })];
    },
    async show(id) {
      calls.push(`show:${id}`);
      return task({ id, labels: ["mvp"], priority: 1 });
    },
    async claim(id) {
      calls.push(`claim:${id}`);
      return task({ id, status: "in_progress" });
    },
    async note(id, message) {
      calls.push(`note:${id}:${message}`);
    }
  };

  const result = await selectAndClaimBeadsWork(client, {
    selector: { loop, requiredLabels: ["mvp"] },
    sessionId: "remote-1",
    activeOwners: [
      remoteOwner({
        id: "remote-1",
        activeBeadId: "ciclo-1",
        state: "working",
        herdrSession: "review-loop",
        herdrAgentTarget: "pane-1"
      })
    ],
    recordSessionOwnership(input) {
      ownershipCalls.push(`${input.sessionId}:${input.beadId}:${input.loopId}`);
      return {
        accepted: true,
        reason: "recorded",
        evidence: [`remote.session.assigned:${input.sessionId}:${input.beadId}`]
      };
    }
  });

  assert.equal(result.claimed, true);
  assert.deepEqual(ownershipCalls, ["remote-1:ciclo-1:review-loop"]);
  assert.match(calls[3] ?? "", /session=remote-1/);
  assert.match(calls[3] ?? "", /remote_session=remote-1/);
  assert.match(calls[3] ?? "", /herdr_session=review-loop/);
  assert.match(calls[3] ?? "", /herdr_target=pane-1/);
  assert.doesNotMatch(calls[3] ?? "", /deploy@example\.com|\/repo/);
  assert.ok(result.evidence.includes("beads.claim.session:remote-1"));
  assert.ok(result.evidence.includes("remote.session.assigned:remote-1:ciclo-1"));
});

test("claim flow avoids already claimed or blocked work on recheck", async () => {
  const calls: string[] = [];
  const client: BeadsWorkClaimClient = {
    async ready() {
      calls.push("ready");
      return [task({ id: "ciclo-1", labels: ["mvp"] })];
    },
    async show(id) {
      calls.push(`show:${id}`);
      return task({ id, status: "in_progress", labels: ["mvp"] });
    },
    async claim(id) {
      calls.push(`claim:${id}`);
      return task({ id });
    },
    async note(id, message) {
      calls.push(`note:${id}:${message}`);
    }
  };

  const result = await selectAndClaimBeadsWork(client, {
    selector: { loop, requiredLabels: ["mvp"] }
  });

  assert.equal(result.claimed, false);
  assert.match(result.reason, /failed recheck/);
  assert.deepEqual(calls, ["ready", "show:ciclo-1"]);
});

test("claim flow stops before reading ready work when authorization denies", async () => {
  const calls: string[] = [];
  const client: BeadsWorkClaimClient = {
    async ready() {
      calls.push("ready");
      return [task({ id: "ciclo-1" })];
    },
    async show(id) {
      calls.push(`show:${id}`);
      return task({ id });
    },
    async claim(id) {
      calls.push(`claim:${id}`);
      return task({ id });
    },
    async note(id, message) {
      calls.push(`note:${id}:${message}`);
    }
  };

  const result = await selectAndClaimBeadsWork(client, {
    selector: { loop },
    authorization: {
      decision: "deny",
      reason: "not allowed",
      evidence: ["access.decision:deny"],
      operatorRoutePrincipalIds: [],
      audit: {
        event: "access.denied",
        action: "claim_beads_task",
        sessionId: "session-1",
        reason: "not allowed",
        evidence: ["access.decision:deny"]
      }
    }
  });

  assert.equal(result.claimed, false);
  assert.deepEqual(calls, []);
  assert.match(result.reason, /not allowed/);
});
