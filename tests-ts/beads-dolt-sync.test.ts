import assert from "node:assert/strict";
import test from "node:test";

import { BeadsClient, type BeadsCommandResult, type BeadsRunner } from "../src/beads-adapter.js";
import { DoltRemoteSyncCoordinator, BeadsDoltSyncError } from "../src/beads-dolt-sync.js";
import type { DoltRemoteSyncConfig } from "../src/beads-remote.js";

const config: DoltRemoteSyncConfig = {
  remote: "origin",
  pullBeforeSelect: true,
  pushAfterClaim: true,
  pushAfterUpdate: true,
  failClosedOnSyncError: true
};

function jsonTask(id: string, status: string): string {
  return JSON.stringify([
    {
      id,
      title: "Task",
      status,
      priority: 1,
      issue_type: "task",
      description: "desc",
      acceptance_criteria: "criteria",
      labels: [],
      dependencies: []
    }
  ]);
}

function runner(handler: (args: readonly string[]) => BeadsCommandResult): {
  readonly calls: readonly string[];
  readonly runner: BeadsRunner;
} {
  const calls: string[] = [];
  return {
    calls,
    runner: async (_cwd, args) => {
      calls.push(args.join(" "));
      return handler(args);
    }
  };
}

test("Dolt sync pulls before selecting ready work", async () => {
  const fixture = runner((args) => {
    const command = args.join(" ");
    if (command === "bd dolt pull origin") return { args, code: 0, stdout: "", stderr: "" };
    if (command === "bd ready --json --limit 5") {
      return { args, code: 0, stdout: jsonTask("ciclo-1", "open"), stderr: "" };
    }
    throw new Error(command);
  });
  const coordinator = new DoltRemoteSyncCoordinator(new BeadsClient(".", fixture.runner), config);
  const ready = await coordinator.ready(5);
  assert.equal(ready[0]?.id, "ciclo-1");
  assert.deepEqual(fixture.calls, ["bd dolt pull origin", "bd ready --json --limit 5"]);
  assert.ok(fixture.calls.every((call) => !call.includes("issues.jsonl")));
});

test("Dolt sync rechecks before claim and pushes after claim", async () => {
  let showCount = 0;
  const fixture = runner((args) => {
    const command = args.join(" ");
    if (command === "bd show ciclo-1 --json") {
      showCount += 1;
      return { args, code: 0, stdout: jsonTask("ciclo-1", showCount === 1 ? "open" : "in_progress"), stderr: "" };
    }
    if (command === "bd update ciclo-1 --claim") return { args, code: 0, stdout: "claimed", stderr: "" };
    if (command === "bd dolt push origin") return { args, code: 0, stdout: "", stderr: "" };
    throw new Error(command);
  });
  const coordinator = new DoltRemoteSyncCoordinator(new BeadsClient(".", fixture.runner), config);
  const result = await coordinator.claimAfterRecheck("ciclo-1");
  assert.equal(result.before.status, "open");
  assert.equal(result.after.status, "in_progress");
  assert.equal(result.pushed, true);
  assert.deepEqual(fixture.calls, [
    "bd show ciclo-1 --json",
    "bd update ciclo-1 --claim",
    "bd show ciclo-1 --json",
    "bd dolt push origin"
  ]);
});

test("Dolt sync avoids already claimed work", async () => {
  const fixture = runner((args) => ({ args, code: 0, stdout: jsonTask("ciclo-1", "in_progress"), stderr: "" }));
  const coordinator = new DoltRemoteSyncCoordinator(new BeadsClient(".", fixture.runner), config);
  await assert.rejects(coordinator.claimAfterRecheck("ciclo-1"), (error: unknown) => {
    assert.ok(error instanceof BeadsDoltSyncError);
    assert.equal(error.operation, "claim");
    assert.match(error.message, /status is in_progress/);
    return true;
  });
  assert.deepEqual(fixture.calls, ["bd show ciclo-1 --json"]);
});

test("Dolt sync reports pull and push errors as fail-closed sync errors", async () => {
  const pullFixture = runner((args) => ({ args, code: 1, stdout: "", stderr: "pull failed" }));
  const pullCoordinator = new DoltRemoteSyncCoordinator(new BeadsClient(".", pullFixture.runner), config);
  await assert.rejects(pullCoordinator.ready(), (error: unknown) => {
    assert.ok(error instanceof BeadsDoltSyncError);
    assert.equal(error.operation, "pull");
    assert.equal(error.failClosed, true);
    return true;
  });

  const pushFixture = runner((args) => ({ args, code: 1, stdout: "", stderr: "push failed" }));
  const pushCoordinator = new DoltRemoteSyncCoordinator(new BeadsClient(".", pushFixture.runner), config);
  await assert.rejects(pushCoordinator.pushAfterUpdate(), (error: unknown) => {
    assert.ok(error instanceof BeadsDoltSyncError);
    assert.equal(error.operation, "push");
    assert.equal(error.failClosed, true);
    return true;
  });
});
