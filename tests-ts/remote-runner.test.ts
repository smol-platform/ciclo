import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCicloAttachPlan,
  buildRemoteRunnerLaunchPlan,
  RemoteRunnerPluginRegistry,
  RemoteRunnerRegistry
} from "../src/remote-runner.js";

const baseRequest = {
  runnerKind: "kubernetes" as const,
  runnerId: "runner-1",
  loopId: "loop-remote",
  beadId: "ciclo-remote.1",
  harnessId: "codex" as const,
  image: "ghcr.io/acme/ciclo-runner:latest",
  repoUrl: "https://github.com/acme/project.git",
  repoPath: "/workspace/project",
  prompt: "Use Ciclo MCP and report progress.",
  herdrSession: "ciclo",
  sshUser: "ciclo",
  wireGuard: {
    networkCidr: "10.55.0.0/24",
    runnerAddress: "10.55.0.7/24",
    cicloEndpoint: "198.51.100.10:51820"
  }
};

function withHerdrSessionEnv(sessionName: string, run: () => void): void {
  const before = {
    CICLO_SESSION_NAME: process.env.CICLO_SESSION_NAME,
    HERDR_SESSION_NAME: process.env.HERDR_SESSION_NAME,
    CICLO_REUSE_HERDR_SESSION: process.env.CICLO_REUSE_HERDR_SESSION
  };
  delete process.env.CICLO_SESSION_NAME;
  process.env.HERDR_SESSION_NAME = sessionName;
  delete process.env.CICLO_REUSE_HERDR_SESSION;
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Kubernetes remote runner plan includes WireGuard tunnel Herdr attach and StatefulSet artifact", () => {
  const plan = buildRemoteRunnerLaunchPlan({
    ...baseRequest,
    wireGuard: {
      ...baseRequest.wireGuard,
      hostRouting: {
        enabled: true,
        serviceCidrs: ["192.168.0.0/16"],
        egressInterface: "en0"
      }
    },
    egress: {
      enabled: true,
      name: "ciclo-remote-1-egress",
      cidrs: ["140.82.112.0/20"],
      domains: ["github.com", "api.github.com"]
    },
    kubernetes: {
      namespace: "ciclo-runners",
      serviceAccount: "ciclo-runner",
      statefulSetName: "ciclo-remote-1",
      serviceName: "ciclo-remote-1-headless",
      storageSize: "10Gi"
    }
  });

  assert.equal(plan.runnerKind, "kubernetes");
  assert.equal(plan.providerName, "kubernetes-statefulset");
  assert.equal(plan.executionModel, "kubernetes_statefulset");
  assert.equal(plan.herdrRemoteTarget, "ciclo@10.55.0.7:/workspace/project");
  assert.deepEqual(plan.attach.args, [
    "--remote",
    "ciclo@10.55.0.7:/workspace/project",
    "--session",
    "ciclo"
  ]);
  assert.equal(plan.wireGuard.interfaceName, "wg-ciclo");
  assert.match(plan.wireGuard.runnerConfig, /Endpoint = 198\.51\.100\.10:51820/);
  assert.match(plan.wireGuard.runnerConfig, /AllowedIPs = 10\.55\.0\.0\/24, 192\.168\.0\.0\/16/);
  assert.deepEqual(plan.wireGuard.runnerAllowedIps, ["10.55.0.0/24", "192.168.0.0/16"]);
  assert.equal(plan.wireGuard.hostRouting.egressInterface, "en0");
  const statefulSetArtifact = plan.artifacts.find((artifact) => artifact.name === "ciclo-remote-1.statefulset.yaml");
  const hostConfigArtifact = plan.artifacts.find((artifact) => artifact.name === "wg-ciclo.host.conf");
  const hostSetupArtifact = plan.artifacts.find((artifact) => artifact.name === "wg-ciclo.host-setup.sh");
  const wireGuardBootstrapArtifact = plan.artifacts.find((artifact) => artifact.name === "ciclo-remote-1.wireguard-bootstrap.sh");
  const serviceArtifact = plan.artifacts.find((artifact) => artifact.name === "ciclo-remote-1-headless.service.yaml");
  const networkPolicyArtifact = plan.artifacts.find((artifact) => artifact.name === "ciclo-remote-1-egress.networkpolicy.yaml");
  const wireGuardSecretArtifact = plan.artifacts.find((artifact) => artifact.name === "ciclo-remote-1.wireguard-secret.yaml");
  const preflightConfigMapArtifact = plan.artifacts.find((artifact) => artifact.name === "ciclo-remote-1.preflight-configmap.yaml");
  const preflightScriptArtifact = plan.artifacts.find((artifact) => artifact.name === "runner-1.preflight.sh");
  assert.match(statefulSetArtifact?.content ?? "", /kind: StatefulSet/);
  assert.match(statefulSetArtifact?.content ?? "", /serviceName: ciclo-remote-1-headless/);
  assert.match(statefulSetArtifact?.content ?? "", /storage: 10Gi/);
  assert.match(statefulSetArtifact?.content ?? "", /command: \["\/bin\/bash", "-lc"\]/);
  assert.doesNotMatch(statefulSetArtifact?.content ?? "", /command: \["\/bin\/sh", "-lc"\]/);
  assert.match(statefulSetArtifact?.content ?? "", /git clone "\$CICLO_REPO_URL" "\$CICLO_REPO_PATH"/);
  assert.match(statefulSetArtifact?.content ?? "", /devenv shell -- true/);
  assert.match(statefulSetArtifact?.content ?? "", /mountPath: \/ciclo\/preflight/);
  assert.match(statefulSetArtifact?.content ?? "", /bash \/ciclo\/preflight\/ciclo-remote-preflight\.sh \|\| true/);
  assert.match(statefulSetArtifact?.content ?? "", /mountPath: \/ciclo\/wg/);
  assert.match(statefulSetArtifact?.content ?? "", /secretName: ciclo-remote-1-wireguard/);
  assert.match(hostConfigArtifact?.content ?? "", /ListenPort = 51820/);
  assert.match(hostConfigArtifact?.content ?? "", /AllowedIPs = 10\.55\.0\.7\/32/);
  assert.match(hostSetupArtifact?.content ?? "", /net\.ipv4\.ip_forward=1/);
  assert.match(hostSetupArtifact?.content ?? "", /MASQUERADE/);
  assert.match(hostSetupArtifact?.content ?? "", /wg-quick up "\$WG_IF"/);
  assert.match(wireGuardBootstrapArtifact?.content ?? "", /wg genkey/);
  assert.match(wireGuardBootstrapArtifact?.content ?? "", /create secret generic "\$SECRET_NAME"/);
  assert.match(wireGuardBootstrapArtifact?.content ?? "", /sudo wg-quick up "\$WG_IF"/);
  assert.match(serviceArtifact?.content ?? "", /kind: Service/);
  assert.match(networkPolicyArtifact?.content ?? "", /kind: NetworkPolicy/);
  assert.match(networkPolicyArtifact?.content ?? "", /cidr: 140\.82\.112\.0\/20/);
  assert.match(networkPolicyArtifact?.content ?? "", /ciclo\.smol\.dev\/egress-domains/);
  assert.match(preflightConfigMapArtifact?.content ?? "", /kind: ConfigMap/);
  assert.match(preflightConfigMapArtifact?.content ?? "", /claude-noninteractive/);
  assert.match(preflightScriptArtifact?.content ?? "", /--max-budget-usd/);
  assert.equal(wireGuardSecretArtifact, undefined);
  assert.ok(plan.commands.some((command) => command.includes("preflight-configmap.yaml")));
  assert.ok(plan.commands.some((command) => command.includes("bash ciclo-remote-1.wireguard-bootstrap.sh")));
  assert.ok(plan.commands.some((command) => command.includes("networkpolicy.yaml")));
  assert.ok(plan.commands.some((command) => command.includes("kubectl -n ciclo-runners apply")));
  assert.ok(plan.evidence.includes("remote.runner.wireguard:planned"));
  assert.ok(plan.evidence.includes("remote.runner.wireguard.host_routing:enabled"));
  assert.ok(plan.evidence.includes("remote.runner.wireguard.host_routing.service_cidrs:192.168.0.0/16"));
  assert.ok(plan.evidence.includes("remote.runner.execution_model:kubernetes_statefulset"));
  assert.ok(plan.evidence.includes("remote.runner.wireguard.secret:bootstrap"));
  assert.ok(plan.evidence.includes("remote.runner.wireguard.bootstrap:planned"));
  assert.ok(plan.evidence.includes("remote.runner.egress:planned"));
  assert.ok(plan.evidence.includes("remote.runner.image.strategy:static"));
  assert.ok(plan.evidence.includes("remote.runner.repo_bootstrap:planned"));
  assert.ok(plan.evidence.includes("remote.runner.preflight.claude:planned"));
  assert.equal(plan.preflight?.reportPath, "/tmp/ciclo-remote-preflight.jsonl");
  assert.equal(plan.repoBootstrap.useDevenv, true);
  assert.equal(plan.mcpConfig?.projectRoot, "/workspace/project");
  assert.deepEqual(plan.mcpConfig?.clients, ["codex"]);
  assert.ok(plan.mcpConfig?.artifacts.some((artifact) => artifact.name === ".codex/config.toml"));
  assert.ok(plan.evidence.includes("remote.runner.mcp_config:planned"));
});

test("Kubernetes remote runner emits WireGuard Secret only when key material is provided", () => {
  const plan = buildRemoteRunnerLaunchPlan({
    ...baseRequest,
    wireGuard: {
      ...baseRequest.wireGuard,
      runnerPrivateKeyValue: "runner-private-key-fixture",
      cicloPublicKeyValue: "ciclo-public-key-fixture",
      cicloPrivateKeyValue: "ciclo-private-key-fixture",
      runnerPublicKeyValue: "runner-public-key-fixture"
    },
    kubernetes: {
      namespace: "ciclo-runners",
      statefulSetName: "ciclo-keyed-runner"
    }
  });

  const wireGuardSecretArtifact = plan.artifacts.find((artifact) => artifact.name === "ciclo-keyed-runner.wireguard-secret.yaml");

  assert.match(wireGuardSecretArtifact?.content ?? "", /kind: Secret/);
  assert.match(wireGuardSecretArtifact?.content ?? "", /runner\.conf: \|/);
  assert.match(wireGuardSecretArtifact?.content ?? "", /runner-private-key-fixture/);
  assert.match(plan.wireGuard.hostConfig, /ciclo-private-key-fixture/);
  assert.match(plan.wireGuard.hostConfig, /runner-public-key-fixture/);
  assert.ok(plan.evidence.includes("remote.runner.wireguard.material:provided"));
  assert.ok(plan.evidence.includes("remote.runner.wireguard.host_material:provided"));
  assert.ok(plan.evidence.includes("remote.runner.wireguard.secret:generated"));
  assert.ok(plan.commands.includes("sudo bash wg-ciclo.host-setup.sh"));
});

test("Kubernetes remote runner can run preflight only with an existing WireGuard secret", () => {
  const plan = buildRemoteRunnerLaunchPlan({
    ...baseRequest,
    repoUrl: undefined,
    preflightOnly: true,
    wireGuard: {
      ...baseRequest.wireGuard,
      existingConfigSecretName: "runner-real-wireguard"
    },
    kubernetes: {
      namespace: "ciclo-runners",
      serviceAccount: "default",
      jobName: "ciclo-preflight-only"
    }
  });

  const jobArtifact = plan.artifacts.find((artifact) => artifact.name === "ciclo-preflight-only.job.yaml");
  assert.match(jobArtifact?.content ?? "", /CICLO_PREFLIGHT_ONLY/);
  assert.match(jobArtifact?.content ?? "", /if \[ "\$\{CICLO_PREFLIGHT_ONLY:-false\}" = "true" \]; then exit 0; fi/);
  assert.match(jobArtifact?.content ?? "", /secretName: runner-real-wireguard/);
  assert.ok(!plan.artifacts.some((artifact) => artifact.name === "ciclo-preflight-only.wireguard-secret.yaml"));
  assert.ok(plan.evidence.includes("remote.runner.preflight_only:planned"));
  assert.ok(plan.evidence.includes("remote.runner.wireguard.secret:existing"));
});

test("remote runner image resolver supports variant and Nixery strategies", () => {
  const variantPlan = buildRemoteRunnerLaunchPlan({
    ...baseRequest,
    image: "",
    imageResolver: {
      strategy: "variant",
      registry: "ghcr.io",
      repository: "smol-platform/ciclo",
      tag: "latest"
    }
  });
  assert.equal(variantPlan.image, "ghcr.io/smol-platform/ciclo:codex-latest");
  assert.equal(variantPlan.imageResolution.strategy, "variant");

  const nixeryPlan = buildRemoteRunnerLaunchPlan({
    ...baseRequest,
    harnessId: "claude-code",
    image: "",
    imageResolver: {
      strategy: "nixery",
      registry: "nixery.internal.example",
      extraPackages: ["ripgrep"]
    }
  });
  assert.equal(nixeryPlan.imageResolution.strategy, "nixery");
  assert.match(nixeryPlan.image, /nixery\.internal\.example\/shell\/git\/nodejs_24\/openssh\/wireguard-tools\/herdr\/claude-code/);
  assert.ok(nixeryPlan.imageResolution.packages?.includes("ripgrep"));
});

test("remote runner plan can generate Claude .mcp.json for the remote repo path", () => {
  const plan = buildRemoteRunnerLaunchPlan({
    ...baseRequest,
    harnessId: "claude-code",
    mcpClients: ["claude", "codex"],
    mcpServerName: "ciclo_remote",
    mcpCommand: "ciclo",
    mcpVars: { CICLO_REUSE_HERDR_SESSION: "true" },
    mcpAdditionalServers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
        env: { MCP_FS_MODE: "remote" }
      }
    },
    kubernetes: {
      namespace: "ciclo-runners",
      serviceAccount: "ciclo-runner",
      jobName: "ciclo-remote-1"
    }
  });

  assert.deepEqual(plan.mcpConfig?.clients, ["claude", "codex"]);
  assert.equal(plan.mcpConfig?.serverName, "ciclo_remote");
  assert.deepEqual(plan.mcpConfig?.varKeys, ["CICLO_REUSE_HERDR_SESSION"]);
  assert.deepEqual(plan.mcpConfig?.additionalServerNames, ["filesystem"]);

  const claudeArtifact = plan.mcpConfig?.artifacts.find((artifact) => artifact.name === ".mcp.json");
  assert.ok(claudeArtifact);
  assert.match(claudeArtifact.content, /"ciclo_remote"/);
  assert.match(claudeArtifact.content, /"filesystem"/);
  assert.match(claudeArtifact.content, /"CICLO_PROJECT_ROOT": "\/workspace\/project"/);
  assert.match(claudeArtifact.content, /"CICLO_REUSE_HERDR_SESSION": "true"/);
  assert.match(claudeArtifact.content, /"MCP_FS_MODE": "remote"/);
  assert.ok(plan.artifacts.some((artifact) => artifact.name === ".mcp.json"));
});

test("AWS Lambda runner plan uses the MicroVM execution model", () => {
  const plan = buildRemoteRunnerLaunchPlan({
    ...baseRequest,
    runnerKind: "aws-lambda",
    awsLambda: {
      microVmImageName: "ciclo-microvm-image",
      microVmName: "ciclo-microvm",
      baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image/nodejs22",
      buildRoleArn: "arn:aws:iam::111122223333:role/ciclo-runner-build",
      executionRoleArn: "arn:aws:iam::111122223333:role/ciclo-runner",
      sourceS3Uri: "s3://ciclo-artifacts/ciclo-microvm.tar",
      memoryMb: 2048,
      vcpuCount: 2
    }
  });

  assert.equal(plan.runnerKind, "aws-lambda");
  assert.equal(plan.providerName, "aws-lambda-microvm");
  assert.equal(plan.executionModel, "aws_lambda_microvm");
  assert.ok(plan.commands.some((command) => command.includes("aws lambda-microvms create-microvm-image")));
  assert.ok(plan.commands.some((command) => command.includes("aws lambda-microvms run-microvm")));
  assert.ok(plan.commands.some((command) => command.includes("aws lambda-microvms suspend-microvm")));
  assert.ok(plan.commands.some((command) => command.includes("aws lambda-microvms resume-microvm")));
  assert.ok(plan.commands.some((command) => command.includes("aws lambda-microvms terminate-microvm")));
  assert.ok(plan.warnings.some((warning) => warning.includes("Firecracker-backed")));
  assert.match(plan.artifacts.find((artifact) => artifact.name === "ciclo-microvm-image.create-microvm-image.json")?.content ?? "", /ciclo-microvm-image/);
  assert.ok(plan.evidence.includes("remote.runner.plugin:aws-lambda-microvm"));
});

test("Cloudflare runner plan requires a container or userspace connector for Herdr", () => {
  const plan = buildRemoteRunnerLaunchPlan({
    ...baseRequest,
    runnerKind: "cloudflare",
    cloudflare: {
      accountId: "cf-account",
      workerName: "ciclo-cloudflare"
    }
  });

  assert.equal(plan.runnerKind, "cloudflare");
  assert.ok(plan.commands.some((command) => command.includes("wrangler deploy")));
  assert.ok(plan.warnings.some((warning) => warning.includes("container or userspace connector")));
  assert.match(plan.artifacts.find((artifact) => artifact.name === "ciclo-cloudflare.wrangler.toml")?.content ?? "", /name = "ciclo-cloudflare"/);
});

test("Ciclo attach plan targets overview or one agent inside a Herdr session", () => {
  const before = process.env.CICLO_REUSE_HERDR_SESSION;
  process.env.CICLO_REUSE_HERDR_SESSION = "false";
  try {
    const defaultOverview = buildCicloAttachPlan();
    assert.deepEqual(defaultOverview.args, ["--session", "ciclo"]);
  } finally {
    if (before === undefined) delete process.env.CICLO_REUSE_HERDR_SESSION;
    else process.env.CICLO_REUSE_HERDR_SESSION = before;
  }

  const overview = buildCicloAttachPlan({ session: "ciclo" });
  assert.deepEqual(overview.args, ["--session", "ciclo"]);
  assert.equal(overview.mode, "overview");

  const agent = buildCicloAttachPlan({
    remoteTarget: "ciclo@10.55.0.7:/workspace/project",
    session: "ciclo",
    target: "pane-1"
  });
  assert.deepEqual(agent.args, [
    "--remote",
    "ciclo@10.55.0.7:/workspace/project",
    "--session",
    "ciclo",
    "agent",
    "attach",
    "pane-1"
  ]);
  assert.equal(agent.mode, "agent");
});

test("remote runner registry records launch plans for later status", () => {
  const registry = new RemoteRunnerRegistry();
  const result = registry.launch(baseRequest);

  assert.equal(result.accepted, true);
  assert.equal(result.plan?.runnerId, "runner-1");
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("runner-1")?.herdrSession, "ciclo");
});

test("remote runner plans default Herdr session to repository name", () => {
  const before = process.env.CICLO_REUSE_HERDR_SESSION;
  process.env.CICLO_REUSE_HERDR_SESSION = "false";
  try {
    const plan = buildRemoteRunnerLaunchPlan({
      ...baseRequest,
      herdrSession: undefined
    });

    assert.equal(plan.herdrSession, "ciclo");
    assert.deepEqual(plan.attach.args, ["--remote", "ciclo@10.55.0.7:/workspace/project", "--session", "ciclo"]);
  } finally {
    if (before === undefined) delete process.env.CICLO_REUSE_HERDR_SESSION;
    else process.env.CICLO_REUSE_HERDR_SESSION = before;
  }
});

test("remote runner defaults reuse active Herdr session", () => {
  withHerdrSessionEnv("operator-main", () => {
    const plan = buildRemoteRunnerLaunchPlan({
      ...baseRequest,
      herdrSession: undefined
    });

    assert.equal(plan.herdrSession, "operator-main");
    assert.deepEqual(plan.attach.args, ["--remote", "ciclo@10.55.0.7:/workspace/project", "--session", "operator-main"]);
    const statefulSetArtifact = plan.artifacts.find((artifact) => artifact.name === "runner-1.statefulset.yaml");
    assert.match(statefulSetArtifact?.content ?? "", /operator-main/);
  });
});

test("remote runner registry accepts new provider plugins without core branching", () => {
  const plugins = new RemoteRunnerPluginRegistry([
    {
      kind: "kubernetes",
      name: "test-kubernetes-provider",
      executionModel: "test_model",
      plan(_input, _wireGuard) {
        return {
          providerName: "test-kubernetes-provider",
          executionModel: "test_model",
          artifacts: [{ name: "test.json", format: "json", content: "{}" }],
          commands: ["test-provider launch"],
          warnings: [],
          evidence: ["remote.runner.plugin:test-kubernetes-provider"]
        };
      }
    }
  ]);
  const registry = new RemoteRunnerRegistry(plugins);
  const result = registry.launch(baseRequest);

  assert.equal(result.accepted, true);
  assert.equal(result.plan?.providerName, "test-kubernetes-provider");
  assert.deepEqual(result.plan?.commands, ["test-provider launch"]);
  assert.ok(result.evidence.includes("remote.runner.plugin:test-kubernetes-provider"));
});
