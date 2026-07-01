import assert from "node:assert/strict";
import test from "node:test";

import { classifyContextItem, classifyContextItems, type ContextInput, type ContextSourceKind } from "../src/context-classifier.js";

function input(source: ContextSourceKind, text = "context material"): ContextInput {
  return {
    id: `${source}-1`,
    source,
    text,
    scope: { kind: "loop", id: "review-demo", loopId: "review-demo" }
  };
}

test("classifier tags all required input sources with estimate and scope", () => {
  const sources: readonly ContextSourceKind[] = [
    "spec",
    "beads",
    "audit",
    "repo",
    "herdr",
    "mcp",
    "remote_session",
    "transcript"
  ];
  for (const source of sources) {
    const item = classifyContextItem(input(source));
    assert.equal(item.source, source);
    assert.equal(item.scope.loopId, "review-demo");
    assert.ok(item.priority >= 0 && item.priority <= 100);
    assert.ok(item.tokenEstimate.usedTokens > 0);
    assert.equal(item.tokenEstimate.source, "character_heuristic");
    assert.deepEqual(item.tokenEstimate.attributedTo, [`${source}:${source}-1`]);
  }
});

test("classifier prioritizes Beads and Herdr active state above stale transcript", () => {
  const items = classifyContextItems([
    { ...input("transcript"), ageMinutes: 24 * 60 },
    { ...input("beads"), scope: { kind: "beads_issue", id: "ciclo-1", beadsIssueId: "ciclo-1" } },
    input("herdr")
  ]);
  assert.equal(items[0]?.source, "beads");
  assert.equal(items[1]?.source, "herdr");
  assert.equal(items[2]?.source, "transcript");
  assert.ok(items[2]?.tags.includes("discardable"));
});

test("classifier marks sensitive remote transcript and MCP material for redaction", () => {
  const remote = classifyContextItem(input("remote_session", "remote path /srv/app"));
  const transcript = classifyContextItem(input("transcript", "raw terminal transcript"));
  const mcp = classifyContextItem(input("mcp", "api_key should not persist"));
  assert.equal(remote.redactBeforePersist, true);
  assert.equal(transcript.redactBeforePersist, true);
  assert.equal(mcp.redactBeforePersist, true);
  assert.ok(mcp.tags.includes("sensitive"));
});

test("classifier marks duplicate material redundant", () => {
  const item = classifyContextItem({ ...input("audit"), duplicateOf: "audit-0" });
  assert.ok(item.tags.includes("redundant"));
  assert.ok(item.priority < classifyContextItem(input("audit")).priority);
});
