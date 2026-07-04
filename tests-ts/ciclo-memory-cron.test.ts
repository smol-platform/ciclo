import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CicloCronScheduler, type CicloCronJob } from "../src/ciclo-cron.js";
import { parseCicloProjectConfigText } from "../src/ciclo-config.js";
import { CicloEventStore } from "../src/ciclo-events.js";
import { CicloMemoryStore } from "../src/ciclo-memory.js";
import { CicloInternalHeartbeat } from "../src/internal-heartbeat.js";

test("memory store records, ages, compounds, and archives durable memories", () => {
  const root = mkdtempSync(join(tmpdir(), "ciclo-memory-"));
  try {
    let now = "2026-01-01T00:00:00.000Z";
    const events = new CicloEventStore(() => now);
    const store = new CicloMemoryStore({ projectRoot: root, now: () => now, eventSink: events });
    store.record({ content: "Codex handles small TypeScript fixes well.", tags: ["model-fit"], beadId: "ciclo-1" });
    store.record({ content: "Claude should review broad architecture changes.", tags: ["model-fit"], beadId: "ciclo-1" });
    store.record({ content: "Escalate if a worker takes too many turns.", tags: ["model-fit"], beadId: "ciclo-1" });

    now = "2026-02-01T00:00:00.000Z";
    const result = store.compact({ compactAfterDays: 1, archiveAfterDays: 365, minCompoundEntries: 3 });

    assert.equal(result.compounded.length, 1);
    assert.equal(result.compacted.length, 3);
    assert.match(result.compounded[0]?.content ?? "", /Codex handles small TypeScript fixes/u);
    assert.equal(store.list({ state: "active", tag: "model-fit" }).length, 1);
    assert.equal(store.list({ state: "compacted", tag: "model-fit" }).length, 3);
    assert.ok(events.poll(0).events.some((event) => event.type === "memory.recorded"));
    assert.ok(events.poll(0).events.some((event) => event.type === "memory.compacted"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cron scheduler finds due interval and cron jobs once per persisted run window", () => {
  const root = mkdtempSync(join(tmpdir(), "ciclo-cron-"));
  try {
    const scheduler = new CicloCronScheduler({ projectRoot: root });
    const jobs: readonly CicloCronJob[] = [
      { id: "every-minute", enabled: true, schedule: { everyMs: 60_000 }, task: { kind: "memory_compact" } },
      { id: "utc-noon", enabled: true, schedule: { cron: "0 12 * * *" }, task: { kind: "brain_decision" } }
    ];
    const first = scheduler.dueJobs(jobs, "2026-01-01T12:00:00.000Z");
    assert.deepEqual(first.map((entry) => entry.job.id), ["every-minute", "utc-noon"]);
    scheduler.recordRun({ jobId: "utc-noon", startedAt: "2026-01-01T12:00:00.000Z", status: "ran", evidence: ["test"] });
    assert.deepEqual(scheduler.dueJobs(jobs, "2026-01-01T12:00:10.000Z").map((entry) => entry.job.id), ["every-minute"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project config parses cron jobs and memory policy", () => {
  const config = parseCicloProjectConfigText(JSON.stringify({
    cron: {
      jobs: [
        {
          id: "memory-compact",
          schedule: { daily_at: "03:30" },
          task: { kind: "memory_compact" }
        }
      ]
    },
    memory: {
      enabled: true,
      compact_after_days: 7,
      archive_after_days: 30,
      default_importance: "high"
    }
  }));
  assert.equal(config.cron?.jobs?.[0]?.id, "memory-compact");
  assert.equal(config.cron?.jobs?.[0]?.schedule.dailyAt, "03:30");
  assert.equal(config.memory?.compactAfterDays, 7);
  assert.equal(config.memory?.defaultImportance, "high");
});

test("heartbeat runs due memory cron jobs and records run history", async () => {
  const root = mkdtempSync(join(tmpdir(), "ciclo-heartbeat-cron-"));
  try {
    mkdirSync(join(root, ".ciclo"), { recursive: true });
    writeFileSync(join(root, ".ciclo", "config.json"), JSON.stringify({
      cron: {
        jobs: [
          {
            id: "compact-now",
            schedule: { cron: "0 0 * * *" },
            task: { kind: "memory_compact" }
          }
        ]
      },
      memory: { enabled: true, compact_after_days: 1, min_compound_entries: 2 }
    }));
    let now = "2026-01-01T00:00:00.000Z";
    const events = new CicloEventStore(() => now);
    const memory = new CicloMemoryStore({ projectRoot: root, now: () => now, eventSink: events });
    memory.record({ content: "First deployment note", tags: ["deploy"] });
    memory.record({ content: "Second deployment note", tags: ["deploy"] });
    now = "2026-01-03T00:00:00.000Z";
    const scheduler = new CicloCronScheduler({ projectRoot: root });
    const config = parseCicloProjectConfigText(JSON.stringify({
      cron: { jobs: [{ id: "compact-now", schedule: { cron: "0 0 * * *" }, task: { kind: "memory_compact" } }] },
      memory: { enabled: true, compactAfterDays: 1, minCompoundEntries: 2 }
    }));
    const heartbeat = new CicloInternalHeartbeat(
      { projectConfig: config, eventStore: events, cronScheduler: scheduler, memoryStore: memory },
      { now: () => now }
    );

    const result = await heartbeat.tick();
    assert.equal(result.cronDue.length, 1);
    assert.equal(result.cronRuns[0]?.jobId, "compact-now");
    assert.equal(result.memoryCompactions.length, 1);
    assert.ok(events.poll(0).events.some((event) => event.type === "cron.ran"));
    assert.ok(heartbeat.status().cron);
    assert.ok(heartbeat.status().memory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
