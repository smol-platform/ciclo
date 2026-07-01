import assert from "node:assert/strict";
import test from "node:test";

import {
  beadsRemoteConfigFromObject,
  defaultLocalBeadsRemoteConfig,
  detectBeadsRemoteMode
} from "../src/beads-remote.js";

test("detects local Beads mode", () => {
  const state = detectBeadsRemoteMode(defaultLocalBeadsRemoteConfig());
  assert.equal(state.mode, "local");
  assert.equal(state.databaseIdentity, "local-beads");
  assert.equal(state.health, "healthy");
  assert.equal(state.centralizedCoordinationRequired, false);
});

test("detects shared Dolt SQL server mode", () => {
  const config = beadsRemoteConfigFromObject({
    enabled: true,
    mode: "shared_dolt_server",
    require_remote_for_multi_agent: true,
    shared_dolt_server: {
      host: "127.0.0.1",
      port: 3308,
      database: "ciclo",
      user: "root"
    }
  });
  const state = detectBeadsRemoteMode(config);
  assert.equal(state.mode, "shared_dolt_server");
  assert.equal(state.host, "127.0.0.1");
  assert.equal(state.port, 3308);
  assert.equal(state.database, "ciclo");
  assert.equal(state.databaseIdentity, "127.0.0.1:3308/ciclo");
  assert.equal(state.health, "unknown");
  assert.equal(state.centralizedCoordinationRequired, true);
});

test("detects Dolt remote sync mode", () => {
  const config = beadsRemoteConfigFromObject({
    enabled: true,
    mode: "dolt_remote_sync",
    require_remote_for_multi_agent: false,
    dolt_remote_sync: {
      remote: "origin",
      pull_before_select: true,
      push_after_claim: true,
      push_after_update: true,
      fail_closed_on_sync_error: true
    }
  });
  const state = detectBeadsRemoteMode(config);
  assert.equal(state.mode, "dolt_remote_sync");
  assert.equal(state.remoteName, "origin");
  assert.equal(state.databaseIdentity, "dolt-remote:origin");
  assert.equal(state.health, "unknown");
  assert.equal(state.centralizedCoordinationRequired, true);
});

test("reports unavailable health for missing remote config", () => {
  const state = detectBeadsRemoteMode({
    enabled: true,
    mode: "shared_dolt_server",
    requireRemoteForMultiAgent: true
  });
  assert.equal(state.health, "unavailable");
  assert.equal(state.centralizedCoordinationRequired, true);
});
