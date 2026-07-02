import { randomUUID } from "node:crypto";

import type { HarnessId } from "./ciclo-core.js";
import {
  renderFreshCicloMcpInstallArtifacts,
  type CicloMcpAdditionalServerConfig,
  type CicloMcpInstallClient,
  type CicloMcpInstallResult
} from "./mcp-install.js";
import type { CicloMcpAdditionalServerSecretEnvInstall } from "./mcp-secret-placeholders.js";
import { repoSessionName } from "./repo-session-name.js";

export type BuiltinRemoteRunnerKind = "kubernetes" | "aws-lambda" | "cloudflare";
export type RemoteRunnerKind = string;
export const builtinRemoteRunnerKinds: readonly BuiltinRemoteRunnerKind[] = ["kubernetes", "aws-lambda", "cloudflare"];
export type RemoteRunnerState = "planned" | "launching" | "registered" | "failed" | "stopped";

export interface WireGuardTunnelRequest {
  readonly interfaceName?: string;
  readonly networkCidr?: string;
  readonly cicloAddress?: string;
  readonly runnerAddress?: string;
  readonly cicloEndpoint?: string;
  readonly cicloPublicKeySecretRef?: string;
  readonly runnerPrivateKeySecretRef?: string;
  readonly persistentKeepaliveSeconds?: number;
}

export interface RemoteRunnerLaunchRequest {
  readonly runnerKind: RemoteRunnerKind;
  readonly runnerId?: string;
  readonly loopId: string;
  readonly beadId?: string;
  readonly harnessId: HarnessId;
  readonly image: string;
  readonly repoUrl?: string;
  readonly repoPath: string;
  readonly prompt: string;
  readonly herdrSession?: string;
  readonly sshUser?: string;
  readonly wireGuard?: WireGuardTunnelRequest;
  readonly environment?: Record<string, string>;
  readonly configureMcp?: boolean;
  readonly mcpClients?: readonly CicloMcpInstallClient[];
  readonly mcpServerName?: string;
  readonly mcpCommand?: string;
  readonly mcpVars?: Record<string, string>;
  readonly mcpAdditionalServers?: Record<string, CicloMcpAdditionalServerConfig>;
  readonly mcpAdditionalServerSecretEnv?: readonly CicloMcpAdditionalServerSecretEnvInstall[];
  readonly mcpClaudeChannel?: boolean;
  readonly kubernetes?: {
    readonly namespace?: string;
    readonly serviceAccount?: string;
    readonly jobName?: string;
  };
  readonly awsLambda?: {
    readonly microVmImageName?: string;
    readonly microVmImageIdentifier?: string;
    readonly microVmName?: string;
    readonly baseImageArn?: string;
    readonly buildRoleArn?: string;
    readonly executionRoleArn?: string;
    readonly sourceS3Uri?: string;
    readonly ingressNetworkConnectors?: readonly string[];
    readonly egressNetworkConnectors?: readonly string[];
    readonly memoryMb?: number;
    readonly vcpuCount?: number;
  };
  readonly cloudflare?: {
    readonly accountId?: string;
    readonly workerName?: string;
  };
  readonly dryRun?: boolean;
}

export interface WireGuardTunnelPlan {
  readonly interfaceName: string;
  readonly networkCidr: string;
  readonly cicloAddress: string;
  readonly runnerAddress: string;
  readonly cicloEndpoint: string;
  readonly requiredSecrets: readonly string[];
  readonly runnerConfig: string;
  readonly evidence: readonly string[];
}

export interface RemoteRunnerArtifact {
  readonly name: string;
  readonly format: "yaml" | "json" | "shell" | "toml";
  readonly content: string;
}

export interface RemoteRunnerMcpConfigPlan {
  readonly enabled: boolean;
  readonly projectRoot: string;
  readonly clients: readonly CicloMcpInstallClient[];
  readonly serverName: string;
  readonly command: string;
  readonly vars: Record<string, string>;
  readonly varKeys: readonly string[];
  readonly additionalServers: Record<string, CicloMcpAdditionalServerConfig>;
  readonly additionalServerNames: readonly string[];
  readonly additionalServerSecretEnv: readonly CicloMcpAdditionalServerSecretEnvInstall[];
  readonly claudeChannel?: boolean;
  readonly install: CicloMcpInstallResult;
  readonly commands: readonly string[];
  readonly artifacts: readonly RemoteRunnerArtifact[];
  readonly warnings: readonly string[];
  readonly evidence: readonly string[];
}

export interface CicloAttachPlan {
  readonly session: string;
  readonly remoteTarget?: string;
  readonly target?: string;
  readonly mode: "overview" | "agent";
  readonly command: string;
  readonly args: readonly string[];
  readonly evidence: readonly string[];
}

export interface RemoteRunnerLaunchPlan {
  readonly runnerId: string;
  readonly runnerKind: RemoteRunnerKind;
  readonly providerName: string;
  readonly executionModel: string;
  readonly state: RemoteRunnerState;
  readonly loopId: string;
  readonly beadId?: string;
  readonly harnessId: HarnessId;
  readonly image: string;
  readonly repoUrl?: string;
  readonly repoPath: string;
  readonly prompt: string;
  readonly herdrSession: string;
  readonly herdrRemoteTarget: string;
  readonly wireGuard: WireGuardTunnelPlan;
  readonly attach: CicloAttachPlan;
  readonly mcpConfig?: RemoteRunnerMcpConfigPlan;
  readonly commands: readonly string[];
  readonly artifacts: readonly RemoteRunnerArtifact[];
  readonly warnings: readonly string[];
  readonly evidence: readonly string[];
}

export interface RemoteRunnerRegistryLaunchResult {
  readonly accepted: boolean;
  readonly plan?: RemoteRunnerLaunchPlan;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface RemoteRunnerProviderPlan {
  readonly providerName: string;
  readonly executionModel: string;
  readonly commands: readonly string[];
  readonly artifacts: readonly RemoteRunnerArtifact[];
  readonly warnings: readonly string[];
  readonly evidence: readonly string[];
}

export interface RemoteRunnerProviderPlugin {
  readonly kind: RemoteRunnerKind;
  readonly name: string;
  readonly executionModel: string;
  plan(input: RemoteRunnerLaunchRequest, wireGuard: WireGuardTunnelPlan): RemoteRunnerProviderPlan;
}

export class RemoteRunnerPluginRegistry {
  private readonly plugins = new Map<RemoteRunnerKind, RemoteRunnerProviderPlugin>();

  constructor(plugins: readonly RemoteRunnerProviderPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: RemoteRunnerProviderPlugin): void {
    this.plugins.set(plugin.kind, plugin);
  }

  get(kind: RemoteRunnerKind): RemoteRunnerProviderPlugin | undefined {
    return this.plugins.get(kind);
  }

  require(kind: RemoteRunnerKind): RemoteRunnerProviderPlugin {
    const plugin = this.plugins.get(kind);
    if (plugin === undefined) throw new Error(`remote runner plugin is not registered: ${kind}`);
    return plugin;
  }

  list(): readonly RemoteRunnerProviderPlugin[] {
    return [...this.plugins.values()];
  }
}

export interface CicloRemoteRunnerPluginApi {
  readonly remoteRunners: {
    register(plugin: RemoteRunnerProviderPlugin): void;
  };
}

export function createRemoteRunnerPluginApi(registry: RemoteRunnerPluginRegistry): CicloRemoteRunnerPluginApi {
  return {
    remoteRunners: {
      register(plugin) {
        registry.register(plugin);
      }
    }
  };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function required(value: string | undefined, name: string): string {
  const cleaned = clean(value);
  if (cleaned === undefined) throw new Error(`${name} is required`);
  return cleaned;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function envLines(environment: Record<string, string> | undefined): string {
  return Object.entries(environment ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `            - name: ${key}\n              value: ${JSON.stringify(value)}`)
    .join("\n");
}

function wireGuardPlan(input: RemoteRunnerLaunchRequest): WireGuardTunnelPlan {
  const request = input.wireGuard ?? {};
  const interfaceName = clean(request.interfaceName) ?? "wg-ciclo";
  const networkCidr = clean(request.networkCidr) ?? "10.44.0.0/24";
  const cicloAddress = clean(request.cicloAddress) ?? "10.44.0.1/24";
  const runnerAddress = clean(request.runnerAddress) ?? "10.44.0.2/24";
  const cicloEndpoint = clean(request.cicloEndpoint) ?? "ciclo-wireguard.example.invalid:51820";
  const cicloPublicKeySecretRef = clean(request.cicloPublicKeySecretRef) ?? "ciclo/wireguard/ciclo_public_key";
  const runnerPrivateKeySecretRef = clean(request.runnerPrivateKeySecretRef) ?? "ciclo/wireguard/runner_private_key";
  const keepalive = request.persistentKeepaliveSeconds ?? 25;
  const runnerConfig = [
    "[Interface]",
    `Address = ${runnerAddress}`,
    `PrivateKey = \${secret:${runnerPrivateKeySecretRef}}`,
    "",
    "[Peer]",
    `PublicKey = \${secret:${cicloPublicKeySecretRef}}`,
    `AllowedIPs = ${networkCidr}`,
    `Endpoint = ${cicloEndpoint}`,
    `PersistentKeepalive = ${keepalive}`
  ].join("\n");

  return {
    interfaceName,
    networkCidr,
    cicloAddress,
    runnerAddress,
    cicloEndpoint,
    requiredSecrets: [runnerPrivateKeySecretRef, cicloPublicKeySecretRef],
    runnerConfig,
    evidence: [
      "remote.runner.wireguard:planned",
      `remote.runner.wireguard.interface:${interfaceName}`,
      `remote.runner.wireguard.network:${networkCidr}`
    ]
  };
}

export function buildCicloAttachPlan(input: {
  readonly remoteTarget?: string;
  readonly session?: string;
  readonly target?: string;
} = {}): CicloAttachPlan {
  const session = clean(input.session) ?? repoSessionName();
  const remoteTarget = clean(input.remoteTarget);
  const target = clean(input.target);
  const args = [
    ...(remoteTarget === undefined ? [] : ["--remote", remoteTarget]),
    "--session",
    session,
    ...(target === undefined ? [] : ["agent", "attach", target])
  ];
  return {
    session,
    remoteTarget,
    target,
    mode: target === undefined ? "overview" : "agent",
    command: "herdr",
    args,
    evidence: [
      "ciclo.attach:planned",
      remoteTarget === undefined ? "ciclo.attach.scope:local" : "ciclo.attach.scope:remote",
      `ciclo.attach.session:${session}`,
      ...(target === undefined ? ["ciclo.attach.mode:overview"] : [`ciclo.attach.target:${target}`])
    ]
  };
}

function runnerHostAddress(wireGuard: WireGuardTunnelPlan): string {
  return wireGuard.runnerAddress.split("/")[0] ?? wireGuard.runnerAddress;
}

function remoteTarget(input: RemoteRunnerLaunchRequest, wireGuard: WireGuardTunnelPlan): string {
  const user = clean(input.sshUser) ?? "ciclo";
  return `${user}@${runnerHostAddress(wireGuard)}:${input.repoPath}`;
}

function mcpClientsForRemote(input: RemoteRunnerLaunchRequest): readonly CicloMcpInstallClient[] {
  if (input.mcpClients !== undefined && input.mcpClients.length > 0) return [...new Set(input.mcpClients)];
  return input.harnessId === "codex" ? ["codex"] : ["claude"];
}

function mcpClientArg(clients: readonly CicloMcpInstallClient[]): string {
  return clients.includes("claude") && clients.includes("codex") ? "all" : clients[0] ?? "claude";
}

function remoteMcpArtifactName(path: string, projectRoot: string): string {
  const prefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function remoteMcpConfigPlan(input: RemoteRunnerLaunchRequest, repoPath: string): RemoteRunnerMcpConfigPlan | undefined {
  if (input.configureMcp === false) return undefined;
  const requestedClients = mcpClientsForRemote(input);
  const claudeChannel = input.mcpClaudeChannel === true;
  const clients = claudeChannel && !requestedClients.includes("claude")
    ? [...requestedClients, "claude" as const]
    : requestedClients;
  const serverName = clean(input.mcpServerName) ?? "ciclo";
  const command = clean(input.mcpCommand) ?? "ciclo";
  const rendered = renderFreshCicloMcpInstallArtifacts({
    projectRoot: repoPath,
    clients,
    serverName,
    command,
    env: input.mcpVars,
    additionalServers: input.mcpAdditionalServers,
    additionalServerSecretEnv: input.mcpAdditionalServerSecretEnv,
    ...(claudeChannel ? { claudeChannel } : {}),
    dryRun: true
  });
  const clientArg = mcpClientArg(clients);
  const installCommand = [
    "ciclo mcp install",
    `--client ${clientArg}`,
    `--project ${shellQuote(repoPath)}`,
    ...(serverName === "ciclo" ? [] : [`--server-name ${shellQuote(serverName)}`]),
    ...(command === "ciclo" ? [] : [`--command ${shellQuote(command)}`]),
    ...(claudeChannel ? ["--claude-channel"] : [])
  ].join(" ");
  return {
    enabled: true,
    projectRoot: repoPath,
    clients,
    serverName,
    command,
    vars: input.mcpVars ?? {},
    varKeys: Object.keys(input.mcpVars ?? {}),
    additionalServers: input.mcpAdditionalServers ?? {},
    additionalServerNames: Object.keys(input.mcpAdditionalServers ?? {}),
    additionalServerSecretEnv: input.mcpAdditionalServerSecretEnv ?? [],
    ...(claudeChannel ? { claudeChannel } : {}),
    install: rendered.install,
    commands: [installCommand],
    artifacts: rendered.artifacts.map((artifact) => ({
      name: remoteMcpArtifactName(artifact.path, repoPath),
      format: artifact.format,
      content: artifact.content
    })),
    warnings: [
      "Remote MCP artifacts are rendered for a fresh remote checkout; run the install command inside the runner when existing client config should be merged."
    ],
    evidence: [
      "remote.runner.mcp_config:planned",
      `remote.runner.mcp_config.server:${serverName}`,
      `remote.runner.mcp_config.clients:${clients.join(",")}`,
      `remote.runner.mcp_config.project_root:${repoPath}`,
      `remote.runner.mcp_config.var_keys:${Object.keys(input.mcpVars ?? {}).length}`,
      `remote.runner.mcp_config.additional_servers:${Object.keys(input.mcpAdditionalServers ?? {}).length}`,
      `remote.runner.mcp_config.targets:${rendered.install.targets.length}`
    ]
  };
}

function kubernetesArtifacts(input: RemoteRunnerLaunchRequest, wireGuard: WireGuardTunnelPlan): RemoteRunnerProviderPlan {
  const namespace = clean(input.kubernetes?.namespace) ?? "ciclo";
  const jobName = clean(input.kubernetes?.jobName) ?? input.runnerId ?? "ciclo-runner";
  const serviceAccount = clean(input.kubernetes?.serviceAccount) ?? "ciclo-runner";
  const extraEnv = envLines(input.environment);
  const herdrSession = clean(input.herdrSession) ?? repoSessionName();
  const manifest = [
    "apiVersion: batch/v1",
    "kind: Job",
    "metadata:",
    `  name: ${jobName}`,
    `  namespace: ${namespace}`,
    "spec:",
    "  template:",
    "    spec:",
    `      serviceAccountName: ${serviceAccount}`,
    "      restartPolicy: Never",
    "      containers:",
    "        - name: runner",
    `          image: ${input.image}`,
    "          securityContext:",
    "            capabilities:",
    "              add: [\"NET_ADMIN\"]",
    "          env:",
    `            - name: CICLO_REMOTE_SESSION_ID\n              value: ${JSON.stringify(input.runnerId ?? jobName)}`,
    `            - name: CICLO_HERDR_SESSION\n              value: ${JSON.stringify(herdrSession)}`,
    `            - name: CICLO_REPO_PATH\n              value: ${JSON.stringify(input.repoPath)}`,
    `            - name: CICLO_WIREGUARD_INTERFACE\n              value: ${JSON.stringify(wireGuard.interfaceName)}`,
    ...(extraEnv.length === 0 ? [] : [extraEnv]),
    "          command: [\"/bin/sh\", \"-lc\"]",
    "          args:",
    "            - |",
    "              set -euo pipefail",
    "              install -m 0600 /ciclo/wg/runner.conf /etc/wireguard/wg-ciclo.conf",
    "              wg-quick up wg-ciclo",
    "              herdr session start \"$CICLO_HERDR_SESSION\" --cwd \"$CICLO_REPO_PATH\"",
    "              tail -f /dev/null"
  ].join("\n");
  return {
    providerName: "kubernetes-job",
    executionModel: "kubernetes_job",
    artifacts: [{ name: `${jobName}.job.yaml`, format: "yaml", content: manifest }],
    commands: [
      `kubectl create namespace ${namespace} --dry-run=client -o yaml | kubectl apply -f -`,
      `kubectl -n ${namespace} apply -f ${jobName}.job.yaml`
    ],
    warnings: [],
    evidence: ["remote.runner.plugin:kubernetes-job", "remote.runner.execution_model:kubernetes_job"]
  };
}

function lambdaArtifacts(input: RemoteRunnerLaunchRequest, wireGuard: WireGuardTunnelPlan): RemoteRunnerProviderPlan {
  const microVmImageName = clean(input.awsLambda?.microVmImageName) ?? `${input.runnerId ?? "ciclo-runner"}-image`;
  const microVmName = clean(input.awsLambda?.microVmName) ?? input.runnerId ?? "ciclo-runner";
  const memory = input.awsLambda?.memoryMb ?? 2048;
  const vcpu = input.awsLambda?.vcpuCount ?? 2;
  const buildRole = clean(input.awsLambda?.buildRoleArn) ?? clean(input.awsLambda?.executionRoleArn) ?? "arn:aws:iam::123456789012:role/ciclo-runner-build";
  const executionRole = clean(input.awsLambda?.executionRoleArn) ?? "arn:aws:iam::123456789012:role/ciclo-runner";
  const baseImageArn = clean(input.awsLambda?.baseImageArn) ?? "arn:aws:lambda:${AWS_REGION}:aws:microvm-image/nodejs22";
  const sourceS3Uri = clean(input.awsLambda?.sourceS3Uri) ?? `s3://ciclo-runner-artifacts/${microVmImageName}.tar`;
  const microVmImageIdentifier = clean(input.awsLambda?.microVmImageIdentifier) ??
    `arn:aws:lambda-microvms:us-east-1:123456789012:microvm-image:${microVmImageName}`;
  const herdrSession = clean(input.herdrSession) ?? repoSessionName();
  const payload = {
    MicroVmImageName: microVmImageName,
    Source: {
      S3Uri: sourceS3Uri,
      ContainerImageUri: input.image
    },
    BaseImageArn: baseImageArn,
    BuildRoleArn: buildRole,
    ExecutionRoleArn: executionRole,
    RuntimeConfig: {
      MemorySizeInMB: memory,
      VcpuCount: vcpu
    },
    Environment: {
      Variables: {
        CICLO_HERDR_SESSION: herdrSession,
        CICLO_REPO_PATH: input.repoPath,
        CICLO_WIREGUARD_INTERFACE: wireGuard.interfaceName,
        ...(input.environment ?? {})
      }
    }
  };
  return {
    providerName: "aws-lambda-microvm",
    executionModel: "aws_lambda_microvm",
    artifacts: [
      { name: `${microVmImageName}.create-microvm-image.json`, format: "json", content: JSON.stringify(payload, null, 2) },
      {
        name: `${microVmName}.microvm-bootstrap.sh`,
        format: "shell",
        content: [
          "set -euo pipefail",
          "# Lambda MicroVM images run inside Firecracker-backed microVMs.",
          "# Include userspace WireGuard such as boringtun or wireguard-go in the image.",
          `export WG_CONFIG=${shellQuote(wireGuard.runnerConfig)}`,
          "ciclo-wg-up \"$WG_CONFIG\"",
          "herdr session start \"$CICLO_HERDR_SESSION\" --cwd \"$CICLO_REPO_PATH\""
        ].join("\n")
      }
    ],
    commands: [
      [
        "aws lambda-microvms create-microvm-image",
        `--name ${microVmImageName}`,
        `--code-artifact ${shellQuote(JSON.stringify({ uri: sourceS3Uri }))}`,
        `--base-image-arn ${shellQuote(baseImageArn)}`,
        `--build-role-arn ${shellQuote(buildRole)}`
      ].join(" "),
      [
        "aws lambda-microvms run-microvm",
        `--image-identifier ${shellQuote(microVmImageIdentifier)}`,
        `--execution-role-arn ${shellQuote(executionRole)}`,
        `--client-token ${shellQuote(microVmName)}`,
        `--memory-size-in-mb ${memory}`,
        `--vcpu-count ${vcpu}`
      ].join(" "),
      `aws lambda-microvms suspend-microvm --microvm-identifier ${shellQuote(microVmName)}`,
      `aws lambda-microvms resume-microvm --microvm-identifier ${shellQuote(microVmName)}`,
      `aws lambda-microvms terminate-microvm --microvm-identifier ${shellQuote(microVmName)}`
    ],
    warnings: [
      "AWS Lambda MicroVMs are Firecracker-backed serverless environments; keep Herdr interactivity bounded by the MicroVM lifecycle and provider limits."
    ],
    evidence: ["remote.runner.plugin:aws-lambda-microvm", "remote.runner.execution_model:aws_lambda_microvm"]
  };
}

function cloudflareArtifacts(input: RemoteRunnerLaunchRequest, wireGuard: WireGuardTunnelPlan): RemoteRunnerProviderPlan {
  const workerName = clean(input.cloudflare?.workerName) ?? input.runnerId ?? "ciclo-runner";
  const account = clean(input.cloudflare?.accountId) ?? "${CLOUDFLARE_ACCOUNT_ID}";
  const herdrSession = clean(input.herdrSession) ?? repoSessionName();
  const wrangler = [
    `name = "${workerName}"`,
    "main = \"src/index.ts\"",
    "compatibility_date = \"2026-06-30\"",
    `account_id = "${account}"`,
    "",
    "[vars]",
    `CICLO_HERDR_SESSION = "${herdrSession}"`,
    `CICLO_REPO_PATH = "${input.repoPath}"`,
    `CICLO_WIREGUARD_INTERFACE = "${wireGuard.interfaceName}"`
  ].join("\n");
  return {
    providerName: "cloudflare-runner",
    executionModel: "cloudflare_container_or_userspace_connector",
    artifacts: [
      { name: `${workerName}.wrangler.toml`, format: "toml", content: wrangler },
      {
        name: `${workerName}.runner-notes.sh`,
        format: "shell",
        content: [
          "set -euo pipefail",
          "# Plain Workers cannot run Herdr or kernel WireGuard.",
          "# Use a Cloudflare container or userspace connector that starts WireGuard and Herdr.",
          `export WG_CONFIG=${shellQuote(wireGuard.runnerConfig)}`
        ].join("\n")
      }
    ],
    commands: [
      `wrangler secret put CICLO_WG_PRIVATE_KEY --config ${workerName}.wrangler.toml`,
      `wrangler deploy --config ${workerName}.wrangler.toml`
    ],
    warnings: [
      "Cloudflare Workers need a container or userspace connector for Herdr plus WireGuard interactivity."
    ],
    evidence: ["remote.runner.plugin:cloudflare-runner", "remote.runner.execution_model:cloudflare_container_or_userspace_connector"]
  };
}

export const kubernetesRemoteRunnerPlugin: RemoteRunnerProviderPlugin = {
  kind: "kubernetes",
  name: "kubernetes-job",
  executionModel: "kubernetes_job",
  plan: kubernetesArtifacts
};

export const awsLambdaMicroVmRemoteRunnerPlugin: RemoteRunnerProviderPlugin = {
  kind: "aws-lambda",
  name: "aws-lambda-microvm",
  executionModel: "aws_lambda_microvm",
  plan: lambdaArtifacts
};

export const cloudflareRemoteRunnerPlugin: RemoteRunnerProviderPlugin = {
  kind: "cloudflare",
  name: "cloudflare-runner",
  executionModel: "cloudflare_container_or_userspace_connector",
  plan: cloudflareArtifacts
};

export function createDefaultRemoteRunnerPluginRegistry(): RemoteRunnerPluginRegistry {
  return new RemoteRunnerPluginRegistry([
    kubernetesRemoteRunnerPlugin,
    awsLambdaMicroVmRemoteRunnerPlugin,
    cloudflareRemoteRunnerPlugin
  ]);
}

export function buildRemoteRunnerLaunchPlan(
  input: RemoteRunnerLaunchRequest,
  planId = input.runnerId ?? `remote-runner-${randomUUID()}`,
  pluginRegistry = createDefaultRemoteRunnerPluginRegistry()
): RemoteRunnerLaunchPlan {
  const image = required(input.image, "image");
  const repoPath = required(input.repoPath, "repo_path");
  const prompt = required(input.prompt, "prompt");
  const herdrSession = clean(input.herdrSession) ?? repoSessionName();
  const resolvedInput = { ...input, runnerId: planId, image, repoPath, prompt, herdrSession };
  const wireGuard = wireGuardPlan(resolvedInput);
  const herdrRemoteTarget = remoteTarget(resolvedInput, wireGuard);
  const attach = buildCicloAttachPlan({
    remoteTarget: herdrRemoteTarget,
    session: herdrSession
  });
  const mcpConfig = remoteMcpConfigPlan(resolvedInput, repoPath);
  const runnerArtifacts = pluginRegistry.require(input.runnerKind).plan(
    resolvedInput,
    wireGuard
  );
  const evidence = [
    `remote.runner.plan:${planId}`,
    `remote.runner.kind:${input.runnerKind}`,
    `remote.runner.provider:${runnerArtifacts.providerName}`,
    `remote.runner.execution_model:${runnerArtifacts.executionModel}`,
    `remote.runner.harness:${input.harnessId}`,
    `remote.runner.loop:${input.loopId}`,
    ...(input.beadId === undefined ? [] : [`remote.runner.bead:${input.beadId}`]),
    `remote.runner.herdr_target:${herdrRemoteTarget}`,
    ...wireGuard.evidence,
    ...attach.evidence,
    ...(mcpConfig?.evidence ?? []),
    ...runnerArtifacts.evidence,
    ...(input.dryRun === false ? ["remote.runner.launch:intent"] : ["remote.runner.launch:planned"])
  ];
  return {
    runnerId: planId,
    runnerKind: input.runnerKind,
    providerName: runnerArtifacts.providerName,
    executionModel: runnerArtifacts.executionModel,
    state: "planned",
    loopId: input.loopId,
    beadId: clean(input.beadId),
    harnessId: input.harnessId,
    image,
    repoUrl: clean(input.repoUrl),
    repoPath,
    prompt,
    herdrSession,
    herdrRemoteTarget,
    wireGuard,
    attach,
    ...(mcpConfig === undefined ? {} : { mcpConfig }),
    commands: runnerArtifacts.commands,
    artifacts: [...runnerArtifacts.artifacts, ...(mcpConfig?.artifacts ?? [])],
    warnings: [...runnerArtifacts.warnings, ...(mcpConfig?.warnings ?? [])],
    evidence
  };
}

export class RemoteRunnerRegistry {
  private readonly runners = new Map<string, RemoteRunnerLaunchPlan>();

  constructor(private readonly pluginRegistry = createDefaultRemoteRunnerPluginRegistry()) {}

  launch(input: RemoteRunnerLaunchRequest): RemoteRunnerRegistryLaunchResult {
    const plan = buildRemoteRunnerLaunchPlan(input, input.runnerId ?? undefined, this.pluginRegistry);
    this.runners.set(plan.runnerId, plan);
    return {
      accepted: true,
      plan,
      reason: input.dryRun === false
        ? "remote runner launch plan recorded; executor integration is not configured"
        : "remote runner launch planned",
      evidence: plan.evidence
    };
  }

  list(): readonly RemoteRunnerLaunchPlan[] {
    return [...this.runners.values()];
  }

  get(runnerId: string): RemoteRunnerLaunchPlan | undefined {
    return this.runners.get(runnerId);
  }
}
