import assert from "node:assert/strict";
import test from "node:test";

import type { BeadsTaskSnapshot } from "../src/beads-adapter.js";
import { selectWorkerModelForProblem } from "../src/worker-model-selection.js";

function task(input: Partial<BeadsTaskSnapshot> = {}): BeadsTaskSnapshot {
  return {
    id: input.id ?? "ciclo-task",
    title: input.title ?? "Update docs",
    status: input.status ?? "open",
    priority: input.priority ?? 2,
    issueType: input.issueType ?? "task",
    description: input.description ?? "",
    acceptanceCriteria: input.acceptanceCriteria ?? "",
    labels: input.labels ?? [],
    dependencies: input.dependencies ?? [],
    externalRefs: input.externalRefs ?? []
  };
}

test("worker model selection uses a small Codex model for small documentation tasks", () => {
  const selection = selectWorkerModelForProblem({
    task: task({
      title: "Update README getting started guide",
      labels: ["docs"]
    }),
    profiles: [{ harnessId: "codex" }, { harnessId: "claude-code", model: "claude-fable-5" }]
  });

  assert.equal(selection.harness.harnessId, "codex");
  assert.equal(selection.model, "gpt-5-mini");
  assert.equal(selection.effort, undefined);
  assert.equal(selection.classification.complexity, "small");
  assert.ok(selection.evidence.includes("model.selection.model:gpt-5-mini"));
});

test("worker model selection prefers Claude Fable high effort for hard orchestration work", () => {
  const selection = selectWorkerModelForProblem({
    task: task({
      id: "ciclo-hard",
      title: "Implement remote Kubernetes session orchestration with secrets",
      issueType: "feature",
      priority: 1,
      description: "Coordinate Herdr remote sessions, MCP, and secret policy."
    }),
    profiles: [{ harnessId: "codex" }, { harnessId: "claude-code" }]
  });

  assert.equal(selection.harness.harnessId, "claude-code");
  assert.equal(selection.model, "claude-fable-5");
  assert.equal(selection.effort, "high");
  assert.equal(selection.classification.complexity, "hard");
  assert.ok(selection.evidence.includes("model.selection.reason:preferred_claude-code"));
});

test("worker model selection respects explicit selected harness profile defaults", () => {
  const selection = selectWorkerModelForProblem({
    task: task({
      title: "Fix failing CLI integration test",
      issueType: "bug",
      labels: ["test"]
    }),
    profiles: [{ harnessId: "codex", model: "custom-codex-model", effort: "low" }, { harnessId: "claude-code" }]
  });

  assert.equal(selection.harness.harnessId, "codex");
  assert.equal(selection.model, "custom-codex-model");
  assert.equal(selection.effort, "low");
  assert.equal(selection.classification.complexity, "standard");
});
