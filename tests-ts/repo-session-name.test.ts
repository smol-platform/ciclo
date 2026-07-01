import assert from "node:assert/strict";
import test from "node:test";

import { defaultClientAuthContext } from "../src/client-auth.js";
import {
  activeHerdrSessionName,
  parseHerdrStatusSessionName,
  repoSessionName
} from "../src/repo-session-name.js";

function withSessionEnv(run: () => void): void {
  const before = {
    CICLO_SESSION_ID: process.env.CICLO_SESSION_ID,
    CICLO_SESSION_NAME: process.env.CICLO_SESSION_NAME,
    CICLO_HERDR_SESSION: process.env.CICLO_HERDR_SESSION,
    HERDR_SESSION_NAME: process.env.HERDR_SESSION_NAME,
    HERDR_SESSION: process.env.HERDR_SESSION,
    CICLO_REUSE_HERDR_SESSION: process.env.CICLO_REUSE_HERDR_SESSION
  };
  delete process.env.CICLO_SESSION_ID;
  delete process.env.CICLO_SESSION_NAME;
  delete process.env.CICLO_HERDR_SESSION;
  delete process.env.HERDR_SESSION_NAME;
  delete process.env.HERDR_SESSION;
  process.env.CICLO_REUSE_HERDR_SESSION = "false";
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("repo session name is derived from the repository directory", () => {
  withSessionEnv(() => {
    assert.equal(repoSessionName("/Users/ztaylor/repos/workspaces/ciclo"), "ciclo");
    assert.equal(repoSessionName("/tmp/My Repo!"), "my-repo");
  });
});

test("repo session name supports explicit environment override", () => {
  withSessionEnv(() => {
    process.env.CICLO_SESSION_NAME = "shared-ciclo";
    assert.equal(repoSessionName("/tmp/other"), "shared-ciclo");
  });
});

test("repo session name reuses active Herdr session from environment", () => {
  withSessionEnv(() => {
    delete process.env.CICLO_REUSE_HERDR_SESSION;
    process.env.HERDR_SESSION_NAME = "operator-main";
    assert.equal(activeHerdrSessionName(), "operator-main");
    assert.equal(repoSessionName("/tmp/project"), "operator-main");
  });
});

test("Herdr status parser accepts string and object session shapes", () => {
  assert.equal(parseHerdrStatusSessionName(JSON.stringify({
    client: { session: "operator-main" }
  })), "operator-main");
  assert.equal(parseHerdrStatusSessionName(JSON.stringify({
    client: { session: { name: "review-room" } }
  })), "review-room");
  assert.equal(parseHerdrStatusSessionName("{not-json"), undefined);
});

test("default auth context names local Ciclo sessions for the repository", () => {
  withSessionEnv(() => {
    const context = defaultClientAuthContext("/Users/ztaylor/repos/workspaces/ciclo");
    assert.equal(context.session.id, "ciclo");
    assert.equal(context.session.name, "ciclo");
  });
});
