#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildStandaloneStatus } from "./app.js";
import { runBenchmarkSuite, type BenchmarkRunnerOptions } from "./benchmark-runner.js";
import {
  cicloConfigPath,
  configMcpSecretEnvBindings,
  loadCicloProjectConfig,
  mergeMcpInstallOptionsWithConfig,
  redactedCicloProjectConfig,
  writeSampleCicloConfig
} from "./ciclo-config.js";
import { runtimeDecision } from "./ciclo-core.js";
import { runMcpHttpServer, type McpHttpConfig } from "./mcp-http.js";
import { installCicloMcp, type CicloMcpInstallClient, type CicloMcpInstallOptions, type CicloMcpInstallResult } from "./mcp-install.js";
import { resolveMcpAdditionalServerSecretPlaceholders } from "./mcp-secret-placeholders.js";
import {
  createLocalMcpReadService,
  createLocalMcpRuntimeContextWithPlugins,
  runMcpStdioServer
} from "./mcp-stdio.js";
import {
  defaultPluginPaths,
  installPlugin,
  readPluginConfig,
  setPluginEnabled
} from "./plugin-manager.js";
import { buildCicloAttachPlan } from "./remote-runner.js";
import {
  decodeRuntimeSecretEnvBindings,
  resolveRuntimeSecretEnv,
  type RuntimeSecretEnvBinding
} from "./secret-env-runtime.js";
import { installCicloSkills, type CicloSkillInstallClient } from "./skill-install.js";
import { CICLO_VERSION } from "./version.js";

const DEFAULT_BENCHMARK_DIR = "tests/fixtures/benchmarks";
const DEFAULT_CLAUDE_PERMISSION_MODE = "bypassPermissions";
const DEFAULT_CODEX_APPROVAL_POLICY = "never";
const DEFAULT_CODEX_SANDBOX = "danger-full-access";

export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface CliMcpHttpOptions {
  readonly host: string;
  readonly port: number;
  readonly path?: string;
  readonly maxBodyBytes?: number;
}

export interface CliBenchmarkOptions {
  readonly runner: BenchmarkRunnerOptions;
}

export interface CliAttachOptions {
  readonly remoteTarget?: string;
  readonly herdrSession?: string;
  readonly agentTarget?: string;
  readonly dryRun: boolean;
}

export interface CliMcpInstallOptions {
  readonly projectRoot?: string;
  readonly clients?: readonly CicloMcpInstallClient[];
  readonly serverName?: string;
  readonly command?: string;
  readonly claudeChannel?: boolean;
  readonly dryRun: boolean;
}

export interface CliLaunchOptions {
  readonly projectRoot?: string;
  readonly client: CicloMcpInstallClient;
  readonly herdr: boolean;
  readonly herdrSession?: string;
  readonly paneName?: string;
  readonly attach: boolean;
  readonly harnessCommand?: string;
  readonly mcpCommand?: string;
  readonly serverName?: string;
  readonly claudeChannel?: boolean;
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly approvalPolicy?: string;
  readonly sandbox?: string;
  readonly prompt?: string;
  readonly extraArgs: readonly string[];
  readonly dryRun: boolean;
}

export interface CicloLaunchPlan {
  readonly client: CicloMcpInstallClient;
  readonly launchMode: "herdr" | "terminal";
  readonly projectRoot: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly harnessCommand: string;
  readonly harnessArgs: readonly string[];
  readonly herdr?: {
    readonly sessionName: string;
    readonly paneName: string;
    readonly attach: boolean;
    readonly attachCommand?: string;
    readonly attachArgs?: readonly string[];
  };
  readonly mcpInstall: ReturnType<typeof installCicloMcp>;
  readonly dryRun: boolean;
  readonly evidence: readonly string[];
}

export interface CliSkillInstallOptions {
  readonly projectRoot?: string;
  readonly clients: readonly CicloSkillInstallClient[];
  readonly dryRun: boolean;
}

interface ParsedArgs {
  readonly command: string;
  readonly args: readonly string[];
}

type JsonMode = "pretty" | "compact";

function defaultIo(): CliIo {
  return {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line)
  };
}

function usage(): string {
  return [
    "Usage: ciclo <command> [options]",
    "",
    "Commands:",
    "  status                         Print Ciclo status JSON.",
    "  runtime                        Print runtime/product-boundary JSON.",
    "  benchmark [scenario-dir]       Run benchmark scenarios.",
    "  attach [options]               Attach to Ciclo's Herdr session.",
    "  launch [claude|codex]          Install MCP config and start a Herdr harness session.",
    "  secret exec [options] -- <cmd> Resolve secret env for one child process.",
    "  config <show|init|path>        Manage .ciclo/config.json defaults.",
    "  plugin <subcommand>            Install, list, enable, or disable plugins.",
    "  skill install [options]        Install Ciclo agent skills into a project.",
    "  mcp stdio                      Start the MCP stdio server.",
    "  mcp http [options]             Start the MCP HTTP server.",
    "  mcp install [options]          Install Ciclo MCP config into a project.",
    "  demo                           Alias for status.",
    "  help [command]                 Show help.",
    "",
    "Options:",
    "  -h, --help                     Show help.",
    "  -v, --version                  Show version.",
    "  --json                         Pretty-print JSON output. This is the default.",
    "  --compact                      Print compact JSON output.",
    "",
    "Benchmark options:",
    "  --scenario-dir <dir>           Load scenarios from a directory.",
    "  --real, --real-judge           Score with Pi instead of fixture-only local judges.",
    "  --judge <scenario|pi>          Select judge provider. Default: scenario.",
    "  --model <provider/model>       Pi model for real judging. Default: openai-codex/gpt-5.5.",
    "  --thinking <effort>            Pi thinking effort for real judging. Default: high.",
    "  --limit <count>                Run only the first N scenarios.",
    "  --threshold <score>            Required average score. Default: 0.8.",
    "",
    "MCP HTTP options:",
    "  --host <host>                  Bind host. Default: CICLO_MCP_HTTP_HOST or 127.0.0.1.",
    "  --port <port>                  Bind port. Default: CICLO_MCP_HTTP_PORT or 0.",
    "  --path <path>                  MCP HTTP path. Default: /mcp.",
    "  --max-body-bytes <bytes>       Request body limit. Default: 1048576.",
    "",
    "Examples:",
    "  ciclo status",
    `  ciclo benchmark ${DEFAULT_BENCHMARK_DIR}`,
    "  ciclo attach --session ciclo",
    "  ciclo attach --remote ciclo@10.44.0.2:/workspace/ciclo --session ciclo",
    "  ciclo launch codex",
    "  ciclo launch claude --model claude-fable-5",
    "  ciclo secret exec --binding <payload> -- env",
    "  ciclo plugin install @acme/ciclo-runner-fly --trust",
    "  ciclo skill install --client all --project /path/to/repo",
    "  ciclo mcp stdio",
    "  ciclo mcp http --host 127.0.0.1 --port 7331",
    "  ciclo mcp install --client claude --project /path/to/repo"
  ].join("\n");
}

function commandHelp(command: string): string {
  if (command === "status" || command === "demo") {
    return [
      "Usage: ciclo status [--compact]",
      "",
      "Print standalone Ciclo status JSON. `demo` is an alias for `status`."
    ].join("\n");
  }
  if (command === "runtime") {
    return [
      "Usage: ciclo runtime [--compact]",
      "",
      "Print the runtime decision JSON. Ciclo is the orchestrator; OpenAI is the default brain provider through the Pi SDK adapter."
    ].join("\n");
  }
  if (command === "benchmark") {
    return [
      "Usage: ciclo benchmark [scenario-dir] [--scenario-dir <dir>] [--compact]",
      "",
      "Run benchmark scenario fixtures and print the scored report JSON.",
      "Use --real or --judge pi to score with the local Pi CLI.",
      `Default scenario directory: ${DEFAULT_BENCHMARK_DIR}`
    ].join("\n");
  }
  if (command === "attach") {
    return [
      "Usage: ciclo attach [--remote <herdr-target>] [--session <name>] [--target <agent>] [--dry-run]",
      "",
      "Attach to the overall Ciclo Herdr session, or to one agent target inside it.",
      "Without --dry-run this runs Herdr interactively.",
      "",
      "Examples:",
      "  ciclo attach --session ciclo",
      "  ciclo attach --remote ciclo@10.44.0.2:/workspace/ciclo --session ciclo",
      "  ciclo attach --remote ciclo@10.44.0.2:/workspace/ciclo --session ciclo --target pane-1"
    ].join("\n");
  }
  if (command === "launch") {
    return [
      "Usage: ciclo launch [claude|codex] [options] [-- <harness-args>...]",
      "",
      "Install Ciclo MCP config plus configured additional MCP servers into the project, then launch Claude Code or Codex in a named Herdr session.",
      "",
      "Options:",
      "  --client <claude|codex>        Harness client to launch. Default: codex.",
      "  --project <dir>                Target project root. Default: cwd.",
      "  --session <name>               Herdr session name. Default: project directory name.",
      "  --pane-name <name>             First Herdr pane/agent name. Default: project directory name.",
      "  --terminal, --no-herdr         Launch the harness directly in this terminal instead of Herdr.",
      "  --no-attach                    Start the Herdr pane without attaching to the session.",
      "  --harness-command <command>    Harness executable override. Default: claude or codex.",
      "  --server-name <name>           Ciclo MCP server name. Default: config or ciclo.",
      "  --mcp-command <command>        Ciclo command for clients to run. Default: config or ciclo.",
      "  --claude-channel               Enable Claude Code channel capability for launched Claude sessions.",
      "  --model <model>                Pass model to the harness.",
      "  --effort <effort>              Pass effort to Claude Code.",
      "  --permission-mode <mode>       Pass Claude Code permission mode. Default: bypassPermissions.",
      "  --approval-policy <policy>     Pass approval policy to Codex. Default: never.",
      "  --sandbox <mode>               Pass sandbox mode to Codex. Default: danger-full-access.",
      "  --prompt <text>                Optional initial prompt.",
      "  --extra-arg <arg>              Extra harness arg; may be repeated.",
      "  --dry-run                      Print install and launch plan without writing files or starting Herdr/the harness.",
      "",
      "Examples:",
      "  ciclo launch codex",
      "  ciclo launch codex --session my-project",
      "  ciclo launch claude --model claude-fable-5",
      "  ciclo launch --client codex --prompt \"Review the repo\" -- --full-auto",
      "  ciclo launch codex --terminal"
    ].join("\n");
  }
  if (command === "secret") {
    return [
      "Usage: ciclo secret exec [options] -- <command> [args...]",
      "",
      "Resolve configured secret references immediately before starting one child process.",
      "Generated MCP configs and worker launch plans use this wrapper so resolved secret values are not persisted to project config files.",
      "",
      "Options:",
      "  --binding <payload>            Base64url-encoded secret binding payload. May be repeated.",
      "  --project <dir>                Project root for loading .ciclo/config.json and secret providers. Default: CICLO_PROJECT_ROOT or cwd.",
      "",
      "Example:",
      "  ciclo secret exec --binding <payload> -- mcp-server stdio"
    ].join("\n");
  }
  if (command === "plugin") {
    return [
      "Usage: ciclo plugin <install|list|enable|disable> [options]",
      "",
      "Install and manage third-party Ciclo plugins.",
      "",
      "Commands:",
      "  ciclo plugin install <package> [--path <local-package-dir>] [--trust] [--disable]",
      "  ciclo plugin list [--compact]",
      "  ciclo plugin enable <package>",
      "  ciclo plugin disable <package>",
      "",
      "External plugins must include ciclo.plugin.json and export activate(api)."
    ].join("\n");
  }
  if (command === "config") {
    return [
      "Usage: ciclo config <show|init|path> [options]",
      "",
      "Manage project-level Ciclo configuration stored in .ciclo/config.json.",
      "",
      "Commands:",
      "  ciclo config show [--project <dir>] [--compact]",
      "  ciclo config init [--project <dir>] [--dry-run] [--compact]",
      "  ciclo config path [--project <dir>]",
      "",
      "The config stores secret provider references, MCP defaults, and remote runner defaults. It should not contain raw secret values."
    ].join("\n");
  }
  if (command === "skill") {
    return [
      "Usage: ciclo skill <install> [options]",
      "",
      "Install Ciclo helper skills into a target project.",
      "",
      "Commands:",
      "  ciclo skill install --client all --project /path/to/repo",
      "  ciclo skill install --client claude --project /path/to/repo",
      "  ciclo skill install --client codex --project /path/to/repo",
      "",
      "Install options:",
      "  --client <claude|codex|all>    Skill target to update. Default: all.",
      "  --project <dir>                Target project root. Default: cwd.",
      "  --dry-run                      Print the install plan without writing files.",
      "",
      "Claude skills are written under .claude/skills/.",
      "Codex-compatible skills are written under .agents/skills/."
    ].join("\n");
  }
  if (command === "mcp" || command === "mcp-http" || command === "mcp-stdio") {
    return [
      "Usage: ciclo mcp <stdio|http|install> [options]",
      "",
      "Start a Ciclo MCP server or install project MCP client configuration.",
      "",
      "Stdio:",
      "  ciclo mcp stdio",
      "",
      "HTTP:",
      "  ciclo mcp http --host 127.0.0.1 --port 7331 --path /mcp",
      "",
      "Install:",
      "  ciclo mcp install --client claude --project /path/to/repo",
      "  ciclo mcp install --client codex --project /path/to/repo",
      "  ciclo mcp install --client all --project /path/to/repo",
      "",
      "Install options:",
      "  --client <claude|codex|all>    Client config to update. Default: claude.",
      "  --project <dir>                Target project root. Default: cwd.",
      "  --server-name <name>           MCP server name. Default: ciclo.",
      "  --command <command>            Ciclo command for clients to run. Default: ciclo.",
      "  --claude-channel               Enable Claude Code channel capability for this MCP server.",
      "  --dry-run                      Print the install plan without writing files.",
      "",
      "Legacy aliases are still accepted:",
      "  ciclo mcp-stdio",
      "  ciclo mcp-http"
    ].join("\n");
  }
  return usage();
}

function parseTopLevel(argv: readonly string[]): ParsedArgs {
  const args = argv.slice(2);
  if (args.length === 0) return { command: "help", args: [] };
  const command = args[0] ?? "help";
  return { command, args: args.slice(1) };
}

function parseJsonMode(args: readonly string[]): JsonMode {
  return args.includes("--compact") ? "compact" : "pretty";
}

function assertOnlyJsonOptions(command: string, args: readonly string[]): void {
  for (const arg of args) {
    if (arg === "--json" || arg === "--compact") continue;
    throw new Error(`unexpected ${command} argument: ${arg}`);
  }
}

function printJson(value: unknown, mode: JsonMode, io: CliIo): void {
  io.stdout(JSON.stringify(value, null, mode === "pretty" ? 2 : 0));
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function requireAnyValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePort(value: string, flag: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${flag} must be an integer between 0 and 65535`);
  }
  return port;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export function parseBenchmarkScenarioDir(args: readonly string[]): string | undefined {
  return parseBenchmarkOptions(args).runner.scenarioDir;
}

function parseThreshold(value: string, flag: string): number {
  const threshold = Number.parseFloat(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`${flag} must be a number between 0 and 1`);
  }
  return threshold;
}

export function parseBenchmarkOptions(args: readonly string[]): CliBenchmarkOptions {
  let scenarioDir: string | undefined;
  let judgeProvider: BenchmarkRunnerOptions["judgeProvider"];
  let model: string | undefined;
  let thinking: string | undefined;
  let scenarioLimit: number | undefined;
  let scoreThreshold: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json" || arg === "--compact") continue;
    if (arg === "--real" || arg === "--real-judge") {
      judgeProvider = "pi";
      continue;
    }
    if (arg === "--judge") {
      const value = requireValue(args, index, arg);
      if (value !== "scenario" && value !== "pi") {
        throw new Error("--judge must be scenario or pi");
      }
      judgeProvider = value;
      index += 1;
      continue;
    }
    if (arg === "--model") {
      model = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--thinking") {
      thinking = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      scenarioLimit = parsePositiveInteger(requireValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--threshold") {
      scoreThreshold = parseThreshold(requireValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--scenario-dir") {
      scenarioDir = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new Error(`unknown benchmark option: ${arg}`);
    }
    if (scenarioDir !== undefined) {
      throw new Error(`unexpected benchmark argument: ${arg}`);
    }
    scenarioDir = arg;
  }
  return {
    runner: {
      scenarioDir,
      judgeProvider,
      model,
      thinking,
      scenarioLimit,
      scoreThreshold
    }
  };
}

export function parseMcpHttpOptions(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): CliMcpHttpOptions {
  let host = env.CICLO_MCP_HTTP_HOST ?? "127.0.0.1";
  let port = parsePort(env.CICLO_MCP_HTTP_PORT ?? "0", "CICLO_MCP_HTTP_PORT");
  let path: string | undefined;
  let maxBodyBytes: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") {
      host = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--port") {
      port = parsePort(requireValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--path") {
      path = requireValue(args, index, arg);
      if (!path.startsWith("/")) throw new Error("--path must start with /");
      index += 1;
      continue;
    }
    if (arg === "--max-body-bytes") {
      maxBodyBytes = parsePositiveInteger(requireValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--json" || arg === "--compact") continue;
    throw new Error(`unknown MCP HTTP option: ${arg}`);
  }

  return { host, port, path, maxBodyBytes };
}

function parseMcpInstallClient(value: string): readonly CicloMcpInstallClient[] {
  if (value === "claude") return ["claude"];
  if (value === "codex") return ["codex"];
  if (value === "all") return ["claude", "codex"];
  throw new Error("--client must be claude, codex, or all");
}

function parseLaunchClient(value: string): CicloMcpInstallClient {
  if (value === "claude" || value === "claude-code") return "claude";
  if (value === "codex") return "codex";
  throw new Error("--client must be claude or codex");
}

function parseSkillInstallClient(value: string): readonly CicloSkillInstallClient[] {
  if (value === "claude") return ["claude"];
  if (value === "codex") return ["codex"];
  if (value === "all") return ["claude", "codex"];
  throw new Error("--client must be claude, codex, or all");
}

export function parseMcpInstallOptions(args: readonly string[]): CliMcpInstallOptions {
  let projectRoot: string | undefined;
  let clients: readonly CicloMcpInstallClient[] | undefined;
  let serverName: string | undefined;
  let command: string | undefined;
  let claudeChannel = false;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--client") {
      clients = parseMcpInstallClient(requireValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--project") {
      projectRoot = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--server-name") {
      serverName = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--command") {
      command = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--claude-channel") {
      claudeChannel = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json" || arg === "--compact") continue;
    throw new Error(`unknown MCP install option: ${arg}`);
  }

  return {
    ...(projectRoot === undefined ? {} : { projectRoot }),
    clients,
    ...(serverName === undefined ? {} : { serverName }),
    ...(command === undefined ? {} : { command }),
    ...(claudeChannel ? { claudeChannel } : {}),
    dryRun
  };
}

export function parseLaunchOptions(args: readonly string[]): CliLaunchOptions {
  let projectRoot: string | undefined;
  let client: CicloMcpInstallClient = "codex";
  let herdr = true;
  let herdrSession: string | undefined;
  let paneName: string | undefined;
  let attach = true;
  let harnessCommand: string | undefined;
  let mcpCommand: string | undefined;
  let serverName: string | undefined;
  let claudeChannel: boolean | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let permissionMode: string | undefined;
  let approvalPolicy: string | undefined;
  let sandbox: string | undefined;
  let prompt: string | undefined;
  let dryRun = false;
  const extraArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      extraArgs.push(...args.slice(index + 1));
      break;
    }
    if (arg === "claude" || arg === "claude-code" || arg === "codex") {
      client = parseLaunchClient(arg);
      continue;
    }
    if (arg === "--client" || arg === "--harness") {
      client = parseLaunchClient(requireValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--project") {
      projectRoot = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--herdr") {
      herdr = true;
      continue;
    }
    if (arg === "--terminal" || arg === "--no-herdr") {
      herdr = false;
      continue;
    }
    if (arg === "--session" || arg === "--herdr-session") {
      herdrSession = requireValue(args, index, arg);
      herdr = true;
      index += 1;
      continue;
    }
    if (arg === "--pane-name" || arg === "--agent-name") {
      paneName = requireValue(args, index, arg);
      herdr = true;
      index += 1;
      continue;
    }
    if (arg === "--no-attach") {
      attach = false;
      continue;
    }
    if (arg === "--attach") {
      attach = true;
      continue;
    }
    if (arg === "--harness-command") {
      harnessCommand = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--mcp-command") {
      mcpCommand = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--server-name") {
      serverName = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--claude-channel") {
      claudeChannel = true;
      continue;
    }
    if (arg === "--model") {
      model = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--effort") {
      effort = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--permission-mode") {
      permissionMode = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--approval-policy" || arg === "--ask-for-approval") {
      approvalPolicy = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--sandbox") {
      sandbox = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--prompt") {
      prompt = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--extra-arg") {
      extraArgs.push(requireAnyValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json" || arg === "--compact") continue;
    throw new Error(`unknown launch option: ${arg}`);
  }

  return {
    ...(projectRoot === undefined ? {} : { projectRoot }),
    client,
    herdr,
    ...(herdrSession === undefined ? {} : { herdrSession }),
    ...(paneName === undefined ? {} : { paneName }),
    attach,
    ...(harnessCommand === undefined ? {} : { harnessCommand }),
    ...(mcpCommand === undefined ? {} : { mcpCommand }),
    ...(serverName === undefined ? {} : { serverName }),
    ...(claudeChannel === undefined ? {} : { claudeChannel }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(prompt === undefined ? {} : { prompt }),
    extraArgs,
    dryRun
  };
}

export function parseSkillInstallOptions(args: readonly string[]): CliSkillInstallOptions {
  let projectRoot: string | undefined;
  let clients: readonly CicloSkillInstallClient[] = ["claude", "codex"];
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--client") {
      clients = parseSkillInstallClient(requireValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--project") {
      projectRoot = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json" || arg === "--compact") continue;
    throw new Error(`unknown skill install option: ${arg}`);
  }

  return {
    ...(projectRoot === undefined ? {} : { projectRoot }),
    clients,
    dryRun
  };
}

export function parseAttachOptions(args: readonly string[]): CliAttachOptions {
  let remoteTarget: string | undefined;
  let herdrSession: string | undefined;
  let agentTarget: string | undefined;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--remote") {
      remoteTarget = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--session") {
      herdrSession = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--target") {
      agentTarget = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json" || arg === "--compact") continue;
    throw new Error(`unknown attach option: ${arg}`);
  }

  return {
    ...(remoteTarget === undefined ? {} : { remoteTarget }),
    ...(herdrSession === undefined ? {} : { herdrSession }),
    ...(agentTarget === undefined ? {} : { agentTarget }),
    dryRun
  };
}

function mcpHttpConfig(options: CliMcpHttpOptions): Partial<McpHttpConfig> {
  return {
    host: options.host,
    port: options.port,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes })
  };
}

async function startMcpHttp(args: readonly string[], io: CliIo): Promise<number> {
  const options = parseMcpHttpOptions(args);
  const root = projectRootFromEnv();
  const server = await runMcpHttpServer(
    mcpHttpConfig(options),
    createLocalMcpReadService(root),
    await createLocalMcpRuntimeContextWithPlugins(root)
  );
  const address = server.address();
  if (address !== null && typeof address === "object") {
    const path = options.path ?? "/mcp";
    io.stderr(`ciclo MCP HTTP listening on http://${formatAddress(address)}${path}`);
  }
  return 0;
}

function formatAddress(address: AddressInfo): string {
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  return `${host}:${address.port}`;
}

function projectRootFromEnv(): string {
  return process.env.CICLO_PROJECT_ROOT ?? process.cwd();
}

async function configuredMcpInstall(options: CicloMcpInstallOptions): Promise<CicloMcpInstallResult> {
  const root = options.projectRoot ?? process.cwd();
  const loaded = loadCicloProjectConfig(root);
  const runtime = await createLocalMcpRuntimeContextWithPlugins(root);
  if (runtime.secretProviderRegistry === undefined) throw new Error("MCP install secret provider registry is unavailable");
  const secretProviderRegistry = runtime.secretProviderRegistry;
  const dryRun = options.dryRun ?? false;
  const merged = mergeMcpInstallOptionsWithConfig({
    ...options,
    projectRoot: root,
    secretEnv: configMcpSecretEnvBindings(loaded.config)
  }, loaded.config);
  const additionalServerSecrets = await resolveMcpAdditionalServerSecretPlaceholders({
    additionalServers: merged.additionalServers,
    dryRun,
    resolveSecret: async (request) => await secretProviderRegistry.resolve({
      providerId: request.providerId,
      secretRef: request.secretRef,
      field: request.field,
      reason: request.reason,
      dryRun
    })
  });
  return installCicloMcp({
    ...merged,
    additionalServers: additionalServerSecrets.additionalServers,
    additionalServerSecretEnv: additionalServerSecrets.secretEnv
  });
}

function launchCommand(options: CliLaunchOptions): string {
  return options.harnessCommand ?? (options.client === "claude" ? "claude" : "codex");
}

function projectLaunchName(root: string): string {
  const name = basename(resolve(root))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name.length === 0 ? "ciclo" : name;
}

function herdrSessionName(options: CliLaunchOptions, projectRoot: string): string {
  return options.herdrSession ?? projectLaunchName(projectRoot);
}

function herdrPaneName(options: CliLaunchOptions, projectRoot: string): string {
  return options.paneName ?? projectLaunchName(projectRoot);
}

function herdrStartArgs(
  sessionName: string,
  paneName: string,
  cwd: string,
  command: string,
  args: readonly string[]
): readonly string[] {
  return ["--session", sessionName, "agent", "start", paneName, "--cwd", cwd, "--focus", "--", command, ...args];
}

function herdrAttachArgs(sessionName: string): readonly string[] {
  return ["session", "attach", sessionName];
}

function appendClaudePermissionMode(args: string[], value: string | undefined): void {
  const mode = value?.trim() || DEFAULT_CLAUDE_PERMISSION_MODE;
  if (mode === undefined || mode.length === 0 || mode === "default") return;
  args.push("--permission-mode", mode);
}

function effectiveCliPermissionEvidence(options: CliLaunchOptions): readonly string[] {
  if (options.client === "claude") {
    return [`ciclo.launch.permission_mode:${options.permissionMode?.trim() || DEFAULT_CLAUDE_PERMISSION_MODE}`];
  }
  return [
    `ciclo.launch.approval_policy:${options.approvalPolicy ?? DEFAULT_CODEX_APPROVAL_POLICY}`,
    `ciclo.launch.sandbox:${options.sandbox ?? DEFAULT_CODEX_SANDBOX}`
  ];
}

function launchArgs(options: CliLaunchOptions, projectRoot: string, install: CicloMcpInstallResult): readonly string[] {
  const args: string[] = [];
  if (options.client === "claude") {
    if (install.claudeChannel !== undefined) args.push(...install.claudeChannel.launchArgs);
    if (options.model !== undefined) args.push("--model", options.model);
    if (options.effort !== undefined) args.push("--effort", options.effort);
    appendClaudePermissionMode(args, options.permissionMode);
    args.push(...options.extraArgs);
    if (options.prompt !== undefined) args.push(options.prompt);
    return args;
  }
  if (options.model !== undefined) args.push("--model", options.model);
  args.push("--cd", projectRoot);
  args.push("--ask-for-approval", options.approvalPolicy ?? DEFAULT_CODEX_APPROVAL_POLICY);
  args.push("--sandbox", options.sandbox ?? DEFAULT_CODEX_SANDBOX);
  args.push(...options.extraArgs);
  if (options.prompt !== undefined) args.push(options.prompt);
  return args;
}

async function buildLaunchPlan(options: CliLaunchOptions): Promise<CicloLaunchPlan> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const install = await configuredMcpInstall({
    projectRoot,
    clients: [options.client],
    ...(options.serverName === undefined ? {} : { serverName: options.serverName }),
    ...(options.mcpCommand === undefined ? {} : { command: options.mcpCommand }),
    claudeChannel: options.client === "claude" ? options.claudeChannel : false,
    dryRun: options.dryRun
  });
  const harnessCommand = launchCommand(options);
  const harnessArgs = launchArgs(options, projectRoot, install);
  const sessionName = herdrSessionName(options, projectRoot);
  const paneName = herdrPaneName(options, projectRoot);
  const attachArgs = herdrAttachArgs(sessionName);
  const launchMode = options.herdr ? "herdr" : "terminal";
  const command = options.herdr ? "herdr" : harnessCommand;
  const args = options.herdr ? herdrStartArgs(sessionName, paneName, projectRoot, harnessCommand, harnessArgs) : harnessArgs;
  return {
    client: options.client,
    launchMode,
    projectRoot,
    command,
    args,
    harnessCommand,
    harnessArgs,
    ...(options.herdr ? {
      herdr: {
        sessionName,
        paneName,
        attach: options.attach,
        ...(options.attach ? { attachCommand: "herdr", attachArgs } : {})
      }
    } : {}),
    mcpInstall: install,
    dryRun: options.dryRun,
    evidence: [
      "ciclo.launch:planned",
      `ciclo.launch.client:${options.client}`,
      `ciclo.launch.mode:${launchMode}`,
      `ciclo.launch.project_root:${projectRoot}`,
      ...(options.herdr ? [
        `ciclo.launch.herdr_session:${sessionName}`,
        `ciclo.launch.herdr_pane:${paneName}`
      ] : []),
      ...effectiveCliPermissionEvidence(options),
      `ciclo.launch.mcp_targets:${install.targets.map((target) => target.client).join(",")}`,
      options.dryRun ? "ciclo.launch.dry_run:true" : "ciclo.launch.dry_run:false"
    ]
  };
}

async function runLaunch(args: readonly string[], io: CliIo): Promise<number> {
  const options = parseLaunchOptions(args);
  const plan = await buildLaunchPlan(options);
  if (options.dryRun) {
    printJson(plan, parseJsonMode(args), io);
    return 0;
  }
  const result = spawnSync(plan.command, [...plan.args], {
    cwd: plan.projectRoot,
    stdio: "inherit"
  });
  if (result.status !== 0 || plan.launchMode !== "herdr" || plan.herdr?.attachCommand === undefined) return result.status ?? 1;
  const attach = spawnSync(plan.herdr.attachCommand, [...(plan.herdr.attachArgs ?? [])], {
    cwd: plan.projectRoot,
    stdio: "inherit"
  });
  return attach.status ?? 1;
}

function parseSecretExecArgs(args: readonly string[]): {
  readonly projectRoot?: string;
  readonly bindings: readonly RuntimeSecretEnvBinding[];
  readonly command: string;
  readonly commandArgs: readonly string[];
} {
  let projectRoot: string | undefined;
  const bindings: RuntimeSecretEnvBinding[] = [];
  let commandStart = -1;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      commandStart = index + 1;
      break;
    }
    if (arg === "--project") {
      projectRoot = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--binding") {
      bindings.push(...decodeRuntimeSecretEnvBindings(requireValue(args, index, arg)));
      index += 1;
      continue;
    }
    if (arg === "--json" || arg === "--compact") continue;
    throw new Error(`unknown secret exec option: ${arg}`);
  }

  if (commandStart < 0) throw new Error("secret exec requires -- before the child command");
  const command = args[commandStart];
  if (command === undefined || command.length === 0) throw new Error("secret exec requires a child command");
  return {
    ...(projectRoot === undefined ? {} : { projectRoot }),
    bindings,
    command,
    commandArgs: args.slice(commandStart + 1)
  };
}

async function runSecret(args: readonly string[], _io: CliIo): Promise<number> {
  const subcommand = args[0];
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    _io.stdout(commandHelp("secret"));
    return 0;
  }
  if (subcommand !== "exec") throw new Error(`unknown secret subcommand: ${subcommand}`);

  const options = parseSecretExecArgs(args.slice(1));
  const projectRoot = resolve(options.projectRoot ?? process.env.CICLO_PROJECT_ROOT ?? process.cwd());
  const runtime = await createLocalMcpRuntimeContextWithPlugins(projectRoot);
  if (runtime.secretProviderRegistry === undefined) {
    throw new Error("secret provider registry is unavailable");
  }
  const secretEnv = await resolveRuntimeSecretEnv({
    bindings: options.bindings,
    registry: runtime.secretProviderRegistry
  });
  const result = spawnSync(options.command, [...options.commandArgs], {
    cwd: process.cwd(),
    env: { ...process.env, ...secretEnv },
    stdio: "inherit"
  });
  return result.status ?? 1;
}

async function runMcp(args: readonly string[], io: CliIo): Promise<number> {
  const transport = args[0];
  if (transport === undefined || transport === "--help" || transport === "-h") {
    io.stdout(commandHelp("mcp"));
    return 0;
  }
  if (transport === "stdio") {
    const root = projectRootFromEnv();
    await runMcpStdioServer(
      process.stdin,
      process.stdout,
      createLocalMcpReadService(root),
      await createLocalMcpRuntimeContextWithPlugins(root)
    );
    return 0;
  }
  if (transport === "http") {
    return await startMcpHttp(args.slice(1), io);
  }
  if (transport === "install") {
    const options = parseMcpInstallOptions(args.slice(1));
    printJson(await configuredMcpInstall(options), parseJsonMode(args), io);
    return 0;
  }
  throw new Error(`unknown MCP transport: ${transport}`);
}

function runAttach(args: readonly string[], io: CliIo): number {
  const options = parseAttachOptions(args);
  const plan = buildCicloAttachPlan({
    remoteTarget: options.remoteTarget,
    session: options.herdrSession,
    target: options.agentTarget
  });
  if (options.dryRun) {
    printJson(plan, parseJsonMode(args), io);
    return 0;
  }
  const result = spawnSync(plan.command, [...plan.args], { stdio: "inherit" });
  return result.status ?? 1;
}

function parseProjectAndDryRun(args: readonly string[]): { readonly projectRoot?: string; readonly dryRun: boolean } {
  let projectRoot: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project") {
      projectRoot = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json" || arg === "--compact") continue;
    throw new Error(`unknown config option: ${arg}`);
  }
  return { ...(projectRoot === undefined ? {} : { projectRoot }), dryRun };
}

function runConfig(args: readonly string[], io: CliIo): number {
  const subcommand = args[0];
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    io.stdout(commandHelp("config"));
    return 0;
  }
  const rest = args.slice(1);
  const parsed = parseProjectAndDryRun(rest);
  const root = parsed.projectRoot ?? process.cwd();
  if (subcommand === "path") {
    printJson({ path: cicloConfigPath(root) }, parseJsonMode(rest), io);
    return 0;
  }
  if (subcommand === "show") {
    const loaded = loadCicloProjectConfig(root);
    printJson({ ...loaded, config: redactedCicloProjectConfig(loaded.config) }, parseJsonMode(rest), io);
    return 0;
  }
  if (subcommand === "init") {
    const initialized = writeSampleCicloConfig(root, parsed.dryRun);
    printJson({ ...initialized, config: redactedCicloProjectConfig(initialized.config) }, parseJsonMode(rest), io);
    return 0;
  }
  throw new Error(`unknown config subcommand: ${subcommand}`);
}

function requirePluginPackage(args: readonly string[], index: number, command: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`plugin ${command} requires a package name`);
  }
  return value;
}

function runPlugin(args: readonly string[], io: CliIo): number {
  const subcommand = args[0];
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    io.stdout(commandHelp("plugin"));
    return 0;
  }
  const rest = args.slice(1);
  const paths = defaultPluginPaths(process.cwd());
  if (subcommand === "list") {
    for (const arg of rest) {
      if (arg !== "--json" && arg !== "--compact") throw new Error(`unknown plugin list option: ${arg}`);
    }
    printJson(readPluginConfig(paths), parseJsonMode(rest), io);
    return 0;
  }
  if (subcommand === "enable" || subcommand === "disable") {
    const packageName = requirePluginPackage(rest, 0, subcommand);
    if (rest.length > 1) throw new Error(`unexpected plugin ${subcommand} argument: ${rest[1]}`);
    printJson(setPluginEnabled(packageName, subcommand === "enable", paths), "pretty", io);
    return 0;
  }
  if (subcommand === "install") {
    const packageName = requirePluginPackage(rest, 0, "install");
    let pluginPath: string | undefined;
    let trust = false;
    let enable = true;
    for (let index = 1; index < rest.length; index += 1) {
      const arg = rest[index];
      if (arg === "--path") {
        pluginPath = requireValue(rest, index, arg);
        index += 1;
        continue;
      }
      if (arg === "--trust") {
        trust = true;
        continue;
      }
      if (arg === "--disable") {
        enable = false;
        continue;
      }
      if (arg === "--enable") {
        enable = true;
        continue;
      }
      if (arg === "--json" || arg === "--compact") continue;
      throw new Error(`unknown plugin install option: ${arg}`);
    }
    printJson(
      installPlugin({ packageName, path: pluginPath, trust, enable }, paths),
      parseJsonMode(rest),
      io
    );
    return 0;
  }
  throw new Error(`unknown plugin subcommand: ${subcommand}`);
}

function runSkill(args: readonly string[], io: CliIo): number {
  const subcommand = args[0];
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    io.stdout(commandHelp("skill"));
    return 0;
  }
  if (subcommand !== "install") {
    throw new Error(`unknown skill subcommand: ${subcommand}`);
  }
  const options = parseSkillInstallOptions(args.slice(1));
  printJson(installCicloSkills(options), parseJsonMode(args), io);
  return 0;
}

export async function main(argv: readonly string[] = process.argv, io: CliIo = defaultIo()): Promise<number> {
  const parsed = parseTopLevel(argv);
  const command = parsed.command;
  const args = parsed.args;

  try {
    if (command === "--help" || command === "-h" || command === "help") {
      const topic = args[0];
      io.stdout(topic === undefined ? usage() : commandHelp(topic));
      return 0;
    }

    if (command === "--version" || command === "-v" || command === "version") {
      io.stdout(CICLO_VERSION);
      return 0;
    }

    if (command === "secret") {
      return await runSecret(args, io);
    }

    if (args.includes("--help") || args.includes("-h")) {
      io.stdout(commandHelp(command));
      return 0;
    }

    if (command === "status" || command === "demo") {
      assertOnlyJsonOptions(command, args);
      printJson(buildStandaloneStatus(), parseJsonMode(args), io);
      return 0;
    }

    if (command === "runtime") {
      assertOnlyJsonOptions(command, args);
      printJson(runtimeDecision, parseJsonMode(args), io);
      return 0;
    }

    if (command === "benchmark") {
      const options = parseBenchmarkOptions(args);
      printJson(await runBenchmarkSuite(options.runner), parseJsonMode(args), io);
      return 0;
    }

    if (command === "attach") {
      return runAttach(args, io);
    }

    if (command === "launch") {
      return await runLaunch(args, io);
    }
    if (command === "plugin") {
      return runPlugin(args, io);
    }

    if (command === "config") {
      return runConfig(args, io);
    }

    if (command === "skill") {
      return runSkill(args, io);
    }

    if (command === "mcp") {
      return await runMcp(args, io);
    }

    if (command === "mcp-stdio") {
      const root = projectRootFromEnv();
      await runMcpStdioServer(
        process.stdin,
        process.stdout,
        createLocalMcpReadService(root),
        await createLocalMcpRuntimeContextWithPlugins(root)
      );
      return 0;
    }

    if (command === "mcp-http") {
      return await startMcpHttp(args, io);
    }

    io.stderr(`unknown ciclo command: ${command}`);
    io.stderr("Run `ciclo --help` for usage.");
    return 2;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "unknown ciclo CLI error");
    io.stderr("Run `ciclo --help` for usage.");
    return 2;
  }
}

function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(modulePath) === realpathSync(entrypoint);
  } catch {
    return modulePath === entrypoint;
  }
}

if (isCliEntrypoint()) {
  process.exitCode = await main();
}
