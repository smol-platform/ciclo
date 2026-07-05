import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface McpSessionLeadershipView {
  readonly sessionId: string;
  readonly mode: "leader" | "follower";
  readonly heartbeatOwner: boolean;
  readonly projectRoot: string;
  readonly sessionName?: string;
  readonly lockPath: string;
  readonly recordPath: string;
  readonly leaderPid?: number;
  readonly pid: number;
  readonly startedAt: string;
  readonly evidence: readonly string[];
}

export interface McpSessionLeadership extends McpSessionLeadershipView {
  release(): void;
}

export interface AcquireMcpSessionLeadershipInput {
  readonly projectRoot: string;
  readonly sessionName?: string;
  readonly sessionId?: string;
  readonly now?: () => string;
  readonly pid?: number;
}

interface LeadershipRecord {
  readonly sessionId?: string;
  readonly pid?: number;
  readonly projectRoot?: string;
  readonly sessionName?: string;
  readonly startedAt?: string;
}

function nowIso(input: AcquireMcpSessionLeadershipInput): string {
  return input.now?.() ?? new Date().toISOString();
}

function canonicalRoot(projectRoot: string): string {
  const absolute = resolve(projectRoot);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function sessionKey(input: {
  readonly projectRoot: string;
  readonly sessionName?: string;
  readonly sessionId?: string;
}): string {
  return createHash("sha256")
    .update(`${input.projectRoot}\n${input.sessionId ?? ""}\n${input.sessionName ?? ""}`)
    .digest("hex")
    .slice(0, 24);
}

function recordPath(projectRoot: string, key: string): string {
  return join(projectRoot, ".ciclo", "runtime", "mcp", `${key}.json`);
}

function lockPath(projectRoot: string, key: string): string {
  return join(projectRoot, ".ciclo", "runtime", "mcp", `${key}.lock`);
}

function readRecord(path: string): LeadershipRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as LeadershipRecord;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Another process may have cleaned it up first.
  }
}

export function acquireMcpSessionLeadership(input: AcquireMcpSessionLeadershipInput): McpSessionLeadership {
  const projectRoot = canonicalRoot(input.projectRoot);
  const key = sessionKey({ projectRoot, sessionId: input.sessionId, sessionName: input.sessionName });
  const lock = lockPath(projectRoot, key);
  const record = recordPath(projectRoot, key);
  const pid = input.pid ?? process.pid;
  const startedAt = nowIso(input);
  mkdirSync(dirname(lock), { recursive: true });

  let fd: number | undefined;
  let staleEvidence: readonly string[] = [];
  try {
    fd = openSync(lock, "wx");
  } catch {
    const current = readRecord(record);
    if (!processAlive(current?.pid)) {
      unlinkIfExists(lock);
      unlinkIfExists(record);
      staleEvidence = ["mcp.leadership:stale_reclaimed"];
      fd = openSync(lock, "wx");
    } else {
      return {
        sessionId: key,
        mode: "follower",
        heartbeatOwner: false,
        projectRoot,
        ...(input.sessionName === undefined ? {} : { sessionName: input.sessionName }),
        lockPath: lock,
        recordPath: record,
        leaderPid: current?.pid,
        pid,
        startedAt,
        evidence: [
          "mcp.leadership:follower",
          ...(current?.pid === undefined ? [] : [`mcp.leadership.leader_pid:${current.pid}`])
        ],
        release() {}
      };
    }
  }

  closeSync(fd);
  const leaderRecord: LeadershipRecord = {
    sessionId: key,
    pid,
    projectRoot,
    ...(input.sessionName === undefined ? {} : { sessionName: input.sessionName }),
    startedAt
  };
  writeFileSync(record, `${JSON.stringify(leaderRecord, null, 2)}\n`, "utf8");
  let released = false;
  return {
    sessionId: key,
    mode: "leader",
    heartbeatOwner: true,
    projectRoot,
    ...(input.sessionName === undefined ? {} : { sessionName: input.sessionName }),
    lockPath: lock,
    recordPath: record,
    leaderPid: pid,
    pid,
    startedAt,
    evidence: ["mcp.leadership:leader", ...staleEvidence],
    release() {
      if (released) return;
      released = true;
      const current = readRecord(record);
      if (current?.pid === pid && current.sessionId === key) {
        unlinkIfExists(record);
        unlinkIfExists(lock);
      }
    }
  };
}

export function mcpLeadershipView(leadership: McpSessionLeadership | undefined): Record<string, unknown> {
  if (leadership === undefined) {
    return {
      mode: "unmanaged",
      heartbeat_owner: true,
      evidence: ["mcp.leadership:unmanaged"]
    };
  }
  return {
    session_id: leadership.sessionId,
    mode: leadership.mode,
    heartbeat_owner: leadership.heartbeatOwner,
    project_root: leadership.projectRoot,
    session_name: leadership.sessionName,
    lock_path: leadership.lockPath,
    record_path: leadership.recordPath,
    leader_pid: leadership.leaderPid,
    pid: leadership.pid,
    started_at: leadership.startedAt,
    evidence: leadership.evidence
  };
}

export function ownsMcpAutomation(leadership: McpSessionLeadership | undefined): boolean {
  return leadership === undefined || leadership.heartbeatOwner;
}
