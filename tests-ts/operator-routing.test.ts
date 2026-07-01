import assert from "node:assert/strict";
import test from "node:test";

import { OperatorRoutingStore } from "../src/operator-routing.js";

test("operator questions are queued deduplicated and visible while pending", () => {
  const store = new OperatorRoutingStore();
  const first = store.ask({
    loopId: "review-demo",
    beadId: "ciclo-1",
    harnessId: "codex",
    question: "Should I deploy this change?",
    urgency: "blocking",
    principalId: "agent:codex",
    evidence: ["herdr:blocked"],
    now: "2026-06-29T00:00:00.000Z"
  });
  const duplicate = store.ask({
    loopId: "review-demo",
    beadId: "ciclo-1",
    harnessId: "codex",
    question: "  Should I deploy   this change? ",
    urgency: "blocking",
    now: "2026-06-29T00:01:00.000Z"
  });

  assert.equal(first.queued, true);
  assert.equal(duplicate.queued, false);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.questionId, first.questionId);
  assert.equal(store.listQuestions().length, 1);
  assert.equal(store.listQuestions()[0]?.urgency, "blocking");
});

test("operator answers route back to loop bead harness and remote context", () => {
  const store = new OperatorRoutingStore();
  const question = store.ask({
    loopId: "deploy-loop",
    beadId: "ciclo-2",
    harnessId: "claude-code",
    remoteSessionId: "remote-1",
    question: "Can I run deploy?",
    now: "2026-06-29T00:00:00.000Z"
  });
  const answer = store.answer({
    questionId: question.questionId,
    answer: "Run the dry-run deploy gate only.",
    principalId: "operator:ada",
    evidence: ["policy:dry-run"],
    now: "2026-06-29T00:02:00.000Z"
  });
  const duplicate = store.answer({
    questionId: question.questionId,
    answer: "second answer"
  });

  assert.equal(answer.answered, true);
  assert.deepEqual(answer.routedTo, {
    loopId: "deploy-loop",
    beadId: "ciclo-2",
    harnessId: "claude-code",
    remoteSessionId: "remote-1"
  });
  assert.equal(answer.question?.answer?.answeredByPrincipalId, "operator:ada");
  assert.equal(store.listQuestions().length, 0);
  assert.equal(store.listQuestions(true)[0]?.status, "answered");
  assert.equal(duplicate.answered, false);
  assert.match(duplicate.reason, /already answered/);
});

test("operator feedback is queued and repeated reports are deduplicated", () => {
  const store = new OperatorRoutingStore();
  const first = store.reportFeedback({
    loopId: "review-demo",
    beadId: "ciclo-3",
    severity: "warning",
    message: "Validation is flaky",
    evidence: ["just check failed once"],
    now: "2026-06-29T00:00:00.000Z"
  });
  const second = store.reportFeedback({
    loopId: "review-demo",
    beadId: "ciclo-3",
    severity: "warning",
    message: " validation   is flaky ",
    evidence: ["second observation"],
    now: "2026-06-29T00:05:00.000Z"
  });

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.feedbackId, first.feedbackId);
  assert.equal(store.listFeedback()[0]?.duplicateCount, 1);
  assert.ok(store.listFeedback()[0]?.evidence.includes("second observation"));
});
