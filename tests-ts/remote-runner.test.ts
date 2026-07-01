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

test("Kubernetes remote runner plan includes WireGuard tunnel Herdr attach and job artifact", () => {
  const plan = buildRemoteRunnerLaunchPlan({
    ...baseRequest,
    kubernetes: {
      namespace: "ciclo-runners",
      serviceAccount: "ciclo-runner",
      jobName: "ciclo-remote-1"
    }
  });

  assert.equal(plan.runnerKind, "kubernetes");
  assert.equal(plan.providerName, "kubernetes-job");
  assert.equal(plan.executionModel, "kubernetes_job");
  assert.equal(plan.herdrRemoteTarget, "ciclo@10.55.0.7:/workspace/project");
  assert.deepEqual(plan.attach.args, [
    "--remote",
    "ciclo@10.55.0.7:/workspace/project",
    "--session",
    "ciclo"
  ]);
  assert.equal(plan.wireGuard.interfaceName, "wg-ciclo");
  assert.match(plan.wireGuard.runnerConfig, /Endpoint = 198\.51\.100\.10:51820/);
  assert.match(plan.artifacts[0]?.content ?? "", /kind: Job/);
  assert.ok(plan.commands.some((command) => command.includes("kubectl -n ciclo-runners apply")));
  assert.ok(plan.evidence.includes("remote.runner.wireguard:planned"));
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
  assert.match(plan.artifacts[0]?.content ?? "", /ciclo-microvm-image/);
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
  assert.match(plan.artifacts[0]?.content ?? "", /name = "ciclo-cloudflare"/);
});

test("Ciclo attach plan targets overview or one agent inside a Herdr session", () => {
  const defaultOverview = buildCicloAttachPlan();
  assert.deepEqual(defaultOverview.args, ["--session", "ciclo"]);

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
  const plan = buildRemoteRunnerLaunchPlan({
    ...baseRequest,
    herdrSession: undefined
  });

  assert.equal(plan.herdrSession, "ciclo");
  assert.deepEqual(plan.attach.args, ["--remote", "ciclo@10.55.0.7:/workspace/project", "--session", "ciclo"]);
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
