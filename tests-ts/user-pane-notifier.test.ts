import assert from "node:assert/strict";
import test from "node:test";

import type { CicloEvent } from "../src/ciclo-events.js";
import { UserControlPaneNotifier, userControlPaneTargetFromEnv } from "../src/user-pane-notifier.js";

function event(input: Partial<CicloEvent> & Pick<CicloEvent, "type">): CicloEvent {
  return {
    cursor: 1,
    at: "2026-07-04T00:00:00.000Z",
    evidence: [],
    ...input
  };
}

test("user control pane notifier sends high-signal Ciclo events through Herdr notification", () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const notifier = new UserControlPaneNotifier(
    { enabled: true, herdrSession: "infra-blocks", paneName: "infra-blocks" },
    (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    }
  );

  const result = notifier.notify(event({
    type: "question.asked",
    beadId: "infra-123",
    loopId: "deploy",
    data: {
      question: "Should Ciclo deploy after validation?"
    }
  }));

  assert.equal(result.delivered, true);
  assert.equal(calls[0]?.command, "herdr");
  assert.deepEqual(calls[0]?.args.slice(0, 5), [
    "--session",
    "infra-blocks",
    "notification",
    "show",
    "Ciclo needs input"
  ]);
  assert.match(calls[0]?.args.join("\n") ?? "", /Should Ciclo deploy after validation/u);
  assert.ok(calls[0]?.args.includes("--sound"));
  assert.ok(calls[0]?.args.includes("request"));
});

test("user control pane notifier skips low-signal heartbeat events", () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const notifier = new UserControlPaneNotifier(
    { enabled: true, herdrSession: "ciclo" },
    (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    }
  );

  const result = notifier.notify(event({ type: "heartbeat.tick" }));

  assert.equal(result.delivered, false);
  assert.equal(calls.length, 0);
});

test("user control pane target is read from Ciclo launch environment", () => {
  assert.deepEqual(userControlPaneTargetFromEnv({
    CICLO_USER_PANE_ENABLED: "true",
    CICLO_USER_PANE_HERDR_SESSION: "project",
    CICLO_USER_PANE_NAME: "project"
  }), {
    enabled: true,
    herdrSession: "project",
    paneName: "project"
  });
  assert.equal(userControlPaneTargetFromEnv({
    CICLO_USER_PANE_ENABLED: "false",
    CICLO_USER_PANE_HERDR_SESSION: "project"
  }), undefined);
});
