import assert from "node:assert/strict";
import test from "node:test";

import type { BeadsTaskSnapshot } from "../src/beads-adapter.js";
import { buildBeadsHarnessPrompt } from "../src/beads-prompt-builder.js";
import type { HerdrObservation, LoopConfig } from "../src/ciclo-core.js";
import { claudeCodePlugin, codexPlugin } from "../src/harness-registry.js";

const loop: LoopConfig = {
  id: "work-loop",
  kind: "beads_work",
  goal: "Work Beads tasks",
  harnesses: ["codex", "claude-code"],
  dryRun: true
};

const observation: HerdrObservation = {
  source: "fixture",
  target: "pane-1",
  harness: "codex",
  state: "idle",
  evidence: ["herdr:idle"]
};

const task: BeadsTaskSnapshot = {
  id: "ciclo-123",
  title: "Implement prompt builder",
  status: "open",
  priority: 1,
  issueType: "task",
  description: "Convert Beads work into bounded harness prompts.",
  acceptanceCriteria: "- includes bead ID\n- includes known blockers\n- includes validation",
  specId: "SPEC-CICLO-001",
  labels: ["mvp"],
  dependencies: [
    {
      id: "ciclo-100",
      title: "Finish plugin registry",
      status: "closed"
    },
    {
      id: "ciclo-101",
      title: "Resolve design blocker",
      status: "open"
    }
  ],
  externalRefs: ["linear:CIC-123"]
};

test("builds Codex prompt from Beads work with ID spec acceptance blockers validation and stop conditions", () => {
  const result = buildBeadsHarnessPrompt({
    task,
    loop,
    observation,
    plugin: codexPlugin,
    repoSummary: "main branch, dirty src",
    validationCommands: ["just typescript", "just check"],
    context: ["Use the existing harness plugin style."]
  });

  assert.equal(result.request.beadId, "ciclo-123");
  assert.equal(result.request.specId, "SPEC-CICLO-001");
  assert.deepEqual(result.request.acceptanceCriteria, [
    "includes bead ID",
    "includes known blockers",
    "includes validation"
  ]);
  assert.match(result.prompt, /Beads task: ciclo-123/);
  assert.match(result.prompt, /Spec: SPEC-CICLO-001/);
  assert.match(result.prompt, /ciclo-101 Resolve design blocker \[open\]/);
  assert.match(result.prompt, /just check/);
  assert.match(result.prompt, /Stop and ask before secrets/);
  assert.ok(result.evidence.includes("beads.prompt.harness:codex"));
});

test("builds Claude Code prompt with fallback spec validation and blocker context", () => {
  const result = buildBeadsHarnessPrompt({
    task: {
      ...task,
      specId: undefined,
      acceptanceCriteria: ""
    },
    loop,
    observation: { ...observation, harness: "claude-code" },
    plugin: claudeCodePlugin,
    action: "review"
  });

  assert.equal(result.request.specId, "SPEC-CICLO-001");
  assert.deepEqual(result.request.validationCommands, ["just check"]);
  assert.match(result.prompt, /Beads task: ciclo-123/);
  assert.match(result.prompt, /Acceptance criteria:/);
  assert.match(result.prompt, /Report which acceptance criteria are missing/);
  assert.match(result.prompt, /Do not approve permission prompts/);
  assert.match(result.prompt, /Known blockers\/dependencies/);
});

test("appends configured Beads guidance to task harness prompts", () => {
  const result = buildBeadsHarnessPrompt({
    task,
    loop,
    observation,
    plugin: codexPlugin,
    promptInjections: [
      {
        id: "beads-memory",
        scope: "beads",
        text: "Record durable progress in the Beads task before closeout."
      }
    ]
  });

  assert.match(result.prompt, /Configured Ciclo guidance:/);
  assert.match(result.prompt, /\[beads-memory\] Record durable progress/);
  assert.ok(result.evidence.includes("prompt.injections.beads:1"));
  assert.ok(result.evidence.includes("prompt.injection.beads:beads-memory"));
});
