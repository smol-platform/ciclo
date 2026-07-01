import assert from "node:assert/strict";
import test from "node:test";

import { BeadsClient, type BeadsCommandResult, type BeadsRunner } from "../src/beads-adapter.js";
import {
  SharedDoltServerCoordinator,
  SharedDoltServerError,
  type SharedServerProbe
} from "../src/beads-shared-server.js";
import type { SharedDoltServerConfig } from "../src/beads-remote.js";

const config: SharedDoltServerConfig = {
  host: "127.0.0.1",
  port: 3308,
  database: "ciclo",
  user: "root"
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

const healthyProbe: SharedServerProbe = async () => ({
  health: "healthy",
  databaseIdentity: "127.0.0.1:3308/ciclo",
  evidence: ["beads.shared.health:healthy"]
});

test("shared server coordinator checks health and lists ready work", async () => {
  const fixture = runner((args) => {
    if (args.join(" ") === "bd ready --json --limit 2") {
      return { args, code: 0, stdout: jsonTask("ciclo-1", "open"), stderr: "" };
    }
    throw new Error(args.join(" "));
  });
  const coordinator = new SharedDoltServerCoordinator(
    new BeadsClient(".", fixture.runner),
    config,
    healthyProbe
  );
  const ready = await coordinator.ready(2);
  assert.equal(ready[0]?.id, "ciclo-1");
  assert.deepEqual(fixture.calls, ["bd ready --json --limit 2"]);
});

test("shared server coordinator re-reads before claim and claims through Beads", async () => {
  let showCount = 0;
  const fixture = runner((args) => {
    const command = args.join(" ");
    if (command === "bd show ciclo-1 --json") {
      showCount += 1;
      return { args, code: 0, stdout: jsonTask("ciclo-1", showCount === 1 ? "open" : "in_progress"), stderr: "" };
    }
    if (command === "bd update ciclo-1 --claim") return { args, code: 0, stdout: "claimed", stderr: "" };
    throw new Error(command);
  });
  const coordinator = new SharedDoltServerCoordinator(
    new BeadsClient(".", fixture.runner),
    config,
    healthyProbe
  );
  const result = await coordinator.claimAfterRecheck("ciclo-1");
  assert.equal(result.before.status, "open");
  assert.equal(result.after.status, "in_progress");
  assert.ok(result.evidence.includes("beads.shared.claimed:ciclo-1"));
});

test("shared server coordinator records progress through Beads", async () => {
  const fixture = runner((args) => {
    assert.equal(args.join(" "), "bd note ciclo-1 progress recorded");
    return { args, code: 0, stdout: "", stderr: "" };
  });
  const coordinator = new SharedDoltServerCoordinator(
    new BeadsClient(".", fixture.runner),
    config,
    healthyProbe
  );
  await coordinator.recordProgress("ciclo-1", "progress recorded");
  assert.deepEqual(fixture.calls, ["bd note ciclo-1 progress recorded"]);
});

test("shared server coordinator fails closed when required server is unavailable", async () => {
  const unavailableProbe: SharedServerProbe = async () => ({
    health: "unavailable",
    databaseIdentity: "127.0.0.1:3308/ciclo",
    evidence: ["beads.shared.health:unavailable"]
  });
  const coordinator = new SharedDoltServerCoordinator(
    new BeadsClient(".", async () => {
      throw new Error("must not run bd");
    }),
    config,
    unavailableProbe
  );
  await assert.rejects(coordinator.ready(), (error: unknown) => {
    assert.ok(error instanceof SharedDoltServerError);
    assert.equal(error.operation, "health");
    assert.equal(error.failClosed, true);
    return true;
  });
});
