import assert from "node:assert/strict";
import test from "node:test";

import { probeRepository, summarizeRepoProbe, type CommandResult, type RepoCommandRunner } from "../src/repo-probe.js";

function runnerFor(results: Record<string, CommandResult>): RepoCommandRunner {
  return async (_cwd, args) => {
    const key = args.join(" ");
    const result = results[key];
    if (result === undefined) {
      throw new Error(`unexpected command: ${key}`);
    }
    return result;
  };
}

test("repo probe handles clean git repos", async () => {
  const probe = await probeRepository(
    ".",
    runnerFor({
      "git rev-parse --is-inside-work-tree": {
        args: ["git"],
        code: 0,
        stdout: "true\n",
        stderr: ""
      },
      "git status --porcelain=v1 --branch": {
        args: ["git"],
        code: 0,
        stdout: "## main...origin/main\n",
        stderr: ""
      }
    })
  );
  assert.equal(probe.isGitRepo, true);
  assert.equal(probe.branch, "main");
  assert.equal(probe.upstream, "origin/main");
  assert.deepEqual(probe.dirtyFiles, []);
  assert.deepEqual(probe.stagedFiles, []);
});

test("repo probe handles dirty and staged files", async () => {
  const probe = await probeRepository(
    ".",
    runnerFor({
      "git rev-parse --is-inside-work-tree": {
        args: ["git"],
        code: 0,
        stdout: "true\n",
        stderr: ""
      },
      "git status --porcelain=v1 --branch": {
        args: ["git"],
        code: 0,
        stdout: "## feature\n M src/a.ts\nA  src/b.ts\n?? scratch.txt\n",
        stderr: ""
      }
    })
  );
  assert.equal(probe.branch, "feature");
  assert.deepEqual(probe.dirtyFiles, ["src/a.ts", "scratch.txt"]);
  assert.deepEqual(probe.stagedFiles, ["src/b.ts"]);
});

test("repo probe handles non-git repos", async () => {
  const probe = await probeRepository(
    ".",
    runnerFor({
      "git rev-parse --is-inside-work-tree": {
        args: ["git"],
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository"
      }
    })
  );
  assert.equal(probe.isGitRepo, false);
  assert.match(probe.errors.join(" "), /not a git repository/);
});

test("repo probe reports Beads presence and configured checks for this repo", async () => {
  const probe = await probeRepository(
    ".",
    runnerFor({
      "git rev-parse --is-inside-work-tree": {
        args: ["git"],
        code: 0,
        stdout: "true\n",
        stderr: ""
      },
      "git status --porcelain=v1 --branch": {
        args: ["git"],
        code: 0,
        stdout: "## main\n",
        stderr: ""
      }
    })
  );
  assert.equal(probe.beadsPresent, true);
  assert.ok(probe.configuredChecks.includes("just check"));
  assert.ok(probe.configuredChecks.includes("npm run check"));
  assert.match(summarizeRepoProbe(probe), /beads present/);
});
