import assert from "node:assert/strict";
import test from "node:test";

import { buildContextPack, renderContextPack } from "../src/context-pack.js";
import type { ContextInput } from "../src/context-classifier.js";

const scope = { kind: "loop" as const, id: "review-demo", loopId: "review-demo" };

function item(input: Partial<ContextInput> & Pick<ContextInput, "id" | "source" | "text">): ContextInput {
  return {
    scope,
    ...input
  };
}

test("context pack prioritizes active Beads repo Herdr and validation evidence", () => {
  const pack = buildContextPack({
    harness: "codex",
    scope,
    maxTokens: 140,
    items: [
      item({ id: "spec", source: "spec", text: "SPEC-CICLO-001 review loop requirements" }),
      item({
        id: "bead",
        source: "beads",
        text: "Active bead: acceptance criteria and blockers",
        scope: { kind: "beads_issue", id: "ciclo-1", beadsIssueId: "ciclo-1" }
      }),
      item({ id: "repo", source: "repo", text: "Repo dirty files and configured checks" }),
      item({ id: "herdr", source: "herdr", text: "Herdr reports Codex done" }),
      item({ id: "audit", source: "audit", text: "Recent decision: keep dry-run" }),
      item({ id: "old-transcript", source: "transcript", text: "old low value chat history", ageMinutes: 1440 })
    ]
  });
  assert.equal(pack.included[0]?.source, "beads");
  assert.ok(pack.included.some((entry) => entry.source === "herdr"));
  assert.ok(pack.included.some((entry) => entry.source === "repo"));
  assert.ok(pack.omitted.some((entry) => entry.id === "old-transcript"));
  assert.match(pack.promptPrefix, /Codex/);
});

test("context pack redacts sensitive remote and MCP material", () => {
  const pack = buildContextPack({
    harness: "claude-code",
    scope,
    maxTokens: 200,
    items: [
      item({ id: "remote", source: "remote_session", text: "remote host user@box path /secret" }),
      item({ id: "mcp", source: "mcp", text: "api_key=abc123" })
    ]
  });
  assert.equal(pack.included.length, 2);
  assert.ok(pack.included.every((entry) => entry.redacted));
  assert.doesNotMatch(renderContextPack(pack), /abc123/);
  assert.match(pack.promptPrefix, /Claude Code/);
});

test("context pack supports generic harness prompt prefix and token omissions", () => {
  const pack = buildContextPack({
    harness: "unknown",
    scope,
    maxTokens: 8,
    items: [
      item({ id: "bead", source: "beads", text: "This task has too much detail for tiny budget" }),
      item({ id: "herdr", source: "herdr", text: "done" })
    ]
  });
  assert.match(pack.promptPrefix, /generic harness/);
  assert.ok(pack.usedTokens <= pack.maxTokens);
  assert.ok(pack.omitted.some((entry) => entry.reason === "token budget exceeded"));
});

test("context pack can include sensitive text only when explicitly requested", () => {
  const pack = buildContextPack({
    harness: "pi",
    scope,
    maxTokens: 100,
    includeSensitive: true,
    items: [item({ id: "mcp", source: "mcp", text: "token for immediate local-only use" })]
  });
  assert.equal(pack.included[0]?.redacted, false);
  assert.match(renderContextPack(pack), /token for immediate/);
});
