import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadBenchmarkScenarioText } from "../src/benchmark-scenario.js";
import type { BenchmarkCandidateResponse } from "../src/benchmark-safety-checks.js";
import {
  BenchmarkModelRegistry,
  FakeLocalJudge,
  FixtureDriver,
  PiSdkJudge,
  judgeFromConfig
} from "../src/benchmark-models.js";

const scenario = loadBenchmarkScenarioText(
  readFileSync("tests/fixtures/benchmarks/codex_done_dirty_repo_review.json", "utf8")
);

const goodCandidate: BenchmarkCandidateResponse = {
  responseKind: "build_context_pack",
  text: "summarize_changed_files and preserve_validation_expectations before review.",
  evidence: ["herdr.state:done", "repo.dirty_files"],
  actions: [
    { kind: "summarize_changed_files" },
    { kind: "preserve_validation_expectations" }
  ]
};

test("fake local judge scores safe expected benchmark candidate without credentials", async () => {
  const judge = new FakeLocalJudge("deterministic-safety", ["safety", "correctness", "explainability"]);
  const result = await judge.judge({ scenario, candidate: goodCandidate });

  assert.equal(result.judgeId, "deterministic-safety");
  assert.equal(result.kind, "deterministic");
  assert.equal(result.model, "fake-local");
  assert.equal(result.failures.length, 0);
  assert.equal(result.dimensions.safety, 1);
  assert.equal(result.dimensions.correctness, 1);
  assert.equal(result.score, 1);
});

test("fake local judge surfaces deterministic safety failures before model scoring", async () => {
  const judge = new FakeLocalJudge();
  const result = await judge.judge({
    scenario: {
      ...scenario,
      herdrEvents: [{ ...scenario.herdrEvents[0]!, state: "working" }]
    },
    candidate: {
      responseKind: "nudge_agent",
      text: "send another prompt",
      evidence: [],
      actions: [{ kind: "send_prompt" }]
    }
  });

  assert.equal(result.dimensions.safety, 0);
  assert.ok(result.failures.includes("send_while_working"));
  assert.ok(result.score < 1);
});

test("benchmark model registry resolves configured drivers and judges", async () => {
  const registry = new BenchmarkModelRegistry();
  const driver = new FixtureDriver("fixture-agent", "agent_driver", goodCandidate);
  const judge = judgeFromConfig({
    id: "deterministic-safety",
    kind: "deterministic",
    dimensions: ["safety", "correctness"]
  });
  registry.registerDriver(driver);
  registry.registerJudge(judge);

  const driven = await registry.driver("fixture-agent")?.drive({ scenario });
  const judged = await registry.judge("deterministic-safety")?.judge({
    scenario,
    candidate: driven!.candidate
  });

  assert.equal(driven?.candidate.responseKind, "build_context_pack");
  assert.equal(judged?.kind, "deterministic");
  assert.equal(judged?.model, "fake-local");
});

test("external judge config is accepted but requires provider adapter", async () => {
  const judge = judgeFromConfig({
    id: "hosted-judge",
    kind: "model",
    model: "provider/model-name",
    dimensions: ["safety"]
  });

  await assert.rejects(
    () => judge.judge({ scenario, candidate: goodCandidate }),
    /no provider adapter is installed/
  );
});

test("Pi SDK judge invokes Pi with codex model defaults and normalizes JSON output", async () => {
  const judge = new PiSdkJudge({
    id: "pi-smoke",
    dimensions: ["safety", "correctness"],
    completePrompt: async (prompt, options) => {
      assert.equal(options.model, "openai-codex/gpt-5.5");
      assert.equal(options.thinking, "high");
      assert.match(prompt, /codex_done_dirty_repo_review/);
      return JSON.stringify({
          score: 0.9,
          dimensions: { safety: 1, correctness: 0.8 },
          failures: ["needs_more_specificity"],
          evidence: ["expected actions mostly matched"]
        });
    }
  });

  const result = await judge.judge({ scenario, candidate: goodCandidate });

  assert.equal(result.judgeId, "pi-smoke");
  assert.equal(result.kind, "model");
  assert.equal(result.model, "openai-codex/gpt-5.5");
  assert.equal(result.score, 0.9);
  assert.equal(result.dimensions.safety, 1);
  assert.equal(result.dimensions.correctness, 0.8);
  assert.deepEqual(result.failures, ["needs_more_specificity"]);
  assert.ok(result.evidence.includes("benchmark.judge.provider:pi-sdk"));
});

test("Pi SDK judge prompt includes harness control directives", async () => {
  const harnessScenario = loadBenchmarkScenarioText(
    readFileSync("tests/fixtures/benchmarks/codex_goal_answer_reasonable_question.json", "utf8")
  );
  const judge = new PiSdkJudge({
    id: "pi-harness-control",
    dimensions: ["safety", "correctness"],
    completePrompt: async (prompt) => {
      assert.match(prompt, /harnessControl/);
      assert.ok(prompt.includes('"controlDirective":"/goal"'));
      assert.match(prompt, /"route":"answer_directly"/);
      assert.match(prompt, /Run npm run check/);
      return JSON.stringify({
        score: 1,
        dimensions: { safety: 1, correctness: 1 },
        failures: [],
        evidence: ["harness control scored"]
      });
    }
  });

  const result = await judge.judge({
    scenario: harnessScenario,
    candidate: {
      responseKind: "answer_question",
      text: "Run npm run check, then report validation evidence.",
      evidence: ["harness.control.codex:/goal", "harness.question.route:answer_directly"],
      actions: [{ kind: "answer_reasonable_harness_question" }]
    }
  });

  assert.equal(result.score, 1);
  assert.ok(result.evidence.includes("harness control scored"));
});
