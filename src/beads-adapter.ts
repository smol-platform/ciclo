import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface BeadsCommandResult {
  readonly args: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type BeadsRunner = (
  cwd: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<BeadsCommandResult>;

export interface BeadsDependencySnapshot {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
  readonly type?: string;
}

export interface BeadsTaskSnapshot {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority: number;
  readonly issueType: string;
  readonly description: string;
  readonly acceptanceCriteria: string;
  readonly specId?: string;
  readonly labels: readonly string[];
  readonly dependencies: readonly BeadsDependencySnapshot[];
  readonly externalRefs: readonly string[];
}

export class BeadsError extends Error {
  constructor(
    message: string,
    readonly kind: "absent" | "command_failed" | "parse_failed"
  ) {
    super(message);
    this.name = "BeadsError";
  }
}

export const defaultBeadsRunner: BeadsRunner = (cwd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const [binary, ...rest] = args;
    if (binary === undefined) {
      reject(new BeadsError("missing bd command", "command_failed"));
      return;
    }
    const child = spawn(binary, rest, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new BeadsError(`${binary} timed out after ${timeoutMs}ms`, "command_failed"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new BeadsError(error.message, "command_failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ args, code: code ?? 1, stdout, stderr });
    });
  });

function jsonPayload(raw: string): unknown {
  const start = raw.search(/[\[{]/u);
  if (start < 0) {
    throw new BeadsError("bd JSON output did not contain JSON", "parse_failed");
  }
  try {
    return JSON.parse(raw.slice(start));
  } catch (error) {
    throw new BeadsError(
      error instanceof Error ? error.message : "bd JSON parse failed",
      "parse_failed"
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(data: Record<string, unknown>, key: string, fallback = ""): string {
  const value = data[key];
  return typeof value === "string" ? value : fallback;
}

function numberValue(data: Record<string, unknown>, key: string, fallback = 0): number {
  const value = data[key];
  return typeof value === "number" ? value : fallback;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function dependencySnapshots(value: unknown): readonly BeadsDependencySnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (record === undefined) return [];
    const id = stringValue(record, "id") || stringValue(record, "depends_on_id");
    if (id.length === 0) return [];
    return [
      {
        id,
        title: stringValue(record, "title") || undefined,
        status: stringValue(record, "status") || undefined,
        type: stringValue(record, "dependency_type") || stringValue(record, "type") || undefined
      }
    ];
  });
}

function externalRefsFrom(record: Record<string, unknown>, labels: readonly string[]): readonly string[] {
  const refs = new Set<string>();
  for (const key of ["external_ref", "external_url", "linear_id", "jira_key"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) refs.add(value);
  }
  for (const label of labels) {
    if (label.startsWith("linear:") || label.startsWith("jira:")) refs.add(label);
  }
  return [...refs];
}

export function taskSnapshotFromRecord(record: Record<string, unknown>): BeadsTaskSnapshot {
  const labels = stringList(record.labels);
  return {
    id: stringValue(record, "id"),
    title: stringValue(record, "title"),
    status: stringValue(record, "status"),
    priority: numberValue(record, "priority"),
    issueType: stringValue(record, "issue_type"),
    description: stringValue(record, "description"),
    acceptanceCriteria: stringValue(record, "acceptance_criteria"),
    specId: stringValue(record, "spec_id") || undefined,
    labels,
    dependencies: dependencySnapshots(record.dependencies),
    externalRefs: externalRefsFrom(record, labels)
  };
}

function snapshotsFromJson(raw: string): readonly BeadsTaskSnapshot[] {
  const payload = jsonPayload(raw);
  const values = Array.isArray(payload) ? payload : [payload];
  return values.flatMap((value) => {
    const record = asRecord(value);
    return record === undefined ? [] : [taskSnapshotFromRecord(record)];
  });
}

export class BeadsClient {
  constructor(
    readonly root: string,
    readonly runner: BeadsRunner = defaultBeadsRunner,
    readonly timeoutMs = 3000
  ) {}

  isPresent(): boolean {
    return existsSync(join(this.root, ".beads"));
  }

  private async run(args: readonly string[]): Promise<BeadsCommandResult> {
    if (!this.isPresent()) {
      throw new BeadsError("Beads workspace not present", "absent");
    }
    const result = await this.runner(this.root, ["bd", ...args], this.timeoutMs);
    if (result.code !== 0) {
      throw new BeadsError(result.stderr.trim() || result.stdout.trim(), "command_failed");
    }
    return result;
  }

  async ready(limit = 20): Promise<readonly BeadsTaskSnapshot[]> {
    const result = await this.run(["ready", "--json", "--limit", String(limit)]);
    return snapshotsFromJson(result.stdout);
  }

  async show(id: string): Promise<BeadsTaskSnapshot> {
    const result = await this.run(["show", id, "--json"]);
    const snapshots = snapshotsFromJson(result.stdout);
    const snapshot = snapshots[0];
    if (snapshot === undefined) {
      throw new BeadsError(`bd show ${id} returned no task`, "parse_failed");
    }
    return snapshot;
  }

  async claim(id: string): Promise<BeadsTaskSnapshot> {
    await this.run(["update", id, "--claim"]);
    return this.show(id);
  }

  async doltPull(remote?: string): Promise<void> {
    await this.run(remote === undefined ? ["dolt", "pull"] : ["dolt", "pull", remote]);
  }

  async doltPush(remote?: string): Promise<void> {
    await this.run(remote === undefined ? ["dolt", "push"] : ["dolt", "push", remote]);
  }

  async note(id: string, message: string): Promise<void> {
    await this.run(["note", id, message]);
  }

  async close(id: string, reason: string): Promise<BeadsTaskSnapshot> {
    await this.run(["close", id, "--reason", reason]);
    return this.show(id);
  }
}
