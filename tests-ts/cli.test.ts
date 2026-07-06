import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  main,
  parseAttachOptions,
  parseBenchmarkOptions,
  parseBenchmarkScenarioDir,
  parseEventsOptions,
  parseHerdrPaneList,
  parseLaunchOptions,
  parseMcpHttpOptions,
  parseMcpInstallOptions,
  parseSkillInstallOptions,
  type CliIo
} from "../src/cli.js";
import { cicloEventLogPath, CicloEventStore } from "../src/ciclo-events.js";
import { encodeRuntimeSecretEnvBindings } from "../src/secret-env-runtime.js";
import { CICLO_VERSION } from "../src/version.js";

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
  assert.match(help.stdout.join("\n"), /launch/);
  assert.match(help.stdout.join("\n"), /gc workspaces/);
  assert.match(help.stdout.join("\n"), /events/);
  assert.match(help.stdout.join("\n"), /mcp http/);
  assert.match(help.stdout.join("\n"), /mcp install/);
  assert.match(help.stdout.join("\n"), /skill install/);

  const version = captureIo();
  assert.equal(await main(["node", "ciclo", "--version"], version.io), 0);
  assert.equal(version.stdout[0], CICLO_VERSION);

  const gcHelp = captureIo();
  assert.equal(await main(["node", "ciclo", "help", "gc"], gcHelp.io), 0);
  assert.match(gcHelp.stdout.join("\n"), /Usage: ciclo gc workspaces/);
  assert.match(gcHelp.stdout.join("\n"), /skips working agents/);
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

test("CLI installs project MCP config for Claude and Codex", async () => {
  assert.deepEqual(parseMcpInstallOptions([
    "--client",
    "all",
    "--project",
    "/tmp/project",
    "--server-name",
    "ciclo_local",
    "--command",
    "/bin/ciclo",
    "--claude-channel",
    "--dry-run"
  ]), {
    projectRoot: "/tmp/project",
    clients: ["claude", "codex"],
    serverName: "ciclo_local",
    command: "/bin/ciclo",
    claudeChannel: true,
    dryRun: true
  });
  assert.throws(() => parseMcpInstallOptions(["--client", "wat"]), /--client must be/);

  const before = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-mcp-cli-"));
  try {
    process.chdir(tempDir);
    const install = captureIo();
    assert.equal(await main([
      "node",
      "ciclo",
      "mcp",
      "install",
      "--client",
      "all",
      "--command",
      "ciclo-test",
      "--claude-channel",
      "--compact"
    ], install.io), 0);

    const payload = JSON.parse(install.stdout[0] ?? "{}") as {
      installed?: boolean;
      claudeChannel?: { selector?: string };
      targets?: readonly { client?: string; changed?: boolean }[];
    };
    assert.equal(payload.installed, true);
    assert.equal(payload.claudeChannel?.selector, "server:ciclo");
    assert.deepEqual(payload.targets?.map((target) => target.client), ["claude", "codex"]);
    assert.equal(payload.targets?.every((target) => target.changed), true);
  } finally {
    process.chdir(before);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI config commands initialize and mcp install reads project defaults", async () => {
  const before = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-config-cli-"));
  try {
    process.chdir(tempDir);

    const init = captureIo();
    assert.equal(await main(["node", "ciclo", "config", "init", "--compact"], init.io), 0);
    const initialized = JSON.parse(init.stdout[0] ?? "{}") as { found?: boolean; path?: string };
    assert.equal(initialized.found, true);
    assert.ok(initialized.path?.endsWith(join(".ciclo", "config.json")));

    const show = captureIo();
    assert.equal(await main(["node", "ciclo", "config", "show", "--compact"], show.io), 0);
    const shown = JSON.parse(show.stdout[0] ?? "{}") as { config?: { mcp?: { secretBindings?: readonly { ref?: string }[] } } };
    assert.equal(shown.config?.mcp?.secretBindings?.[0]?.ref, "[redacted secret ref]");

    mkdirSync(join(tempDir, ".ciclo"), { recursive: true });
    const mcpServerEnvKey = ["e", "n", "v"].join("");
    writeFileSync(join(tempDir, ".ciclo", "config.json"), JSON.stringify({
      secrets: {
        providers: [{ id: "team-1password", kind: "onepassword", command: "op" }]
      },
      mcp: {
        clients: ["codex"],
        serverName: "ciclo_config",
        command: "ciclo-dev",
        vars: { CICLO_REUSE_HERDR_SESSION: "true" },
        additionalServers: {
          service: {
            command: "service-mcp-server",
            args: ["stdio"],
            [mcpServerEnvKey]: {
              SERVICE_MODE: "Bearer ${secret://team-1password/Ciclo/API/token}"
            }
          }
        },
        secretBindings: [
          {
            name: "GITHUB_TOKEN",
            providerId: "team-1password",
            ref: "op://Engineering/GitHub Token/token"
          },
          {
            name: "GITHUB_AUTHORIZATION",
            providerId: "team-1password",
            ref: "op://Engineering/GitHub Token/token",
            format: "Bearer ${secret}"
          }
        ]
      }
    }));

    const install = captureIo();
    assert.equal(await main(["node", "ciclo", "mcp", "install", "--dry-run", "--compact"], install.io), 0);
    const installed = JSON.parse(install.stdout[0] ?? "{}") as {
      serverName?: string;
      server?: { command?: string; ["env"]?: Record<string, string> };
      secretEnv?: readonly { name?: string; formatApplied?: boolean }[];
      targets?: readonly { client?: string }[];
    };
    assert.equal(installed.serverName, "ciclo_config");
    assert.equal(installed.server?.command, "ciclo-dev");
    assert.equal(installed.server?.["env"]?.CICLO_REUSE_HERDR_SESSION, "true");
    assert.equal(installed.server?.["env"]?.GITHUB_TOKEN, "[redacted secret]");
    assert.equal(installed.server?.["env"]?.GITHUB_AUTHORIZATION, "[redacted secret]");
    assert.deepEqual(installed.secretEnv?.map((binding) => binding.name), ["GITHUB_TOKEN", "GITHUB_AUTHORIZATION"]);
    assert.equal(installed.secretEnv?.[1]?.formatApplied, true);
    assert.match(install.stdout[0] ?? "", /additionalServerSecret/);
    assert.match(install.stdout[0] ?? "", /SERVICE_MODE/);
    assert.match(install.stdout[0] ?? "", /\[redacted secret\]/);
    assert.deepEqual(installed.targets?.map((target) => target.client), ["codex"]);
  } finally {
    process.chdir(before);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI events command reads and follows the project event log", async () => {
  assert.deepEqual(parseEventsOptions([
    "--project",
    "/tmp/project",
    "--cursor",
    "4",
    "--limit",
    "12",
    "--follow",
    "--once",
    "--interval-ms",
    "25"
  ]), {
    projectRoot: "/tmp/project",
    cursor: 4,
    limit: 12,
    follow: true,
    once: true,
    intervalMs: 25,
    json: false
  });
  assert.throws(() => parseEventsOptions(["--cursor", "wat"]), /--cursor must be/);

  const before = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-events-cli-"));
  try {
    process.chdir(tempDir);
    const eventStore = new CicloEventStore({ persistPath: cicloEventLogPath(tempDir), now: () => "2026-07-04T14:00:00.000Z" });
    eventStore.append({
      type: "brain.decision",
      loopId: "review-loop",
      beadId: "ciclo-1",
      workerSessionId: "worker-1",
      evidence: ["brain:fixture"],
      data: { purpose: "monitoring", provider: "openai" }
    });

    const human = captureIo();
    assert.equal(await main(["node", "ciclo", "events", "--project", tempDir], human.io), 0);
    assert.match(human.stdout.join("\n"), /#1 2026-07-04T14:00:00.000Z brain\.decision/);
    assert.match(human.stdout.join("\n"), /loop=review-loop/);
    assert.match(human.stdout.join("\n"), /data=\{"purpose":"monitoring","provider":"openai"\}/);

    const json = captureIo();
    assert.equal(await main(["node", "ciclo", "events", "--project", tempDir, "--follow", "--once", "--compact"], json.io), 0);
    const payload = JSON.parse(json.stdout[0] ?? "{}") as {
      next_cursor?: number;
      events?: readonly { type?: string; data?: { provider?: string } }[];
    };
    assert.equal(payload.next_cursor, 1);
    assert.equal(payload.events?.[0]?.type, "brain.decision");
    assert.equal(payload.events?.[0]?.data?.provider, "openai");
  } finally {
    process.chdir(before);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI memory and cron commands expose durable orchestration state", async () => {
  const before = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-memory-cron-cli-"));
  try {
    process.chdir(tempDir);
    mkdirSync(join(tempDir, ".ciclo"), { recursive: true });
    writeFileSync(join(tempDir, ".ciclo", "config.json"), JSON.stringify({
      cron: {
        jobs: [
          {
            id: "compact-memory",
            schedule: { everyMs: 1 },
            task: { kind: "memory_compact" }
          }
        ]
      },
      memory: { enabled: true }
    }));

    const remember = captureIo();
    assert.equal(await main([
      "node",
      "ciclo",
      "memory",
      "remember",
      "--content",
      "Codex is a good default for small TypeScript fixes.",
      "--tag",
      "model-fit",
      "--importance",
      "high",
      "--compact"
    ], remember.io), 0);
    const remembered = JSON.parse(remember.stdout[0] ?? "{}") as { memory?: { tags?: readonly string[]; importance?: string } };
    assert.deepEqual(remembered.memory?.tags, ["model-fit"]);
    assert.equal(remembered.memory?.importance, "high");

    const listed = captureIo();
    assert.equal(await main(["node", "ciclo", "memory", "list", "--tag", "model-fit", "--compact"], listed.io), 0);
    const listPayload = JSON.parse(listed.stdout[0] ?? "{}") as { memories?: readonly unknown[] };
    assert.equal(listPayload.memories?.length, 1);

    const cron = captureIo();
    assert.equal(await main(["node", "ciclo", "cron", "list", "--compact"], cron.io), 0);
    const cronPayload = JSON.parse(cron.stdout[0] ?? "{}") as { jobs?: readonly { id?: string }[] };
    assert.equal(cronPayload.jobs?.[0]?.id, "compact-memory");
  } finally {
    process.chdir(before);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI secret exec resolves configured providers only for the child process", async () => {
  const before = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-secret-exec-cli-"));
  try {
    process.chdir(tempDir);
    mkdirSync(join(tempDir, ".ciclo"), { recursive: true });
    const opFixture = join(tempDir, "op-fixture.js");
    writeFileSync(opFixture, [
      "#!/usr/bin/env node",
      "if (process.argv[2] !== 'read') process.exit(2);",
      "process.stdout.write('fixture-runtime-token\\n');"
    ].join("\n"));
    chmodSync(opFixture, 0o700);
    writeFileSync(join(tempDir, ".ciclo", "config.json"), JSON.stringify({
      secrets: {
        providers: [{ id: "fixture-op", kind: "onepassword", command: opFixture }]
      }
    }));
    const binding = encodeRuntimeSecretEnvBindings([
      {
        name: "API_TOKEN",
        providerId: "fixture-op",
        secretRef: opFixture,
        format: "Bearer ${secret}",
        reason: "test runtime child injection"
      }
    ]);
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = spawnSync(process.execPath, [
      cliPath,
      "secret",
      "exec",
      "--binding",
      binding,
      "--",
      process.execPath,
      "-e",
      "process.stdout.write(process['env'].API_TOKEN || 'missing')"
    ], {
      cwd: tempDir,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Bearer fixture-runtime-token");
  } finally {
    process.chdir(before);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI launch dry-run prepares MCP config and Herdr harness command", async () => {
  assert.deepEqual(parseLaunchOptions([
    "claude",
    "--project",
    "/tmp/project",
    "--session",
    "review-loop",
    "--pane-name",
    "repo-reviewer",
    "--model",
    "claude-fable-5",
    "--effort",
    "high",
    "--extra-arg",
    "--verbose",
    "--dry-run"
  ]), {
    projectRoot: "/tmp/project",
    client: "claude",
    herdr: true,
    herdrSession: "review-loop",
    paneName: "repo-reviewer",
    attach: true,
    model: "claude-fable-5",
    effort: "high",
    extraArgs: ["--verbose"],
    dryRun: true
  });
  assert.deepEqual(parseLaunchOptions(["--client", "codex", "--", "--full-auto"]), {
    client: "codex",
    herdr: true,
    attach: true,
    extraArgs: ["--full-auto"],
    dryRun: false
  });
  assert.deepEqual(parseLaunchOptions(["codex", "--terminal"]), {
    client: "codex",
    herdr: false,
    attach: true,
    extraArgs: [],
    dryRun: false
  });
  assert.throws(() => parseLaunchOptions(["--client", "wat"]), /--client must be/);

  const before = process.cwd();
  const beforeReuse = process.env.CICLO_REUSE_HERDR_SESSION;
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-launch-cli-"));
  try {
    process.env.CICLO_REUSE_HERDR_SESSION = "false";
    process.chdir(tempDir);
    mkdirSync(join(tempDir, ".ciclo"), { recursive: true });
    writeFileSync(join(tempDir, ".ciclo", "config.json"), JSON.stringify({
      mcp: {
        clients: ["claude", "codex"],
        serverName: "ciclo_launch",
        command: "ciclo-dev",
        vars: { CICLO_REUSE_HERDR_SESSION: "true" },
        additionalServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
            env: { MCP_FS_MODE: "workspace" }
          }
        },
        claudeChannel: true
      }
    }));
    const projectName = basename(resolve(tempDir)).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");

    const codex = captureIo();
    assert.equal(await main([
      "node",
      "ciclo",
      "launch",
      "codex",
      "--model",
      "gpt-5.5",
      "--prompt",
      "Review the repo",
      "--dry-run",
      "--compact"
    ], codex.io), 0);
    const codexPlan = JSON.parse(codex.stdout[0] ?? "{}") as {
      client?: string;
      launchMode?: string;
      projectRoot?: string;
      command?: string;
      args?: readonly string[];
      harnessCommand?: string;
      harnessArgs?: readonly string[];
      herdr?: { sessionName?: string; paneName?: string; attach?: boolean; attachCommand?: string; attachArgs?: readonly string[] };
      mcpInstall?: {
        serverName?: string;
        server?: { env?: Record<string, string> };
        targets?: readonly { client?: string }[];
        additionalServers?: Record<string, unknown>;
      };
    };
    assert.equal(codexPlan.client, "codex");
    assert.equal(codexPlan.launchMode, "herdr");
    assert.equal(codexPlan.command, "herdr");
    assert.equal(codexPlan.harnessCommand, "codex");
    assert.equal(codexPlan.harnessArgs?.[0], "-c");
    const codexMcpOverride = codexPlan.harnessArgs?.[1] ?? "";
    assert.match(codexMcpOverride, /^mcp_servers=/u);
    assert.match(codexMcpOverride, /ciclo_launch/u);
    assert.match(codexMcpOverride, /filesystem/u);
    assert.doesNotMatch(codexMcpOverride, /user_profile/u);
    assert.ok(codexPlan.harnessArgs?.includes("--cd"));
    assert.ok(codexPlan.harnessArgs?.includes("--ask-for-approval"));
    assert.ok(codexPlan.harnessArgs?.includes("never"));
    assert.ok(codexPlan.harnessArgs?.includes("--sandbox"));
    assert.ok(codexPlan.harnessArgs?.includes("danger-full-access"));
    assert.ok(codexPlan.projectRoot);
    assert.ok(codexPlan.harnessArgs?.includes(codexPlan.projectRoot));
    assert.ok(codexPlan.harnessArgs?.includes("Review the repo"));
    assert.deepEqual(codexPlan.args?.slice(0, 13), [
      "--session",
      projectName,
      "agent",
      "start",
      projectName,
      "--cwd",
      codexPlan.projectRoot,
      "--focus",
      "--",
      "codex",
      "-c",
      codexMcpOverride,
      "--model"
    ]);
    assert.equal(codexPlan.args?.[13], "gpt-5.5");
    assert.equal(codexPlan.herdr?.sessionName, projectName);
    assert.equal(codexPlan.herdr?.paneName, projectName);
    assert.equal(codexPlan.herdr?.attach, true);
    assert.equal(codexPlan.herdr?.attachCommand, "herdr");
    assert.deepEqual(codexPlan.herdr?.attachArgs, ["session", "attach", projectName]);
    assert.equal(codexPlan.mcpInstall?.serverName, "ciclo_launch");
    const codexServerEnv = codexPlan.mcpInstall?.server?.["env"];
    assert.equal(codexServerEnv?.CICLO_USER_PANE_ENABLED, "true");
    assert.equal(codexServerEnv?.CICLO_USER_PANE_HERDR_SESSION, projectName);
    assert.equal(codexServerEnv?.CICLO_USER_PANE_NAME, projectName);
    assert.deepEqual(codexPlan.mcpInstall?.targets?.map((target) => target.client), ["codex"]);
    assert.ok(codexPlan.mcpInstall?.additionalServers?.filesystem);
    assert.equal(existsSync(join(tempDir, ".codex", "config.toml")), false);

    const claude = captureIo();
    assert.equal(await main([
      "node",
      "ciclo",
      "launch",
      "claude",
      "--model",
      "claude-fable-5",
      "--dry-run",
      "--compact"
    ], claude.io), 0);
    const claudePlan = JSON.parse(claude.stdout[0] ?? "{}") as {
      client?: string;
      launchMode?: string;
      command?: string;
      args?: readonly string[];
      harnessCommand?: string;
      harnessArgs?: readonly string[];
      mcpInstall?: { claudeChannel?: { selector?: string }; server?: { env?: Record<string, string> }; targets?: readonly { client?: string }[] };
    };
    assert.equal(claudePlan.client, "claude");
    assert.equal(claudePlan.launchMode, "herdr");
    assert.equal(claudePlan.command, "herdr");
    assert.equal(claudePlan.harnessCommand, "claude");
    assert.ok(claudePlan.harnessArgs?.includes("--dangerously-load-development-channels"));
    assert.ok(claudePlan.harnessArgs?.includes("server:ciclo_launch"));
    assert.ok(claudePlan.harnessArgs?.includes("--permission-mode"));
    assert.ok(claudePlan.harnessArgs?.includes("bypassPermissions"));
    assert.ok(!claudePlan.harnessArgs?.includes("default"));
    assert.ok(claudePlan.args?.includes("claude"));
    assert.deepEqual(claudePlan.mcpInstall?.targets?.map((target) => target.client), ["claude"]);
    assert.equal(claudePlan.mcpInstall?.claudeChannel?.selector, "server:ciclo_launch");
    assert.equal(claudePlan.mcpInstall?.server?.["env"]?.CICLO_USER_PANE_ENABLED, "true");
    assert.equal(existsSync(join(tempDir, ".mcp.json")), false);

    const terminal = captureIo();
    assert.equal(await main([
      "node",
      "ciclo",
      "launch",
      "codex",
      "--terminal",
      "--dry-run",
      "--compact"
    ], terminal.io), 0);
    const terminalPlan = JSON.parse(terminal.stdout[0] ?? "{}") as {
      launchMode?: string;
      command?: string;
      harnessCommand?: string;
      harnessArgs?: readonly string[];
      herdr?: unknown;
    };
    assert.equal(terminalPlan.launchMode, "terminal");
    assert.equal(terminalPlan.command, "codex");
    assert.equal(terminalPlan.harnessCommand, "codex");
    assert.ok(terminalPlan.harnessArgs?.includes("--ask-for-approval"));
    assert.ok(terminalPlan.harnessArgs?.includes("never"));
    assert.ok(terminalPlan.harnessArgs?.includes("--sandbox"));
    assert.ok(terminalPlan.harnessArgs?.includes("danger-full-access"));
    assert.equal(terminalPlan.herdr, undefined);

    const events = readFileSync(cicloEventLogPath(tempDir), "utf8");
    assert.match(events, /"type":"cli.command"/);
    assert.match(events, /"command":"launch"/);
    assert.match(events, /"phase":"dry_run"/);
    assert.match(events, /"launch_mode":"herdr"/);
  } finally {
    process.chdir(before);
    if (beforeReuse === undefined) delete process.env.CICLO_REUSE_HERDR_SESSION;
    else process.env.CICLO_REUSE_HERDR_SESSION = beforeReuse;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Herdr pane list parser extracts reusable bootstrap panes", () => {
  assert.deepEqual(parseHerdrPaneList(JSON.stringify({
    id: "cli:pane:list",
    result: {
      panes: [
        {
          pane_id: "w1:p1",
          workspace_id: "w1",
          label: "shell",
          focused: true
        }
      ]
    }
  })), [
    {
      paneId: "w1:p1",
      workspaceId: "w1",
      label: "shell",
      focused: true
    }
  ]);
  assert.deepEqual(parseHerdrPaneList("{not-json"), []);
});

test("CLI launch reuses first existing Herdr pane instead of starting a second pane", async () => {
  const before = {
    PATH: process.env.PATH,
    HERDR_LOG: process.env.HERDR_LOG,
    CICLO_REUSE_HERDR_SESSION: process.env.CICLO_REUSE_HERDR_SESSION,
    HERDR_SESSION_NAME: process.env.HERDR_SESSION_NAME,
    CICLO_HERDR_SESSION: process.env.CICLO_HERDR_SESSION,
    HERDR_SESSION: process.env.HERDR_SESSION
  };
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-launch-herdr-reuse-"));
  try {
    const binDir = join(tempDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const herdrLog = join(tempDir, "herdr.log");
    const herdrBin = join(binDir, "herdr");
    writeFileSync(herdrBin, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$HERDR_LOG\"",
      "if [ \"$3\" = \"pane\" ] && [ \"$4\" = \"list\" ]; then",
      "  printf '%s\\n' '{\"id\":\"cli:pane:list\",\"result\":{\"panes\":[{\"pane_id\":\"w1:p1\",\"workspace_id\":\"w1\",\"label\":\"shell\"}]}}'",
      "  exit 0",
      "fi",
      "exit 0",
      ""
    ].join("\n"));
    chmodSync(herdrBin, 0o700);
    const codexBin = join(binDir, "codex");
    writeFileSync(codexBin, "#!/bin/sh\nexit 0\n");
    chmodSync(codexBin, 0o700);

    process.env.PATH = `${binDir}:${before.PATH ?? ""}`;
    process.env.HERDR_LOG = herdrLog;
    process.env.CICLO_REUSE_HERDR_SESSION = "false";
    delete process.env.HERDR_SESSION_NAME;
    delete process.env.CICLO_HERDR_SESSION;
    delete process.env.HERDR_SESSION;

    const launch = captureIo();
    assert.equal(await main([
      "node",
      "ciclo",
      "launch",
      "codex",
      "--project",
      tempDir,
      "--no-attach",
      "--prompt",
      "Review the repo"
    ], launch.io), 0);

    const log = readFileSync(herdrLog, "utf8");
    assert.match(log, /--session ciclo-launch-herdr-reuse-[^ ]+ status server/u);
    assert.match(log, /--session ciclo-launch-herdr-reuse-[^ ]+ pane list/u);
    assert.match(log, /--session ciclo-launch-herdr-reuse-[^ ]+ pane rename w1:p1 ciclo-launch-herdr-reuse-/u);
    assert.match(log, /--session ciclo-launch-herdr-reuse-[^ ]+ pane run w1:p1 /u);
    assert.doesNotMatch(log, / agent start /u);

    const events = readFileSync(cicloEventLogPath(tempDir), "utf8");
    assert.match(events, /"herdr_pane_reused":true/u);
    assert.match(events, /"herdr_pane":"w1:p1"/u);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("CLI installs Ciclo skills for Claude and Codex", async () => {
  assert.deepEqual(parseSkillInstallOptions([
    "--client",
    "all",
    "--project",
    "/tmp/project",
    "--dry-run"
  ]), {
    projectRoot: "/tmp/project",
    clients: ["claude", "codex"],
    dryRun: true
  });
  assert.throws(() => parseSkillInstallOptions(["--client", "wat"]), /--client must be/);

  const before = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-skill-cli-"));
  try {
    process.chdir(tempDir);

    const dryRun = captureIo();
    assert.equal(await main([
      "node",
      "ciclo",
      "skill",
      "install",
      "--client",
      "all",
      "--dry-run",
      "--compact"
    ], dryRun.io), 0);
    const dryRunPayload = JSON.parse(dryRun.stdout[0] ?? "{}") as { installed?: boolean; targets?: readonly { dryRun?: boolean }[] };
    assert.equal(dryRunPayload.installed, false);
    assert.equal(dryRunPayload.targets?.every((target) => target.dryRun), true);
    assert.equal(existsSync(join(tempDir, ".claude", "skills", "ciclo-mcp.md")), false);

    const install = captureIo();
    assert.equal(await main([
      "node",
      "ciclo",
      "skill",
      "install",
      "--client",
      "all",
      "--compact"
    ], install.io), 0);
    const payload = JSON.parse(install.stdout[0] ?? "{}") as {
      installed?: boolean;
      targets?: readonly { client?: string; changed?: boolean; paths?: readonly string[] }[];
    };
    assert.equal(payload.installed, true);
    assert.deepEqual(payload.targets?.map((target) => target.client), ["claude", "codex"]);
    assert.equal(payload.targets?.every((target) => target.changed), true);

    const claudeSkill = join(tempDir, ".claude", "skills", "ciclo-mcp.md");
    const claudeReleaseSkill = join(tempDir, ".claude", "skills", "release.md");
    const claudeReleaseCommand = join(tempDir, ".claude", "commands", "release.md");
    const codexSkill = join(tempDir, ".agents", "skills", "ciclo-mcp", "SKILL.md");
    const codexReleaseSkill = join(tempDir, ".agents", "skills", "release", "SKILL.md");
    const codexReleaseAgent = join(tempDir, ".agents", "skills", "release", "agents", "openai.yaml");
    const codexReference = join(tempDir, ".agents", "skills", "ciclo-mcp", "references", "mcp-workflows.md");
    assert.equal(existsSync(claudeSkill), true);
    assert.equal(existsSync(claudeReleaseSkill), true);
    assert.equal(existsSync(claudeReleaseCommand), true);
    assert.equal(existsSync(codexSkill), true);
    assert.equal(existsSync(codexReleaseSkill), true);
    assert.equal(existsSync(codexReleaseAgent), true);
    assert.equal(existsSync(codexReference), true);
    const codexSkillText = readFileSync(codexSkill, "utf8");
    const codexReleaseText = readFileSync(codexReleaseSkill, "utf8");
    const claudeSkillText = readFileSync(claudeSkill, "utf8");
    const claudeReleaseText = readFileSync(claudeReleaseSkill, "utf8");
    const releaseCommandText = readFileSync(claudeReleaseCommand, "utf8");
    const referenceText = readFileSync(codexReference, "utf8");
    assert.match(codexSkillText, /ciclo_launch_worker_session/);
    assert.match(codexSkillText, /ciclo skill install --client all/);
    assert.match(codexSkillText, /configure_mcp: true/);
    assert.match(codexSkillText, /ciclo_request_secret/);
    assert.match(codexSkillText, /ciclo_launch_remote_runner/);
    assert.match(codexReleaseText, /name: release/);
    assert.match(codexReleaseText, /gh release create/);
    assert.match(codexReleaseText, /git tag -a/);
    assert.match(claudeSkillText, /ciclo skill install --client all/);
    assert.match(claudeReleaseText, /name: release/);
    assert.match(releaseCommandText, /release skill/);
    assert.match(releaseCommandText, /gh release view/);
    assert.match(referenceText, /ciclo_launch_remote_runner/);
  } finally {
    process.chdir(before);
    rmSync(tempDir, { recursive: true, force: true });
  }
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
    assert.equal(result.stdout.trim(), CICLO_VERSION);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
