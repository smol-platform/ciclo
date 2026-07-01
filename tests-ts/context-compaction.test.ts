import assert from "node:assert/strict";
import test from "node:test";

import type { BeadsTaskSnapshot } from "../src/beads-adapter.js";
import type { BeadsProgressClient } from "../src/beads-progress.js";
import type { LoopConfig } from "../src/ciclo-core.js";
import {
  buildContextBudgetState,
  estimateTokensFromText,
  type ContextBudgetState
} from "../src/context-budget.js";
import { smartCompactAfterBeadsTransition, InMemoryIdempotencyStore } from "../src/context-compaction.js";
import { buildContextPack, type ContextPack } from "../src/context-pack.js";
import type { PolicyConfig } from "../src/loop-config.js";

function task(id: string, status = "in_progress"): BeadsTaskSnapshot {
  return {
    id,
    title: id,
    status,
    priority: 1,
    issueType: "task",
    description: "",
    acceptanceCriteria: "",
    labels: [],
    dependencies: [],
    externalRefs: []
  };
}

function fakeClient(calls: string[]): BeadsProgressClient {
  return {
    async show(id) {
      calls.push(`show:${id}`);
      return task(id);
    },
    async note(id, message) {
      calls.push(`note:${id}:${message}`);
    },
    async close(id, reason) {
      calls.push(`close:${id}:${reason}`);
      return task(id, "closed");
    }
  };
}

const loop: LoopConfig = {
  id: "context-loop",
  kind: "beads_work",
  goal: "Preserve work memory",
  harnesses: ["codex"],
  dryRun: false
};

const policy: PolicyConfig = {
  mode: "supervised",
  requireApprovalFor: [],
  allowCommands: ["just check"]
};

function budget(): ContextBudgetState {
  return buildContextBudgetState({
    scope: { kind: "beads_issue", id: "ciclo-1", beadsIssueId: "ciclo-1" },
    maxTokens: 4000,
    estimate: estimateTokensFromText("recent transcript and tool output", ["transcript"]),
    thresholds: { warn: 0.3, compactAfterTask: 0.4, forceCompact: 0.8 },
    reserves: [
      { section: "system", tokens: 200 },
      { section: "developer", tokens: 200 },
      { section: "active_task", tokens: 300 },
      { section: "safety_policy", tokens: 100 },
      { section: "tool_output", tokens: 200 },
      { section: "response", tokens: 200 }
    ]
  });
}

function pack(): ContextPack {
  return buildContextPack({
    harness: "codex",
    scope: { kind: "beads_issue", id: "ciclo-1", beadsIssueId: "ciclo-1" },
    maxTokens: 200,
    items: [
      {
        id: "bead",
        source: "beads",
        text: "Active task with acceptance criteria",
        scope: { kind: "beads_issue", id: "ciclo-1", beadsIssueId: "ciclo-1" }
      },
      {
        id: "repo",
        source: "repo",
        text: "Changed src/context-compaction.ts",
        scope: { kind: "beads_issue", id: "ciclo-1", beadsIssueId: "ciclo-1" }
      }
    ]
  });
}

test("smart compact writes durable Beads memory with decisions validation files follow-ups and idempotency key", async () => {
  const calls: string[] = [];
  const store = new InMemoryIdempotencyStore();
  const result = await smartCompactAfterBeadsTransition(fakeClient(calls), {
    id: "ciclo-1",
    transition: "completed",
    loop,
    policy,
    budget: budget(),
    contextPack: pack(),
    idempotencyStore: store,
    principalId: "user:zach",
    harnessId: "codex",
    decisions: ["Use Beads as durable work memory"],
    validation: [{ command: "just check", passed: true, summary: "all checks passed" }],
    blockers: [],
    changedFiles: ["src/context-compaction.ts", "tests-ts/context-compaction.test.ts"],
    followUps: ["Extend Quint compaction invariant"],
    sync: {
      async pushAfterUpdate() {
        calls.push("push");
        return true;
      }
    }
  });

  assert.equal(result.compacted, true);
  assert.equal(result.pushed, true);
  assert.match(result.idempotencyKey, /^ciclo-compact:ciclo-1:completed:/);
  assert.match(calls[0] ?? "", /ciclo.final_summary loop=context-loop harness=codex principal=user:zach/);
  assert.match(calls[0] ?? "", /Use Beads as durable work memory/);
  assert.match(calls[0] ?? "", /just check: passed - all checks passed/);
  assert.match(calls[0] ?? "", /src\/context-compaction.ts/);
  assert.match(calls[0] ?? "", /Extend Quint compaction invariant/);
  assert.match(result.continuationSummary, /Idempotency key:/);
  assert.equal(calls[1], "push");
});

test("smart compact skips duplicate idempotency keys without writing a second note", async () => {
  const calls: string[] = [];
  const store = new InMemoryIdempotencyStore();
  const input = {
    id: "ciclo-1",
    transition: "handed_off" as const,
    loop,
    policy,
    budget: budget(),
    contextPack: pack(),
    idempotencyStore: store,
    decisions: ["Pause for remote operator"],
    validation: [],
    blockers: [],
    changedFiles: [],
    followUps: ["Resume from Beads memory"]
  };

  const first = await smartCompactAfterBeadsTransition(fakeClient(calls), input);
  const second = await smartCompactAfterBeadsTransition(fakeClient(calls), input);

  assert.equal(first.compacted, true);
  assert.equal(second.compacted, false);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(calls.length, 1);
  assert.match(second.reason, /idempotency key/);
});

test("blocked compaction preserves blockers and included context for continuation", async () => {
  const calls: string[] = [];
  const result = await smartCompactAfterBeadsTransition(fakeClient(calls), {
    id: "ciclo-1",
    transition: "blocked",
    loop,
    policy,
    budget: budget(),
    contextPack: pack(),
    decisions: ["Do not close until remote DB conflict is resolved"],
    validation: [],
    blockers: ["remote DB conflict"],
    changedFiles: ["src/beads-remote-health.ts"],
    followUps: ["Ask operator to resolve Dolt conflict"]
  });

  assert.equal(result.compacted, true);
  assert.match(calls[0] ?? "", /ciclo.blocker loop=context-loop blocker=remote DB conflict/);
  assert.match(result.continuationSummary, /Blockers:\n- remote DB conflict/);
  assert.match(result.continuationSummary, /Included context:\n- beads:bead/);
  assert.ok(result.evidence.some((item) => item.startsWith("context.status:")));
});

test("compaction redacts secrets transcripts and remote details before Beads persistence", async () => {
  const calls: string[] = [];
  const result = await smartCompactAfterBeadsTransition(fakeClient(calls), {
    id: "ciclo-1",
    transition: "blocked",
    loop,
    policy,
    budget: budget(),
    contextPack: pack(),
    decisions: [
      "Do not persist api_key=sk-test-123",
      "Remote is deploy@prod.example.com at /srv/ciclo",
      "```terminal\n$ export TOKEN=abc123\nraw output\n```"
    ],
    validation: [{ command: "just check", passed: true, summary: "Bearer abc.def.ghi was not needed" }],
    blockers: ["remote host prod.example.com path /srv/ciclo is blocked"],
    changedFiles: ["/Users/zach/secret-project/file.ts", "src/context-redaction.ts"],
    followUps: ["Rotate token=follow-up-secret"]
  });

  const persisted = calls[0] ?? "";
  assert.equal(result.compacted, true);
  assert.doesNotMatch(persisted, /sk-test-123|prod\.example\.com|\/srv\/ciclo|abc123|abc\.def\.ghi|follow-up-secret/);
  assert.doesNotMatch(result.continuationSummary, /sk-test-123|prod\.example\.com|\/srv\/ciclo|abc123|abc\.def\.ghi|follow-up-secret/);
  assert.match(persisted, /\[redacted secret\]/);
  assert.match(persisted, /\[redacted remote host\]/);
  assert.match(persisted, /\[redacted remote path\]/);
  assert.match(persisted, /\[redacted raw transcript\]/);
  assert.ok(result.redactions.some((item) => item.kind === "secret"));
  assert.ok(result.redactions.some((item) => item.kind === "token"));
  assert.ok(result.redactions.some((item) => item.kind === "raw_transcript"));
  assert.ok(result.evidence.some((item) => item.startsWith("context.redaction.secret:")));
});
