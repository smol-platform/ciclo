import assert from "node:assert/strict";
import test from "node:test";

import type { BeadsRunner, BeadsTaskSnapshot } from "../src/beads-adapter.js";
import {
  BeadsRemoteTrackerSync,
  InMemoryBeadsTrackerSyncStateStore,
  detectBeadsJiraSyncTarget,
  detectBeadsLinearSyncTarget,
  type BeadsRemoteTrackerTarget
} from "../src/beads-tracker-sync.js";

const targets: readonly BeadsRemoteTrackerTarget[] = [
  {
    id: "linear-team",
    kind: "linear",
    required: true,
    syncArgs: ["trackers", "sync", "--target", "linear-team"],
    statusArgs: ["trackers", "status", "--target", "linear-team"]
  },
  {
    id: "jira-project",
    kind: "jira",
    required: false,
    syncArgs: ["trackers", "sync", "--target", "jira-project"]
  }
];

function task(input: Pick<BeadsTaskSnapshot, "id" | "externalRefs">): BeadsTaskSnapshot {
  return {
    id: input.id,
    title: input.id,
    status: "open",
    priority: 1,
    issueType: "task",
    description: "",
    acceptanceCriteria: "",
    labels: [],
    dependencies: [],
    externalRefs: input.externalRefs
  };
}

function runnerFrom(handler: BeadsRunner): BeadsRunner {
  return handler;
}

test("dry-run uses Beads status where configured and redacts sensitive output", async () => {
  const calls: readonly string[][] = [];
  const mutableCalls: string[][] = calls as string[][];
  const sync = new BeadsRemoteTrackerSync(
    { root: process.cwd(), targets: [targets[0]!] },
    runnerFrom(async (_cwd, args) => {
      mutableCalls.push([...args]);
      return {
        args,
        code: 0,
        stdout: JSON.stringify({ cursor: "cursor-1", note: "token=secret-value" }),
        stderr: "remote host prod.example.com"
      };
    })
  );

  const result = await sync.trigger({
    dryRun: true,
    beadId: "ciclo-1",
    loopId: "review-demo",
    idempotencyKey: "dry-run-1"
  });

  assert.equal(result.synced, false);
  assert.equal(result.required_failed, false);
  assert.deepEqual(calls[0], ["bd", "trackers", "status", "--target", "linear-team"]);
  assert.equal(result.targets[0]?.operation, "status");
  assert.equal(result.targets[0]?.cursor, "cursor-1");
  assert.ok(result.targets[0]?.redactions.some((item) => item.kind === "secret"));
  assert.ok(result.targets[0]?.redactions.some((item) => item.kind === "remote_host"));
  assert.doesNotMatch(JSON.stringify(result), /secret-value|prod\.example\.com/);
});

test("sync stores cursor and deduplicates completed idempotency keys", async () => {
  let calls = 0;
  const state = new InMemoryBeadsTrackerSyncStateStore();
  const sync = new BeadsRemoteTrackerSync(
    { root: process.cwd(), targets: [targets[0]!] },
    runnerFrom(async (_cwd, args) => {
      calls += 1;
      return {
        args,
        code: 0,
        stdout: JSON.stringify({ cursor: `cursor-${calls}` }),
        stderr: ""
      };
    }),
    state
  );

  const first = await sync.trigger({ dryRun: false, idempotencyKey: "sync-1" });
  const second = await sync.trigger({ dryRun: false, idempotencyKey: "sync-1" });

  assert.equal(first.synced, true);
  assert.equal(second.targets[0]?.skipped, true);
  assert.equal(second.targets[0]?.cursor, "cursor-1");
  assert.equal(calls, 1);
  assert.equal(state.get("linear-team")?.lastCursor, "cursor-1");
});

test("required target failures fail the batch while optional failures do not", async () => {
  const requiredFails = new BeadsRemoteTrackerSync(
    { root: process.cwd(), targets },
    runnerFrom(async (_cwd, args) => ({
      args,
      code: args.includes("linear-team") ? 1 : 0,
      stdout: args.includes("linear-team") ? "" : JSON.stringify({ cursor: "jira-1" }),
      stderr: args.includes("linear-team") ? "linear unavailable" : ""
    }))
  );
  const requiredResult = await requiredFails.trigger({ dryRun: false, idempotencyKey: "required-fails" });

  assert.equal(requiredResult.synced, false);
  assert.equal(requiredResult.required_failed, true);
  assert.equal(requiredResult.targets.find((target) => target.targetId === "linear-team")?.retryCount, 1);

  const optionalFails = new BeadsRemoteTrackerSync(
    { root: process.cwd(), targets },
    runnerFrom(async (_cwd, args) => ({
      args,
      code: args.includes("jira-project") ? 1 : 0,
      stdout: args.includes("linear-team") ? JSON.stringify({ cursor: "linear-1" }) : "",
      stderr: args.includes("jira-project") ? "jira unavailable" : ""
    }))
  );
  const optionalResult = await optionalFails.trigger({ dryRun: false, idempotencyKey: "optional-fails" });

  assert.equal(optionalResult.synced, true);
  assert.equal(optionalResult.required_failed, false);
  assert.equal(optionalResult.targets.find((target) => target.targetId === "jira-project")?.retryCount, 1);
});

test("retry state increments on failure and resets after success", async () => {
  let fail = true;
  const state = new InMemoryBeadsTrackerSyncStateStore();
  const sync = new BeadsRemoteTrackerSync(
    { root: process.cwd(), targets: [targets[0]!] },
    runnerFrom(async (_cwd, args) => ({
      args,
      code: fail ? 1 : 0,
      stdout: fail ? "" : JSON.stringify({ cursor: "recovered" }),
      stderr: fail ? "temporary outage" : ""
    })),
    state
  );

  const failed = await sync.trigger({ dryRun: false, idempotencyKey: "retry-1" });
  fail = false;
  const recovered = await sync.trigger({ dryRun: false, idempotencyKey: "retry-2" });

  assert.equal(failed.targets[0]?.retryCount, 1);
  assert.equal(state.get("linear-team")?.retryCount, 0);
  assert.equal(recovered.targets[0]?.retryCount, 0);
  assert.equal(recovered.targets[0]?.cursor, "recovered");
});

test("detects configured Beads-native Jira sync target from Beads config and refs", async () => {
  const calls: string[][] = [];
  const detection = await detectBeadsJiraSyncTarget({
    root: process.cwd(),
    tasks: [
      task({ id: "ciclo-1", externalRefs: ["jira:CICLO-9", "linear:CIC-1"] }),
      task({ id: "ciclo-2", externalRefs: ["https://example.atlassian.net/browse/CICLO-10"] })
    ],
    runner: async (_cwd, args) => {
      calls.push([...args]);
      const key = args.at(-1);
      return {
        args,
        code: 0,
        stdout: key === "jira.url" ? "https://example.atlassian.net\n" : "CICLO\n",
        stderr: ""
      };
    }
  });

  assert.equal(detection.configured, true);
  assert.equal(detection.target?.kind, "jira");
  assert.equal(detection.target?.id, "jira:CICLO");
  assert.deepEqual(detection.target?.syncArgs, ["trackers", "sync", "--target", "jira"]);
  assert.deepEqual(detection.refs, ["https://example.atlassian.net/browse/CICLO-10", "jira:CICLO-9"]);
  assert.deepEqual(calls, [
    ["bd", "config", "get", "jira.url"],
    ["bd", "config", "get", "jira.project"]
  ]);
});

test("Jira refs without Beads config are detected but do not enable sync target", async () => {
  const detection = await detectBeadsJiraSyncTarget({
    root: process.cwd(),
    tasks: [task({ id: "ciclo-1", externalRefs: ["jira:CICLO-9"] })],
    runner: async (_cwd, args) => ({ args, code: 1, stdout: "", stderr: "missing config" })
  });

  assert.equal(detection.configured, false);
  assert.equal(detection.target, undefined);
  assert.deepEqual(detection.refs, ["jira:CICLO-9"]);
  assert.ok(detection.evidence.includes("beads.tracker.jira.configured:false"));
});

test("detected Jira target runs through Beads-native tracker sync", async () => {
  const detection = await detectBeadsJiraSyncTarget({
    root: process.cwd(),
    required: true,
    runner: async (_cwd, args) => ({
      args,
      code: 0,
      stdout: args.at(-1) === "jira.url" ? "https://example.atlassian.net\n" : "CICLO\n",
      stderr: ""
    })
  });
  assert.ok(detection.target);
  const sync = new BeadsRemoteTrackerSync(
    { root: process.cwd(), targets: [detection.target] },
    runnerFrom(async (_cwd, args) => ({
      args,
      code: 0,
      stdout: JSON.stringify({ cursor: "jira-cursor-1" }),
      stderr: ""
    }))
  );

  const result = await sync.trigger({ dryRun: false, idempotencyKey: "jira-sync-1" });

  assert.equal(result.synced, true);
  assert.equal(result.required_failed, false);
  assert.equal(result.targets[0]?.kind, "jira");
  assert.equal(result.targets[0]?.cursor, "jira-cursor-1");
  assert.ok(result.evidence.includes("beads.tracker_sync.target:jira:CICLO"));
});

test("detects configured Beads-native Linear sync target from Beads config and refs", async () => {
  const calls: string[][] = [];
  const detection = await detectBeadsLinearSyncTarget({
    root: process.cwd(),
    tasks: [
      task({ id: "ciclo-1", externalRefs: ["linear:CIC-123", "jira:CICLO-9"] }),
      task({ id: "ciclo-2", externalRefs: ["https://linear.app/acme/issue/CIC-124/fix-sync"] })
    ],
    runner: async (_cwd, args) => {
      calls.push([...args]);
      return {
        args,
        code: 0,
        stdout: "team-123\n",
        stderr: ""
      };
    }
  });

  assert.equal(detection.configured, true);
  assert.equal(detection.target?.kind, "linear");
  assert.equal(detection.target?.id, "linear:team-123");
  assert.deepEqual(detection.target?.syncArgs, ["trackers", "sync", "--target", "linear"]);
  assert.deepEqual(detection.refs, ["https://linear.app/acme/issue/CIC-124/fix-sync", "linear:CIC-123"]);
  assert.deepEqual(calls, [["bd", "config", "get", "linear.team_id"]]);
});

test("Linear refs without Beads config are detected but do not enable sync target", async () => {
  const detection = await detectBeadsLinearSyncTarget({
    root: process.cwd(),
    tasks: [task({ id: "ciclo-1", externalRefs: ["linear:CIC-123"] })],
    runner: async (_cwd, args) => ({ args, code: 1, stdout: "", stderr: "missing config" })
  });

  assert.equal(detection.configured, false);
  assert.equal(detection.target, undefined);
  assert.deepEqual(detection.refs, ["linear:CIC-123"]);
  assert.ok(detection.evidence.includes("beads.tracker.linear.configured:false"));
});

test("detected Linear target runs through Beads-native tracker sync", async () => {
  const detection = await detectBeadsLinearSyncTarget({
    root: process.cwd(),
    required: true,
    runner: async (_cwd, args) => ({
      args,
      code: 0,
      stdout: "team-123\n",
      stderr: ""
    })
  });
  assert.ok(detection.target);
  const sync = new BeadsRemoteTrackerSync(
    { root: process.cwd(), targets: [detection.target] },
    runnerFrom(async (_cwd, args) => ({
      args,
      code: 0,
      stdout: JSON.stringify({ cursor: "linear-cursor-1" }),
      stderr: ""
    }))
  );

  const result = await sync.trigger({ dryRun: false, idempotencyKey: "linear-sync-1" });

  assert.equal(result.synced, true);
  assert.equal(result.required_failed, false);
  assert.equal(result.targets[0]?.kind, "linear");
  assert.equal(result.targets[0]?.cursor, "linear-cursor-1");
  assert.ok(result.evidence.includes("beads.tracker_sync.target:linear:team-123"));
});
