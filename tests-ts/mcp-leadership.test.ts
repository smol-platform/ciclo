import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireMcpSessionLeadership } from "../src/mcp-leadership.js";

test("MCP leadership allows one automation owner per project session", () => {
  const root = mkdtempSync(join(tmpdir(), "ciclo-mcp-lock-"));
  try {
    const first = acquireMcpSessionLeadership({
      projectRoot: root,
      sessionId: "project-session",
      sessionName: "project"
    });
    const second = acquireMcpSessionLeadership({
      projectRoot: root,
      sessionId: "project-session",
      sessionName: "project"
    });

    assert.equal(first.mode, "leader");
    assert.equal(first.heartbeatOwner, true);
    assert.equal(second.mode, "follower");
    assert.equal(second.heartbeatOwner, false);
    assert.equal(second.leaderPid, process.pid);

    first.release();
    const third = acquireMcpSessionLeadership({
      projectRoot: root,
      sessionId: "project-session",
      sessionName: "project"
    });
    assert.equal(third.mode, "leader");
    assert.equal(third.heartbeatOwner, true);

    second.release();
    third.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP leadership separates different session identities", () => {
  const root = mkdtempSync(join(tmpdir(), "ciclo-mcp-lock-sessions-"));
  try {
    const first = acquireMcpSessionLeadership({ projectRoot: root, sessionId: "session-a" });
    const second = acquireMcpSessionLeadership({ projectRoot: root, sessionId: "session-b" });

    assert.equal(first.mode, "leader");
    assert.equal(second.mode, "leader");
    assert.notEqual(first.sessionId, second.sessionId);

    first.release();
    second.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
