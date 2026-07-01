import assert from "node:assert/strict";
import test from "node:test";

import {
  BeadsClient,
  BeadsError,
  taskSnapshotFromRecord,
  type BeadsCommandResult,
  type BeadsRunner
} from "../src/beads-adapter.js";

function runnerFor(results: Record<string, BeadsCommandResult>): BeadsRunner {
  return async (_cwd, args) => {
    const result = results[args.join(" ")];
    if (result === undefined) throw new Error(`unexpected command: ${args.join(" ")}`);
    return result;
  };
}

test("Beads snapshot parses labels dependencies spec and external refs", () => {
  const snapshot = taskSnapshotFromRecord({
    id: "ciclo-123",
    title: "Do work",
    status: "open",
    priority: 1,
    issue_type: "task",
    description: "desc",
    acceptance_criteria: "done",
    spec_id: "SPEC-CICLO-001",
    labels: ["mvp", "jira:CICLO-9"],
    dependencies: [{ id: "ciclo-100", title: "Parent", status: "closed", dependency_type: "blocks" }],
    linear_id: "LIN-1"
  });
  assert.equal(snapshot.id, "ciclo-123");
  assert.deepEqual(snapshot.labels, ["mvp", "jira:CICLO-9"]);
  assert.equal(snapshot.dependencies[0]?.id, "ciclo-100");
  assert.deepEqual(snapshot.externalRefs, ["LIN-1", "jira:CICLO-9"]);
});

test("Beads client handles Beads-present ready and show JSON", async () => {
  const readyJson = `Showing 1 of 1 ready issues.\n${JSON.stringify([
    {
      id: "ciclo-1",
      title: "Ready",
      status: "open",
      priority: 1,
      issue_type: "task",
      description: "desc",
      acceptance_criteria: "criteria",
      labels: ["mvp"],
      dependencies: []
    }
  ])}`;
  const showJson = JSON.stringify([
    {
      id: "ciclo-1",
      title: "Ready",
      status: "open",
      priority: 1,
      issue_type: "task",
      description: "desc",
      acceptance_criteria: "criteria",
      labels: ["mvp"],
      dependencies: []
    }
  ]);
  const client = new BeadsClient(
    ".",
    runnerFor({
      "bd ready --json --limit 10": { args: ["bd"], code: 0, stdout: readyJson, stderr: "" },
      "bd show ciclo-1 --json": { args: ["bd"], code: 0, stdout: showJson, stderr: "" }
    })
  );
  const ready = await client.ready(10);
  const shown = await client.show("ciclo-1");
  assert.equal(ready[0]?.id, "ciclo-1");
  assert.equal(shown.acceptanceCriteria, "criteria");
});

test("Beads client closes with reason and re-reads the task", async () => {
  const closedJson = JSON.stringify([
    {
      id: "ciclo-1",
      title: "Ready",
      status: "closed",
      priority: 1,
      issue_type: "task",
      description: "desc",
      acceptance_criteria: "criteria",
      labels: ["mvp"],
      dependencies: []
    }
  ]);
  const client = new BeadsClient(
    ".",
    runnerFor({
      "bd close ciclo-1 --reason Done": { args: ["bd"], code: 0, stdout: "", stderr: "" },
      "bd show ciclo-1 --json": { args: ["bd"], code: 0, stdout: closedJson, stderr: "" }
    })
  );

  const closed = await client.close("ciclo-1", "Done");

  assert.equal(closed.id, "ciclo-1");
  assert.equal(closed.status, "closed");
});

test("Beads client reports absent workspaces before reading work", async () => {
  const client = new BeadsClient("/definitely/not/a/ciclo/workspace");
  await assert.rejects(client.ready(), (error: unknown) => {
    assert.ok(error instanceof BeadsError);
    assert.equal(error.kind, "absent");
    return true;
  });
});
