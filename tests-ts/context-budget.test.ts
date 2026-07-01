import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContextBudgetState,
  contextBudgetEvidence,
  estimateTokensFromText,
  type ContextReserve
} from "../src/context-budget.js";

const reserves: readonly ContextReserve[] = [
  { section: "system", tokens: 100 },
  { section: "developer", tokens: 50 },
  { section: "active_task", tokens: 100 },
  { section: "safety_policy", tokens: 50 },
  { section: "tool_output", tokens: 100 },
  { section: "response", tokens: 100 }
];

test("context budget state tracks max used reserved thresholds and attribution", () => {
  const state = buildContextBudgetState({
    scope: { kind: "harness_session", id: "session-1", harness: "codex" },
    maxTokens: 4000,
    estimate: { usedTokens: 1000, source: "model_reported", attributedTo: ["codex"] },
    reserves
  });
  assert.equal(state.maxTokens, 4000);
  assert.equal(state.estimate.usedTokens, 1000);
  assert.equal(state.reservedTokens, 500);
  assert.equal(state.availableTokens, 2500);
  assert.equal(state.status, "ok");
  assert.ok(contextBudgetEvidence(state).includes("context.source:model_reported"));
});

test("context budget reports warn compact and force thresholds", () => {
  const base = {
    scope: { kind: "loop" as const, id: "review-demo", loopId: "review-demo" },
    maxTokens: 1000,
    reserves,
    thresholds: { warn: 0.6, compactAfterTask: 0.75, forceCompact: 0.9 }
  };
  assert.equal(
    buildContextBudgetState({
      ...base,
      estimate: { usedTokens: 150, source: "tokenizer", attributedTo: ["loop"] }
    }).status,
    "warn"
  );
  assert.equal(
    buildContextBudgetState({
      ...base,
      estimate: { usedTokens: 280, source: "tokenizer", attributedTo: ["loop"] }
    }).status,
    "compact_after_task"
  );
  assert.equal(
    buildContextBudgetState({
      ...base,
      estimate: { usedTokens: 420, source: "tokenizer", attributedTo: ["loop"] }
    }).status,
    "force_compact"
  );
});

test("context budget supports remote session and Beads issue scopes", () => {
  const remote = buildContextBudgetState({
    scope: { kind: "remote_session", id: "remote-1", remoteSessionId: "remote-1" },
    maxTokens: 8000,
    estimate: { usedTokens: 1000, source: "character_heuristic", attributedTo: ["remote"] },
    reserves
  });
  const bead = buildContextBudgetState({
    scope: { kind: "beads_issue", id: "ciclo-123", beadsIssueId: "ciclo-123" },
    maxTokens: 8000,
    estimate: estimateTokensFromText("acceptance evidence", ["beads:ciclo-123"]),
    reserves
  });
  assert.equal(remote.scope.remoteSessionId, "remote-1");
  assert.equal(bead.scope.beadsIssueId, "ciclo-123");
  assert.equal(bead.estimate.source, "character_heuristic");
});
