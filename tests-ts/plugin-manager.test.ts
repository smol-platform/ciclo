import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  activateConfiguredPlugins,
  defaultPluginPaths,
  installPlugin,
  parsePluginManifest,
  readPluginConfig,
  setPluginEnabled
} from "../src/plugin-manager.js";
import {
  buildRemoteRunnerLaunchPlan,
  createDefaultRemoteRunnerPluginRegistry
} from "../src/remote-runner.js";

const fixturePluginPath = resolve("tests/fixtures/plugins/fly-runner");

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ciclo-plugin-test-"));
}

test("plugin manifest validation accepts remote runner package manifests", () => {
  const manifest = parsePluginManifest({
    schema: "ciclo.plugin.v1",
    name: "@example/ciclo-runner-fly",
    version: "1.0.0",
    entrypoint: "./dist/index.js",
    capabilities: ["remote-runner"],
    runnerKinds: ["fly"]
  });

  assert.equal(manifest.name, "@example/ciclo-runner-fly");
  assert.deepEqual(manifest.runnerKinds, ["fly"]);
  assert.throws(
    () => parsePluginManifest({ schema: "ciclo.plugin.v1", name: "bad", version: "1", entrypoint: "../bad.js", capabilities: [], runnerKinds: [] }),
    /remote-runner capability/
  );
});

test("local plugin install writes trusted enabled config and can toggle state", () => {
  const root = tempRoot();
  try {
    const paths = defaultPluginPaths(root);
    const installed = installPlugin({
      packageName: "@example/ciclo-runner-fly",
      path: fixturePluginPath,
      trust: true,
      enable: true,
      now: "2026-07-01T00:00:00.000Z"
    }, paths);

    assert.equal(installed.installed, true);
    assert.equal(installed.entry.trusted, true);
    assert.ok(installed.evidence.includes("plugin.runner_kind:fly"));
    assert.equal(readPluginConfig(paths).plugins.length, 1);

    const disabled = setPluginEnabled("@example/ciclo-runner-fly", false, paths);
    assert.equal(disabled.enabled, false);
    const enabled = setPluginEnabled("@example/ciclo-runner-fly", true, paths);
    assert.equal(enabled.enabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enabled external plugin activates a custom remote runner kind", async () => {
  const root = tempRoot();
  try {
    const paths = defaultPluginPaths(root);
    installPlugin({
      packageName: "@example/ciclo-runner-fly",
      path: fixturePluginPath,
      trust: true,
      enable: true,
      now: "2026-07-01T00:00:00.000Z"
    }, paths);
    const registry = createDefaultRemoteRunnerPluginRegistry();
    const activation = await activateConfiguredPlugins(registry, paths);

    assert.deepEqual(activation.activated, ["@example/ciclo-runner-fly"]);
    const plan = buildRemoteRunnerLaunchPlan({
      runnerKind: "fly",
      runnerId: "fly-1",
      loopId: "loop-1",
      harnessId: "codex",
      image: "ghcr.io/example/ciclo-runner:latest",
      repoPath: "/workspace/ciclo",
      prompt: "Use Ciclo MCP.",
      dryRun: true
    }, "fly-1", registry);

    assert.equal(plan.providerName, "fly-machines");
    assert.equal(plan.executionModel, "fly_machine");
    assert.ok(plan.commands[0]?.includes("fly machines run"));
    assert.ok(plan.evidence.includes("remote.runner.plugin:fly-machines"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("untrusted enabled plugin fails closed during activation", async () => {
  const root = tempRoot();
  try {
    const paths = defaultPluginPaths(root);
    installPlugin({
      packageName: "@example/ciclo-runner-fly",
      path: fixturePluginPath,
      trust: false,
      enable: true,
      now: "2026-07-01T00:00:00.000Z"
    }, paths);
    const activation = await activateConfiguredPlugins(createDefaultRemoteRunnerPluginRegistry(), paths);

    assert.deepEqual(activation.activated, []);
    assert.equal(activation.failures.length, 1);
    assert.match(activation.failures[0] ?? "", /not trusted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
