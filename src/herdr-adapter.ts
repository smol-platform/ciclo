import { spawn } from "node:child_process";

import { normalizeHarness, type AgentState, type HarnessId, type HerdrObservation } from "./ciclo-core.js";
import { redactContextMemory } from "./context-redaction.js";

export interface CommandResult {
  readonly args: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HerdrTarget {
  readonly id: string;
  readonly cwd?: string;
  readonly agentLabel?: string;
  readonly harness: HarnessId;
}

export interface HerdrRemoteAttachConfig {
  readonly target: string;
  readonly session?: string;
}

export type HerdrRemoteSetupBlockerKind =
  | "missing_remote_herdr"
  | "unsupported_remote_platform"
  | "attach_failed";

export interface HerdrRemoteSetupBlocker {
  readonly kind: HerdrRemoteSetupBlockerKind;
  readonly operatorMessage: string;
  readonly evidence: readonly string[];
}

export type HerdrRunner = (args: readonly string[], timeoutMs: number) => Promise<CommandResult>;

export class HerdrError extends Error {
  constructor(
    message: string,
    readonly kind: "unavailable" | "command_failed" | "parse_failed",
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

export const defaultRunner: HerdrRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const [binary, ...rest] = args;
    if (binary === undefined) {
      reject(new HerdrError("missing herdr command", "command_failed"));
      return;
    }

    const child = spawn(binary, rest, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new HerdrError(`herdr command timed out after ${timeoutMs}ms`, "command_failed"));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(new HerdrError(`${binary} binary not found`, "unavailable", { binary }));
        return;
      }
      reject(new HerdrError(error.message, "command_failed", { binary }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        args,
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });

function stringValue(data: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizeState(value: string | undefined): AgentState {
  const text = (value ?? "").trim().toLowerCase();
  if (["working", "busy", "running", "thinking", "executing"].includes(text)) return "working";
  if (["blocked", "needs_input", "needs-input", "error", "failed"].includes(text)) return "blocked";
  if (["done", "complete", "completed", "finished", "success"].includes(text)) return "done";
  if (["idle", "waiting", "ready", "stopped"].includes(text)) return "idle";
  return "unknown";
}

function evidenceFromPayload(payload: Record<string, unknown>): readonly string[] {
  const evidence: string[] = [];
  for (const key of ["evidence", "reasons", "reason", "explanation", "summary", "status", "state"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      evidence.push(`herdr:${value.trim()}`);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim().length > 0) {
          evidence.push(`herdr:${item.trim()}`);
        }
      }
    }
  }
  return [...new Set(evidence)];
}

function explainPayloadEvidence(
  raw: string,
  payload: Record<string, unknown>,
  fallbackReason?: string
): readonly string[] {
  const evidence: string[] = [];
  const matchedRule = stringValue(payload, "matched_rule", "matchedRule", "rule");
  const fallback = fallbackReason ?? stringValue(payload, "fallback_reason", "fallbackReason");
  const visibleFlags = payload.visible_flags ?? payload.visibleFlags ?? payload.flags;

  if (matchedRule !== undefined) {
    evidence.push(`herdr.explain.matched_rule:${matchedRule}`);
  }
  if (Array.isArray(visibleFlags)) {
    for (const flag of visibleFlags) {
      if (typeof flag === "string" && flag.trim().length > 0) {
        evidence.push(`herdr.explain.visible_flag:${flag.trim()}`);
      }
    }
  } else if (visibleFlags !== null && typeof visibleFlags === "object") {
    for (const [flag, value] of Object.entries(visibleFlags)) {
      if (typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
        evidence.push(`herdr.explain.visible_flag:${flag}=${String(value)}`);
      }
    }
  }
  if (fallback !== undefined) {
    evidence.push(`herdr.explain.fallback_reason:${fallback}`);
  }

  const redactedRaw = redactContextMemory({ text: raw.trim() }).text.replace(/\s+/g, " ").slice(0, 2000);
  if (redactedRaw.length > 0) {
    evidence.push(`herdr.explain.raw_payload:${redactedRaw}`);
  }

  return [...new Set(evidence)];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function parseExplainJson(raw: string, target = "unknown"): HerdrObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HerdrError("Herdr explain output is not valid JSON", "parse_failed", { cause: error });
  }

  const root = objectRecord(parsed);
  if (root === undefined) {
    throw new HerdrError("Herdr explain JSON must be an object", "parse_failed");
  }

  const agent = objectRecord(root.agent);
  const payload = agent === undefined ? root : { ...root, ...agent };
  const agentLabel = stringValue(payload, "harness", "agent", "label", "detected_agent", "name");
  const stateValue = stringValue(payload, "state", "status", "agent_state");
  const normalizedTarget = stringValue(payload, "target", "terminal", "pane", "id") ?? target;
  const cwd = stringValue(payload, "cwd", "working_directory", "project_path");

  return {
    source: "herdr",
    target: normalizedTarget,
    harness: normalizeHarness(agentLabel),
    state: normalizeState(stateValue),
    cwd,
    agentLabel,
    evidence: [...evidenceFromPayload(payload), ...explainPayloadEvidence(raw, payload)]
  };
}

export function parseExplainText(
  raw: string,
  target = "unknown",
  fallbackReason = "text_output"
): HerdrObservation {
  const lowered = raw.toLowerCase();
  const state =
    (["working", "blocked", "done", "idle"] as const).find((candidate) =>
      lowered.includes(candidate)
    ) ?? normalizeState(lowered);
  const targetMatch = raw.match(/^Target:\s*(?<target>.+)$/im);
  const cwdMatch = raw.match(/^Cwd:\s*(?<cwd>.+)$/im);
  const evidence = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 5)
    .map((line) => `herdr:${line}`);

  return {
    source: "herdr",
    target: targetMatch?.groups?.target?.trim() ?? target,
    harness: normalizeHarness(raw),
    state,
    cwd: cwdMatch?.groups?.cwd?.trim(),
    agentLabel: undefined,
    evidence: [
      ...(evidence.length > 0 ? evidence : [`herdr:target=${target}`]),
      ...explainPayloadEvidence(raw, {}, fallbackReason)
    ]
  };
}

function targetFromObject(value: Record<string, unknown>): HerdrTarget | undefined {
  const id = stringValue(value, "id", "target", "pane", "terminal", "name");
  if (id === undefined) return undefined;
  const agent = objectRecord(value.agent);
  const payload = agent === undefined ? value : { ...value, ...agent };
  const agentLabel = stringValue(payload, "harness", "agent", "label", "detected_agent", "name");
  return {
    id,
    cwd: stringValue(payload, "cwd", "working_directory", "project_path"),
    agentLabel,
    harness: normalizeHarness(agentLabel)
  };
}

function remoteArgs(config: HerdrRemoteAttachConfig, args: readonly string[]): readonly string[] {
  return [
    "--remote",
    config.target,
    ...(config.session === undefined ? [] : ["--session", config.session]),
    ...args
  ];
}

function redactedRemoteValue(value: string): string {
  return redactContextMemory({ text: value }).text;
}

export function herdrRemoteAuditEvidence(
  config: HerdrRemoteAttachConfig,
  args: readonly string[] = []
): readonly string[] {
  return [
    `herdr.remote.target:${redactedRemoteValue(config.target)}`,
    ...(config.session === undefined ? [] : [`herdr.remote.session:${redactedRemoteValue(config.session)}`]),
    `herdr.remote.args:${["herdr", ...remoteArgs(config, args)].map(redactedRemoteValue).join(" ")}`
  ];
}

export function classifyHerdrRemoteSetupBlocker(error: HerdrError): HerdrRemoteSetupBlocker {
  const text = `${error.message} ${JSON.stringify(error.details)}`.toLowerCase();
  if (
    text.includes("herdr: command not found") ||
    text.includes("herdr command not found") ||
    text.includes("remote herdr") ||
    text.includes("no such file or directory")
  ) {
    return {
      kind: "missing_remote_herdr",
      operatorMessage: "Remote Herdr is not installed or not on PATH for the configured target.",
      evidence: ["herdr.remote.blocker:missing_remote_herdr"]
    };
  }
  if (text.includes("unsupported") || text.includes("platform")) {
    return {
      kind: "unsupported_remote_platform",
      operatorMessage: "The configured remote platform is not supported by Herdr remote attach.",
      evidence: ["herdr.remote.blocker:unsupported_remote_platform"]
    };
  }
  return {
    kind: "attach_failed",
    operatorMessage: "Herdr remote attach failed for the configured target.",
    evidence: ["herdr.remote.blocker:attach_failed"]
  };
}

export function parseTargetList(raw: string): readonly HerdrTarget[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const values = Array.isArray(parsed) ? parsed : objectRecord(parsed)?.targets;
    if (Array.isArray(values)) {
      return values
        .map((value) => objectRecord(value))
        .filter((value): value is Record<string, unknown> => value !== undefined)
        .map(targetFromObject)
        .filter((value): value is HerdrTarget => value !== undefined);
    }
  } catch {
    // Fall through to line-oriented parsing for older Herdr output.
  }

  return trimmed.split(/\r?\n/).flatMap((line) => {
    const [id, ...rest] = line.trim().split(/\s+/);
    if (id === undefined || id.length === 0) return [];
    const agentLabel = rest.join(" ") || undefined;
    return [{ id, agentLabel, harness: normalizeHarness(agentLabel) }];
  });
}

export class HerdrClient {
  constructor(
    readonly binary = "herdr",
    readonly timeoutMs = 3000,
    readonly runner: HerdrRunner = defaultRunner
  ) {}

  private async run(args: readonly string[]): Promise<CommandResult> {
    const result = await this.runner([this.binary, ...args], this.timeoutMs);
    if (result.code !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || "unknown Herdr error";
      throw new HerdrError(message, "command_failed", {
        code: result.code,
        args: result.args
      });
    }
    return result;
  }

  private async runRemote(config: HerdrRemoteAttachConfig, args: readonly string[]): Promise<CommandResult> {
    try {
      return await this.run(remoteArgs(config, args));
    } catch (error) {
      if (error instanceof HerdrError) {
        throw new HerdrError(error.message, error.kind, {
          ...error.details,
          remoteSetupBlocker: classifyHerdrRemoteSetupBlocker(error),
          auditEvidence: herdrRemoteAuditEvidence(config, args)
        });
      }
      throw error;
    }
  }

  async listTargets(): Promise<readonly HerdrTarget[]> {
    const result = await this.run(["agent", "list", "--json"]);
    return parseTargetList(result.stdout);
  }

  async listRemoteTargets(config: HerdrRemoteAttachConfig): Promise<readonly HerdrTarget[]> {
    const result = await this.runRemote(config, ["agent", "list", "--json"]);
    return parseTargetList(result.stdout);
  }

  async explain(target: string): Promise<HerdrObservation> {
    const result = await this.run(["agent", "explain", target, "--json"]);
    try {
      return parseExplainJson(result.stdout, target);
    } catch (error) {
      if (error instanceof HerdrError) {
        return parseExplainText(result.stdout, target, "json_parse_failed");
      }
      throw error;
    }
  }

  async explainRemote(config: HerdrRemoteAttachConfig, target: string): Promise<HerdrObservation> {
    const result = await this.runRemote(config, ["agent", "explain", target, "--json"]);
    const evidence = herdrRemoteAuditEvidence(config, ["agent", "explain", target, "--json"]);
    try {
      const observation = parseExplainJson(result.stdout, target);
      return {
        ...observation,
        evidence: [...observation.evidence, ...evidence]
      };
    } catch (error) {
      if (error instanceof HerdrError) {
        const observation = parseExplainText(result.stdout, target, "json_parse_failed");
        return {
          ...observation,
          evidence: [...observation.evidence, ...evidence]
        };
      }
      throw error;
    }
  }
}
