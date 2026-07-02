import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CicloMcpAdditionalServerConfig, CicloMcpInstallClient, CicloMcpInstallOptions, CicloMcpSecretEnvBinding } from "./mcp-install.js";
import type { RemoteRunnerLaunchRequest, WireGuardTunnelRequest } from "./remote-runner.js";
import {
  createDefaultSecretProviderRegistry,
  OnePasswordCliSecretProvider,
  OpenBaoCliSecretProvider,
  SecretProviderRegistry,
  secretRefHash,
  type SecretProviderPlugin,
  type SecretProviderRequest,
  type SecretProviderResult
} from "./secret-provider.js";
import type { WorkerSessionLaunchRequest } from "./worker-session-supervisor.js";

export interface CicloConfigSecretProvider {
  readonly id: string;
  readonly kind: "openbao" | "onepassword" | string;
  readonly name?: string;
  readonly command?: string;
  readonly pluginProviderId?: string;
}

export interface CicloConfigMcpSecretBinding {
  readonly name: string;
  readonly providerId: string;
  readonly ref: string;
  readonly field?: string;
  readonly format?: string;
  readonly reason?: string;
}

export interface CicloConfigMcp {
  readonly clients?: readonly CicloMcpInstallClient[];
  readonly serverName?: string;
  readonly command?: string;
  readonly vars?: Record<string, string>;
  readonly additionalServers?: Record<string, CicloMcpAdditionalServerConfig>;
  readonly secretBindings?: readonly CicloConfigMcpSecretBinding[];
  readonly claudeChannel?: boolean;
}

export interface CicloConfigRemote {
  readonly runnerKind?: string;
  readonly image?: string;
  readonly repoUrl?: string;
  readonly repoPath?: string;
  readonly herdrSession?: string;
  readonly sshUser?: string;
  readonly wireGuard?: WireGuardTunnelRequest;
  readonly vars?: Record<string, string>;
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
    readonly memoryMb?: number;
    readonly vcpuCount?: number;
  };
  readonly cloudflare?: {
    readonly accountId?: string;
    readonly workerName?: string;
  };
}

export interface CicloProjectConfig {
  readonly secrets?: {
    readonly providers?: readonly CicloConfigSecretProvider[];
  };
  readonly mcp?: CicloConfigMcp;
  readonly remote?: CicloConfigRemote;
}

export interface CicloProjectConfigLoadResult {
  readonly projectRoot: string;
  readonly path?: string;
  readonly found: boolean;
  readonly config: CicloProjectConfig;
  readonly evidence: readonly string[];
}

export const defaultCicloConfigRelativePath = ".ciclo/config.json";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? clean(value) : undefined;
}

function optionalStringAny(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = optionalString(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalBooleanAny(record: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = optionalBoolean(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalNumberAny(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = optionalNumber(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function stringRecord(record: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  const input = objectValue(value, key);
  const output: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(input)) {
    if (typeof entryValue !== "string") throw new Error(`${key}.${entryKey} must be a string`);
    output[entryKey] = entryValue;
  }
  return output;
}

function clientList(record: Record<string, unknown>, key: string): readonly CicloMcpInstallClient[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  const clients = value.map((client) => {
    if (client === "claude" || client === "codex") return client;
    throw new Error(`${key} entries must be claude or codex`);
  });
  return [...new Set(clients)];
}

function secretProviderConfig(value: unknown, index: number): CicloConfigSecretProvider {
  const record = objectValue(value, `secrets.providers[${index}]`);
  const id = optionalString(record, "id");
  const kind = optionalString(record, "kind");
  if (id === undefined) throw new Error(`secrets.providers[${index}].id is required`);
  if (kind === undefined) throw new Error(`secrets.providers[${index}].kind is required`);
  const name = optionalString(record, "name");
  const command = optionalString(record, "command");
  const pluginProviderId = optionalStringAny(record, ["plugin_provider_id", "pluginProviderId"]);
  return {
    id,
    kind,
    ...(name === undefined ? {} : { name }),
    ...(command === undefined ? {} : { command }),
    ...(pluginProviderId === undefined ? {} : { pluginProviderId })
  };
}

function parseSecrets(root: Record<string, unknown>): CicloProjectConfig["secrets"] {
  if (root.secrets === undefined) return undefined;
  const record = objectValue(root.secrets, "secrets");
  if (record.providers === undefined) return {};
  if (!Array.isArray(record.providers)) throw new Error("secrets.providers must be an array");
  return { providers: record.providers.map(secretProviderConfig) };
}

function parseMcpSecretBinding(value: unknown, index: number): CicloConfigMcpSecretBinding {
  const record = objectValue(value, `mcp.secret_bindings[${index}]`);
  const name = optionalString(record, "name");
  const providerId = optionalStringAny(record, ["provider_id", "providerId"]);
  const ref = optionalString(record, "ref");
  if (name === undefined) throw new Error(`mcp.secret_bindings[${index}].name is required`);
  if (providerId === undefined) throw new Error(`mcp.secret_bindings[${index}].provider_id is required`);
  if (ref === undefined) throw new Error(`mcp.secret_bindings[${index}].ref is required`);
  const field = optionalString(record, "field");
  const format = optionalStringAny(record, ["format", "value_format", "valueFormat"]);
  const reason = optionalString(record, "reason");
  return { name, providerId, ref, ...(field === undefined ? {} : { field }), ...(format === undefined ? {} : { format }), ...(reason === undefined ? {} : { reason }) };
}

function stringList(value: unknown, path: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`${path}[${index}] must be a string`);
    return entry;
  });
}

function parseMcpAdditionalServers(record: Record<string, unknown>): Record<string, CicloMcpAdditionalServerConfig> | undefined {
  const value = record.additional_servers ?? record.additionalServers;
  if (value === undefined) return undefined;
  const servers = objectValue(value, "mcp.additional_servers");
  const output: Record<string, CicloMcpAdditionalServerConfig> = {};
  for (const [name, rawServer] of Object.entries(servers)) {
    const server = objectValue(rawServer, `mcp.additional_servers.${name}`);
    const command = optionalString(server, "command");
    if (command === undefined) throw new Error(`mcp.additional_servers.${name}.command is required`);
    output[name] = {
      command,
      args: stringList(server.args, `mcp.additional_servers.${name}.args`),
      env: stringRecord(server, "env") ?? {}
    };
  }
  return output;
}

function parseMcp(root: Record<string, unknown>): CicloConfigMcp | undefined {
  if (root.mcp === undefined) return undefined;
  const record = objectValue(root.mcp, "mcp");
  const secretBindingValue = record.secret_bindings ?? record.secretBindings;
  if (secretBindingValue !== undefined && !Array.isArray(secretBindingValue)) throw new Error("mcp.secret_bindings must be an array");
  const clients = clientList(record, "clients");
  const serverName = optionalStringAny(record, ["server_name", "serverName"]);
  const command = optionalString(record, "command");
  const vars = stringRecord(record, "vars");
  const additionalServers = parseMcpAdditionalServers(record);
  const claudeChannel = optionalBooleanAny(record, ["claude_channel", "claudeChannel"]);
  return {
    ...(clients === undefined ? {} : { clients }),
    ...(serverName === undefined ? {} : { serverName }),
    ...(command === undefined ? {} : { command }),
    ...(vars === undefined ? {} : { vars }),
    ...(additionalServers === undefined ? {} : { additionalServers }),
    ...(secretBindingValue === undefined ? {} : { secretBindings: secretBindingValue.map(parseMcpSecretBinding) }),
    ...(claudeChannel === undefined ? {} : { claudeChannel })
  };
}

function parseWireGuard(record: Record<string, unknown>): WireGuardTunnelRequest | undefined {
  const value = record.wireguard ?? record.wireGuard;
  if (value === undefined) return undefined;
  const wireguard = objectValue(value, "remote.wireguard");
  const interfaceName = optionalStringAny(wireguard, ["interface_name", "interfaceName"]);
  const networkCidr = optionalStringAny(wireguard, ["network_cidr", "networkCidr"]);
  const cicloAddress = optionalStringAny(wireguard, ["ciclo_address", "cicloAddress"]);
  const runnerAddress = optionalStringAny(wireguard, ["runner_address", "runnerAddress"]);
  const cicloEndpoint = optionalStringAny(wireguard, ["ciclo_endpoint", "cicloEndpoint"]);
  const cicloPublicKeySecretRef = optionalStringAny(wireguard, ["ciclo_public_key_ref", "cicloPublicKeySecretRef"]);
  const runnerPrivateKeySecretRef = optionalStringAny(wireguard, ["runner_private_key_ref", "runnerPrivateKeySecretRef"]);
  const persistentKeepaliveSeconds = optionalNumberAny(wireguard, ["persistent_keepalive_seconds", "persistentKeepaliveSeconds"]);
  return {
    ...(interfaceName === undefined ? {} : { interfaceName }),
    ...(networkCidr === undefined ? {} : { networkCidr }),
    ...(cicloAddress === undefined ? {} : { cicloAddress }),
    ...(runnerAddress === undefined ? {} : { runnerAddress }),
    ...(cicloEndpoint === undefined ? {} : { cicloEndpoint }),
    ...(cicloPublicKeySecretRef === undefined ? {} : { cicloPublicKeySecretRef }),
    ...(runnerPrivateKeySecretRef === undefined ? {} : { runnerPrivateKeySecretRef }),
    ...(persistentKeepaliveSeconds === undefined ? {} : { persistentKeepaliveSeconds })
  };
}

function parseRemote(root: Record<string, unknown>): CicloConfigRemote | undefined {
  if (root.remote === undefined) return undefined;
  const record = objectValue(root.remote, "remote");
  const kubernetes = objectValue(record.kubernetes, "remote.kubernetes");
  const awsLambda = objectValue(record.aws_lambda ?? record.awsLambda, "remote.aws_lambda");
  const cloudflare = objectValue(record.cloudflare, "remote.cloudflare");
  const runnerKind = optionalStringAny(record, ["runner_kind", "runnerKind"]);
  const image = optionalString(record, "image");
  const repoUrl = optionalStringAny(record, ["repo_url", "repoUrl"]);
  const repoPath = optionalStringAny(record, ["repo_path", "repoPath"]);
  const herdrSession = optionalStringAny(record, ["herdr_session", "herdrSession"]);
  const sshUser = optionalStringAny(record, ["ssh_user", "sshUser"]);
  const wireGuard = parseWireGuard(record);
  const vars = stringRecord(record, "vars");
  return {
    ...(runnerKind === undefined ? {} : { runnerKind }),
    ...(image === undefined ? {} : { image }),
    ...(repoUrl === undefined ? {} : { repoUrl }),
    ...(repoPath === undefined ? {} : { repoPath }),
    ...(herdrSession === undefined ? {} : { herdrSession }),
    ...(sshUser === undefined ? {} : { sshUser }),
    ...(wireGuard === undefined ? {} : { wireGuard }),
    ...(vars === undefined ? {} : { vars }),
    kubernetes: {
      ...(optionalString(kubernetes, "namespace") === undefined ? {} : { namespace: optionalString(kubernetes, "namespace") }),
      ...(optionalStringAny(kubernetes, ["service_account", "serviceAccount"]) === undefined ? {} : { serviceAccount: optionalStringAny(kubernetes, ["service_account", "serviceAccount"]) }),
      ...(optionalStringAny(kubernetes, ["job_name", "jobName"]) === undefined ? {} : { jobName: optionalStringAny(kubernetes, ["job_name", "jobName"]) })
    },
    awsLambda: {
      ...(optionalStringAny(awsLambda, ["microvm_image_name", "microVmImageName"]) === undefined ? {} : { microVmImageName: optionalStringAny(awsLambda, ["microvm_image_name", "microVmImageName"]) }),
      ...(optionalStringAny(awsLambda, ["microvm_image_identifier", "microVmImageIdentifier"]) === undefined ? {} : { microVmImageIdentifier: optionalStringAny(awsLambda, ["microvm_image_identifier", "microVmImageIdentifier"]) }),
      ...(optionalStringAny(awsLambda, ["microvm_name", "microVmName"]) === undefined ? {} : { microVmName: optionalStringAny(awsLambda, ["microvm_name", "microVmName"]) }),
      ...(optionalStringAny(awsLambda, ["base_image_arn", "baseImageArn"]) === undefined ? {} : { baseImageArn: optionalStringAny(awsLambda, ["base_image_arn", "baseImageArn"]) }),
      ...(optionalStringAny(awsLambda, ["build_role_arn", "buildRoleArn"]) === undefined ? {} : { buildRoleArn: optionalStringAny(awsLambda, ["build_role_arn", "buildRoleArn"]) }),
      ...(optionalStringAny(awsLambda, ["execution_role_arn", "executionRoleArn"]) === undefined ? {} : { executionRoleArn: optionalStringAny(awsLambda, ["execution_role_arn", "executionRoleArn"]) }),
      ...(optionalStringAny(awsLambda, ["source_s3_uri", "sourceS3Uri"]) === undefined ? {} : { sourceS3Uri: optionalStringAny(awsLambda, ["source_s3_uri", "sourceS3Uri"]) }),
      ...(optionalNumberAny(awsLambda, ["memory_mb", "memoryMb"]) === undefined ? {} : { memoryMb: optionalNumberAny(awsLambda, ["memory_mb", "memoryMb"]) }),
      ...(optionalNumberAny(awsLambda, ["vcpu_count", "vcpuCount"]) === undefined ? {} : { vcpuCount: optionalNumberAny(awsLambda, ["vcpu_count", "vcpuCount"]) })
    },
    cloudflare: {
      ...(optionalStringAny(cloudflare, ["account_id", "accountId"]) === undefined ? {} : { accountId: optionalStringAny(cloudflare, ["account_id", "accountId"]) }),
      ...(optionalStringAny(cloudflare, ["worker_name", "workerName"]) === undefined ? {} : { workerName: optionalStringAny(cloudflare, ["worker_name", "workerName"]) })
    }
  };
}

export function parseCicloProjectConfigText(text: string): CicloProjectConfig {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  const root = objectValue(JSON.parse(trimmed) as unknown, "ciclo config");
  const secrets = parseSecrets(root);
  const mcp = parseMcp(root);
  const remote = parseRemote(root);
  return { ...(secrets === undefined ? {} : { secrets }), ...(mcp === undefined ? {} : { mcp }), ...(remote === undefined ? {} : { remote }) };
}

export function cicloConfigPath(projectRoot = process.cwd(), explicitPath?: string): string {
  return resolve(explicitPath ?? join(projectRoot, defaultCicloConfigRelativePath));
}

export function loadCicloProjectConfig(projectRoot = process.cwd(), explicitPath?: string): CicloProjectConfigLoadResult {
  const path = cicloConfigPath(projectRoot, explicitPath);
  if (!existsSync(path)) return { projectRoot: resolve(projectRoot), found: false, config: {}, evidence: ["ciclo.config:missing", `ciclo.config.path:${path}`] };
  const config = parseCicloProjectConfigText(readFileSync(path, "utf8"));
  return {
    projectRoot: resolve(projectRoot),
    path,
    found: true,
    config,
    evidence: [
      "ciclo.config:loaded",
      `ciclo.config.path:${path}`,
      `ciclo.config.secret_providers:${config.secrets?.providers?.length ?? 0}`,
      `ciclo.config.mcp:${config.mcp === undefined ? "absent" : "present"}`,
      `ciclo.config.remote:${config.remote === undefined ? "absent" : "present"}`
    ]
  };
}

export function redactedCicloProjectConfig(config: CicloProjectConfig): CicloProjectConfig {
  return {
    ...config,
    ...(config.mcp?.secretBindings === undefined ? {} : {
      mcp: {
        ...config.mcp,
        secretBindings: config.mcp.secretBindings.map((binding) => ({ ...binding, ref: "[redacted secret ref]" }))
      }
    })
  };
}

class ConfiguredPluginSecretProviderAlias implements SecretProviderPlugin {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly supportsFields = true;

  constructor(
    private readonly provider: CicloConfigSecretProvider,
    private readonly registry: SecretProviderRegistry
  ) {
    this.id = provider.id;
    this.kind = provider.kind;
    this.name = provider.name ?? `${provider.kind} plugin provider`;
  }

  async resolve(input: SecretProviderRequest): Promise<SecretProviderResult> {
    const delegateId = this.provider.pluginProviderId;
    if (delegateId === undefined || delegateId === this.id) {
      return {
        resolved: false,
        providerId: this.id,
        providerKind: this.kind,
        secretRefHash: secretRefHash(input.secretRef),
        field: input.field,
        reason: "configured plugin secret provider has no distinct delegate provider id",
        evidence: [
          `secret.provider:${this.id}`,
          `secret.kind:${this.kind}`,
          `secret.ref_hash:${secretRefHash(input.secretRef)}`,
          "secret.provider.plugin_alias:invalid",
          "secret.resolved:false"
        ]
      };
    }
    const delegate = this.registry.get(delegateId);
    if (delegate === undefined) {
      return {
        resolved: false,
        providerId: this.id,
        providerKind: this.kind,
        secretRefHash: secretRefHash(input.secretRef),
        field: input.field,
        reason: `plugin secret provider is not registered: ${delegateId}`,
        evidence: [
          `secret.provider:${this.id}`,
          `secret.kind:${this.kind}`,
          `secret.ref_hash:${secretRefHash(input.secretRef)}`,
          `secret.provider.plugin_delegate:${delegateId}`,
          "secret.provider.plugin_delegate:missing",
          "secret.resolved:false"
        ]
      };
    }
    const delegated = await delegate.resolve({ ...input, providerId: delegateId });
    return {
      ...delegated,
      providerId: this.id,
      providerKind: this.kind,
      evidence: [
        `secret.provider:${this.id}`,
        `secret.kind:${this.kind}`,
        `secret.provider.plugin_delegate:${delegateId}`,
        ...delegated.evidence
      ]
    };
  }
}

function providerFromConfig(
  provider: CicloConfigSecretProvider,
  registry: SecretProviderRegistry
): SecretProviderPlugin | undefined {
  if (provider.kind === "openbao") return new OpenBaoCliSecretProvider({ id: provider.id, name: provider.name, command: provider.command });
  if (provider.kind === "onepassword") return new OnePasswordCliSecretProvider({ id: provider.id, name: provider.name, command: provider.command });
  if (provider.pluginProviderId !== undefined && provider.pluginProviderId !== provider.id) {
    return new ConfiguredPluginSecretProviderAlias(provider, registry);
  }
  return undefined;
}

export function createSecretProviderRegistryFromConfig(config: CicloProjectConfig): SecretProviderRegistry {
  const registry = createDefaultSecretProviderRegistry();
  for (const provider of config.secrets?.providers ?? []) {
    const configuredProvider = providerFromConfig(provider, registry);
    if (configuredProvider !== undefined) registry.register(configuredProvider);
  }
  return registry;
}

export function configMcpSecretBindingParams(config: CicloProjectConfig): readonly Record<string, string>[] {
  return (config.mcp?.secretBindings ?? []).map((binding) => ({
    name: binding.name,
    provider_id: binding.providerId,
    ref: binding.ref,
    ...(binding.field === undefined ? {} : { field: binding.field }),
    ...(binding.format === undefined ? {} : { format: binding.format }),
    ...(binding.reason === undefined ? {} : { reason: binding.reason })
  }));
}

export function configMcpSecretEnvBindings(config: CicloProjectConfig): readonly CicloMcpSecretEnvBinding[] {
  return (config.mcp?.secretBindings ?? []).map((binding) => ({
    name: binding.name,
    providerId: binding.providerId,
    providerKind: "configured",
    secretRefHash: secretRefHash(binding.ref),
    ...(binding.field === undefined ? {} : { field: binding.field }),
    ...(binding.format === undefined ? {} : { format: binding.format }),
    evidence: [
      `secret.provider:${binding.providerId}`,
      `secret.ref_hash:${secretRefHash(binding.ref)}`,
      `mcp.secret_env:${binding.name}`,
      "mcp.secret_env:configured"
    ]
  }));
}

export async function resolveConfigMcpSecretEnvBindings(input: {
  readonly config: CicloProjectConfig;
  readonly registry: SecretProviderRegistry;
  readonly dryRun: boolean;
}): Promise<readonly CicloMcpSecretEnvBinding[]> {
  const resolved: CicloMcpSecretEnvBinding[] = [];
  for (const binding of input.config.mcp?.secretBindings ?? []) {
    const result = await input.registry.resolve({
      providerId: binding.providerId,
      secretRef: binding.ref,
      field: binding.field,
      reason: binding.reason ?? `provide ${binding.name} to configured MCP server`,
      dryRun: input.dryRun
    });
    if (!input.dryRun && (!result.resolved || result.value === undefined)) {
      throw new Error(`MCP secret env ${binding.name} was not resolved: ${result.reason}`);
    }
    resolved.push({
      name: binding.name,
      value: input.dryRun ? undefined : result.value,
      providerId: result.providerId,
      providerKind: result.providerKind,
      secretRefHash: result.secretRefHash,
      field: result.field,
      ...(binding.format === undefined ? {} : { format: binding.format }),
      evidence: [
        ...result.evidence,
        `mcp.secret_env:${binding.name}`,
        ...(binding.format === undefined ? [] : ["mcp.secret_env.format:applied"]),
        input.dryRun ? "mcp.secret_env:dry_run" : "mcp.secret_env:resolved"
      ]
    });
  }
  return resolved;
}

export function mergeVars(configValues: Record<string, string> | undefined, overrideValues: Record<string, string> | undefined): Record<string, string> | undefined {
  const merged = { ...(configValues ?? {}), ...(overrideValues ?? {}) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function mergeAdditionalServers(
  configValues: Record<string, CicloMcpAdditionalServerConfig> | undefined,
  overrideValues: Record<string, CicloMcpAdditionalServerConfig> | undefined
): Record<string, CicloMcpAdditionalServerConfig> | undefined {
  const merged = { ...(configValues ?? {}), ...(overrideValues ?? {}) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

export function mergeMcpInstallOptionsWithConfig(options: CicloMcpInstallOptions, config: CicloProjectConfig): CicloMcpInstallOptions {
  const mcp = config.mcp;
  return {
    ...options,
    clients: options.clients ?? mcp?.clients,
    serverName: options.serverName ?? mcp?.serverName,
    command: options.command ?? mcp?.command,
    env: mergeVars(mcp?.vars, options.env),
    secretEnv: options.secretEnv ?? configMcpSecretEnvBindings(config),
    additionalServers: mergeAdditionalServers(mcp?.additionalServers, options.additionalServers),
    claudeChannel: options.claudeChannel ?? mcp?.claudeChannel
  };
}

export function mergeWorkerLaunchWithConfig(input: WorkerSessionLaunchRequest, config: CicloProjectConfig): WorkerSessionLaunchRequest {
  const mcp = config.mcp;
  return {
    ...input,
    configureMcp: input.configureMcp ?? (mcp === undefined ? undefined : true),
    mcpClients: input.mcpClients ?? mcp?.clients,
    mcpServerName: input.mcpServerName ?? mcp?.serverName,
    mcpCommand: input.mcpCommand ?? mcp?.command,
    mcpEnv: mergeVars(mcp?.vars, input.mcpEnv),
    mcpAdditionalServers: mergeAdditionalServers(mcp?.additionalServers, input.mcpAdditionalServers),
    mcpSecretEnv: input.mcpSecretEnv ?? configMcpSecretEnvBindings(config),
    mcpClaudeChannel: input.mcpClaudeChannel ?? mcp?.claudeChannel
  };
}

export function mergeRemoteRunnerLaunchWithConfig(input: RemoteRunnerLaunchRequest, config: CicloProjectConfig): RemoteRunnerLaunchRequest {
  const remote = config.remote;
  const mcp = config.mcp;
  return {
    ...input,
    runnerKind: input.runnerKind || remote?.runnerKind || "",
    image: input.image || remote?.image || "",
    repoUrl: input.repoUrl ?? remote?.repoUrl,
    repoPath: input.repoPath || remote?.repoPath || "",
    herdrSession: input.herdrSession ?? remote?.herdrSession,
    sshUser: input.sshUser ?? remote?.sshUser,
    wireGuard: { ...(remote?.wireGuard ?? {}), ...(input.wireGuard ?? {}) },
    environment: mergeVars(remote?.vars, input.environment),
    configureMcp: input.configureMcp ?? (mcp === undefined ? undefined : true),
    mcpClients: input.mcpClients ?? mcp?.clients,
    mcpServerName: input.mcpServerName ?? mcp?.serverName,
    mcpCommand: input.mcpCommand ?? mcp?.command,
    mcpVars: mergeVars(mcp?.vars, input.mcpVars),
    mcpAdditionalServers: mergeAdditionalServers(mcp?.additionalServers, input.mcpAdditionalServers),
    mcpClaudeChannel: input.mcpClaudeChannel ?? mcp?.claudeChannel,
    kubernetes: { ...(remote?.kubernetes ?? {}), ...(input.kubernetes ?? {}) },
    awsLambda: { ...(remote?.awsLambda ?? {}), ...(input.awsLambda ?? {}) },
    cloudflare: { ...(remote?.cloudflare ?? {}), ...(input.cloudflare ?? {}) }
  };
}

export const sampleCicloProjectConfig: CicloProjectConfig = {
  secrets: {
    providers: [
      { id: "openbao", kind: "openbao", command: "bao", name: "OpenBao CLI" },
      { id: "onepassword", kind: "onepassword", command: "op", name: "1Password CLI" }
    ]
  },
  mcp: {
    clients: ["claude", "codex"],
    serverName: "ciclo",
    command: "ciclo",
    vars: { CICLO_REUSE_HERDR_SESSION: "true" },
    additionalServers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
        env: {}
      }
    },
    secretBindings: [{ name: "EXAMPLE_API_TOKEN", providerId: "onepassword", ref: "op://Ciclo/API/token", format: "Bearer ${secret}", reason: "example reference for spawned MCP tools" }],
    claudeChannel: false
  },
  remote: {
    runnerKind: "kubernetes",
    image: "ghcr.io/example/ciclo-runner:latest",
    repoPath: "/workspace/project",
    sshUser: "ciclo",
    wireGuard: {
      networkCidr: "10.44.0.0/24",
      cicloEndpoint: "ciclo-wireguard.example.invalid:51820",
      runnerPrivateKeySecretRef: "ciclo/wireguard/runner_private_key",
      cicloPublicKeySecretRef: "ciclo/wireguard/ciclo_public_key"
    },
    kubernetes: { namespace: "ciclo", serviceAccount: "ciclo-runner" }
  }
};

export function writeSampleCicloConfig(projectRoot = process.cwd(), dryRun = false): CicloProjectConfigLoadResult {
  const path = cicloConfigPath(projectRoot);
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, `${JSON.stringify(sampleCicloProjectConfig, null, 2)}\n`);
  }
  return {
    projectRoot: resolve(projectRoot),
    path,
    found: existsSync(path),
    config: sampleCicloProjectConfig,
    evidence: [dryRun ? "ciclo.config.init:dry_run" : "ciclo.config.init:exists_or_written", `ciclo.config.path:${path}`]
  };
}
