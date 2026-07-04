import { randomUUID } from "node:crypto";

import type { HarnessId } from "./ciclo-core.js";
import {
  renderFreshCicloMcpInstallArtifacts,
  type CicloMcpAdditionalServerConfig,
  type CicloMcpInstallClient,
  type CicloMcpInstallResult,
  type CicloMcpSecretEnvBinding,
  type CicloMcpSecretEnvInstall
} from "./mcp-install.js";
import type { CicloMcpAdditionalServerSecretEnvInstall } from "./mcp-secret-placeholders.js";
import { encodeRuntimeSecretEnvBindings, type RuntimeSecretEnvBinding } from "./secret-env-runtime.js";
import { repoSessionName } from "./repo-session-name.js";

export type BuiltinRemoteRunnerKind = "kubernetes" | "aws-lambda" | "cloudflare";
export type RemoteRunnerKind = string;
export const builtinRemoteRunnerKinds: readonly BuiltinRemoteRunnerKind[] = ["kubernetes", "aws-lambda", "cloudflare"];
export type RemoteRunnerState = "planned" | "launching" | "registered" | "failed" | "stopped";
export type RemoteRunnerImageStrategy = "static" | "variant" | "nixery";
export type RemoteRunnerImageVariant = "base" | "claude" | "codex" | "full" | string;

export interface WireGuardTunnelRequest {
  readonly interfaceName?: string;
  readonly networkCidr?: string;
  readonly cicloAddress?: string;
  readonly runnerAddress?: string;
  readonly cicloEndpoint?: string;
  readonly cicloPublicKeySecretRef?: string;
  readonly cicloPrivateKeySecretRef?: string;
  readonly runnerPrivateKeySecretRef?: string;
  readonly runnerPublicKeySecretRef?: string;
  readonly existingConfigSecretName?: string;
  readonly runnerPrivateKeyValue?: string;
  readonly cicloPublicKeyValue?: string;
  readonly cicloPrivateKeyValue?: string;
  readonly runnerPublicKeyValue?: string;
  readonly persistentKeepaliveSeconds?: number;
  readonly hostRouting?: WireGuardHostRoutingRequest;
}

export interface WireGuardHostRoutingRequest {
  readonly enabled?: boolean;
  readonly serviceCidrs?: readonly string[];
  readonly routeAllTraffic?: boolean;
  readonly egressInterface?: string;
  readonly masquerade?: boolean;
}

export type RemoteRunnerPreflightProbeKind = "command" | "version" | "claude_access" | "repo_build";

export interface RemoteRunnerPreflightRequest {
  readonly enabled?: boolean;
  readonly claude?: boolean;
  readonly build?: boolean;
  readonly reportPath?: string;
}

export interface RemoteRunnerPreflightProbe {
  readonly id: string;
  readonly kind: RemoteRunnerPreflightProbeKind;
  readonly command: string;
  readonly args: readonly string[];
  readonly required: boolean;
  readonly description: string;
}

export interface RemoteRunnerPreflightPlan {
  readonly enabled: true;
  readonly reportPath: string;
  readonly probes: readonly RemoteRunnerPreflightProbe[];
  readonly commands: readonly string[];
  readonly artifacts: readonly RemoteRunnerArtifact[];
  readonly warnings: readonly string[];
  readonly evidence: readonly string[];
}

export interface RemoteRunnerRepoBootstrapPlan {
  readonly enabled: boolean;
  readonly repoUrl?: string;
  readonly repoPath: string;
  readonly useDevenv: boolean;
  readonly commands: readonly string[];
  readonly evidence: readonly string[];
}

export interface RemoteRunnerRepoBootstrapRequest {
  readonly enabled?: boolean;
  readonly useDevenv?: boolean;
}

export interface RemoteRunnerEgressPolicyRequest {
  readonly enabled?: boolean;
  readonly name?: string;
  readonly cidrs?: readonly string[];
  readonly domains?: readonly string[];
}

export interface RemoteRunnerEgressPolicyPlan {
  readonly enabled: boolean;
  readonly name?: string;
  readonly cidrs: readonly string[];
  readonly domains: readonly string[];
  readonly commands: readonly string[];
  readonly artifacts: readonly RemoteRunnerArtifact[];
  readonly warnings: readonly string[];
  readonly evidence: readonly string[];
}

export interface RemoteRunnerImageResolverRequest {
  readonly strategy?: RemoteRunnerImageStrategy;
  readonly image?: string;
  readonly registry?: string;
  readonly repository?: string;
  readonly tag?: string;
  readonly variant?: RemoteRunnerImageVariant;
  readonly basePackages?: readonly string[];
  readonly harnessPackages?: Partial<Record<HarnessId, readonly string[]>>;
  readonly extraPackages?: readonly string[];
}

export interface RemoteRunnerImageResolution {
  readonly strategy: RemoteRunnerImageStrategy;
  readonly image: string;
  readonly variant?: RemoteRunnerImageVariant;
  readonly packages?: readonly string[];
  readonly warnings: readonly string[];
  readonly evidence: readonly string[];
}

export interface RemoteRunnerLaunchRequest {
  readonly runnerKind: RemoteRunnerKind;
  readonly runnerId?: string;
  readonly loopId: string;
  readonly beadId?: string;
  readonly harnessId: HarnessId;
  readonly image: string;
  readonly imageResolver?: RemoteRunnerImageResolverRequest;
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
  readonly mcpSecretEnv?: readonly CicloMcpSecretEnvBinding[];
  readonly workerSecretEnv?: readonly CicloMcpSecretEnvBinding[];
  readonly mcpClaudeChannel?: boolean;
  readonly preflightOnly?: boolean;
  readonly repoBootstrap?: RemoteRunnerRepoBootstrapRequest;
  readonly egress?: RemoteRunnerEgressPolicyRequest;
  readonly kubernetes?: {
    readonly namespace?: string;
    readonly serviceAccount?: string;
    readonly jobName?: string;
    readonly mode?: "statefulset" | "job";
    readonly statefulSetName?: string;
    readonly serviceName?: string;
    readonly replicas?: number;
    readonly storageSize?: string;
    readonly storageClassName?: string;
  };
  readonly preflight?: RemoteRunnerPreflightRequest;
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
  readonly requiredHostSecrets: readonly string[];
  readonly existingConfigSecretName?: string;
  readonly secretMaterialProvided: boolean;
  readonly hostMaterialProvided: boolean;
  readonly runnerAllowedIps: readonly string[];
  readonly hostRouting: {
    readonly enabled: boolean;
    readonly serviceCidrs: readonly string[];
    readonly routeAllTraffic: boolean;
    readonly egressInterface: string;
    readonly masquerade: boolean;
  };
  readonly runnerConfig: string;
  readonly hostConfig: string;
  readonly hostSetupScript: string;
  readonly artifacts: readonly RemoteRunnerArtifact[];
  readonly commands: readonly string[];
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
  readonly secretEnv: readonly CicloMcpSecretEnvInstall[];
  readonly secretEnvBindings: readonly CicloMcpSecretEnvBinding[];
  readonly claudeChannel?: boolean;
  readonly install: CicloMcpInstallResult;
  readonly commands: readonly string[];
  readonly artifacts: readonly RemoteRunnerArtifact[];
  readonly warnings: readonly string[];
  readonly evidence: readonly string[];
}

export interface RemoteRunnerWorkerSecretEnvPlan {
  readonly envNames: readonly string[];
  readonly bindings: readonly {
    readonly name: string;
    readonly providerId: string;
    readonly providerKind: string;
    readonly secretRefHash: string;
    readonly field?: string;
    readonly formatApplied?: boolean;
    readonly evidence: readonly string[];
  }[];
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
  readonly imageResolution: RemoteRunnerImageResolution;
  readonly repoBootstrap: RemoteRunnerRepoBootstrapPlan;
  readonly egress?: RemoteRunnerEgressPolicyPlan;
  readonly wireGuard: WireGuardTunnelPlan;
  readonly preflight?: RemoteRunnerPreflightPlan;
  readonly attach: CicloAttachPlan;
  readonly mcpConfig?: RemoteRunnerMcpConfigPlan;
  readonly workerSecretEnv?: RemoteRunnerWorkerSecretEnvPlan;
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
  plan(
    input: RemoteRunnerLaunchRequest,
    wireGuard: WireGuardTunnelPlan,
    preflight?: RemoteRunnerPreflightPlan,
    repoBootstrap?: RemoteRunnerRepoBootstrapPlan,
    egress?: RemoteRunnerEgressPolicyPlan,
  ): RemoteRunnerProviderPlan;
}

export interface RemoteRunnerImageResolverPlugin {
  readonly strategy: RemoteRunnerImageStrategy;
  readonly name: string;
  resolve(input: RemoteRunnerLaunchRequest): RemoteRunnerImageResolution;
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

export class RemoteRunnerImageResolverRegistry {
  private readonly plugins = new Map<RemoteRunnerImageStrategy, RemoteRunnerImageResolverPlugin>();

  constructor(plugins: readonly RemoteRunnerImageResolverPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: RemoteRunnerImageResolverPlugin): void {
    this.plugins.set(plugin.strategy, plugin);
  }

  require(strategy: RemoteRunnerImageStrategy): RemoteRunnerImageResolverPlugin {
    const plugin = this.plugins.get(strategy);
    if (plugin === undefined) throw new Error(`remote runner image resolver is not registered: ${strategy}`);
    return plugin;
  }

  list(): readonly RemoteRunnerImageResolverPlugin[] {
    return [...this.plugins.values()];
  }
}

export interface CicloRemoteRunnerPluginApi {
  readonly remoteRunners: {
    register(plugin: RemoteRunnerProviderPlugin): void;
  };
  readonly imageResolvers: {
    register(plugin: RemoteRunnerImageResolverPlugin): void;
  };
}

export function createRemoteRunnerPluginApi(
  registry: RemoteRunnerPluginRegistry,
  imageResolverRegistry = createDefaultRemoteRunnerImageResolverRegistry()
): CicloRemoteRunnerPluginApi {
  return {
    remoteRunners: {
      register(plugin) {
        registry.register(plugin);
      }
    },
    imageResolvers: {
      register(plugin) {
        imageResolverRegistry.register(plugin);
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

function pathSegment(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function uniqueValues(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function harnessImageVariant(harnessId: HarnessId): RemoteRunnerImageVariant {
  if (harnessId === "claude-code") return "claude";
  if (harnessId === "codex") return "codex";
  return "base";
}

function imageRequest(input: RemoteRunnerLaunchRequest): RemoteRunnerImageResolverRequest {
  return {
    ...(input.imageResolver ?? {}),
    ...(clean(input.image) === undefined ? {} : { image: clean(input.image) })
  };
}

export const staticRemoteRunnerImageResolver: RemoteRunnerImageResolverPlugin = {
  strategy: "static",
  name: "static-image",
  resolve(input) {
    const request = imageRequest(input);
    const image = required(request.image, "image");
    return {
      strategy: "static",
      image,
      warnings: [],
      evidence: ["remote.runner.image.strategy:static", `remote.runner.image:${image}`]
    };
  }
};

export const variantRemoteRunnerImageResolver: RemoteRunnerImageResolverPlugin = {
  strategy: "variant",
  name: "ciclo-image-variant",
  resolve(input) {
    const request = imageRequest(input);
    const registry = pathSegment(clean(request.registry) ?? "ghcr.io");
    const repository = pathSegment(clean(request.repository) ?? "smol-platform/ciclo");
    const tag = clean(request.tag) ?? "latest";
    const variant = clean(request.variant) ?? harnessImageVariant(input.harnessId);
    const image = `${registry}/${repository}:${variant}-${tag}`;
    return {
      strategy: "variant",
      image,
      variant,
      warnings: [],
      evidence: [
        "remote.runner.image.strategy:variant",
        `remote.runner.image.variant:${variant}`,
        `remote.runner.image:${image}`
      ]
    };
  }
};

export const nixeryRemoteRunnerImageResolver: RemoteRunnerImageResolverPlugin = {
  strategy: "nixery",
  name: "nixery-image",
  resolve(input) {
    const request = imageRequest(input);
    const registry = pathSegment(clean(request.registry) ?? "nixery.dev");
    const basePackages = request.basePackages ?? ["shell", "git", "nodejs_24", "openssh", "wireguard-tools"];
    const defaultHarnessPackages: Partial<Record<HarnessId, readonly string[]>> = {
      "claude-code": ["herdr", "claude-code", "gh", "just", "python3", "beads", "devenv"],
      codex: ["herdr", "codex", "gh", "just", "python3", "beads", "devenv"]
    };
    const harnessPackages = request.harnessPackages?.[input.harnessId] ?? defaultHarnessPackages[input.harnessId] ?? [];
    const packages = uniqueValues([...basePackages, ...harnessPackages, ...(request.extraPackages ?? [])]);
    const image = `${registry}/${packages.map(pathSegment).join("/")}`;
    return {
      strategy: "nixery",
      image,
      packages,
      warnings: registry === "nixery.dev"
        ? ["Public nixery.dev is best-effort; use a private Nixery registry for production remote runners and unfree harness packages."]
        : [],
      evidence: [
        "remote.runner.image.strategy:nixery",
        `remote.runner.image.packages:${packages.length}`,
        `remote.runner.image:${image}`
      ]
    };
  }
};

export function createDefaultRemoteRunnerImageResolverRegistry(): RemoteRunnerImageResolverRegistry {
  return new RemoteRunnerImageResolverRegistry([
    staticRemoteRunnerImageResolver,
    variantRemoteRunnerImageResolver,
    nixeryRemoteRunnerImageResolver
  ]);
}

function resolveRemoteRunnerImage(
  input: RemoteRunnerLaunchRequest,
  registry: RemoteRunnerImageResolverRegistry
): RemoteRunnerImageResolution {
  const strategy = input.imageResolver?.strategy ?? (clean(input.image) === undefined ? "variant" : "static");
  return registry.require(strategy).resolve(input);
}

function envLines(environment: Record<string, string> | undefined): string {
  return Object.entries(environment ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `            - name: ${key}\n              value: ${JSON.stringify(value)}`)
    .join("\n");
}

function indentBlock(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function endpointPort(endpoint: string): string {
  const bracketMatch = endpoint.match(/\]:(\d+)$/u);
  if (bracketMatch?.[1] !== undefined) return bracketMatch[1];
  const last = endpoint.split(":").pop();
  return last !== undefined && /^\d+$/u.test(last) ? last : "51820";
}

function addressHost(address: string): string {
  return address.split("/")[0] ?? address;
}

function addressAsSingleHostCidr(address: string): string {
  return `${addressHost(address)}/32`;
}

function serviceRouteCidrs(request: WireGuardHostRoutingRequest | undefined): readonly string[] {
  if (request?.routeAllTraffic === true) return ["0.0.0.0/0"];
  return uniqueValues(request?.serviceCidrs ?? []);
}

function wireGuardPlan(input: RemoteRunnerLaunchRequest): WireGuardTunnelPlan {
  const request = input.wireGuard ?? {};
  const interfaceName = clean(request.interfaceName) ?? "wg-ciclo";
  const networkCidr = clean(request.networkCidr) ?? "10.44.0.0/24";
  const cicloAddress = clean(request.cicloAddress) ?? "10.44.0.1/24";
  const runnerAddress = clean(request.runnerAddress) ?? "10.44.0.2/24";
  const cicloEndpoint = clean(request.cicloEndpoint) ?? "ciclo-wireguard.example.invalid:51820";
  const cicloPublicKeySecretRef = clean(request.cicloPublicKeySecretRef) ?? "ciclo/wireguard/ciclo_public_key";
  const cicloPrivateKeySecretRef = clean(request.cicloPrivateKeySecretRef) ?? "ciclo/wireguard/ciclo_private_key";
  const runnerPrivateKeySecretRef = clean(request.runnerPrivateKeySecretRef) ?? "ciclo/wireguard/runner_private_key";
  const runnerPublicKeySecretRef = clean(request.runnerPublicKeySecretRef) ?? "ciclo/wireguard/runner_public_key";
  const existingConfigSecretName = clean(request.existingConfigSecretName);
  const runnerPrivateKey = clean(request.runnerPrivateKeyValue);
  const cicloPublicKey = clean(request.cicloPublicKeyValue);
  const cicloPrivateKey = clean(request.cicloPrivateKeyValue);
  const runnerPublicKey = clean(request.runnerPublicKeyValue);
  const keepalive = request.persistentKeepaliveSeconds ?? 25;
  const hostRoutingEnabled = request.hostRouting?.enabled ?? true;
  const routeAllTraffic = request.hostRouting?.routeAllTraffic ?? false;
  const serviceCidrs = hostRoutingEnabled ? serviceRouteCidrs(request.hostRouting) : [];
  const runnerAllowedIps = uniqueValues([networkCidr, ...serviceCidrs]);
  const egressInterface = clean(request.hostRouting?.egressInterface) ?? "${CICLO_WG_EGRESS_INTERFACE:-auto}";
  const masquerade = request.hostRouting?.masquerade ?? true;
  const runnerConfig = [
    "[Interface]",
    `Address = ${runnerAddress}`,
    `PrivateKey = ${runnerPrivateKey ?? `\${secret:${runnerPrivateKeySecretRef}}`}`,
    "",
    "[Peer]",
    `PublicKey = ${cicloPublicKey ?? `\${secret:${cicloPublicKeySecretRef}}`}`,
    `AllowedIPs = ${runnerAllowedIps.join(", ")}`,
    `Endpoint = ${cicloEndpoint}`,
    `PersistentKeepalive = ${keepalive}`
  ].join("\n");
  const hostConfig = [
    "[Interface]",
    `Address = ${cicloAddress}`,
    `ListenPort = ${endpointPort(cicloEndpoint)}`,
    `PrivateKey = ${cicloPrivateKey ?? `\${secret:${cicloPrivateKeySecretRef}}`}`,
    "",
    "[Peer]",
    `PublicKey = ${runnerPublicKey ?? `\${secret:${runnerPublicKeySecretRef}}`}`,
    `AllowedIPs = ${addressAsSingleHostCidr(runnerAddress)}`
  ].join("\n");
  const hostSetupScript = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `WG_IF=${shellQuote(interfaceName)}`,
    `NETWORK_CIDR=${shellQuote(networkCidr)}`,
    `HOST_CONFIG=${shellQuote(`${interfaceName}.host.conf`)}`,
    `EGRESS_IF=${shellQuote(egressInterface)}`,
    "if [ \"$EGRESS_IF\" = \"${CICLO_WG_EGRESS_INTERFACE:-auto}\" ] || [ \"$EGRESS_IF\" = \"auto\" ]; then",
    "  EGRESS_IF=\"$(ip route get 1.1.1.1 | awk '{for (i=1; i<=NF; i++) if ($i == \"dev\") {print $(i+1); exit}}')\"",
    "fi",
    "test -n \"$EGRESS_IF\"",
    "install -m 0600 \"$HOST_CONFIG\" \"/etc/wireguard/$WG_IF.conf\"",
    "sysctl -w net.ipv4.ip_forward=1",
    ...(masquerade ? [
      "iptables -C FORWARD -i \"$WG_IF\" -j ACCEPT 2>/dev/null || iptables -A FORWARD -i \"$WG_IF\" -j ACCEPT",
      "iptables -C FORWARD -o \"$WG_IF\" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || iptables -A FORWARD -o \"$WG_IF\" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
      "iptables -t nat -C POSTROUTING -s \"$NETWORK_CIDR\" -o \"$EGRESS_IF\" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s \"$NETWORK_CIDR\" -o \"$EGRESS_IF\" -j MASQUERADE"
    ] : []),
    "wg-quick up \"$WG_IF\""
  ].join("\n");
  const hostMaterialProvided = cicloPrivateKey !== undefined && runnerPublicKey !== undefined;

  return {
    interfaceName,
    networkCidr,
    cicloAddress,
    runnerAddress,
    cicloEndpoint,
    requiredSecrets: [runnerPrivateKeySecretRef, cicloPublicKeySecretRef],
    requiredHostSecrets: [cicloPrivateKeySecretRef, runnerPublicKeySecretRef],
    ...(existingConfigSecretName === undefined ? {} : { existingConfigSecretName }),
    secretMaterialProvided: runnerPrivateKey !== undefined && cicloPublicKey !== undefined,
    hostMaterialProvided,
    runnerAllowedIps,
    hostRouting: {
      enabled: hostRoutingEnabled,
      serviceCidrs,
      routeAllTraffic,
      egressInterface,
      masquerade
    },
    runnerConfig,
    hostConfig,
    hostSetupScript,
    artifacts: [
      { name: `${interfaceName}.host.conf`, format: "shell", content: hostConfig },
      { name: `${interfaceName}.host-setup.sh`, format: "shell", content: hostSetupScript }
    ],
    commands: [`sudo bash ${interfaceName}.host-setup.sh`],
    evidence: [
      "remote.runner.wireguard:planned",
      `remote.runner.wireguard.interface:${interfaceName}`,
      `remote.runner.wireguard.network:${networkCidr}`,
      `remote.runner.wireguard.runner_allowed_ips:${runnerAllowedIps.join(",")}`,
      hostRoutingEnabled ? "remote.runner.wireguard.host_routing:enabled" : "remote.runner.wireguard.host_routing:disabled",
      ...(serviceCidrs.length === 0 ? ["remote.runner.wireguard.host_routing.service_cidrs:host_only"] : [`remote.runner.wireguard.host_routing.service_cidrs:${serviceCidrs.join(",")}`]),
      ...(routeAllTraffic ? ["remote.runner.wireguard.host_routing.route_all:true"] : []),
      ...(masquerade ? ["remote.runner.wireguard.host_routing.masquerade:true"] : []),
      ...(existingConfigSecretName === undefined ? [] : [`remote.runner.wireguard.existing_secret:${existingConfigSecretName}`]),
      ...(runnerPrivateKey !== undefined && cicloPublicKey !== undefined ? ["remote.runner.wireguard.material:provided"] : []),
      ...(hostMaterialProvided ? ["remote.runner.wireguard.host_material:provided"] : ["remote.runner.wireguard.host_material:required"])
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

function runtimeSecretBindings(secretEnv: readonly CicloMcpSecretEnvBinding[] | undefined, target: string): readonly RuntimeSecretEnvBinding[] {
  return (secretEnv ?? []).map((binding) => {
    if (binding.secretRef === undefined) {
      throw new Error(`${target} secret env ${binding.name} requires a provider secret reference for runtime-scoped delivery`);
    }
    return {
      name: binding.name,
      providerId: binding.providerId,
      secretRef: binding.secretRef,
      ...(binding.field === undefined ? {} : { field: binding.field }),
      ...(binding.format === undefined ? {} : { format: binding.format }),
      reason: `provide ${binding.name} to ${target} process`
    };
  });
}

function remoteWorkerSecretEnvPlan(input: RemoteRunnerLaunchRequest): RemoteRunnerWorkerSecretEnvPlan | undefined {
  const bindings = input.workerSecretEnv ?? [];
  if (bindings.length === 0) return undefined;
  return {
    envNames: bindings.map((binding) => binding.name),
    bindings: bindings.map((binding) => ({
      name: binding.name,
      providerId: binding.providerId,
      providerKind: binding.providerKind,
      secretRefHash: binding.secretRefHash,
      field: binding.field,
      ...(binding.format === undefined ? {} : { formatApplied: true }),
      evidence: binding.evidence
    })),
    evidence: [
      "remote.runner.worker_secret_env:runtime_exec",
      `remote.runner.worker_secret_env.count:${bindings.length}`,
      `remote.runner.worker_secret_env.names:${bindings.map((binding) => binding.name).join(",")}`
    ]
  };
}

function herdrSessionStartCommand(input: RemoteRunnerLaunchRequest): string {
  const workerSecrets = runtimeSecretBindings(input.workerSecretEnv, "remote worker");
  const prefix = workerSecrets.length === 0
    ? ""
    : `ciclo secret exec --binding ${shellQuote(encodeRuntimeSecretEnvBindings(workerSecrets))} -- `;
  return `${prefix}herdr session start "$CICLO_HERDR_SESSION" --cwd "$CICLO_REPO_PATH"`;
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
    secretEnv: input.mcpSecretEnv,
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
    secretEnv: rendered.install.secretEnv,
    secretEnvBindings: input.mcpSecretEnv ?? [],
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
      `remote.runner.mcp_config.secret_env:${rendered.install.secretEnv.length}`,
      `remote.runner.mcp_config.targets:${rendered.install.targets.length}`
    ]
  };
}

function repoBootstrapPlan(input: RemoteRunnerLaunchRequest, repoPath: string): RemoteRunnerRepoBootstrapPlan {
  const enabled = input.repoBootstrap?.enabled ?? true;
  const useDevenv = input.repoBootstrap?.useDevenv ?? true;
  const repoUrl = clean(input.repoUrl);
  const commands = enabled
    ? [
      ...(repoUrl === undefined
        ? [`test -d ${shellQuote(repoPath)}`]
        : [`git clone ${shellQuote(repoUrl)} ${shellQuote(repoPath)} || git -C ${shellQuote(repoPath)} fetch --all --prune`]),
      ...(useDevenv ? [`cd ${shellQuote(repoPath)} && if [ -f devenv.nix ] && command -v devenv >/dev/null 2>&1; then devenv shell -- true; fi`] : [])
    ]
    : [];
  return {
    enabled,
    ...(repoUrl === undefined ? {} : { repoUrl }),
    repoPath,
    useDevenv,
    commands,
    evidence: [
      enabled ? "remote.runner.repo_bootstrap:planned" : "remote.runner.repo_bootstrap:disabled",
      `remote.runner.repo_bootstrap.devenv:${useDevenv ? "enabled" : "disabled"}`,
      ...(repoUrl === undefined ? ["remote.runner.repo_bootstrap.repo_url:absent"] : ["remote.runner.repo_bootstrap.repo_url:present"])
    ]
  };
}

function egressPolicyPlan(input: RemoteRunnerLaunchRequest, planId: string): RemoteRunnerEgressPolicyPlan | undefined {
  const request = input.egress;
  if (request === undefined || request.enabled === false) return undefined;
  const cidrs = uniqueValues(request.cidrs ?? []);
  const domains = uniqueValues(request.domains ?? []);
  const name = clean(request.name) ?? `${planId}-egress`;
  return {
    enabled: true,
    name,
    cidrs,
    domains,
    commands: [],
    artifacts: [],
    warnings: [
      ...(domains.length > 0
        ? ["Kubernetes NetworkPolicy cannot enforce DNS domain allowlists by itself; pair this plan with a CNI egress gateway, DNS proxy, or provider policy that understands domains."]
        : []),
      ...(cidrs.length === 0 && domains.length === 0
        ? ["Egress policy is enabled but no cidrs or domains were configured; the Kubernetes artifact denies pod egress except cluster DNS when a CNI enforces NetworkPolicy."]
        : [])
    ],
    evidence: [
      "remote.runner.egress:planned",
      `remote.runner.egress.name:${name}`,
      `remote.runner.egress.cidrs:${cidrs.length}`,
      `remote.runner.egress.domains:${domains.length}`
    ]
  };
}

function preflightProbe(
  id: string,
  kind: RemoteRunnerPreflightProbeKind,
  command: string,
  args: readonly string[],
  required: boolean,
  description: string
): RemoteRunnerPreflightProbe {
  return { id, kind, command, args, required, description };
}

function remotePreflightPlan(input: RemoteRunnerLaunchRequest, planId: string): RemoteRunnerPreflightPlan | undefined {
  if (input.preflight?.enabled === false) return undefined;
  const reportPath = clean(input.preflight?.reportPath) ?? "/tmp/ciclo-remote-preflight.jsonl";
  const includeClaude = input.preflight?.claude ?? true;
  const includeBuild = input.preflight?.build ?? true;
  const probes: RemoteRunnerPreflightProbe[] = [
    preflightProbe("command-bash", "command", "bash", [], true, "Bash is available for runner bootstrap scripts."),
    preflightProbe("command-git", "command", "git", [], true, "Git is available to inspect or clone the repository."),
    preflightProbe("command-node", "command", "node", [], true, "Node.js is available for the Ciclo TypeScript runtime."),
    preflightProbe("command-npm", "command", "npm", [], true, "npm is available to install and run project scripts."),
    preflightProbe("command-ciclo", "command", "ciclo", [], true, "The Ciclo CLI is available inside the runner image."),
    preflightProbe("command-herdr", "command", "herdr", [], true, "Herdr is available for interactive remote sessions."),
    preflightProbe("command-ssh", "command", "ssh", [], true, "OpenSSH is available for Herdr remote attachment."),
    preflightProbe("command-wg", "command", "wg", [], true, "WireGuard tools are available for the remote tunnel."),
    preflightProbe("command-wg-quick", "command", "wg-quick", [], true, "wg-quick is available for the remote tunnel bootstrap."),
    preflightProbe("git-version", "version", "git", ["--version"], false, "Capture the Git version in the runner."),
    preflightProbe("node-version", "version", "node", ["--version"], false, "Capture the Node.js version in the runner."),
    preflightProbe("npm-version", "version", "npm", ["--version"], false, "Capture the npm version in the runner."),
    preflightProbe("ciclo-version", "version", "ciclo", ["--version"], false, "Capture the Ciclo version in the runner."),
    preflightProbe("herdr-version", "version", "herdr", ["--version"], false, "Capture the Herdr version in the runner."),
    ...(includeBuild ? [
      preflightProbe("command-just", "command", "just", [], false, "just is available for repository gates."),
      preflightProbe("command-devenv", "command", "devenv", [], false, "devenv is available for the project shell."),
      preflightProbe("command-python3", "command", "python3", [], false, "Python is available for hooks and Quint helpers."),
      preflightProbe("command-bd", "command", "bd", [], false, "Beads is available for durable task coordination."),
      preflightProbe("command-gh", "command", "gh", [], false, "GitHub CLI is available for remote PR and release workflows."),
      preflightProbe("repo-path", "repo_build", "test", ["-d", "$CICLO_REPO_PATH"], true, "The configured repository path exists."),
      preflightProbe("repo-git-root", "repo_build", "git", ["rev-parse", "--show-toplevel"], false, "The repository path is a Git checkout."),
      preflightProbe("repo-package-json", "repo_build", "test", ["-f", "$CICLO_REPO_PATH/package.json"], false, "The checkout looks like a Node package."),
      preflightProbe("repo-npm-scripts", "repo_build", "npm", ["pkg", "get", "scripts"], false, "npm can read project scripts.")
    ] : []),
    ...(includeClaude ? [
      preflightProbe("command-claude", "command", "claude", [], true, "Claude Code is available in the runner image."),
      preflightProbe("claude-version", "version", "claude", ["--version"], false, "Capture the Claude Code version in the runner."),
      preflightProbe(
        "claude-noninteractive",
        "claude_access",
        "claude",
        [
          "--safe-mode",
          "--print",
          "--output-format",
          "json",
          "--no-session-persistence",
          "--max-budget-usd",
          "0.01",
          "Reply with OK only."
        ],
        true,
        "Claude Code can run a tiny non-interactive prompt with the runner's configured credentials."
      )
    ] : [])
  ];
  const script = remotePreflightScript({ includeBuild, includeClaude, reportPath });
  return {
    enabled: true,
    reportPath,
    probes,
    commands: [`bash ${planId}.preflight.sh`],
    artifacts: [{ name: `${planId}.preflight.sh`, format: "shell", content: script }],
    warnings: includeClaude
      ? ["Remote preflight checks Claude Code at runtime with a tiny non-interactive prompt and redacts common token shapes from the report."]
      : [],
    evidence: [
      "remote.runner.preflight:planned",
      `remote.runner.preflight.report:${reportPath}`,
      ...(includeBuild ? ["remote.runner.preflight.build:planned"] : []),
      ...(includeClaude ? ["remote.runner.preflight.claude:planned"] : [])
    ]
  };
}

function remotePreflightScript(input: {
  readonly includeBuild: boolean;
  readonly includeClaude: boolean;
  readonly reportPath: string;
}): string {
  const commandChecks = [
    ["command-bash", "bash", true],
    ["command-git", "git", true],
    ["command-node", "node", true],
    ["command-npm", "npm", true],
    ["command-ciclo", "ciclo", true],
    ["command-herdr", "herdr", true],
    ["command-ssh", "ssh", true],
    ["command-wg", "wg", true],
    ["command-wg-quick", "wg-quick", true],
    ...(input.includeBuild ? [
      ["command-just", "just", false],
      ["command-devenv", "devenv", false],
      ["command-python3", "python3", false],
      ["command-bd", "bd", false],
      ["command-gh", "gh", false]
    ] : []),
    ...(input.includeClaude ? [["command-claude", "claude", true]] : [])
  ] as const;
  const versionChecks = [
    ["git-version", "git", "--version"],
    ["node-version", "node", "--version"],
    ["npm-version", "npm", "--version"],
    ["ciclo-version", "ciclo", "--version"],
    ["herdr-version", "herdr", "--version"],
    ...(input.includeClaude ? [["claude-version", "claude", "--version"]] : [])
  ] as const;
  return [
    "#!/usr/bin/env bash",
    "set -u",
    `REPORT_PATH=${shellQuote(input.reportPath)}`,
    "if [ -n \"${CICLO_PREFLIGHT_REPORT:-}\" ]; then REPORT_PATH=\"$CICLO_PREFLIGHT_REPORT\"; fi",
    "required_failed=0",
    "mkdir -p \"$(dirname \"$REPORT_PATH\")\" 2>/dev/null || true",
    ": > \"$REPORT_PATH\"",
    "sanitize() {",
    "  printf '%s' \"$1\" | tr '\\n' ' ' | sed -E 's/(sk-ant-[A-Za-z0-9_-]+)/[redacted]/g; s/(Bearer )[A-Za-z0-9._-]+/\\1[redacted]/g; s/(ANTHROPIC_API_KEY=)[^ ]+/\\1[redacted]/g; s/[\\\\\"]/ /g' | cut -c1-240",
    "}",
    "append_report() {",
    "  printf '%s\\n' \"$1\"",
    "  printf '%s\\n' \"$1\" >> \"$REPORT_PATH\"",
    "}",
    "emit_probe() {",
    "  local id=\"$1\" kind=\"$2\" required=\"$3\" ok=\"$4\" summary=\"$5\" line",
    "  summary=\"$(sanitize \"$summary\")\"",
    "  line=\"$(printf '{\"id\":\"%s\",\"kind\":\"%s\",\"required\":%s,\"ok\":%s,\"summary\":\"%s\"}' \"$id\" \"$kind\" \"$required\" \"$ok\" \"$summary\")\"",
    "  append_report \"$line\"",
    "  if [ \"$required\" = \"true\" ] && [ \"$ok\" != \"true\" ]; then required_failed=$((required_failed + 1)); fi",
    "}",
    "check_command() {",
    "  local id=\"$1\" binary=\"$2\" required=\"$3\" location",
    "  if location=\"$(command -v \"$binary\" 2>/dev/null)\"; then",
    "    emit_probe \"$id\" command \"$required\" true \"$location\"",
    "  else",
    "    emit_probe \"$id\" command \"$required\" false \"missing command: $binary\"",
    "  fi",
    "}",
    "check_run() {",
    "  local id=\"$1\" kind=\"$2\" required=\"$3\" timeout_s=\"$4\" output status ok",
    "  shift 4",
    "  set +e",
    "  output=\"$(timeout \"$timeout_s\" \"$@\" 2>&1)\"",
    "  status=$?",
    "  set -u",
    "  if [ \"$status\" -eq 0 ]; then ok=true; else ok=false; fi",
    "  emit_probe \"$id\" \"$kind\" \"$required\" \"$ok\" \"exit=$status $output\"",
    "}",
    "check_repo_file() {",
    "  local id=\"$1\" required=\"$2\" path=\"$3\"",
    "  if [ -f \"$path\" ]; then",
    "    emit_probe \"$id\" repo_build \"$required\" true \"found $path\"",
    "  else",
    "    emit_probe \"$id\" repo_build \"$required\" false \"missing $path\"",
    "  fi",
    "}",
    ...commandChecks.map(([id, binary, isRequired]) =>
      `check_command ${shellQuote(String(id))} ${shellQuote(String(binary))} ${isRequired === true ? "true" : "false"}`
    ),
    ...versionChecks.map(([id, binary, arg]) =>
      `if command -v ${shellQuote(binary)} >/dev/null 2>&1; then check_run ${shellQuote(id)} version false 20 ${shellQuote(binary)} ${shellQuote(arg)}; fi`
    ),
    ...(input.includeBuild ? [
      "if [ -d \"${CICLO_REPO_PATH:-}\" ]; then",
      "  emit_probe repo-path repo_build true true \"$CICLO_REPO_PATH\"",
      "  if command -v git >/dev/null 2>&1; then check_run repo-git-root repo_build false 20 git -C \"$CICLO_REPO_PATH\" rev-parse --show-toplevel; fi",
      "  check_repo_file repo-package-json false \"$CICLO_REPO_PATH/package.json\"",
      "  if command -v npm >/dev/null 2>&1 && [ -f \"$CICLO_REPO_PATH/package.json\" ]; then check_run repo-npm-scripts repo_build false 30 npm --prefix \"$CICLO_REPO_PATH\" pkg get scripts; fi",
      "else",
      "  emit_probe repo-path repo_build true false \"missing CICLO_REPO_PATH or directory does not exist\"",
      "fi"
    ] : []),
    ...(input.includeClaude ? [
      "if command -v claude >/dev/null 2>&1; then",
      "  check_run claude-noninteractive claude_access true 45 claude --safe-mode --print --output-format json --no-session-persistence --max-budget-usd 0.01 \"Reply with OK only.\"",
      "fi"
    ] : []),
    "if [ \"$required_failed\" -eq 0 ]; then",
    "  emit_probe overall summary true true \"remote runner preflight passed\"",
    "else",
    "  emit_probe overall summary true false \"remote runner preflight failed required checks: $required_failed\"",
    "fi",
    "exit 0"
  ].join("\n");
}

function kubernetesArtifacts(
  input: RemoteRunnerLaunchRequest,
  wireGuard: WireGuardTunnelPlan,
  preflight?: RemoteRunnerPreflightPlan,
  repoBootstrap?: RemoteRunnerRepoBootstrapPlan,
  egress?: RemoteRunnerEgressPolicyPlan
): RemoteRunnerProviderPlan {
  const namespace = clean(input.kubernetes?.namespace) ?? "ciclo";
  const requestedMode = input.kubernetes?.mode ?? "statefulset";
  const mode = input.preflightOnly === true ? "job" : requestedMode;
  const workloadName = mode === "job"
    ? clean(input.kubernetes?.jobName) ?? input.runnerId ?? "ciclo-runner"
    : clean(input.kubernetes?.statefulSetName) ?? clean(input.kubernetes?.jobName) ?? input.runnerId ?? "ciclo-runner";
  const serviceName = clean(input.kubernetes?.serviceName) ?? `${workloadName}-headless`;
  const serviceAccount = clean(input.kubernetes?.serviceAccount) ?? "ciclo-runner";
  const replicas = input.kubernetes?.replicas ?? 1;
  const storageSize = clean(input.kubernetes?.storageSize);
  const storageClassName = clean(input.kubernetes?.storageClassName);
  const wireGuardSecretName = wireGuard.existingConfigSecretName ?? `${workloadName}-wireguard`;
  const shouldGenerateWireGuardSecret = wireGuard.existingConfigSecretName === undefined && wireGuard.secretMaterialProvided;
  const shouldBootstrapWireGuard = wireGuard.existingConfigSecretName === undefined && !wireGuard.secretMaterialProvided;
  const preflightConfigMapName = `${workloadName}-preflight`;
  const labels = {
    "app.kubernetes.io/name": "ciclo-runner",
    "app.kubernetes.io/instance": workloadName
  };
  const labelLines = Object.entries(labels).map(([key, value]) => `    ${key}: ${value}`);
  const selectorLabelLines = Object.entries(labels).map(([key, value]) => `        ${key}: ${value}`);
  const extraEnv = envLines(input.environment);
  const herdrSession = clean(input.herdrSession) ?? repoSessionName();
  const preflightConfigMap = preflight === undefined ? undefined : [
    "apiVersion: v1",
    "kind: ConfigMap",
    "metadata:",
    `  name: ${preflightConfigMapName}`,
    `  namespace: ${namespace}`,
    "  labels:",
    ...labelLines,
    "data:",
    "  ciclo-remote-preflight.sh: |",
    indentBlock(preflight.artifacts[0]?.content ?? "", 4)
  ].join("\n");
  const wireGuardSecret = shouldGenerateWireGuardSecret ? [
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    `  name: ${wireGuardSecretName}`,
    `  namespace: ${namespace}`,
    "  labels:",
    ...labelLines,
    "type: Opaque",
    "stringData:",
    "  runner.conf: |",
    indentBlock(wireGuard.runnerConfig, 4)
  ].join("\n") : undefined;
  const wireGuardBootstrap = shouldBootstrapWireGuard ? [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `NAMESPACE=${shellQuote(namespace)}`,
    `SECRET_NAME=${shellQuote(wireGuardSecretName)}`,
    `WG_IF=${shellQuote(wireGuard.interfaceName)}`,
    `NETWORK_CIDR=${shellQuote(wireGuard.networkCidr)}`,
    `CICLO_ADDRESS=${shellQuote(wireGuard.cicloAddress)}`,
    `RUNNER_ADDRESS=${shellQuote(wireGuard.runnerAddress)}`,
    `CICLO_ENDPOINT=${shellQuote(wireGuard.cicloEndpoint)}`,
    `RUNNER_ALLOWED_IPS=${shellQuote(wireGuard.runnerAllowedIps.join(", "))}`,
    `LISTEN_PORT=${shellQuote(endpointPort(wireGuard.cicloEndpoint))}`,
    `PERSISTENT_KEEPALIVE=${input.wireGuard?.persistentKeepaliveSeconds ?? 25}`,
    "EGRESS_IF=${CICLO_WG_EGRESS_INTERFACE:-auto}",
    "if [ \"$EGRESS_IF\" = \"auto\" ]; then",
    "  EGRESS_IF=\"$(ip route get 1.1.1.1 | awk '{for (i=1; i<=NF; i++) if ($i == \"dev\") {print $(i+1); exit}}')\"",
    "fi",
    "test -n \"$EGRESS_IF\"",
    "CICLO_PRIVATE_KEY=\"$(wg genkey)\"",
    "CICLO_PUBLIC_KEY=\"$(printf '%s' \"$CICLO_PRIVATE_KEY\" | wg pubkey)\"",
    "RUNNER_PRIVATE_KEY=\"$(wg genkey)\"",
    "RUNNER_PUBLIC_KEY=\"$(printf '%s' \"$RUNNER_PRIVATE_KEY\" | wg pubkey)\"",
    "HOST_CONFIG=\"$(printf '%s\\n' '[Interface]' \"Address = $CICLO_ADDRESS\" \"ListenPort = $LISTEN_PORT\" \"PrivateKey = $CICLO_PRIVATE_KEY\" '' '[Peer]' \"PublicKey = $RUNNER_PUBLIC_KEY\" \"AllowedIPs = ${RUNNER_ADDRESS%%/*}/32\")\"",
    "RUNNER_CONFIG=\"$(printf '%s\\n' '[Interface]' \"Address = $RUNNER_ADDRESS\" \"PrivateKey = $RUNNER_PRIVATE_KEY\" '' '[Peer]' \"PublicKey = $CICLO_PUBLIC_KEY\" \"AllowedIPs = $RUNNER_ALLOWED_IPS\" \"Endpoint = $CICLO_ENDPOINT\" \"PersistentKeepalive = $PERSISTENT_KEEPALIVE\")\"",
    "printf '%s\\n' \"$HOST_CONFIG\" | sudo install -m 0600 /dev/stdin \"/etc/wireguard/$WG_IF.conf\"",
    "sudo sysctl -w net.ipv4.ip_forward=1",
    "sudo iptables -C FORWARD -i \"$WG_IF\" -j ACCEPT 2>/dev/null || sudo iptables -A FORWARD -i \"$WG_IF\" -j ACCEPT",
    "sudo iptables -C FORWARD -o \"$WG_IF\" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || sudo iptables -A FORWARD -o \"$WG_IF\" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
    "sudo iptables -t nat -C POSTROUTING -s \"$NETWORK_CIDR\" -o \"$EGRESS_IF\" -j MASQUERADE 2>/dev/null || sudo iptables -t nat -A POSTROUTING -s \"$NETWORK_CIDR\" -o \"$EGRESS_IF\" -j MASQUERADE",
    "sudo wg-quick up \"$WG_IF\"",
    "kubectl create namespace \"$NAMESPACE\" --dry-run=client -o yaml | kubectl apply -f -",
    "kubectl -n \"$NAMESPACE\" create secret generic \"$SECRET_NAME\" --from-literal=runner.conf=\"$RUNNER_CONFIG\" --dry-run=client -o yaml | kubectl apply -f -"
  ].join("\n") : undefined;
  const repoBootstrapLines = repoBootstrap?.enabled === false ? [] : [
    "              if [ -n \"${CICLO_REPO_URL:-}\" ] && [ ! -d \"$CICLO_REPO_PATH/.git\" ]; then",
    "                mkdir -p \"$(dirname \"$CICLO_REPO_PATH\")\"",
    "                git clone \"$CICLO_REPO_URL\" \"$CICLO_REPO_PATH\"",
    "              elif [ -d \"$CICLO_REPO_PATH/.git\" ]; then",
    "                git -C \"$CICLO_REPO_PATH\" fetch --all --prune || true",
    "              fi",
    "              if [ \"${CICLO_REMOTE_DEVENV_BOOTSTRAP:-true}\" = \"true\" ] && [ -f \"$CICLO_REPO_PATH/devenv.nix\" ] && command -v devenv >/dev/null 2>&1; then",
    "                (cd \"$CICLO_REPO_PATH\" && devenv shell -- true)",
    "              fi"
  ];
  const containerSpec = [
    "      containers:",
    "        - name: runner",
    `          image: ${input.image}`,
    "          securityContext:",
    "            allowPrivilegeEscalation: false",
    "            capabilities:",
    "              add: [\"NET_ADMIN\"]",
    "              drop: [\"ALL\"]",
    "          env:",
    `            - name: CICLO_REMOTE_SESSION_ID\n              value: ${JSON.stringify(input.runnerId ?? workloadName)}`,
    `            - name: CICLO_HERDR_SESSION\n              value: ${JSON.stringify(herdrSession)}`,
    `            - name: CICLO_REPO_PATH\n              value: ${JSON.stringify(input.repoPath)}`,
    ...(input.repoUrl === undefined ? [] : [`            - name: CICLO_REPO_URL\n              value: ${JSON.stringify(input.repoUrl)}`]),
    `            - name: CICLO_WIREGUARD_INTERFACE\n              value: ${JSON.stringify(wireGuard.interfaceName)}`,
    ...(preflight === undefined ? [] : [`            - name: CICLO_PREFLIGHT_REPORT\n              value: ${JSON.stringify(preflight.reportPath)}`]),
    ...(input.preflightOnly === true ? [`            - name: CICLO_PREFLIGHT_ONLY\n              value: "true"`] : []),
    ...(repoBootstrap?.useDevenv === false ? [`            - name: CICLO_REMOTE_DEVENV_BOOTSTRAP\n              value: "false"`] : []),
    ...(extraEnv.length === 0 ? [] : [extraEnv]),
    "          command: [\"/bin/bash\", \"-lc\"]",
    "          volumeMounts:",
    ...(storageSize === undefined ? [] : [
      "            - name: workspace",
      "              mountPath: /workspace"
    ]),
    ...(preflight === undefined ? [] : [
      "            - name: preflight-script",
      "              mountPath: /ciclo/preflight",
      "              readOnly: true"
    ]),
    "            - name: wireguard-config",
    "              mountPath: /ciclo/wg",
    "              readOnly: true",
    "          args:",
    "            - |",
    "              set -euo pipefail",
    ...repoBootstrapLines,
    ...(preflight === undefined ? [] : ["              bash /ciclo/preflight/ciclo-remote-preflight.sh || true"]),
    ...(input.preflightOnly === true ? ["              if [ \"${CICLO_PREFLIGHT_ONLY:-false}\" = \"true\" ]; then exit 0; fi"] : []),
    "              install -m 0600 /ciclo/wg/runner.conf /etc/wireguard/wg-ciclo.conf",
    "              wg-quick up wg-ciclo",
    `              ${herdrSessionStartCommand(input)}`,
    "              tail -f /dev/null",
    "      volumes:",
    ...(preflight === undefined ? [] : [
      "        - name: preflight-script",
      "          configMap:",
      `            name: ${preflightConfigMapName}`,
      "            defaultMode: 493"
    ]),
    "        - name: wireguard-config",
    "          secret:",
    `            secretName: ${wireGuardSecretName}`,
    "            defaultMode: 384"
  ];
  const jobManifest = [
    "apiVersion: batch/v1",
    "kind: Job",
    "metadata:",
    `  name: ${workloadName}`,
    `  namespace: ${namespace}`,
    "  labels:",
    ...labelLines,
    "spec:",
    "  template:",
    "    metadata:",
    "      labels:",
    ...selectorLabelLines,
    "    spec:",
    `      serviceAccountName: ${serviceAccount}`,
    "      restartPolicy: Never",
    ...containerSpec
  ].join("\n");
  const serviceManifest = [
    "apiVersion: v1",
    "kind: Service",
    "metadata:",
    `  name: ${serviceName}`,
    `  namespace: ${namespace}`,
    "  labels:",
    ...labelLines,
    "spec:",
    "  clusterIP: None",
    "  selector:",
    ...labelLines,
    "  ports:",
    "    - name: ssh",
    "      port: 22",
    "      targetPort: 22"
  ].join("\n");
  const statefulSetManifest = [
    "apiVersion: apps/v1",
    "kind: StatefulSet",
    "metadata:",
    `  name: ${workloadName}`,
    `  namespace: ${namespace}`,
    "  labels:",
    ...labelLines,
    "spec:",
    `  serviceName: ${serviceName}`,
    `  replicas: ${replicas}`,
    "  selector:",
    "    matchLabels:",
    ...selectorLabelLines,
    "  template:",
    "    metadata:",
    "      labels:",
    ...selectorLabelLines,
    "    spec:",
    `      serviceAccountName: ${serviceAccount}`,
    "      restartPolicy: Always",
    ...containerSpec,
    ...(storageSize === undefined ? [] : [
      "  volumeClaimTemplates:",
      "    - metadata:",
      "        name: workspace",
      "      spec:",
      "        accessModes: [\"ReadWriteOnce\"]",
      ...(storageClassName === undefined ? [] : [`        storageClassName: ${storageClassName}`]),
      "        resources:",
      "          requests:",
      `            storage: ${storageSize}`
    ])
  ].join("\n");
  const networkPolicy = egress === undefined ? undefined : [
    "apiVersion: networking.k8s.io/v1",
    "kind: NetworkPolicy",
    "metadata:",
    `  name: ${egress.name}`,
    `  namespace: ${namespace}`,
    "  labels:",
    ...labelLines,
    ...(egress.domains.length === 0 ? [] : [
      "  annotations:",
      `    ciclo.smol.dev/egress-domains: ${JSON.stringify(egress.domains.join(","))}`
    ]),
    "spec:",
    "  podSelector:",
    "    matchLabels:",
    ...selectorLabelLines,
    "  policyTypes:",
    "    - Egress",
    "  egress:",
    ...(egress.cidrs.length === 0 ? [] : egress.cidrs.flatMap((cidr) => [
      "    - to:",
      "        - ipBlock:",
      `            cidr: ${cidr}`
    ]))
  ].join("\n");
  const workloadArtifact = mode === "job"
    ? { name: `${workloadName}.job.yaml`, format: "yaml" as const, content: jobManifest }
    : { name: `${workloadName}.statefulset.yaml`, format: "yaml" as const, content: statefulSetManifest };
  return {
    providerName: mode === "job" ? "kubernetes-job" : "kubernetes-statefulset",
    executionModel: mode === "job" ? "kubernetes_job" : "kubernetes_statefulset",
    artifacts: [
      ...(preflightConfigMap === undefined ? [] : [{ name: `${workloadName}.preflight-configmap.yaml`, format: "yaml" as const, content: preflightConfigMap }]),
      ...(wireGuardSecret === undefined ? [] : [{ name: `${workloadName}.wireguard-secret.yaml`, format: "yaml" as const, content: wireGuardSecret }]),
      ...(wireGuardBootstrap === undefined ? [] : [{ name: `${workloadName}.wireguard-bootstrap.sh`, format: "shell" as const, content: wireGuardBootstrap }]),
      ...(networkPolicy === undefined ? [] : [{ name: `${egress?.name}.networkpolicy.yaml`, format: "yaml" as const, content: networkPolicy }]),
      ...(mode === "job" ? [] : [{ name: `${serviceName}.service.yaml`, format: "yaml" as const, content: serviceManifest }]),
      workloadArtifact
    ],
    commands: [
      `kubectl create namespace ${namespace} --dry-run=client -o yaml | kubectl apply -f -`,
      ...(preflight === undefined ? [] : [`kubectl -n ${namespace} apply -f ${workloadName}.preflight-configmap.yaml`]),
      ...(wireGuardSecret === undefined ? [] : [`kubectl -n ${namespace} apply -f ${workloadName}.wireguard-secret.yaml`]),
      ...(wireGuardBootstrap === undefined ? [] : [`bash ${workloadName}.wireguard-bootstrap.sh`]),
      ...(networkPolicy === undefined ? [] : [`kubectl -n ${namespace} apply -f ${egress?.name}.networkpolicy.yaml`]),
      ...(mode === "job" ? [] : [`kubectl -n ${namespace} apply -f ${serviceName}.service.yaml`]),
      `kubectl -n ${namespace} apply -f ${workloadArtifact.name}`
    ],
    warnings: [
      ...(!wireGuard.secretMaterialProvided && wireGuard.existingConfigSecretName === undefined
        ? ["WireGuard key material is not provided; run the generated bootstrap script to create local WireGuard keys, install the host interface, and create the Kubernetes runner.conf Secret before applying the workload."]
        : []),
      ...(mode === "statefulset" ? ["Kubernetes StatefulSet runners keep stable identity for Herdr attach; use explicit kubernetes.mode=job only for short validation runs."] : []),
      ...(egress?.warnings ?? [])
    ],
    evidence: [
      mode === "job" ? "remote.runner.plugin:kubernetes-job" : "remote.runner.plugin:kubernetes-statefulset",
      mode === "job" ? "remote.runner.execution_model:kubernetes_job" : "remote.runner.execution_model:kubernetes_statefulset",
      `remote.runner.kubernetes.mode:${mode}`,
      ...(mode === "statefulset" ? [`remote.runner.kubernetes.service:${serviceName}`, `remote.runner.kubernetes.replicas:${replicas}`] : []),
      ...(storageSize === undefined ? [] : [`remote.runner.kubernetes.storage:${storageSize}`]),
      ...(input.preflightOnly === true ? ["remote.runner.preflight_only:planned"] : []),
      ...(wireGuardSecret === undefined
        ? [wireGuard.existingConfigSecretName === undefined ? "remote.runner.wireguard.secret:bootstrap" : "remote.runner.wireguard.secret:existing"]
        : ["remote.runner.wireguard.secret:generated"]),
      ...(wireGuardBootstrap === undefined ? [] : ["remote.runner.wireguard.bootstrap:planned"]),
      ...(egress?.evidence ?? [])
    ]
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
          herdrSessionStartCommand(input)
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
  pluginRegistry = createDefaultRemoteRunnerPluginRegistry(),
  imageResolverRegistry = createDefaultRemoteRunnerImageResolverRegistry()
): RemoteRunnerLaunchPlan {
  const repoPath = required(input.repoPath, "repo_path");
  const prompt = required(input.prompt, "prompt");
  const herdrSession = clean(input.herdrSession) ?? repoSessionName();
  const imageResolution = resolveRemoteRunnerImage(input, imageResolverRegistry);
  const image = imageResolution.image;
  const repoUrl = clean(input.repoUrl);
  const resolvedInput = {
    ...input,
    runnerId: planId,
    image,
    ...(repoUrl === undefined ? {} : { repoUrl }),
    repoPath,
    prompt,
    herdrSession
  };
  const wireGuard = wireGuardPlan(resolvedInput);
  const herdrRemoteTarget = remoteTarget(resolvedInput, wireGuard);
  const attach = buildCicloAttachPlan({
    remoteTarget: herdrRemoteTarget,
    session: herdrSession
  });
  const mcpConfig = remoteMcpConfigPlan(resolvedInput, repoPath);
  const workerSecretEnv = remoteWorkerSecretEnvPlan(resolvedInput);
  const repoBootstrap = repoBootstrapPlan(resolvedInput, repoPath);
  const egress = egressPolicyPlan(resolvedInput, planId);
  const preflight = remotePreflightPlan(resolvedInput, planId);
  const runnerArtifacts = pluginRegistry.require(input.runnerKind).plan(
    resolvedInput,
    wireGuard,
    preflight,
    repoBootstrap,
    egress
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
    ...imageResolution.evidence,
    ...repoBootstrap.evidence,
    ...(egress?.evidence ?? []),
    ...wireGuard.evidence,
    ...(preflight?.evidence ?? []),
    ...attach.evidence,
    ...(mcpConfig?.evidence ?? []),
    ...(workerSecretEnv?.evidence ?? []),
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
    imageResolution,
    repoBootstrap,
    ...(egress === undefined ? {} : { egress }),
    wireGuard,
    ...(preflight === undefined ? {} : { preflight }),
    attach,
    ...(mcpConfig === undefined ? {} : { mcpConfig }),
    ...(workerSecretEnv === undefined ? {} : { workerSecretEnv }),
    commands: [...(wireGuard.hostMaterialProvided ? wireGuard.commands : []), ...runnerArtifacts.commands],
    artifacts: [...wireGuard.artifacts, ...runnerArtifacts.artifacts, ...(preflight?.artifacts ?? []), ...(mcpConfig?.artifacts ?? [])],
    warnings: [
      ...imageResolution.warnings,
      ...(!wireGuard.hostMaterialProvided
        ? ["WireGuard host config contains unresolved secret references; provide ciclo private key and runner public key material before running the host setup script."]
        : []),
      ...runnerArtifacts.warnings,
      ...(preflight?.warnings ?? []),
      ...(mcpConfig?.warnings ?? [])
    ],
    evidence
  };
}

export class RemoteRunnerRegistry {
  private readonly runners = new Map<string, RemoteRunnerLaunchPlan>();

  constructor(
    private readonly pluginRegistry = createDefaultRemoteRunnerPluginRegistry(),
    private readonly imageResolverRegistry = createDefaultRemoteRunnerImageResolverRegistry()
  ) {}

  launch(input: RemoteRunnerLaunchRequest): RemoteRunnerRegistryLaunchResult {
    const plan = buildRemoteRunnerLaunchPlan(input, input.runnerId ?? undefined, this.pluginRegistry, this.imageResolverRegistry);
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
