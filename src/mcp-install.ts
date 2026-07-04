import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CicloMcpAdditionalServerSecretEnvInstall } from "./mcp-secret-placeholders.js";
import { secretExecArgs, type RuntimeSecretEnvBinding } from "./secret-env-runtime.js";

export type CicloMcpInstallClient = "claude" | "codex";

export interface CicloMcpServerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

export type CicloMcpAdditionalServerConfig = CicloMcpServerConfig;

export interface CicloMcpSecretEnvBinding {
  readonly name: string;
  readonly value?: string;
  readonly providerId: string;
  readonly secretRef?: string;
  readonly providerKind: string;
  readonly secretRefHash: string;
  readonly field?: string;
  readonly format?: string;
  readonly evidence: readonly string[];
}

export interface CicloMcpSecretEnvInstall {
  readonly name: string;
  readonly providerId: string;
  readonly providerKind: string;
  readonly secretRefHash: string;
  readonly field?: string;
  readonly formatApplied?: boolean;
  readonly evidence: readonly string[];
}

export interface CicloMcpInstallOptions {
  readonly projectRoot?: string;
  readonly clients?: readonly CicloMcpInstallClient[];
  readonly serverName?: string;
  readonly command?: string;
  readonly env?: Record<string, string>;
  readonly secretEnv?: readonly CicloMcpSecretEnvBinding[];
  readonly additionalServers?: Record<string, CicloMcpAdditionalServerConfig>;
  readonly additionalServerSecretEnv?: readonly CicloMcpAdditionalServerSecretEnvInstall[];
  readonly claudeChannel?: boolean;
  readonly dryRun?: boolean;
}

export interface CicloMcpInstallTargetResult {
  readonly client: CicloMcpInstallClient;
  readonly path: string;
  readonly changed: boolean;
  readonly dryRun: boolean;
}

export interface CicloMcpInstallRenderedArtifact {
  readonly client: CicloMcpInstallClient;
  readonly path: string;
  readonly format: "json" | "toml";
  readonly content: string;
}

export interface CicloMcpRenderedInstallPlan {
  readonly install: CicloMcpInstallResult;
  readonly artifacts: readonly CicloMcpInstallRenderedArtifact[];
}

export interface CicloMcpInstallResult {
  readonly installed: boolean;
  readonly projectRoot: string;
  readonly serverName: string;
  readonly server: CicloMcpServerConfig;
  readonly additionalServers: Record<string, CicloMcpAdditionalServerConfig>;
  readonly secretEnv: readonly CicloMcpSecretEnvInstall[];
  readonly additionalServerSecretEnv: readonly CicloMcpAdditionalServerSecretEnvInstall[];
  readonly claudeChannel?: CicloClaudeChannelInstall;
  readonly targets: readonly CicloMcpInstallTargetResult[];
  readonly nextSteps: readonly string[];
}

export interface CicloClaudeChannelInstall {
  readonly enabled: boolean;
  readonly selector: string;
  readonly launchArgs: readonly string[];
}

function assertServerName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(name)) {
    throw new Error("--server-name may only contain letters, numbers, underscore, or dash");
  }
}

function uniqueClients(clients: readonly CicloMcpInstallClient[]): readonly CicloMcpInstallClient[] {
  return [...new Set(clients)];
}

function assertEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`MCP env name must be a shell-safe environment variable name: ${name}`);
  }
  if (name === "CICLO_PROJECT_ROOT" || name === "CICLO_CLAUDE_CHANNEL") {
    throw new Error(`MCP env name is reserved by Ciclo: ${name}`);
  }
}

function secretEnvInstall(secretEnv: readonly CicloMcpSecretEnvBinding[]): readonly CicloMcpSecretEnvInstall[] {
  return secretEnv.map((binding) => ({
    name: binding.name,
    providerId: binding.providerId,
    providerKind: binding.providerKind,
    secretRefHash: binding.secretRefHash,
    field: binding.field,
    ...(binding.format === undefined ? {} : { formatApplied: true }),
    evidence: binding.evidence
  }));
}

function assertSecretEnvFormat(name: string, format: string | undefined): void {
  if (format === undefined) return;
  const matches = format.match(/\$\{secret\}/gu) ?? [];
  if (matches.length !== 1) {
    throw new Error(`MCP secret env ${name} format must contain exactly one \${secret} placeholder`);
  }
}

function runtimeSecretEnvBindings(secretEnv: readonly CicloMcpSecretEnvBinding[]): readonly RuntimeSecretEnvBinding[] {
  return secretEnv.map((binding) => {
    if (binding.secretRef === undefined) {
      throw new Error(`MCP secret env ${binding.name} requires a provider secret reference for runtime-scoped delivery`);
    }
    return {
      name: binding.name,
      providerId: binding.providerId,
      secretRef: binding.secretRef,
      ...(binding.field === undefined ? {} : { field: binding.field }),
      ...(binding.format === undefined ? {} : { format: binding.format }),
      reason: `provide ${binding.name} to configured MCP server`
    };
  });
}

function extraEnvValues(env: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    assertEnvName(name);
    result[name] = value;
  }
  return result;
}

function normalizeAdditionalServers(
  servers: Record<string, CicloMcpAdditionalServerConfig> | undefined,
  cicloServerName: string
): Record<string, CicloMcpAdditionalServerConfig> {
  const normalized: Record<string, CicloMcpAdditionalServerConfig> = {};
  for (const [name, server] of Object.entries(servers ?? {})) {
    assertServerName(name);
    if (name === cicloServerName) throw new Error(`additional MCP server conflicts with Ciclo server name: ${name}`);
    const command = server.command.trim();
    if (command.length === 0) throw new Error(`additional MCP server ${name} requires command`);
    normalized[name] = {
      command,
      args: [...(server.args ?? [])],
      env: extraEnvValues(server["env"])
    };
  }
  return normalized;
}

function redactSecretEnv(config: CicloMcpServerConfig, secretEnv: readonly CicloMcpSecretEnvBinding[]): CicloMcpServerConfig {
  const redacted = { ...config.env };
  for (const binding of secretEnv) redacted[binding.name] = "[redacted secret]";
  return { ...config, env: redacted };
}

function redactAdditionalServerSecretEnv(
  servers: Record<string, CicloMcpAdditionalServerConfig>,
  secretEnv: readonly CicloMcpAdditionalServerSecretEnvInstall[]
): Record<string, CicloMcpAdditionalServerConfig> {
  const redacted: Record<string, CicloMcpAdditionalServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    redacted[name] = {
      command: server.command,
      args: [...server.args],
      env: { ...server.env }
    };
  }
  for (const binding of secretEnv) {
    const server = redacted[binding.serverName];
    if (server !== undefined) server.env[binding.envName] = "[redacted secret]";
  }
  return redacted;
}

function serverConfig(
  projectRoot: string,
  command: string,
  claudeChannel: boolean,
  env: Record<string, string> | undefined,
  secretEnv: readonly CicloMcpSecretEnvBinding[]
): CicloMcpServerConfig {
  for (const binding of secretEnv) {
    assertEnvName(binding.name);
    assertSecretEnvFormat(binding.name, binding.format);
  }
  const args = secretEnv.length === 0
    ? ["mcp", "stdio"]
    : secretExecArgs(runtimeSecretEnvBindings(secretEnv), command, ["mcp", "stdio"]);
  return {
    command,
    args,
    env: {
      CICLO_PROJECT_ROOT: projectRoot,
      ...extraEnvValues(env),
      ...(claudeChannel ? { CICLO_CLAUDE_CHANNEL: "true" } : {})
    }
  };
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (raw.length === 0) return {};
  return JSON.parse(raw) as unknown;
}

function asJsonObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

function writeIfChanged(path: string, content: string, dryRun: boolean): boolean {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const changed = previous !== content;
  if (changed && !dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return changed;
}

function installClaude(
  projectRoot: string,
  serverName: string,
  config: CicloMcpServerConfig,
  additionalServers: Record<string, CicloMcpAdditionalServerConfig>,
  dryRun: boolean
): CicloMcpInstallTargetResult {
  const path = join(projectRoot, ".mcp.json");
  const root = asJsonObject(readJsonFile(path), path);
  const mcpServers = asJsonObject(root.mcpServers ?? {}, `${path}:mcpServers`);
  root.mcpServers = {
    ...mcpServers,
    ...additionalServers,
    [serverName]: config
  };

  const changed = writeIfChanged(path, `${JSON.stringify(root, null, 2)}\n`, dryRun);
  return { client: "claude", path, changed, dryRun };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringList(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlBareKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(key) ? key : tomlString(key);
}

function tomlInlineTable(entries: readonly [string, string][]): string {
  if (entries.length === 0) return "{}";
  return `{ ${entries.map(([key, value]) => `${tomlBareKey(key)} = ${value}`).join(", ")} }`;
}

function stripCodexMcpServerBlocks(input: string): string {
  const lines = input.split(/\r?\n/u);
  const kept: string[] = [];
  let dropping = false;

  for (const line of lines) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*$/u)?.[1];
    if (table !== undefined) {
      dropping = table === "mcp_servers" || table.startsWith("mcp_servers.");
    }
    if (!dropping) kept.push(line);
  }

  return kept.join("\n").replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}$/u, "\n\n").trimEnd();
}

function codexTomlBlock(serverName: string, config: CicloMcpServerConfig): string {
  const envEntries = Object.entries(config.env)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join("\n");
  return [
    "# Ciclo MCP server; generated by `ciclo mcp install`.",
    `[mcp_servers.${serverName}]`,
    `command = ${tomlString(config.command)}`,
    `args = ${tomlStringList(config.args)}`,
    "",
    `[mcp_servers.${serverName}.env]`,
    envEntries
  ].join("\n");
}

function installCodex(
  projectRoot: string,
  serverName: string,
  config: CicloMcpServerConfig,
  additionalServers: Record<string, CicloMcpAdditionalServerConfig>,
  dryRun: boolean
): CicloMcpInstallTargetResult {
  const path = join(projectRoot, ".codex", "config.toml");
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  const stripped = stripCodexMcpServerBlocks(previous);
  const generatedBlocks = [
    codexTomlBlock(serverName, config),
    ...Object.entries(additionalServers).map(([additionalName, additionalConfig]) => codexTomlBlock(additionalName, additionalConfig))
  ].join("\n\n");
  const next = `${stripped.trimEnd().length === 0 ? "" : `${stripped.trimEnd()}\n\n`}${generatedBlocks}\n`;
  const changed = writeIfChanged(path, next, dryRun);
  return { client: "codex", path, changed, dryRun };
}

export function codexMcpServersOverrideArgs(install: CicloMcpInstallResult): readonly string[] {
  if (!install.targets.some((target) => target.client === "codex")) return [];
  const servers: [string, CicloMcpServerConfig][] = [
    [install.serverName, install.server],
    ...Object.entries(install.additionalServers)
  ];
  const overrideValue = tomlInlineTable(servers.map(([name, server]) => [
    name,
    tomlInlineTable([
      ["command", tomlString(server.command)],
      ["args", tomlStringList(server.args)],
      ["env", tomlInlineTable(Object.entries(server.env).map(([envName, value]) => [envName, tomlString(value)]))]
    ])
  ]));
  return ["-c", `mcp_servers=${overrideValue}`];
}

export function installCicloMcp(options: CicloMcpInstallOptions = {}): CicloMcpInstallResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const serverName = options.serverName ?? "ciclo";
  assertServerName(serverName);

  const clients = uniqueClients(options.clients ?? ["claude"]);
  const command = options.command ?? "ciclo";
  const dryRun = options.dryRun ?? false;
  const claudeChannelEnabled = options.claudeChannel === true;
  const secretEnv = options.secretEnv ?? [];
  const additionalServerSecretEnv = options.additionalServerSecretEnv ?? [];
  const additionalServers = normalizeAdditionalServers(options.additionalServers, serverName);
  const redactedAdditionalServers = redactAdditionalServerSecretEnv(additionalServers, additionalServerSecretEnv);
  if (claudeChannelEnabled && !clients.includes("claude")) {
    throw new Error("--claude-channel requires --client claude or --client all");
  }
  const config = serverConfig(projectRoot, command, claudeChannelEnabled, options.env, secretEnv);
  const redactedConfig = redactSecretEnv(config, secretEnv);
  const claudeChannel: CicloClaudeChannelInstall | undefined = claudeChannelEnabled
    ? {
        enabled: true,
        selector: `server:${serverName}`,
        launchArgs: ["--dangerously-load-development-channels", `server:${serverName}`]
      }
    : undefined;

  const targets = clients.map((client) => {
    if (client === "claude") return installClaude(projectRoot, serverName, config, additionalServers, dryRun);
    return installCodex(projectRoot, serverName, config, additionalServers, dryRun);
  });

  return {
    installed: targets.some((target) => target.changed) && !dryRun,
    projectRoot,
    serverName,
    server: redactedConfig,
    additionalServers: redactedAdditionalServers,
    secretEnv: secretEnvInstall(secretEnv),
    additionalServerSecretEnv,
    ...(claudeChannel === undefined ? {} : { claudeChannel }),
    targets,
    nextSteps: [
      "Start Claude or Codex in the project after restarting the client if it does not hot-reload MCP config.",
      ...(claudeChannel === undefined
        ? []
        : [`Start Claude Code with ${claudeChannel.launchArgs.join(" ")} to enable the Ciclo MCP channel preview.`]),
      "Ask the session to use Ciclo MCP for status, work claims, operator questions, worker launches, and closeout evidence.",
      "Use ciclo mcp install --client codex or --client all when the same project should expose Ciclo to Codex too."
    ]
  };
}

export function renderFreshCicloMcpInstallArtifacts(options: CicloMcpInstallOptions = {}): CicloMcpRenderedInstallPlan {
  const install = installCicloMcp({ ...options, dryRun: true });
  const artifacts = install.targets.map((target): CicloMcpInstallRenderedArtifact => {
    if (target.client === "claude") {
      return {
        client: target.client,
        path: target.path,
        format: "json",
        content: `${JSON.stringify({ mcpServers: { ...install.additionalServers, [install.serverName]: install.server } }, null, 2)}\n`
      };
    }
    return {
      client: target.client,
      path: target.path,
      format: "toml",
      content: `${[
        codexTomlBlock(install.serverName, install.server),
        ...Object.entries(install.additionalServers).map(([serverName, server]) => codexTomlBlock(serverName, server))
      ].join("\n\n")}\n`
    };
  });
  return { install, artifacts };
}
