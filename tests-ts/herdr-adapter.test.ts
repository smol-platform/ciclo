import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyHerdrRemoteSetupBlocker,
  herdrRemoteAuditEvidence,
  HerdrClient,
  HerdrError,
  parseExplainJson,
  parseExplainText,
  parseTargetList,
  type CommandResult
} from "../src/herdr-adapter.js";

const codexFixture = readFileSync("tests/fixtures/herdr_explain_codex_done.json", "utf8");
const claudeFixture = readFileSync("tests/fixtures/herdr_explain_claude_working.txt", "utf8");
const observationFixtureCases = [
  {
    file: "tests/fixtures/herdr/observations/working.json",
    target: "pane-working",
    state: "working",
    harness: "claude-code"
  },
  {
    file: "tests/fixtures/herdr/observations/blocked.json",
    target: "pane-blocked",
    state: "blocked",
    harness: "codex"
  },
  {
    file: "tests/fixtures/herdr/observations/done.json",
    target: "pane-done",
    state: "done",
    harness: "codex"
  },
  {
    file: "tests/fixtures/herdr/observations/idle.json",
    target: "pane-idle",
    state: "idle",
    harness: "claude-code"
  },
  {
    file: "tests/fixtures/herdr/observations/unknown.json",
    target: "pane-unknown",
    state: "unknown",
    harness: "unknown"
  }
] as const;

test("parses Herdr explain JSON into a normalized observation", () => {
  const event = parseExplainJson(codexFixture);
  assert.equal(event.source, "herdr");
  assert.equal(event.state, "done");
  assert.equal(event.harness, "codex");
  assert.equal(event.target, "pane-1");
  assert.ok(event.evidence.some((item) => item.includes("Codex reports")));
  assert.ok(event.evidence.includes("herdr.explain.matched_rule:codex_done_banner"));
  assert.ok(event.evidence.includes("herdr.explain.visible_flag:bottom_buffer_done"));
  assert.ok(event.evidence.some((item) => item.startsWith("herdr.explain.raw_payload:")));
});

test("parses Herdr explain text fallback", () => {
  const event = parseExplainText(claudeFixture, "pane-2");
  assert.equal(event.state, "working");
  assert.equal(event.harness, "claude-code");
  assert.equal(event.target, "pane-2");
  assert.ok(event.evidence.includes("herdr.explain.fallback_reason:text_output"));
  assert.ok(event.evidence.some((item) => item.startsWith("herdr.explain.raw_payload:")));
});

test("normalizes Herdr observation fixture suite for every agent state", () => {
  for (const fixture of observationFixtureCases) {
    const event = parseExplainJson(readFileSync(fixture.file, "utf8"));
    assert.equal(event.source, "herdr");
    assert.equal(event.target, fixture.target);
    assert.equal(event.state, fixture.state);
    assert.equal(event.harness, fixture.harness);
    assert.ok(event.evidence.every((item) => item.startsWith("herdr:") || item.startsWith("herdr.explain.")));
  }
});

test("parses target list with cwd and agent labels", () => {
  const targets = parseTargetList(
    JSON.stringify({
      targets: [
        {
          id: "pane-1",
          cwd: "/repo",
          agent: { label: "Codex", state: "working" }
        }
      ]
    })
  );
  assert.equal(targets[0]?.id, "pane-1");
  assert.equal(targets[0]?.cwd, "/repo");
  assert.equal(targets[0]?.agentLabel, "Codex");
  assert.equal(targets[0]?.harness, "codex");
});

test("client returns structured command errors", async () => {
  const runner = async (args: readonly string[]): Promise<CommandResult> => ({
    args,
    code: 1,
    stdout: "",
    stderr: "agent target not found"
  });
  const client = new HerdrClient("herdr", 3000, runner);
  await assert.rejects(client.explain("missing"), (error: unknown) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(error.kind, "command_failed");
    assert.equal(error.message, "agent target not found");
    return true;
  });
});

test("client lists targets and reads state through runner", async () => {
  const runner = async (args: readonly string[]): Promise<CommandResult> => {
    const command = args.join(" ");
    if (command.includes("agent list")) {
      return {
        args,
        code: 0,
        stdout: JSON.stringify([{ id: "pane-1", cwd: "/repo", agent: { label: "Codex" } }]),
        stderr: ""
      };
    }
    return {
      args,
      code: 0,
      stdout: codexFixture,
      stderr: ""
    };
  };

  const client = new HerdrClient("herdr", 3000, runner);
  const targets = await client.listTargets();
  const event = await client.explain("pane-1");
  assert.equal(targets[0]?.cwd, "/repo");
  assert.equal(event.state, "done");
});

test("client text fallback records JSON parse fallback reason", async () => {
  const runner = async (args: readonly string[]): Promise<CommandResult> => ({
    args,
    code: 0,
    stdout: claudeFixture,
    stderr: ""
  });
  const client = new HerdrClient("herdr", 3000, runner);
  const event = await client.explain("pane-2");

  assert.equal(event.state, "working");
  assert.ok(event.evidence.includes("herdr.explain.fallback_reason:json_parse_failed"));
});

test("client replays observation fixtures without a live Herdr server", async () => {
  const fixturesByTarget = new Map<string, string>(
    observationFixtureCases.map((fixture) => [fixture.target, readFileSync(fixture.file, "utf8")])
  );
  const runner = async (args: readonly string[]): Promise<CommandResult> => {
    const target = args[3];
    return {
      args,
      code: 0,
      stdout: fixturesByTarget.get(target ?? "") ?? "",
      stderr: ""
    };
  };

  const client = new HerdrClient("herdr", 3000, runner);
  for (const fixture of observationFixtureCases) {
    const event = await client.explain(fixture.target);
    assert.equal(event.state, fixture.state);
    assert.equal(event.harness, fixture.harness);
    assert.equal(event.target, fixture.target);
  }
});

test("client can replay Herdr unavailable fixture as a structured unavailable error", async () => {
  const fixture = JSON.parse(readFileSync("tests/fixtures/herdr/unavailable_command.json", "utf8")) as {
    code: number;
    stderr: string;
    args: readonly string[];
  };
  const runner = async (): Promise<CommandResult> => {
    throw new HerdrError(fixture.stderr, "unavailable", {
      code: fixture.code,
      args: fixture.args
    });
  };
  const client = new HerdrClient("herdr", 3000, runner);

  await assert.rejects(client.explain("pane-missing"), (error: unknown) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(error.kind, "unavailable");
    assert.equal(error.message, "herdr binary not found");
    return true;
  });
});

test("remote client uses Herdr remote attach prefix with optional named session", async () => {
  const calls: string[] = [];
  const runner = async (args: readonly string[]): Promise<CommandResult> => {
    calls.push(args.join(" "));
    if (args.includes("list")) {
      return {
        args,
        code: 0,
        stdout: JSON.stringify([{ id: "remote-pane", cwd: "/srv/app", agent: { label: "Claude" } }]),
        stderr: ""
      };
    }
    return {
      args,
      code: 0,
      stdout: codexFixture,
      stderr: ""
    };
  };

  const client = new HerdrClient("herdr", 3000, runner);
  const targets = await client.listRemoteTargets({ target: "deploy@prod.example.com", session: "review-loop" });
  const event = await client.explainRemote(
    { target: "deploy@prod.example.com", session: "review-loop" },
    "remote-pane"
  );

  assert.equal(calls[0], "herdr --remote deploy@prod.example.com --session review-loop agent list --json");
  assert.equal(calls[1], "herdr --remote deploy@prod.example.com --session review-loop agent explain remote-pane --json");
  assert.equal(targets[0]?.harness, "claude-code");
  assert.equal(event.state, "done");
  assert.ok(event.evidence.some((item) => item.startsWith("herdr.remote.args:")));
});

test("remote setup blockers classify missing Herdr unsupported platform and generic attach failures", () => {
  assert.equal(
    classifyHerdrRemoteSetupBlocker(
      new HerdrError("ssh target: herdr: command not found", "command_failed")
    ).kind,
    "missing_remote_herdr"
  );
  assert.equal(
    classifyHerdrRemoteSetupBlocker(
      new HerdrError("unsupported remote platform: aix", "command_failed")
    ).kind,
    "unsupported_remote_platform"
  );
  assert.equal(
    classifyHerdrRemoteSetupBlocker(
      new HerdrError("ssh connection refused", "command_failed")
    ).kind,
    "attach_failed"
  );
});

test("remote command errors include setup blocker and redacted audit evidence", async () => {
  const runner = async (args: readonly string[]): Promise<CommandResult> => ({
    args,
    code: 1,
    stdout: "",
    stderr: "ssh target: herdr: command not found at /srv/app"
  });
  const client = new HerdrClient("herdr", 3000, runner);

  await assert.rejects(client.listRemoteTargets({ target: "deploy@prod.example.com:/srv/app" }), (error: unknown) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(
      (error.details.remoteSetupBlocker as { kind?: string } | undefined)?.kind,
      "missing_remote_herdr"
    );
    assert.doesNotMatch(JSON.stringify(error.details.auditEvidence), /deploy@prod\.example\.com|\/srv\/app/);
    return true;
  });
});

test("remote audit evidence redacts remote hosts and paths", () => {
  const evidence = herdrRemoteAuditEvidence(
    { target: "deploy@prod.example.com:/srv/app", session: "remote-review" },
    ["agent", "list", "--json"]
  ).join("\n");

  assert.doesNotMatch(evidence, /deploy@prod\.example\.com|\/srv\/app/);
  assert.match(evidence, /\[redacted remote host\]/);
  assert.match(evidence, /\[redacted remote path\]/);
});
