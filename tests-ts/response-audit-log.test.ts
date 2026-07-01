import assert from "node:assert/strict";
import test from "node:test";

import type { HerdrObservation, LoopConfig } from "../src/ciclo-core.js";
import type { PolicyConfig } from "../src/loop-config.js";
import {
  buildDryRunResponseAuditRecord,
  InMemoryResponseAuditLog,
  planDryRunResponseWithAudit
} from "../src/response-audit-log.js";
import type { RepoProbe } from "../src/repo-probe.js";
import { planDryRunResponse } from "../src/response-planner.js";

const loop: LoopConfig = {
  id: "review-loop",
  kind: "review",
  goal: "Review completed work.",
  harnesses: ["codex"],
  dryRun: true
};

const policy: PolicyConfig = {
  mode: "supervised",
  requireApprovalFor: [],
  allowCommands: ["just check"]
};

const observation: HerdrObservation = {
  source: "herdr",
  target: "pane-1",
  harness: "codex",
  state: "done",
  evidence: ["herdr:done", "Authorization: Bearer abc.def.ghi"]
};

const repo: RepoProbe = {
  root: "/repo",
  isGitRepo: true,
  branch: "main",
  upstream: "origin/main",
  dirtyFiles: ["src/app.ts"],
  stagedFiles: ["tests-ts/app.test.ts"],
  beadsPresent: true,
  configuredChecks: ["just check"],
  errors: []
};

test("dry-run response audit record traces Herdr repo loop and policy sources", () => {
  const input = {
    loop,
    policy,
    repo,
    observation,
    event: { kind: "agent_done" as const, summary: "agent finished", evidence: ["event:done"] }
  };
  const plan = planDryRunResponse(input);
  const audit = buildDryRunResponseAuditRecord(input, plan, {
    actor: "owner:zach",
    now: "2026-06-29T00:00:00.000Z"
  });

  assert.equal(audit.actor, "owner:zach");
  assert.equal(audit.time, "2026-06-29T00:00:00.000Z");
  assert.equal(audit.loopId, "review-loop");
  assert.equal(audit.action, plan.response);
  assert.equal(audit.dryRun, true);
  assert.equal(audit.wouldExecute, false);
  assert.equal(audit.trace.herdrEvent, true);
  assert.equal(audit.trace.repoSnapshot, true);
  assert.equal(audit.trace.loopConfig, true);
  assert.equal(audit.trace.policyDecision, true);
  assert.equal(audit.sources.herdr?.state, "done");
  assert.equal(audit.sources.repo?.summary, "main (upstream origin/main); 1 dirty, 1 staged; beads present");
  assert.equal(audit.sources.loop.goal, "Review completed work.");
  assert.equal(audit.policy.decision, plan.policy.decision);
});

test("dry-run response audit redacts sensitive evidence and produces stable ids", () => {
  const input = {
    loop,
    policy,
    repo,
    observation,
    event: { kind: "agent_done" as const, summary: "agent finished", evidence: ["token=secret-value"] }
  };
  const plan = planDryRunResponse(input);
  const left = buildDryRunResponseAuditRecord(input, plan, { now: "2026-06-29T00:00:00.000Z" });
  const right = buildDryRunResponseAuditRecord(input, plan, { now: "2026-06-29T00:00:01.000Z" });
  const serialized = JSON.stringify(left);

  assert.equal(left.eventId, right.eventId);
  assert.equal(left.responseId, right.responseId);
  assert.doesNotMatch(serialized, /abc\.def\.ghi|secret-value/);
  assert.ok(left.redactions.some((item) => item.startsWith("audit.redaction.")));
  assert.ok(left.evidence.some((item) => item.includes("[redacted")));
});

test("dry-run response audit log appends and finds response records", () => {
  const log = new InMemoryResponseAuditLog();
  const { plan, audit } = planDryRunResponseWithAudit(
    {
      loop,
      policy,
      repo,
      observation,
      event: { kind: "agent_done", summary: "agent finished" }
    },
    log,
    { actor: "owner:zach" }
  );

  assert.equal(log.list().length, 1);
  assert.equal(log.findByResponseId(audit.responseId)?.responseId, audit.responseId);
  assert.equal(audit.action, plan.response);
  assert.equal(audit.decision, "dry_run");
});

test("audit trace explicitly marks missing optional Herdr and repo sources", () => {
  const input = {
    loop,
    policy,
    event: { kind: "agent_idle" as const, summary: "agent idle" },
    promptSendConfigured: true
  };
  const plan = planDryRunResponse(input);
  const audit = buildDryRunResponseAuditRecord(input, plan);

  assert.equal(audit.trace.herdrEvent, false);
  assert.equal(audit.trace.repoSnapshot, false);
  assert.equal(audit.trace.loopConfig, true);
  assert.equal(audit.trace.policyDecision, true);
});
