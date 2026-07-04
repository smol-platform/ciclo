import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultOpenAiBrainModel,
  openAiBrainIntelligence,
  openAiBrainModelFamily,
  openAiBrainPolicy,
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
