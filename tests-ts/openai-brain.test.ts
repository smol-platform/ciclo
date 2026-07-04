import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAiBrainPiTools,
  defaultOpenAiBrainModel,
  openAiBrainIntelligence,
  openAiBrainModelFamily,
  openAiBrainPolicy,
  type OpenAiBrainToolExecutor,
  type OpenAiBrainToolResult,
  parseOpenAiControlAction,
  PiSdkOpenAiBrain
} from "../src/openai-brain.js";

test("OpenAI brain policy covers live control-plane decision purposes", () => {
  assert.equal(openAiBrainPolicy.provider, "openai");
  assert.equal(openAiBrainPolicy.adapter, "pi-sdk");
  assert.equal(openAiBrainPolicy.intelligence, "model_backed");
  assert.equal(openAiBrainPolicy.modelFamily, "openai");
  assert.equal(openAiBrainPolicy.model, defaultOpenAiBrainModel);
  assert.equal(openAiBrainPolicy.fallback, "fail_closed");
  assert.ok(openAiBrainPolicy.required_for.includes("remote_session_monitoring"));
  assert.ok(openAiBrainPolicy.required_for.includes("context_insertion"));
  assert.ok(openAiBrainPolicy.required_for.includes("answer_question"));
  assert.ok(openAiBrainPolicy.required_for.includes("user_session_interface"));
  assert.ok(openAiBrainPolicy.local_cli_exceptions.includes("status"));
});

test("Pi SDK OpenAI brain builds an orchestration prompt for remote monitoring", async () => {
  let capturedPrompt = "";
  const brain = new PiSdkOpenAiBrain({
    runner: async (prompt, options) => {
      capturedPrompt = prompt;
      assert.equal(options.model, defaultOpenAiBrainModel);
      assert.equal(options.thinking, "high");
      return "Ask the operator for approval before reassigning work.";
    }
  });

  const decision = await brain.decide({
    purpose: "remote_session_monitoring",
    loopId: "review-loop",
    beadId: "ciclo-1",
    remoteSessionId: "remote-1",
    prompt: "Remote worker has gone silent.",
    context: ["state=stale"],
    evidence: ["remote.session.stale:remote-1"]
  });

  assert.match(capturedPrompt, /model-backed OpenAI orchestration brain/);
  assert.match(capturedPrompt, /Decision purpose: remote_session_monitoring/);
  assert.match(capturedPrompt, /Remote worker has gone silent/);
  assert.equal(decision.provider, "openai");
  assert.equal(decision.adapter, "pi-sdk");
  assert.equal(decision.intelligence, openAiBrainIntelligence);
  assert.equal(decision.modelFamily, openAiBrainModelFamily);
  assert.equal(decision.text, "Ask the operator for approval before reassigning work.");
  assert.ok(decision.evidence.includes("brain.provider:openai"));
  assert.ok(decision.evidence.includes("brain.intelligence:model_backed"));
  assert.ok(decision.evidence.includes("brain.model_family:openai"));
});

test("Pi SDK OpenAI brain parses structured control actions", async () => {
  const brain = new PiSdkOpenAiBrain({
    runner: async () => JSON.stringify({
      action: {
        kind: "launch_debug_worker",
        reason: "worker is stuck in a failing test loop",
        message: "Debug the failing test and report the smallest fix.",
        harnessId: "claude-code",
        model: "claude-fable-5",
        effort: "high"
      },
      decision: "Launch a focused debug worker."
    })
  });

  const decision = await brain.decide({
    purpose: "remote_session_monitoring",
    prompt: "Worker has stalled while debugging."
  });

  assert.equal(decision.action?.kind, "launch_debug_worker");
  assert.equal(decision.action?.harnessId, "claude-code");
  assert.equal(decision.action?.model, "claude-fable-5");
  assert.equal(parseOpenAiControlAction("Ask the operator first."), undefined);
  assert.deepEqual(parseOpenAiControlAction("```json\n{\"action\":\"wait\",\"reason\":\"no capacity\"}\n```"), {
    kind: "wait",
    reason: "no capacity"
  });
});

test("Pi SDK OpenAI brain exposes bounded Ciclo tools to the Pi session", async () => {
  let capturedToolNames: readonly string[] = [];
  const executor: OpenAiBrainToolExecutor = {
    availableTools: () => [{
      name: "ciclo_observe_worker",
      description: "Observe a worker.",
      mutates: false
    }],
    async execute(request) {
      return {
        name: request.name,
        ok: true,
        summary: "observed worker",
        evidence: ["fixture.tool:observed"]
      };
    }
  };
  const brain = new PiSdkOpenAiBrain({
    runner: async (_prompt, options) => {
      capturedToolNames = (options.tools ?? []).map((tool) => tool.name);
      return "{\"action\":\"wait\",\"reason\":\"tool surface verified\"}";
    }
  });

  const decision = await brain.decide({
    purpose: "remote_session_monitoring",
    prompt: "Observe before deciding.",
    toolExecutor: executor
  });

  assert.deepEqual(capturedToolNames, ["ciclo_observe_worker"]);
  assert.equal(decision.action?.kind, "wait");
  assert.ok(decision.evidence.includes("brain.tools.available:1"));
  assert.ok(decision.evidence.includes("brain.tools.used:0"));
});

test("Pi SDK Ciclo tool adapter executes bounded tool calls and records results", async () => {
  const results: OpenAiBrainToolResult[] = [];
  const executor: OpenAiBrainToolExecutor = {
    availableTools: () => [{
      name: "ciclo_poll_events",
      description: "Poll events.",
      mutates: false
    }],
    async execute(request) {
      return {
        name: request.name,
        ok: true,
        summary: `cursor=${request.params.cursor}`,
        evidence: ["fixture.tool:polled"]
      };
    }
  };
  const tools = createOpenAiBrainPiTools(executor, results);
  const tool = tools[0];

  const result = await tool?.execute("tool-1", { cursor: 4 }, undefined, undefined, {} as never);

  assert.equal(result?.content[0]?.type, "text");
  assert.deepEqual(results, [{
    name: "ciclo_poll_events",
    ok: true,
    summary: "cursor=4",
    evidence: ["fixture.tool:polled"]
  }]);
});

test("Pi SDK OpenAI brain accepts non-default intelligent OpenAI model ids", async () => {
  let capturedModel = "";
  const brain = new PiSdkOpenAiBrain({
    model: "openai-codex/gpt-5.1",
    runner: async (_prompt, options) => {
      capturedModel = options.model;
      return "Use the configured model for this decision.";
    }
  });

  const decision = await brain.decide({
    purpose: "context_insertion",
    prompt: "Should Ciclo insert more context?"
  });

  assert.equal(capturedModel, "openai-codex/gpt-5.1");
  assert.equal(decision.model, "openai-codex/gpt-5.1");
  assert.equal(decision.intelligence, "model_backed");
});

test("Pi SDK OpenAI brain appends configured guidance to decision prompts", async () => {
  let capturedPrompt = "";
  const brain = new PiSdkOpenAiBrain({
    promptInjections: [
      {
        id: "brain-help",
        scope: "brain",
        text: "Compare validation state, model fit, and operator feedback before escalating."
      },
      {
        id: "worker-only",
        scope: "worker",
        text: "This should not be in the brain prompt."
      }
    ],
    runner: async (prompt) => {
      capturedPrompt = prompt;
      return "Escalate model and ask for validation status.";
    }
  });

  const decision = await brain.decide({
    purpose: "remote_session_monitoring",
    prompt: "Worker is stalled."
  });

  assert.match(capturedPrompt, /Configured Ciclo guidance:/);
  assert.match(capturedPrompt, /\[brain-help\] Compare validation state/);
  assert.doesNotMatch(capturedPrompt, /worker-only/);
  assert.ok(decision.evidence.includes("prompt.injections.brain:1"));
  assert.ok(decision.evidence.includes("prompt.injection.brain:brain-help"));
});
