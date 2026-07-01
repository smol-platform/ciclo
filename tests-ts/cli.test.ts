import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  main,
  parseAttachOptions,
  parseBenchmarkOptions,
  parseBenchmarkScenarioDir,
  parseMcpHttpOptions,
  type CliIo
} from "../src/cli.js";

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

test("CLI prints top-level help and version", async () => {
  const help = captureIo();
  assert.equal(await main(["node", "ciclo", "--help"], help.io), 0);
  assert.match(help.stdout.join("\n"), /Usage: ciclo <command>/);
  assert.match(help.stdout.join("\n"), /attach/);
  assert.match(help.stdout.join("\n"), /mcp http/);

  const version = captureIo();
  assert.equal(await main(["node", "ciclo", "--version"], version.io), 0);
  assert.equal(version.stdout[0], "0.1.0");
});

test("CLI status and runtime commands emit machine-readable JSON", async () => {
  const status = captureIo();
  assert.equal(await main(["node", "ciclo", "status", "--compact"], status.io), 0);
  const statusPayload = JSON.parse(status.stdout[0] ?? "{}") as Record<string, unknown>;
  assert.equal(statusPayload.runtime, "Standalone TypeScript Ciclo orchestrator agent");

  const runtime = captureIo();
  assert.equal(await main(["node", "ciclo", "runtime", "--compact"], runtime.io), 0);
  const runtimePayload = JSON.parse(runtime.stdout[0] ?? "{}") as Record<string, unknown>;
  assert.equal(runtimePayload.runtime, "Standalone TypeScript Ciclo orchestrator agent");
});

test("CLI rejects unknown commands and unexpected status arguments", async () => {
  const unknown = captureIo();
  assert.equal(await main(["node", "ciclo", "wat"], unknown.io), 2);
  assert.match(unknown.stderr.join("\n"), /unknown ciclo command: wat/);

  const badStatus = captureIo();
  assert.equal(await main(["node", "ciclo", "status", "extra"], badStatus.io), 2);
  assert.match(badStatus.stderr.join("\n"), /unexpected status argument: extra/);
});

test("CLI parses benchmark scenario directory forms", () => {
  assert.equal(parseBenchmarkScenarioDir(["tests/fixtures/benchmarks"]), "tests/fixtures/benchmarks");
  assert.equal(parseBenchmarkScenarioDir(["--scenario-dir", "fixtures", "--compact"]), "fixtures");
  assert.throws(() => parseBenchmarkScenarioDir(["one", "two"]), /unexpected benchmark argument: two/);
  assert.throws(() => parseBenchmarkScenarioDir(["--scenario-dir"]), /--scenario-dir requires a value/);
});

test("CLI parses real benchmark judge options", () => {
  const options = parseBenchmarkOptions([
    "--scenario-dir",
    "fixtures",
    "--real",
    "--model",
    "openai-codex/gpt-5.5",
    "--thinking",
    "high",
    "--limit",
    "3",
    "--threshold",
    "0.75"
  ]);

  assert.deepEqual(options.runner, {
    scenarioDir: "fixtures",
    judgeProvider: "pi",
    model: "openai-codex/gpt-5.5",
    thinking: "high",
    scenarioLimit: 3,
    scoreThreshold: 0.75
  });
  assert.throws(() => parseBenchmarkOptions(["--judge", "wat"]), /--judge must be scenario or pi/);
  assert.throws(() => parseBenchmarkOptions(["--threshold", "2"]), /--threshold must be a number/);
});

test("CLI parses MCP HTTP flags with environment fallback", () => {
  const options = parseMcpHttpOptions(
    ["--host", "127.0.0.1", "--port", "7331", "--path", "/mcp-test", "--max-body-bytes", "4096"],
    {}
  );
  assert.deepEqual(options, {
    host: "127.0.0.1",
    port: 7331,
    path: "/mcp-test",
    maxBodyBytes: 4096
  });

  assert.deepEqual(parseMcpHttpOptions([], { CICLO_MCP_HTTP_HOST: "localhost", CICLO_MCP_HTTP_PORT: "7444" }), {
    host: "localhost",
    port: 7444,
    path: undefined,
    maxBodyBytes: undefined
  });
  assert.throws(() => parseMcpHttpOptions(["--port", "99999"], {}), /--port must be an integer/);
  assert.throws(() => parseMcpHttpOptions(["--path", "mcp"], {}), /--path must start with \//);
});

test("CLI parses and prints Ciclo Herdr attach plans", async () => {
  assert.deepEqual(parseAttachOptions([
    "--remote",
    "ciclo@10.44.0.2:/workspace/ciclo",
    "--session",
    "ciclo",
    "--target",
    "pane-1",
    "--dry-run"
  ]), {
    remoteTarget: "ciclo@10.44.0.2:/workspace/ciclo",
    herdrSession: "ciclo",
    agentTarget: "pane-1",
    dryRun: true
  });
  assert.throws(() => parseAttachOptions(["--wat"]), /unknown attach option/);

  const attach = captureIo();
  assert.equal(await main([
    "node",
    "ciclo",
    "attach",
    "--remote",
    "ciclo@10.44.0.2:/workspace/ciclo",
    "--session",
    "ciclo",
    "--dry-run",
    "--compact"
  ], attach.io), 0);
  const payload = JSON.parse(attach.stdout[0] ?? "{}") as { command?: string; args?: readonly string[] };
  assert.equal(payload.command, "herdr");
  assert.deepEqual(payload.args, ["--remote", "ciclo@10.44.0.2:/workspace/ciclo", "--session", "ciclo"]);
});

test("CLI installs lists and toggles local third-party plugins", async () => {
  const before = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-plugin-cli-"));
  const fixturePlugin = resolve("tests/fixtures/plugins/fly-runner");
  try {
    process.chdir(tempDir);
    const install = captureIo();
    assert.equal(await main([
      "node",
      "ciclo",
      "plugin",
      "install",
      "@example/ciclo-runner-fly",
      "--path",
      fixturePlugin,
      "--trust",
      "--compact"
    ], install.io), 0);
    const installed = JSON.parse(install.stdout[0] ?? "{}") as { installed?: boolean; manifest?: { name?: string } };
    assert.equal(installed.installed, true);
    assert.equal(installed.manifest?.name, "@example/ciclo-runner-fly");

    const list = captureIo();
    assert.equal(await main(["node", "ciclo", "plugin", "list", "--compact"], list.io), 0);
    const config = JSON.parse(list.stdout[0] ?? "{}") as { plugins?: readonly { package?: string; enabled?: boolean }[] };
    assert.equal(config.plugins?.[0]?.package, "@example/ciclo-runner-fly");
    assert.equal(config.plugins?.[0]?.enabled, true);

    const disabled = captureIo();
    assert.equal(await main(["node", "ciclo", "plugin", "disable", "@example/ciclo-runner-fly"], disabled.io), 0);
    assert.equal((JSON.parse(disabled.stdout[0] ?? "{}") as { enabled?: boolean }).enabled, false);
  } finally {
    process.chdir(before);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("compiled CLI runs when invoked through an npm-style symlink", () => {
  const distCliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-cli-"));
  try {
    const symlinkPath = join(tempDir, "ciclo");
    symlinkSync(distCliPath, symlinkPath);
    const result = spawnSync(process.execPath, [symlinkPath, "--version"], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "0.1.0");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
