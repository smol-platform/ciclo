import assert from "node:assert/strict";
import test from "node:test";

import type { AuthorizationResult } from "../src/access-enforcement.js";
import type { BeadsTaskSnapshot } from "../src/beads-adapter.js";
import {
  closeBeadsTaskWithPolicy,
  recordBeadsProgress,
  type BeadsProgressClient
} from "../src/beads-progress.js";
import type { LoopConfig } from "../src/ciclo-core.js";
import type { PolicyConfig } from "../src/loop-config.js";

function task(input: Partial<BeadsTaskSnapshot> & Pick<BeadsTaskSnapshot, "id">): BeadsTaskSnapshot {
  return {
    id: input.id,
    title: input.title ?? input.id,
    status: input.status ?? "open",
    priority: input.priority ?? 1,
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
  id: "beads-loop",
  kind: "beads_work",
  goal: "Work Beads queue",
  harnesses: ["codex"],
  dryRun: false
};

const policy: PolicyConfig = {
  mode: "supervised",
  requireApprovalFor: [],
  allowCommands: ["just check"]
};

const denyAuth: AuthorizationResult = {
  decision: "deny",
  reason: "principal lacks work grant",
  evidence: ["access.denied"],
  operatorRoutePrincipalIds: [],
  audit: {
    event: "access.denied",
    action: "update_beads_progress",
    sessionId: "session-1",
    reason: "principal lacks work grant",
    evidence: ["access.denied"]
  }
};

function fakeClient(calls: string[]): BeadsProgressClient {
  return {
    async show(id) {
      calls.push(`show:${id}`);
      return task({ id, status: "in_progress" });
    },
    async note(id, message) {
      calls.push(`note:${id}:${message}`);
    },
    async close(id, reason) {
      calls.push(`close:${id}:${reason}`);
      return task({ id, status: "closed" });
    }
  };
}

test("records progress notes with loop principal harness and push evidence", async () => {
  const calls: string[] = [];
  const result = await recordBeadsProgress(fakeClient(calls), {
    id: "ciclo-1",
    kind: "progress",
    message: "Implemented prompt builder",
    loop,
    policy,
    principalId: "user:zach",
    harnessId: "codex",
    sessionId: "session-1",
    sync: {
      async pushAfterUpdate() {
        calls.push("push");
        return true;
      }
    }
  });

  assert.equal(result.mutated, true);
  assert.equal(result.pushed, true);
  assert.match(calls[0] ?? "", /ciclo.progress loop=beads-loop harness=codex principal=user:zach/);
  assert.match(calls[0] ?? "", /Implemented prompt builder/);
  assert.equal(calls[1], "push");
  assert.match(
    calls[0] ?? "",
    /ciclo\.metadata action=progress bead=ciclo-1 loop=beads-loop harness=codex principal=user:zach session=session-1/
  );
  assert.ok(result.evidence.includes("beads.progress.metadata:standard"));
});

test("records blocker and validation updates as Beads notes", async () => {
  const calls: string[] = [];

  await recordBeadsProgress(fakeClient(calls), {
    id: "ciclo-1",
    kind: "blocker",
    message: "Waiting on remote database",
    blockerId: "ciclo-remote-1",
    remoteSession: {
      id: "remote-1",
      transport: "herdr_remote_ssh",
      herdrSession: "deploy-loop",
      herdrAgentTarget: "pane-9",
      state: "blocked"
    },
    loop,
    policy
  });
  await recordBeadsProgress(fakeClient(calls), {
    id: "ciclo-1",
    kind: "validation",
    message: "Ran check",
    loop,
    policy,
    validation: {
      command: "just check",
      passed: true,
      summary: "all checks passed"
    }
  });

  assert.match(calls[0] ?? "", /ciclo.blocker loop=beads-loop blocker=ciclo-remote-1/);
  assert.match(calls[0] ?? "", /remote_session=remote-1/);
  assert.match(calls[0] ?? "", /herdr_session=deploy-loop/);
  assert.match(calls[0] ?? "", /herdr_target=pane-9/);
  assert.match(calls[1] ?? "", /validation command=just check/);
  assert.match(calls[1] ?? "", /validation passed=true/);
});

test("progress update fails closed when authorization denies", async () => {
  const calls: string[] = [];
  const result = await recordBeadsProgress(fakeClient(calls), {
    id: "ciclo-1",
    kind: "progress",
    message: "Should not write",
    loop,
    policy,
    authorization: denyAuth
  });

  assert.equal(result.mutated, false);
  assert.deepEqual(calls, []);
  assert.match(result.reason, /principal lacks work grant/);
});

test("close denies without acceptance plus passing validation evidence", async () => {
  const calls: string[] = [];
  const result = await closeBeadsTaskWithPolicy(fakeClient(calls), {
    id: "ciclo-1",
    loop,
    policy,
    finalSummary: "Done",
    acceptanceEvidence: ["Acceptance criteria reviewed"],
    validationEvidence: [{ command: "just check", passed: false, summary: "failed" }]
  });

  assert.equal(result.mutated, false);
  assert.deepEqual(calls, []);
  assert.match(result.reason, /requires acceptance and validation evidence/);
});

test("close asks operator when policy requires close approval", async () => {
  const calls: string[] = [];
  const result = await closeBeadsTaskWithPolicy(fakeClient(calls), {
    id: "ciclo-1",
    loop,
    policy: { ...policy, requireApprovalFor: ["task_close"] },
    finalSummary: "Done",
    acceptanceEvidence: ["Acceptance criteria reviewed"],
    validationEvidence: [{ command: "just check", passed: true, summary: "passed" }]
  });

  assert.equal(result.mutated, false);
  assert.equal(result.policy.decision, "ask_operator");
  assert.deepEqual(calls, []);
});

test("close writes final summary then closes and pushes after update", async () => {
  const calls: string[] = [];
  const result = await closeBeadsTaskWithPolicy(fakeClient(calls), {
    id: "ciclo-1",
    loop,
    policy,
    finalSummary: "Prompt builder is complete",
    acceptanceEvidence: ["Harness prompt includes bead ID", "Harness prompt includes validation command"],
    validationEvidence: [{ command: "just check", passed: true, summary: "all checks passed" }],
    principalId: "user:zach",
    harnessId: "codex",
    sessionId: "session-1",
    sync: {
      async pushAfterUpdate() {
        calls.push("push");
        return true;
      }
    }
  });

  assert.equal(result.mutated, true);
  assert.equal(result.task?.status, "closed");
  assert.deepEqual(
    calls.map((call) => call.split(":")[0]),
    ["show", "note", "close", "push"]
  );
  assert.match(calls[1] ?? "", /ciclo.final_summary loop=beads-loop harness=codex principal=user:zach/);
  assert.match(
    calls[1] ?? "",
    /ciclo\.metadata action=final_summary bead=ciclo-1 loop=beads-loop harness=codex principal=user:zach session=session-1/
  );
  assert.match(calls[1] ?? "", /acceptance evidence: Harness prompt includes bead ID/);
  assert.match(calls[2] ?? "", /close:ciclo-1:Prompt builder is complete/);
  assert.ok(result.evidence.includes("beads.close.metadata:standard"));
});
