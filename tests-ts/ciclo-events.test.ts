import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { cicloEventLogPath, CicloEventStore } from "../src/ciclo-events.js";
import { createLocalMcpRuntimeContextWithPlugins } from "../src/mcp-stdio.js";

test("Ciclo event store persists and reloads project events", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-event-store-"));
  try {
    const path = cicloEventLogPath(tempDir);
    const first = new CicloEventStore({ persistPath: path, now: () => "2026-07-04T15:00:00.000Z" });
    first.append({
      type: "cli.command",
      evidence: ["cli.command:launch"],
      data: { command: "launch", phase: "planned" }
    });

    const second = new CicloEventStore({ persistPath: path });
    const poll = second.poll(0);
    assert.equal(poll.nextCursor, 1);
    assert.equal(poll.events[0]?.type, "cli.command");
    assert.equal(poll.events[0]?.at, "2026-07-04T15:00:00.000Z");
    assert.deepEqual(poll.events[0]?.data, { command: "launch", phase: "planned" });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Ciclo event store skips malformed persisted event lines", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-event-store-malformed-"));
  try {
    const path = cicloEventLogPath(tempDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      "{not-json}",
      JSON.stringify({
        cursor: 7,
        type: "brain.decision",
        at: "2026-07-04T15:01:00.000Z",
        evidence: ["brain:fixture"]
      })
    ].join("\n"));

    const store = new CicloEventStore({ persistPath: path });
    const poll = store.poll(0);
    assert.equal(poll.nextCursor, 7);
    assert.equal(poll.events.length, 1);
    assert.equal(poll.events[0]?.type, "brain.decision");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("local MCP runtime writes runtime events to the project event log", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-event-runtime-"));
  try {
    const runtime = await createLocalMcpRuntimeContextWithPlugins(tempDir);
    runtime.eventStore?.append({
      type: "brain.decision",
      evidence: ["brain:fixture"],
      data: { purpose: "monitoring", provider: "openai" }
    });

    const persisted = readFileSync(cicloEventLogPath(tempDir), "utf8");
    assert.match(persisted, /"type":"brain.decision"/);
    assert.match(persisted, /"provider":"openai"/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
