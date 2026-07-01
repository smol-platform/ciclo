import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface CommandResult {
  readonly args: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RepoCommandRunner = (
  cwd: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<CommandResult>;

export interface RepoProbe {
  readonly root: string;
  readonly isGitRepo: boolean;
  readonly branch?: string;
  readonly upstream?: string;
  readonly dirtyFiles: readonly string[];
  readonly stagedFiles: readonly string[];
  readonly beadsPresent: boolean;
  readonly configuredChecks: readonly string[];
  readonly errors: readonly string[];
}

export const defaultRepoRunner: RepoCommandRunner = (cwd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const [binary, ...rest] = args;
    if (binary === undefined) {
      reject(new Error("missing command"));
      return;
    }
    const child = spawn(binary, rest, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${binary} timed out after ${timeoutMs}ms`));
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
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ args, code: code ?? 1, stdout, stderr });
    });
  });

function parseBranchLine(line: string): { branch?: string; upstream?: string } {
  const match = line.match(/^## (?<branch>[^\s.]+)(?:\.\.\.(?<upstream>[^\s]+))?/u);
  return {
    branch: match?.groups?.branch,
    upstream: match?.groups?.upstream
  };
}

function parsePorcelainStatus(raw: string): Pick<RepoProbe, "branch" | "upstream" | "dirtyFiles" | "stagedFiles"> {
  let branch: string | undefined;
  let upstream: string | undefined;
  const dirtyFiles: string[] = [];
  const stagedFiles: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (line.startsWith("## ")) {
      const parsed = parseBranchLine(line);
      branch = parsed.branch;
      upstream = parsed.upstream;
      continue;
    }
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";
    const path = line.slice(3).trim();
    if (path.length === 0) continue;
    if (indexStatus !== " " && indexStatus !== "?") stagedFiles.push(path);
    if (worktreeStatus !== " " || indexStatus === "?") dirtyFiles.push(path);
  }

  return { branch, upstream, dirtyFiles, stagedFiles };
}

function discoverConfiguredChecks(root: string): readonly string[] {
  const checks: string[] = [];
  if (existsSync(join(root, "justfile"))) checks.push("just check");
  if (existsSync(join(root, "package.json"))) checks.push("npm run check");
  if (existsSync(join(root, "pyproject.toml"))) checks.push("pytest");
  if (existsSync(join(root, "formal", "quint", "ciclo_core.qnt"))) checks.push("just quint");
  return checks;
}

export async function probeRepository(
  root: string,
  runner: RepoCommandRunner = defaultRepoRunner,
  timeoutMs = 2000
): Promise<RepoProbe> {
  const errors: string[] = [];
  const beadsPresent = existsSync(join(root, ".beads"));
  const configuredChecks = discoverConfiguredChecks(root);

  try {
    const inside = await runner(root, ["git", "rev-parse", "--is-inside-work-tree"], timeoutMs);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return {
        root,
        isGitRepo: false,
        dirtyFiles: [],
        stagedFiles: [],
        beadsPresent,
        configuredChecks,
        errors: [inside.stderr.trim() || "not a git repository"]
      };
    }
  } catch (error) {
    return {
      root,
      isGitRepo: false,
      dirtyFiles: [],
      stagedFiles: [],
      beadsPresent,
      configuredChecks,
      errors: [error instanceof Error ? error.message : "git probe failed"]
    };
  }

  const status = await runner(root, ["git", "status", "--porcelain=v1", "--branch"], timeoutMs);
  if (status.code !== 0) {
    errors.push(status.stderr.trim() || "git status failed");
  }
  const parsed = parsePorcelainStatus(status.stdout);

  return {
    root,
    isGitRepo: true,
    branch: parsed.branch,
    upstream: parsed.upstream,
    dirtyFiles: parsed.dirtyFiles,
    stagedFiles: parsed.stagedFiles,
    beadsPresent,
    configuredChecks,
    errors
  };
}

export function summarizeRepoProbe(probe: RepoProbe): string {
  if (!probe.isGitRepo) {
    return `non-git repo; checks=${probe.configuredChecks.join(", ") || "none"}`;
  }
  const dirty = probe.dirtyFiles.length;
  const staged = probe.stagedFiles.length;
  const upstream = probe.upstream === undefined ? "no upstream" : `upstream ${probe.upstream}`;
  const beads = probe.beadsPresent ? "beads present" : "beads absent";
  return `${probe.branch ?? "unknown branch"} (${upstream}); ${dirty} dirty, ${staged} staged; ${beads}`;
}
