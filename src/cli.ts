#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { buildStandaloneStatus } from "./app.js";
import { runBenchmarkSuite, type BenchmarkRunnerOptions } from "./benchmark-runner.js";
import { runtimeDecision } from "./ciclo-core.js";
import { runMcpHttpServer, type McpHttpConfig } from "./mcp-http.js";
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

const VERSION = "0.1.0";
const DEFAULT_BENCHMARK_DIR = "tests/fixtures/benchmarks";

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
    "  plugin <subcommand>            Install, list, enable, or disable plugins.",
    "  mcp stdio                      Start the MCP stdio server.",
    "  mcp http [options]             Start the MCP HTTP server.",
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
    "  ciclo plugin install @acme/ciclo-runner-fly --trust",
    "  ciclo mcp stdio",
    "  ciclo mcp http --host 127.0.0.1 --port 7331"
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
      "Print the runtime decision JSON. Ciclo is the orchestrator; Pi is an internal brain provider."
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
  if (command === "mcp" || command === "mcp-http" || command === "mcp-stdio") {
    return [
      "Usage: ciclo mcp <stdio|http> [options]",
      "",
      "Start a Ciclo MCP server.",
      "",
      "Stdio:",
      "  ciclo mcp stdio",
      "",
      "HTTP:",
      "  ciclo mcp http --host 127.0.0.1 --port 7331 --path /mcp",
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
  const root = process.cwd();
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

async function runMcp(args: readonly string[], io: CliIo): Promise<number> {
  const transport = args[0];
  if (transport === undefined || transport === "--help" || transport === "-h") {
    io.stdout(commandHelp("mcp"));
    return 0;
  }
  if (transport === "stdio") {
    const root = process.cwd();
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
      io.stdout(VERSION);
      return 0;
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

    if (command === "plugin") {
      return runPlugin(args, io);
    }

    if (command === "mcp") {
      return await runMcp(args, io);
    }

    if (command === "mcp-stdio") {
      const root = process.cwd();
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
