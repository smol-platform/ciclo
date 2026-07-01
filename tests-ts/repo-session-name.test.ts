import assert from "node:assert/strict";
import test from "node:test";

import { defaultClientAuthContext } from "../src/client-auth.js";
import { repoSessionName } from "../src/repo-session-name.js";

test("repo session name is derived from the repository directory", () => {
  assert.equal(repoSessionName("/Users/ztaylor/repos/workspaces/ciclo"), "ciclo");
  assert.equal(repoSessionName("/tmp/My Repo!"), "my-repo");
});

test("repo session name supports explicit environment override", () => {
  const before = process.env.CICLO_SESSION_NAME;
  process.env.CICLO_SESSION_NAME = "shared-ciclo";
  try {
    assert.equal(repoSessionName("/tmp/other"), "shared-ciclo");
  } finally {
    if (before === undefined) delete process.env.CICLO_SESSION_NAME;
    else process.env.CICLO_SESSION_NAME = before;
  }
});

test("default auth context names local Ciclo sessions for the repository", () => {
  const beforeId = process.env.CICLO_SESSION_ID;
  const beforeName = process.env.CICLO_SESSION_NAME;
  delete process.env.CICLO_SESSION_ID;
  delete process.env.CICLO_SESSION_NAME;
  try {
    const context = defaultClientAuthContext("/Users/ztaylor/repos/workspaces/ciclo");
    assert.equal(context.session.id, "ciclo");
    assert.equal(context.session.name, "ciclo");
  } finally {
    if (beforeId === undefined) delete process.env.CICLO_SESSION_ID;
    else process.env.CICLO_SESSION_ID = beforeId;
    if (beforeName === undefined) delete process.env.CICLO_SESSION_NAME;
    else process.env.CICLO_SESSION_NAME = beforeName;
  }
});
