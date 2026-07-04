import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import { cicloEventLogPath } from "../src/ciclo-events.js";
import { main, parseHerdrPaneList, type CliIo } from "../src/cli.js";

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  };
}

function herdrAvailable(): boolean {
  return spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0;
}

function herdrJson(sessionName: string, args: readonly string[]): unknown {
  const result = spawnSync("herdr", ["--session", sessionName, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function herdrText(sessionName: string, args: readonly string[]): string {
  const result = spawnSync("herdr", ["--session", sessionName, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function waitFor(predicate: () => boolean, label: string, attempts = 30): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function waitForHerdrServer(sessionName: string): Promise<void> {
  await waitFor(() => {
    const result = spawnSync("herdr", ["--session", sessionName, "status", "server"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return result.status === 0 && !`${result.stdout}\n${result.stderr}`.includes("status: not running");
  }, "Herdr server");
}

function panes(sessionName: string) {
  return parseHerdrPaneList(herdrText(sessionName, ["pane", "list"]));
}

const runRealHerdr = process.env.CICLO_HERDR_INTEGRATION === "1";

test("ciclo launch reuses a real Herdr bootstrap pane", {
  skip: runRealHerdr ? false : "set CICLO_HERDR_INTEGRATION=1 to run real Herdr integration"
}, async () => {
  assert.equal(herdrAvailable(), true, "herdr must be installed for real integration");

  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-real-herdr-launch-"));
  const sessionName = `ciclo-it-${process.pid}-${Date.now()}`;
  const marker = join(tempDir, "harness-ran.txt");
  const harness = join(tempDir, "harness.sh");
  writeFileSync(harness, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" > ${JSON.stringify(marker)}`,
    "sleep 2",
    ""
  ].join("\n"));
  chmodSync(harness, 0o700);

  const before = {
    CICLO_REUSE_HERDR_SESSION: process.env.CICLO_REUSE_HERDR_SESSION,
    HERDR_SESSION_NAME: process.env.HERDR_SESSION_NAME,
    CICLO_HERDR_SESSION: process.env.CICLO_HERDR_SESSION,
    HERDR_SESSION: process.env.HERDR_SESSION
  };
  const server = spawn("herdr", ["--session", sessionName, "server"], {
    detached: true,
    stdio: "ignore"
  });
  server.unref();

  try {
    process.env.CICLO_REUSE_HERDR_SESSION = "false";
    delete process.env.HERDR_SESSION_NAME;
    delete process.env.CICLO_HERDR_SESSION;
    delete process.env.HERDR_SESSION;

    await waitForHerdrServer(sessionName);
    herdrJson(sessionName, [
      "agent",
      "start",
      "bootstrap-shell",
      "--cwd",
      tempDir,
      "--focus",
      "--",
      "/bin/sh",
      "-lc",
      "printf 'bootstrap-ready\\n'; exec /bin/sh"
    ]);
    await waitFor(() => panes(sessionName).length === 1, "initial Herdr pane");

    const beforePanes = panes(sessionName);
    assert.equal(beforePanes.length, 1);
    const firstPaneId = beforePanes[0]?.paneId;
    assert.ok(firstPaneId);

    const launch = captureIo();
    assert.equal(await main([
      "node",
      "ciclo",
      "launch",
      "codex",
      "--project",
      tempDir,
      "--session",
      sessionName,
      "--pane-name",
      "repo-under-test",
      "--harness-command",
      harness,
      "--no-attach",
      "--prompt",
      "real herdr integration"
    ], launch.io), 0, launch.stderr.join("\n"));

    await waitFor(() => existsSync(marker), "harness marker");
    const afterPanes = panes(sessionName);
    assert.equal(afterPanes.length, 1);
    assert.equal(afterPanes[0]?.paneId, firstPaneId);
    assert.equal(afterPanes[0]?.label, "repo-under-test");
    assert.match(readFileSync(marker, "utf8"), /real herdr integration/u);

    const events = readFileSync(cicloEventLogPath(tempDir), "utf8");
    assert.match(events, /"herdr_pane_reused":true/u);
    assert.match(events, new RegExp(`"herdr_pane":"${firstPaneId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "u"));
  } finally {
    spawnSync("herdr", ["session", "stop", sessionName, "--json"], { stdio: "ignore" });
    rmSync(tempDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
