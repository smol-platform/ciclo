import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createSecretProviderRegistryFromConfig,
  configMcpSecretEnvBindings,
  configWorkerSecretEnvBindings,
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
        { id: "corp-bao", kind: "openbao", command: "bao-corp", name: "Corp OpenBao" },
        {
          id: "corp-connect",
          kind: "onepassword-connect",
          name: "Corp Connect",
          endpoint: "https://connect.example.test",
          token_env: "CORP_OP_CONNECT_TOKEN",
          default_vault_id: "vault-default"
        }
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
      egress: {
        enabled: true,
        cidrs: ["140.82.112.0/20"],
        domains: ["github.com", "api.github.com"]
      },
      wireguard: {
        network_cidr: "10.70.0.0/24",
        runner_address: "10.70.0.9/24",
        ciclo_private_key_ref: "team/wg/ciclo_private",
        runner_public_key_ref: "team/wg/runner_public",
        host_routing: {
          enabled: true,
          service_cidrs: ["192.168.0.0/16"],
          egress_interface: "en0",
          masquerade: true
        }
      },
      kubernetes: {
        namespace: "ciclo-team",
        service_account: "ciclo-runner",
        mode: "statefulset",
        statefulset_name: "ciclo-acme",
        service_name: "ciclo-acme-headless",
        replicas: 1,
        storage_size: "20Gi"
      }
    },
    prompts: {
      system_injections: [
        {
          id: "project-goals",
          scope: "all",
          text: "Prefer small changes and keep Beads current."
        },
        {
          id: "brain-help",
          scope: "brain",
          text: "Escalate stuck workers after comparing validation and model fit.",
          enabled: true
        }
      ]
    },
      heartbeat: {
        preemptive_work: {
          issue_types: ["epic", "feature"],
          fallback_issue_types: ["task", "bug", "decision"],
          harnesses: [
            "codex",
            { harness_id: "claude-code", model: "claude-fable-5", effort: "high" }
        ]
      }
    }
  }));

  assert.equal(config.secrets?.providers?.[0]?.id, "corp-bao");
  assert.equal(config.secrets?.providers?.[1]?.kind, "onepassword-connect");
  assert.equal(config.secrets?.providers?.[1]?.tokenEnv, "CORP_OP_CONNECT_TOKEN");
  assert.equal(config.secrets?.providers?.[1]?.defaultVaultId, "vault-default");
  assert.equal(config.mcp?.serverName, "ciclo_team");
  assert.equal(config.mcp?.secretBindings?.[0]?.ref, "secret/data/ciclo/api");
  assert.equal(config.mcp?.secretBindings?.[0]?.format, "Bearer ${secret}");
  assert.equal(config.remote?.runnerKind, "kubernetes");
  assert.deepEqual(config.remote?.egress?.domains, ["github.com", "api.github.com"]);
  assert.equal(config.remote?.wireGuard?.runnerAddress, "10.70.0.9/24");
  assert.equal(config.remote?.wireGuard?.cicloPrivateKeySecretRef, "team/wg/ciclo_private");
  assert.equal(config.remote?.wireGuard?.runnerPublicKeySecretRef, "team/wg/runner_public");
  assert.deepEqual(config.remote?.wireGuard?.hostRouting?.serviceCidrs, ["192.168.0.0/16"]);
  assert.equal(config.remote?.wireGuard?.hostRouting?.egressInterface, "en0");
  assert.equal(config.remote?.kubernetes?.mode, "statefulset");
  assert.equal(config.remote?.kubernetes?.statefulSetName, "ciclo-acme");
  assert.equal(config.remote?.kubernetes?.storageSize, "20Gi");
  assert.equal(config.prompts?.systemInjections?.[0]?.id, "project-goals");
  assert.equal(config.prompts?.systemInjections?.[1]?.scope, "brain");
    assert.deepEqual(config.heartbeat?.preemptiveWork?.harnesses, [
      { harnessId: "codex" },
      { harnessId: "claude-code", model: "claude-fable-5", effort: "high" }
    ]);
    assert.deepEqual(config.heartbeat?.preemptiveWork?.issueTypes, ["epic", "feature"]);
    assert.deepEqual(config.heartbeat?.preemptiveWork?.fallbackIssueTypes, ["task", "bug", "decision"]);

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
    assert.equal(loaded.config.prompts?.systemInjections?.[0]?.id, "project-goals");

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

test("config registers 1Password Connect secret providers", async () => {
  const config = parseCicloProjectConfigText(JSON.stringify({
    secrets: {
      providers: [
        {
          id: "corp-connect",
          kind: "onepassword-connect",
          endpoint: "https://connect.example.test",
          tokenEnv: "CORP_OP_CONNECT_TOKEN",
          defaultVaultId: "vault-default"
        }
      ]
    }
  }));
  const registry = createSecretProviderRegistryFromConfig(config);
  const provider = registry.list().find((entry) => entry.id === "corp-connect");

  assert.equal(provider?.kind, "onepassword-connect");
  assert.equal(provider?.supportsFields, true);
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
      workerSecretBindings: [
        { name: "GRAFANA_URL", providerId: "onepassword", ref: "op://Engineering/Grafana/url" }
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
      imageResolver: {
        strategy: "variant",
        repository: "smol-platform/ciclo",
        tag: "latest"
      },
      repoPath: "/workspace/repo",
      sshUser: "ciclo",
      preflightOnly: true,
      repoBootstrap: { useDevenv: true },
      egress: { enabled: true, cidrs: ["203.0.113.0/24"], domains: ["github.com"] },
      vars: { CICLO_REMOTE_MODE: "config" },
      cloudflare: { accountId: "acct-1", workerName: "ciclo-worker" }
    },
    prompts: {
      systemInjections: [
        {
          id: "worker-goal",
          scope: "worker",
          text: "Use repository-local validation before reporting done."
        }
      ]
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
  assert.equal(worker.workerEnv?.CICLO_REUSE_HERDR_SESSION, "true");
  assert.equal(worker.mcpAdditionalServers?.filesystem?.["env"].MCP_FS_MODE, "config");
  assert.deepEqual(worker.mcpSecretEnv?.map((binding) => binding.name), ["GITHUB_TOKEN", "GITHUB_AUTHORIZATION"]);
  assert.deepEqual(worker.workerSecretEnv?.map((binding) => binding.name), ["GRAFANA_URL"]);
  assert.equal(worker.workerSecretEnv?.[0]?.secretRefHash, secretRefHash("op://Engineering/Grafana/url"));
  assert.equal(worker.promptInjections?.[0]?.id, "worker-goal");

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
  assert.equal(remote.imageResolver?.strategy, "variant");
  assert.equal(remote.preflightOnly, true);
  assert.equal(remote.repoBootstrap?.useDevenv, true);
  assert.deepEqual(remote.egress?.cidrs, ["203.0.113.0/24"]);
  assert.deepEqual(remote.egress?.domains, ["github.com"]);
  assert.equal(remote.repoPath, "/workspace/repo");
  assert.equal(remote.environment?.CICLO_REMOTE_MODE, "config");
  assert.equal(remote.mcpAdditionalServers?.filesystem?.command, "npx");
  assert.equal(remote.cloudflare?.workerName, "ciclo-worker");
  assert.equal(remote.promptInjections?.[0]?.text, "Use repository-local validation before reporting done.");
});

test("config rejects secret-like prompt injections", () => {
  assert.throws(
    () => parseCicloProjectConfigText(JSON.stringify({
      prompts: {
        systemInjections: [
          {
            id: "bad-secret",
            scope: "all",
            text: "Use token=ghp_should_not_be_in_prompts for GitHub."
          }
        ]
      }
    })),
    /appears to contain a secret/u
  );
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

test("config worker secret env bindings are runtime references", () => {
  const config = parseCicloProjectConfigText(JSON.stringify({
    mcp: {
      workerSecretBindings: [
        {
          name: "GITHUB_TOKEN",
          providerId: "fixture",
          ref: "op://Engineering/GitHub Token/token",
          reason: "worker shell needs gh"
        }
      ]
    }
  }));
  const workerSecrets = configWorkerSecretEnvBindings(config);
  assert.equal(workerSecrets[0]?.name, "GITHUB_TOKEN");
  assert.equal(workerSecrets[0]?.value, undefined);
  assert.equal(workerSecrets[0]?.secretRefHash, secretRefHash("op://Engineering/GitHub Token/token"));
  assert.ok(workerSecrets[0]?.evidence.includes("worker.secret_env:configured"));

  const redacted = JSON.stringify(redactedCicloProjectConfig(config));
  assert.doesNotMatch(redacted, /op:\/\/Engineering\/GitHub Token\/token/u);
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
  assert.equal(config.mcp?.secretBindings?.length, 4);
  assert.equal(config.mcp?.secretBindings?.[2]?.providerId, "team-keychain");
  assert.equal(config.mcp?.secretBindings?.[2]?.ref, "keychain://ciclo/example-api-token");
  assert.equal(config.mcp?.secretBindings?.[2]?.format, "Bearer ${secret}");
  assert.equal(config.mcp?.secretBindings?.[3]?.providerId, "team-1password-connect");
  assert.match(config.mcp?.secretBindings?.[3]?.ref ?? "", /^op-connect:\/\//u);
  assert.equal(config.mcp?.workerSecretBindings?.[0]?.name, "GITHUB_TOKEN");
  assert.equal(config.remote?.runnerKind, "kubernetes");
  assert.equal(config.remote?.imageResolver?.strategy, "variant");
  assert.equal(config.remote?.repoBootstrap?.useDevenv, true);
  assert.equal(config.remote?.wireGuard?.interfaceName, "wg-ciclo");
  assert.equal(config.remote?.wireGuard?.existingConfigSecretName, "project-wireguard-runner");
  assert.equal(config.remote?.awsLambda?.microVmName, "ciclo-project-runner");
  assert.equal(config.remote?.cloudflare?.workerName, "ciclo-project-runner");
  assert.equal(config.prompts?.systemInjections?.[0]?.id, "project-goals");
    assert.equal(config.heartbeat?.preemptiveWork?.harnesses?.[1]?.harnessId, "claude-code");
    assert.equal(config.heartbeat?.preemptiveWork?.harnesses?.[1]?.model, "claude-fable-5");
    assert.deepEqual(config.heartbeat?.preemptiveWork?.fallbackIssueTypes, ["task", "bug", "decision"]);

  const redacted = JSON.stringify(redactedCicloProjectConfig(config));
  assert.doesNotMatch(redacted, /op:\/\/Ciclo\/API\/token/);
  assert.doesNotMatch(redacted, /op:\/\/Ciclo\/GitHub\/token/);
  assert.doesNotMatch(redacted, /secret\/data\/ciclo\/mcp/);
  assert.doesNotMatch(redacted, /keychain:\/\/ciclo\/example-api-token/);
  assert.doesNotMatch(redacted, /op-connect:\/\/replace-with-vault-uuid/u);
});
