import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createSecretProviderRegistryFromConfig,
  configMcpSecretEnvBindings,
  loadCicloProjectConfig,
  mergeMcpInstallOptionsWithConfig,
  mergeRemoteRunnerLaunchWithConfig,
  mergeWorkerLaunchWithConfig,
  parseCicloProjectConfigText,
  redactedCicloProjectConfig,
  resolveConfigMcpSecretEnvBindings,
  writeSampleCicloConfig
} from "../src/ciclo-config.js";
import { SecretProviderRegistry, secretRefHash } from "../src/secret-provider.js";

test("loads project config for secrets MCP and remote defaults", () => {
  const config = parseCicloProjectConfigText(JSON.stringify({
    secrets: {
      providers: [
        { id: "corp-bao", kind: "openbao", command: "bao-corp", name: "Corp OpenBao" }
      ]
    },
    mcp: {
      clients: ["claude", "codex"],
      server_name: "ciclo_team",
      command: "ciclo-dev",
      vars: { CICLO_REUSE_HERDR_SESSION: "true" },
      secret_bindings: [
        { name: "API_TOKEN", provider_id: "corp-bao", ref: "secret/data/ciclo/api", field: "token", format: "Bearer ${secret}" }
      ],
      claude_channel: true
    },
    remote: {
      runner_kind: "kubernetes",
      image: "ghcr.io/acme/ciclo-runner:latest",
      repo_path: "/workspace/acme",
      ssh_user: "runner",
      wireguard: {
        network_cidr: "10.70.0.0/24",
        runner_address: "10.70.0.9/24"
      },
      kubernetes: {
        namespace: "ciclo-team",
        service_account: "ciclo-runner"
      }
    }
  }));

  assert.equal(config.secrets?.providers?.[0]?.id, "corp-bao");
  assert.equal(config.mcp?.serverName, "ciclo_team");
  assert.equal(config.mcp?.secretBindings?.[0]?.ref, "secret/data/ciclo/api");
  assert.equal(config.mcp?.secretBindings?.[0]?.format, "Bearer ${secret}");
  assert.equal(config.remote?.runnerKind, "kubernetes");
  assert.equal(config.remote?.wireGuard?.runnerAddress, "10.70.0.9/24");

  const redacted = redactedCicloProjectConfig(config);
  assert.equal(redacted.mcp?.secretBindings?.[0]?.ref, "[redacted secret ref]");
});

test("sample config initializes and can be loaded back", () => {
  const root = mkdtempSync(join(tmpdir(), "ciclo-config-init-"));
  try {
    const initialized = writeSampleCicloConfig(root);
    assert.equal(initialized.found, true);
    assert.ok(initialized.path);

    const loaded = loadCicloProjectConfig(root);
    assert.equal(loaded.found, true);
    assert.deepEqual(loaded.config.mcp?.clients, ["claude", "codex"]);
    assert.equal(loaded.config.remote?.runnerKind, "kubernetes");

    const raw = readFileSync(join(root, ".ciclo", "config.json"), "utf8");
    assert.match(raw, /secretBindings/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config registers CLI secret provider aliases without exposing refs", async () => {
  const config = parseCicloProjectConfigText(JSON.stringify({
    secrets: {
      providers: [{ id: "corp-op", kind: "onepassword", command: "op-corp" }]
    }
  }));
  const registry = createSecretProviderRegistryFromConfig(config);

  assert.ok(registry.list().some((provider) => provider.id === "corp-op"));
});

test("config can alias secret providers registered by plugins", async () => {
  const config = parseCicloProjectConfigText(JSON.stringify({
    secrets: {
      providers: [{
        id: "team-keychain",
        kind: "keychain",
        name: "Team Keychain",
        pluginProviderId: "keychain-test"
      }]
    }
  }));
  const registry = createSecretProviderRegistryFromConfig(config);
  registry.register({
    id: "keychain-test",
    kind: "keychain",
    name: "Keychain Test Provider",
    supportsFields: true,
    resolve(input) {
      return {
        resolved: true,
        providerId: "keychain-test",
        providerKind: "keychain",
        secretRefHash: secretRefHash(input.secretRef),
        field: input.field,
        value: "fixture-secret",
        reason: "fixture provider resolved the secret",
        evidence: ["secret.provider:keychain-test", "secret.resolved:true"]
      };
    }
  });

  assert.ok(registry.list().some((provider) => provider.id === "team-keychain"));
  const resolved = await registry.resolve({
    providerId: "team-keychain",
    secretRef: "keychain://ciclo/demo",
    field: "token"
  });
  assert.equal(resolved.providerId, "team-keychain");
  assert.equal(resolved.providerKind, "keychain");
  assert.equal(resolved.value, "fixture-secret");
  assert.ok(resolved.evidence.includes("secret.provider.plugin_delegate:keychain-test"));
});

test("config merges into MCP install worker and remote requests", () => {
  const config = parseCicloProjectConfigText(JSON.stringify({
    mcp: {
      clients: ["codex"],
      serverName: "ciclo_configured",
      command: "ciclo-dev",
      vars: { CICLO_REUSE_HERDR_SESSION: "true", EXTRA_MODE: "config" },
      secretBindings: [
        { name: "GITHUB_TOKEN", providerId: "onepassword", ref: "op://Engineering/GitHub Token/token" },
        { name: "GITHUB_AUTHORIZATION", providerId: "onepassword", ref: "op://Engineering/GitHub Token/token", format: "Bearer ${secret}" }
      ],
      additionalServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          env: { MCP_FS_MODE: "config" }
        }
      },
      claudeChannel: false
    },
    remote: {
      runnerKind: "cloudflare",
      image: "ghcr.io/acme/ciclo-runner:latest",
      repoPath: "/workspace/repo",
      sshUser: "ciclo",
      vars: { CICLO_REMOTE_MODE: "config" },
      cloudflare: { accountId: "acct-1", workerName: "ciclo-worker" }
    }
  }));

  const install = mergeMcpInstallOptionsWithConfig({ dryRun: true }, config);
  assert.deepEqual(install.clients, ["codex"]);
  assert.equal(install.serverName, "ciclo_configured");
  assert.equal(install.command, "ciclo-dev");
  assert.equal(install.env?.EXTRA_MODE, "config");
  assert.deepEqual(install.secretEnv?.map((binding) => binding.name), ["GITHUB_TOKEN", "GITHUB_AUTHORIZATION"]);
  assert.equal(install.secretEnv?.[1]?.format, "Bearer ${secret}");
  assert.equal(install.secretEnv?.[1]?.secretRefHash, secretRefHash("op://Engineering/GitHub Token/token"));
  assert.equal(install.additionalServers?.filesystem?.command, "npx");

  const worker = mergeWorkerLaunchWithConfig({
    harnessId: "codex",
    loopId: "loop",
    prompt: "Work through Ciclo."
  }, config);
  assert.equal(worker.configureMcp, true);
  assert.equal(worker.mcpServerName, "ciclo_configured");
  assert.equal(worker.mcpEnv?.CICLO_REUSE_HERDR_SESSION, "true");
  assert.equal(worker.mcpAdditionalServers?.filesystem?.["env"].MCP_FS_MODE, "config");
  assert.deepEqual(worker.mcpSecretEnv?.map((binding) => binding.name), ["GITHUB_TOKEN", "GITHUB_AUTHORIZATION"]);

  const remote = mergeRemoteRunnerLaunchWithConfig({
    runnerKind: "",
    loopId: "loop",
    harnessId: "codex",
    image: "",
    repoPath: "",
    prompt: "Use Ciclo."
  }, config);
  assert.equal(remote.runnerKind, "cloudflare");
  assert.equal(remote.image, "ghcr.io/acme/ciclo-runner:latest");
  assert.equal(remote.repoPath, "/workspace/repo");
  assert.equal(remote.environment?.CICLO_REMOTE_MODE, "config");
  assert.equal(remote.mcpAdditionalServers?.filesystem?.command, "npx");
  assert.equal(remote.cloudflare?.workerName, "ciclo-worker");
});

test("config MCP secret env bindings resolve through a registry without leaking refs", async () => {
  const config = parseCicloProjectConfigText(JSON.stringify({
    mcp: {
      secretBindings: [
        {
          name: "GITHUB_AUTHORIZATION",
          providerId: "fixture",
          ref: "op://Engineering/GitHub Token/token",
          format: "Bearer ${secret}",
          reason: "provide GitHub auth"
        }
      ]
    }
  }));
  const unresolved = configMcpSecretEnvBindings(config);
  assert.equal(unresolved[0]?.name, "GITHUB_AUTHORIZATION");
  assert.equal(unresolved[0]?.value, undefined);
  assert.equal(unresolved[0]?.secretRefHash, secretRefHash("op://Engineering/GitHub Token/token"));

  const registry = new SecretProviderRegistry([
    {
      id: "fixture",
      kind: "test",
      name: "Fixture Secret Provider",
      resolve(input) {
        return {
          resolved: true,
          providerId: "fixture",
          providerKind: "test",
          secretRefHash: secretRefHash(input.secretRef),
          value: "ghp_fixture",
          reason: "fixture resolved",
          evidence: ["secret.provider:fixture", "secret.resolved:true"]
        };
      }
    }
  ]);
  const resolved = await resolveConfigMcpSecretEnvBindings({ config, registry, dryRun: false });
  assert.equal(resolved[0]?.value, "ghp_fixture");
  assert.equal(resolved[0]?.format, "Bearer ${secret}");
  assert.doesNotMatch(JSON.stringify(resolved), /op:\/\/Engineering\/GitHub Token\/token/u);
});

test("loads .ciclo config from a project root", () => {
  const root = mkdtempSync(join(tmpdir(), "ciclo-config-load-"));
  try {
    const path = join(root, ".ciclo", "config.json");
    mkdirSync(join(root, ".ciclo"), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcp: { clients: ["claude"] } }), { flag: "wx" });
    const loaded = loadCicloProjectConfig(root);
    assert.equal(loaded.found, true);
    assert.deepEqual(loaded.config.mcp?.clients, ["claude"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checked-in example config parses and redacts secret references", () => {
  const raw = readFileSync(resolve("examples", "ciclo-config.json"), "utf8");
  const config = parseCicloProjectConfigText(raw);

  assert.deepEqual(config.mcp?.clients, ["claude", "codex"]);
  assert.equal(config.mcp?.serverName, "ciclo");
  assert.equal(config.mcp?.additionalServers?.filesystem?.command, "npx");
  assert.equal(config.mcp?.secretBindings?.length, 3);
  assert.equal(config.mcp?.secretBindings?.[2]?.providerId, "team-keychain");
  assert.equal(config.mcp?.secretBindings?.[2]?.ref, "keychain://ciclo/example-api-token");
  assert.equal(config.mcp?.secretBindings?.[2]?.format, "Bearer ${secret}");
  assert.equal(config.remote?.runnerKind, "kubernetes");
  assert.equal(config.remote?.wireGuard?.interfaceName, "wg-ciclo");
  assert.equal(config.remote?.awsLambda?.microVmName, "ciclo-project-runner");
  assert.equal(config.remote?.cloudflare?.workerName, "ciclo-project-runner");

  const redacted = JSON.stringify(redactedCicloProjectConfig(config));
  assert.doesNotMatch(redacted, /op:\/\/Ciclo\/API\/token/);
  assert.doesNotMatch(redacted, /secret\/data\/ciclo\/mcp/);
  assert.doesNotMatch(redacted, /keychain:\/\/ciclo\/example-api-token/);
});
