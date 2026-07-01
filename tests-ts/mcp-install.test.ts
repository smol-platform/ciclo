import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installCicloMcp } from "../src/mcp-install.js";

test("installs Claude project MCP config into .mcp.json", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ciclo-mcp-claude-"));
  try {
    const result = installCicloMcp({ projectRoot, clients: ["claude"], command: "ciclo-test" });
    assert.equal(result.installed, true);
    assert.equal(result.targets[0]?.client, "claude");
    assert.equal(result.targets[0]?.changed, true);

    const config = JSON.parse(readFileSync(join(projectRoot, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: readonly string[]; env?: Record<string, string> }>;
    };
    assert.equal(config.mcpServers?.ciclo?.command, "ciclo-test");
    assert.deepEqual(config.mcpServers?.ciclo?.args, ["mcp", "stdio"]);
    assert.equal(config.mcpServers?.ciclo?.env?.CICLO_PROJECT_ROOT, projectRoot);

    const second = installCicloMcp({ projectRoot, clients: ["claude"], command: "ciclo-test" });
    assert.equal(second.installed, false);
    assert.equal(second.targets[0]?.changed, false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("merges Claude MCP config without removing existing servers", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ciclo-mcp-merge-"));
  try {
    writeFileSync(join(projectRoot, ".mcp.json"), `${JSON.stringify({
      mcpServers: {
        existing: {
          command: "node",
          args: ["server.js"]
        }
      }
    }, null, 2)}\n`);

    installCicloMcp({ projectRoot, clients: ["claude"] });
    const config = JSON.parse(readFileSync(join(projectRoot, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    assert.ok(config.mcpServers?.existing);
    assert.ok(config.mcpServers?.ciclo);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("installs Claude MCP config with optional channel mode", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ciclo-mcp-claude-channel-"));
  try {
    const result = installCicloMcp({
      projectRoot,
      clients: ["claude"],
      serverName: "ciclo_channel",
      claudeChannel: true
    });
    assert.equal(result.installed, true);
    assert.equal(result.claudeChannel?.selector, "server:ciclo_channel");
    assert.deepEqual(result.claudeChannel?.launchArgs, [
      "--dangerously-load-development-channels",
      "server:ciclo_channel"
    ]);

    const config = JSON.parse(readFileSync(join(projectRoot, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    };
    assert.equal(config.mcpServers?.ciclo_channel?.env?.CICLO_CLAUDE_CHANNEL, "true");
    assert.ok(result.nextSteps.some((step) => step.includes("--dangerously-load-development-channels server:ciclo_channel")));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("installs Codex MCP server block into project config.toml", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ciclo-mcp-codex-"));
  try {
    const result = installCicloMcp({ projectRoot, clients: ["codex"], serverName: "ciclo_local" });
    assert.equal(result.installed, true);
    assert.equal(result.targets[0]?.client, "codex");

    const configPath = join(projectRoot, ".codex", "config.toml");
    assert.equal(existsSync(configPath), true);
    const config = readFileSync(configPath, "utf8");
    assert.match(config, /\[mcp_servers\.ciclo_local\]/u);
    assert.match(config, /command = "ciclo"/u);
    assert.match(config, /args = \["mcp", "stdio"\]/u);
    assert.match(config, /\[mcp_servers\.ciclo_local\.env\]/u);
    assert.match(config, /CICLO_PROJECT_ROOT = /u);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("updates existing Codex Ciclo block without disturbing other config", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ciclo-mcp-codex-update-"));
  const configPath = join(projectRoot, ".codex", "config.toml");
  try {
    mkdirSync(join(projectRoot, ".codex"), { recursive: true });
    writeFileSync(configPath, [
      "[features]",
      "hooks = true",
      "",
      "[mcp_servers.ciclo]",
      "command = \"old\"",
      "args = [\"old\"]",
      "",
      "[mcp_servers.ciclo.env]",
      "CICLO_PROJECT_ROOT = \"/old\"",
      "",
      "[mcp_servers.other]",
      "command = \"other\"",
      "args = []",
      ""
    ].join("\n"));

    installCicloMcp({ projectRoot, clients: ["codex"], command: "new-ciclo" });
    const config = readFileSync(configPath, "utf8");
    assert.match(config, /\[features\]\nhooks = true/u);
    assert.match(config, /\[mcp_servers\.other\]\ncommand = "other"/u);
    assert.doesNotMatch(config, /command = "old"/u);
    assert.match(config, /command = "new-ciclo"/u);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("dry-run reports target changes without writing files", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ciclo-mcp-dry-run-"));
  try {
    const result = installCicloMcp({ projectRoot, clients: ["claude", "codex"], dryRun: true });
    assert.equal(result.installed, false);
    assert.equal(result.targets.length, 2);
    assert.equal(result.targets.every((target) => target.changed), true);
    assert.equal(existsSync(join(projectRoot, ".mcp.json")), false);
    assert.equal(existsSync(join(projectRoot, ".codex", "config.toml")), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("rejects unsafe MCP server names", () => {
  assert.throws(() => installCicloMcp({ serverName: "bad.name" }), /--server-name/);
  assert.throws(() => installCicloMcp({ clients: ["codex"], claudeChannel: true }), /--claude-channel requires/);
});
