import { spawnSync } from "node:child_process";

export interface RepoBoardStatus {
  readonly pullRequests: readonly Record<string, unknown>[];
  readonly ci: readonly Record<string, unknown>[];
  readonly mergeState?: string;
  readonly evidence: readonly string[];
}

export interface RepoBoardProvider {
  statusForBranch(branch: string | undefined, cwd: string): RepoBoardStatus;
}

const emptyStatus: RepoBoardStatus = {
  pullRequests: [],
  ci: [],
  evidence: ["repo_board.branch:missing"]
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function checkName(value: Record<string, unknown>): string | undefined {
  return stringValue(value.name) ?? stringValue(value.workflowName) ?? stringValue(value.context);
}

function normalizeCheck(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return {
    name: checkName(record),
    status: stringValue(record.status),
    conclusion: stringValue(record.conclusion)
  };
}

function normalizePr(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const checks = Array.isArray(record.statusCheckRollup) ? record.statusCheckRollup.map(normalizeCheck) : [];
  return {
    number: record.number,
    title: stringValue(record.title),
    url: stringValue(record.url),
    state: stringValue(record.state),
    draft: typeof record.isDraft === "boolean" ? record.isDraft : undefined,
    head_ref: stringValue(record.headRefName),
    base_ref: stringValue(record.baseRefName),
    merge_state: stringValue(record.mergeStateStatus),
    review_decision: stringValue(record.reviewDecision),
    checks
  };
}

export class GitHubCliRepoBoardProvider implements RepoBoardProvider {
  statusForBranch(branch: string | undefined, cwd: string): RepoBoardStatus {
    if (branch === undefined || branch.length === 0) return emptyStatus;
    const result = spawnSync("gh", [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,title,url,state,isDraft,headRefName,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup",
      "--limit",
      "10"
    ], { cwd, encoding: "utf8" });
    if (result.status !== 0) {
      return {
        pullRequests: [],
        ci: [],
        evidence: ["repo_board.github:unavailable", `repo_board.branch:${branch}`]
      };
    }
    try {
      const pullRequests = (JSON.parse(result.stdout) as unknown[]).map(normalizePr);
      const ci = pullRequests.flatMap((pullRequest) =>
        Array.isArray(pullRequest.checks) ? pullRequest.checks as readonly Record<string, unknown>[] : []
      );
      return {
        pullRequests,
        ci,
        mergeState: stringValue(pullRequests[0]?.merge_state),
        evidence: ["repo_board.github:queried", `repo_board.branch:${branch}`, `repo_board.pull_requests:${pullRequests.length}`]
      };
    } catch {
      return {
        pullRequests: [],
        ci: [],
        evidence: ["repo_board.github:parse_failed", `repo_board.branch:${branch}`]
      };
    }
  }
}
