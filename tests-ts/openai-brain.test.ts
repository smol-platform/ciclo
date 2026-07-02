import assert from "node:assert/strict";
import test from "node:test";

import {
  openAiBrainPolicy,
  PiSdkOpenAiBrain
} from "../src/openai-brain.js";

test("OpenAI brain policy covers live control-plane decision purposes", () => {
  assert.equal(openAiBrainPolicy.provider, "openai");
  assert.equal(openAiBrainPolicy.adapter, "pi-sdk");
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
      assert.equal(options.model, "openai-codex/gpt-5.5");
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

  assert.match(capturedPrompt, /OpenAI-backed orchestration brain/);
  assert.match(capturedPrompt, /Decision purpose: remote_session_monitoring/);
  assert.match(capturedPrompt, /Remote worker has gone silent/);
  assert.equal(decision.provider, "openai");
  assert.equal(decision.adapter, "pi-sdk");
  assert.equal(decision.text, "Ask the operator for approval before reassigning work.");
  assert.ok(decision.evidence.includes("brain.provider:openai"));
});
