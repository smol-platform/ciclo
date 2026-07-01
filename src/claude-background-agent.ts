import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ClaudeBackgroundAgentLookup {
  readonly name: string;
  readonly cwd: string;
}

export interface ClaudeBackgroundAgentRecord {
  readonly id: string;
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly name?: string;
  readonly cwd?: string;
  readonly pid?: number;
  readonly status?: string;
  readonly waitingFor?: string;
  readonly ptySock?: string;
  readonly rendezvousSock?: string;
  readonly startedAt?: string;
  readonly updatedAt?: string;
  readonly statusUpdatedAt?: string;
  readonly source: "daemon_roster" | "session_registry" | "merged";
}

export interface ClaudeBackgroundAgentResolver {
  resolve(input: ClaudeBackgroundAgentLookup): ClaudeBackgroundAgentRecord | undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoFromMs(value: unknown): string | undefined {
  const ms = numberValue(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function nameFromLaunchArgs(args: unknown): string | undefined {
  if (!Array.isArray(args)) return undefined;
  for (let index = 0; index < args.length - 1; index += 1) {
    const arg = args[index];
    if ((arg === "--name" || arg === "-n") && typeof args[index + 1] === "string") return args[index + 1];
  }
  return undefined;
}

function rosterRecords(claudeHome: string): readonly ClaudeBackgroundAgentRecord[] {
  const path = join(claudeHome, "daemon", "roster.json");
  if (!existsSync(path)) return [];
  const roster = asRecord(readJson(path));
  const workers = asRecord(roster.workers);
  return Object.entries(workers).flatMap(([jobId, value]) => {
    const worker = asRecord(value);
    const dispatch = asRecord(worker.dispatch);
    const launch = asRecord(dispatch.launch);
    const seed = asRecord(dispatch.seed);
    const sessionId = stringValue(worker.sessionId);
    const cwd = stringValue(worker.cwd) ?? stringValue(dispatch.cwd);
    const name = stringValue(seed.name) ?? nameFromLaunchArgs(launch.args);
    if (sessionId === undefined && name === undefined) return [];
    return [{
      id: sessionId ?? jobId,
      sessionId,
      jobId,
      name,
      cwd,
      pid: numberValue(worker.pid),
      ptySock: stringValue(worker.ptySock),
      rendezvousSock: stringValue(worker.rendezvousSock),
      startedAt: isoFromMs(worker.startedAt),
      updatedAt: isoFromMs(roster.updatedAt),
      source: "daemon_roster" as const
    }];
  });
}

function sessionRecords(claudeHome: string): readonly ClaudeBackgroundAgentRecord[] {
  const dir = join(claudeHome, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      const path = join(dir, file);
      const session = asRecord(readJson(path));
      if (stringValue(session.kind) !== "bg") return [];
      const sessionId = stringValue(session.sessionId);
      const jobId = stringValue(session.jobId);
      const name = stringValue(session.name);
      if (sessionId === undefined && name === undefined) return [];
      return [{
        id: sessionId ?? jobId ?? file.replace(/\.json$/u, ""),
        sessionId,
        jobId,
        name,
        cwd: stringValue(session.cwd),
        pid: numberValue(session.pid),
        status: stringValue(session.status),
        waitingFor: stringValue(session.waitingFor),
        startedAt: isoFromMs(session.startedAt),
        updatedAt: isoFromMs(session.updatedAt),
        statusUpdatedAt: isoFromMs(session.statusUpdatedAt),
        source: "session_registry" as const
      }];
    });
}

function mergeRecords(records: readonly ClaudeBackgroundAgentRecord[]): readonly ClaudeBackgroundAgentRecord[] {
  const merged = new Map<string, ClaudeBackgroundAgentRecord>();
  for (const record of records) {
    const key = record.sessionId ?? record.jobId ?? record.name ?? record.id;
    const existing = merged.get(key);
    merged.set(key, existing === undefined ? record : {
      ...existing,
      ...record,
      ptySock: record.ptySock ?? existing.ptySock,
      rendezvousSock: record.rendezvousSock ?? existing.rendezvousSock,
      pid: record.pid ?? existing.pid,
      source: "merged"
    });
  }
  return [...merged.values()];
}

function matches(input: ClaudeBackgroundAgentLookup, record: ClaudeBackgroundAgentRecord): boolean {
  const nameMatches = record.name === input.name || record.sessionId === input.name || record.jobId === input.name;
  if (!nameMatches) return false;
  if (record.cwd === undefined) return true;
  return resolve(record.cwd) === resolve(input.cwd);
}

function newestFirst(left: ClaudeBackgroundAgentRecord, right: ClaudeBackgroundAgentRecord): number {
  const leftTime = Date.parse(left.statusUpdatedAt ?? left.updatedAt ?? left.startedAt ?? "1970-01-01T00:00:00.000Z");
  const rightTime = Date.parse(right.statusUpdatedAt ?? right.updatedAt ?? right.startedAt ?? "1970-01-01T00:00:00.000Z");
  return rightTime - leftTime;
}

export class FileClaudeBackgroundAgentResolver implements ClaudeBackgroundAgentResolver {
  constructor(private readonly claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")) {}

  resolve(input: ClaudeBackgroundAgentLookup): ClaudeBackgroundAgentRecord | undefined {
    try {
      return mergeRecords([...rosterRecords(this.claudeHome), ...sessionRecords(this.claudeHome)])
        .filter((record) => matches(input, record))
        .sort(newestFirst)[0];
    } catch {
      return undefined;
    }
  }
}
