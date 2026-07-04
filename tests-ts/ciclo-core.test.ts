import assert from "node:assert/strict";
import test from "node:test";

import { buildStandaloneStatus } from "../src/app.js";
import cicloExtension from "../src/pi-extension.js";
import { normalizeHarness, planNext, runtimeDecision, type HerdrObservation } from "../src/ciclo-core.js";
import {
  claudeCodePlugin,
  codexPlugin,
  createDefaultRegistry,
  type HarnessPromptRequest
} from "../src/harness-registry.js";
import type { PiCommandDefinition, PiToolDefinition } from "../src/pi-types.js";

test("runtime decision is standalone Ciclo orchestrator agent with OpenAI brain via Pi", () => {
  assert.equal(runtimeDecision.runtime, "Standalone TypeScript Ciclo orchestrator agent");
  assert.ok(runtimeDecision.entrypoints.includes("standalone CLI: ./src/cli.ts"));
  assert.ok(runtimeDecision.entrypoints.includes("Pi brain adapter: ./src/pi-extension.ts"));
  assert.ok(runtimeDecision.rationale.some((item) => item.includes("Model-backed OpenAI is the default decision provider")));
  assert.ok(runtimeDecision.rationale.some((item) => item.includes("orchestrator agent")));
});

test("standalone status exposes Ciclo as orchestrator agent and OpenAI as brain provider", () => {
  const status = buildStandaloneStatus();
  assert.equal(status.app, "ciclo");
  assert.equal(status.runtime, "Standalone TypeScript Ciclo orchestrator agent");
  assert.equal(status.orchestratorAgent, true);
  assert.equal(status.brain.provider, "openai");
  assert.equal(status.brain.adapter, "pi-sdk");
  assert.equal(status.brain.role, "primary_orchestration_brain");
  assert.equal(status.brain.routing.intelligence, "model_backed");
  assert.equal(status.brain.routing.modelFamily, "openai");
  assert.ok(status.brain.routing.required_for.includes("remote_session_monitoring"));
  assert.equal(status.plan.loopId, "review-demo");
});

test("normalizes known harness labels", () => {
  assert.equal(normalizeHarness("Claude Code"), "claude-code");
  assert.equal(normalizeHarness("OpenAI Codex"), "codex");
  assert.equal(normalizeHarness("Pi coding agent"), "pi");
  assert.equal(normalizeHarness("other"), "unknown");
});

test("plans blocked observations as operator questions", () => {
  const observation: HerdrObservation = {
    source: "fixture",
    target: "pane-1",
    harness: "codex",
    state: "blocked",
    evidence: ["herdr:needs-input"]
  };
  const plan = planNext(
    {
      id: "review-demo",
      kind: "review",
      goal: "Review work",
      harnesses: ["codex"],
      dryRun: true
    },
    observation
  );
  assert.equal(plan.response, "ask_operator");
  assert.equal(plan.dryRun, true);
});

test("registers Pi adapter command and status tool", async () => {
  const tools: PiToolDefinition[] = [];
  const commands = new Map<string, PiCommandDefinition>();

  const registration = cicloExtension({
    registerTool(definition) {
      tools.push(definition);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    }
  });

  assert.deepEqual(registration.tools, ["ciclo_status"]);
  assert.deepEqual(registration.commands, ["ciclo-status"]);
  assert.equal(tools[0]?.name, "ciclo_status");
  assert.ok(commands.has("ciclo-status"));
  assert.equal(typeof tools[0]?.execute, "function");
  assert.equal(typeof (await tools[0]?.execute?.({})), "object");
});

test("default registry selects known harnesses deterministically", () => {
  const registry = createDefaultRegistry();
  const match = registry.select(
    {
      source: "fixture",
      target: "pane-1",
      harness: "codex",
      state: "idle",
      evidence: ["fixture"]
    },
    {
      id: "review-demo",
      kind: "review",
      goal: "Review work",
      harnesses: ["codex", "claude-code"],
      dryRun: true
    }
  );
  assert.equal(match.pluginId, "codex");
  assert.equal(match.confidence, 1);
});

test("default registry falls back to unknown when no plugin is configured", () => {
  const registry = createDefaultRegistry();
  const match = registry.select({
    source: "fixture",
    target: "pane-1",
    harness: "unknown",
    state: "idle",
    evidence: ["fixture"]
  });
  assert.equal(match.pluginId, "unknown");
  assert.equal(match.confidence, 0.05);
});

const promptRequest: HarnessPromptRequest = {
  loop: {
    id: "review-demo",
    kind: "review",
    goal: "Review completed work",
    harnesses: ["codex", "claude-code"],
    dryRun: true
  },
  observation: {
    source: "fixture",
    target: "pane-1",
    harness: "codex",
    state: "done",
    evidence: ["herdr:done"]
  },
  action: "implement",
  specId: "SPEC-CICLO-001",
  taskTitle: "Implement bounded planner slice",
  taskBody: "Keep the change scoped to the active bead.",
  beadId: "ciclo-demo",
  repoSummary: "dirty worktree with TypeScript changes",
  acceptanceCriteria: ["bounded prompt includes spec", "validation evidence is reported"],
  validationCommands: ["just check"]
};

test("Codex plugin builds bounded implementation prompts", () => {
  const prompt = codexPlugin.buildPrompt(promptRequest);
  assert.match(prompt, /Continue Ciclo loop review-demo/);
  assert.match(prompt, /Spec: SPEC-CICLO-001/);
  assert.match(prompt, /Acceptance:/);
  assert.match(prompt, /bounded prompt includes spec/);
  assert.match(prompt, /Validation requested:/);
  assert.match(prompt, /just check/);
  assert.match(prompt, /remaining blockers/);
  assert.match(prompt, /Stop and ask before secrets/);
});

test("Claude Code plugin builds bounded review and deploy prompts without auto-approval", () => {
  const reviewPrompt = claudeCodePlugin.buildPrompt({
    ...promptRequest,
    action: "review",
    observation: { ...promptRequest.observation, harness: "claude-code" }
  });
  const deployPrompt = claudeCodePlugin.buildPrompt({
    ...promptRequest,
    action: "deploy-gate",
    taskTitle: "Gate deployment on validation",
    observation: {
      ...promptRequest.observation,
      harness: "claude-code",
      state: "blocked",
      evidence: ["herdr:permission prompt"]
    }
  });

  assert.match(reviewPrompt, /Required next action: review/);
  assert.match(deployPrompt, /Required next action: deploy-gate/);
  assert.match(deployPrompt, /Do not approve permission prompts/);
  assert.equal(claudeCodePlugin.classifyBlockedReason?.(promptRequest.observation), undefined);
  assert.equal(
    claudeCodePlugin.classifyBlockedReason?.({
      ...promptRequest.observation,
      harness: "claude-code",
      state: "blocked",
      evidence: ["herdr:permission prompt"]
    }),
    "permission_prompt"
  );
});
