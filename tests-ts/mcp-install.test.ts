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

test("installs additional MCP servers alongside Ciclo for Claude and Codex", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ciclo-mcp-additional-"));
  try {
    const result = installCicloMcp({
      projectRoot,
      clients: ["claude", "codex"],
      additionalServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          env: { MCP_FS_MODE: "workspace" }
        }
      }
    });

    assert.deepEqual(Object.keys(result.additionalServers), ["filesystem"]);

    const claudeConfig = JSON.parse(readFileSync(join(projectRoot, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: readonly string[]; ["env"]?: Record<string, string> }>;
    };
    assert.equal(claudeConfig.mcpServers?.filesystem?.command, "npx");
    assert.deepEqual(claudeConfig.mcpServers?.filesystem?.args, ["-y", "@modelcontextprotocol/server-filesystem", "."]);
    assert.equal(claudeConfig.mcpServers?.filesystem?.["env"]?.MCP_FS_MODE, "workspace");
    assert.ok(claudeConfig.mcpServers?.ciclo);

    const codexConfig = readFileSync(join(projectRoot, ".codex", "config.toml"), "utf8");
    assert.match(codexConfig, /\[mcp_servers\.filesystem\]/u);
    assert.match(codexConfig, /command = "npx"/u);
    assert.match(codexConfig, /MCP_FS_MODE = "workspace"/u);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("redacts additional MCP server secret env values from install results", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ciclo-mcp-additional-secret-"));
  try {
    const result = installCicloMcp({
      projectRoot,
      clients: ["claude"],
      additionalServers: {
        service: {
          command: "service-mcp-server",
          args: ["stdio"],
          env: { SERVICE_MODE: "fixture-resolved-value" }
        }
      },
      additionalServerSecretEnv: [
        {
          serverName: "service",
          envName: "SERVICE_MODE",
          providerId: "fixture",
          providerKind: "test",
          secretRefHash: "abc123",
          evidence: ["secret.fixture"]
        }
      ]
    });

    assert.equal(result.additionalServers.service?.["env"].SERVICE_MODE, "[redacted secret]");
    assert.equal(result.additionalServerSecretEnv[0]?.serverName, "service");
    assert.doesNotMatch(JSON.stringify(result), /fixture-resolved-value/u);

    const config = JSON.parse(readFileSync(join(projectRoot, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { readonly ["env"]?: Record<string, string> }>;
    };
    assert.equal(config.mcpServers?.service?.["env"]?.SERVICE_MODE, "fixture-resolved-value");
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

test("installs MCP secret environment through runtime wrapper while redacting install results", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ciclo-mcp-secret-env-"));
  try {
    const result = installCicloMcp({
      projectRoot,
      clients: ["claude"],
      secretEnv: [
        {
          name: "API_TOKEN",
          value: "fixture-secret",
          providerId: "fixture",
          providerKind: "test",
          secretRef: "op://Fixture/API/token",
          secretRefHash: "abc123",
          format: "Bearer ${secret}",
          evidence: ["secret.fixture"]
        }
      ]
    });
    assert.equal(result.server["env"].API_TOKEN, "[redacted secret]");
    assert.equal(result.secretEnv[0]?.name, "API_TOKEN");
    assert.equal(result.secretEnv[0]?.secretRefHash, "abc123");
    assert.equal(result.secretEnv[0]?.formatApplied, true);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/u);

    const config = JSON.parse(readFileSync(join(projectRoot, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { readonly args?: readonly string[]; readonly ["env"]?: Record<string, string> }>;
    };
    assert.deepEqual(config.mcpServers?.ciclo?.["env"], { CICLO_PROJECT_ROOT: projectRoot });
    assert.deepEqual(config.mcpServers?.ciclo?.args?.slice(0, 3), ["secret", "exec", "--binding"]);
    assert.ok(config.mcpServers?.ciclo?.args?.includes("mcp"));
    assert.doesNotMatch(JSON.stringify(config), /fixture-secret/u);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("rejects MCP secret environment formats without exactly one secret placeholder", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ciclo-mcp-secret-format-"));
  try {
    assert.throws(
      () => installCicloMcp({
        projectRoot,
        clients: ["claude"],
        secretEnv: [
          {
            name: "API_TOKEN",
            value: "fixture-secret",
            providerId: "fixture",
            providerKind: "test",
            secretRef: "op://Fixture/API/token",
            secretRefHash: "abc123",
            format: "Bearer token",
            evidence: ["secret.fixture"]
          }
        ]
      }),
      /format must contain exactly one \$\{secret\} placeholder/u
    );
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

test("updates Codex config while removing unmanaged MCP server blocks", () => {
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
    assert.doesNotMatch(config, /\[mcp_servers\.other\]/u);
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
