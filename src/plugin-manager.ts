import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  createRemoteRunnerPluginApi,
  type CicloRemoteRunnerPluginApi,
  type RemoteRunnerImageResolverRegistry,
  type RemoteRunnerPluginRegistry
} from "./remote-runner.js";
import {
  createSecretProviderPluginApi,
  SecretProviderRegistry,
  type CicloSecretProviderPluginApi
} from "./secret-provider.js";

export const CICLO_PLUGIN_SCHEMA = "ciclo.plugin.v1";
export const CICLO_PLUGIN_API_VERSION = "0.1";

export interface CicloPluginManifest {
  readonly schema: typeof CICLO_PLUGIN_SCHEMA;
  readonly name: string;
  readonly displayName?: string;
  readonly version: string;
  readonly cicloApi?: string;
  readonly entrypoint: string;
  readonly capabilities: readonly string[];
  readonly runnerKinds: readonly string[];
  readonly imageResolverStrategies: readonly string[];
  readonly secretProviderKinds: readonly string[];
  readonly permissions?: {
    readonly commands?: readonly string[];
    readonly network?: boolean;
    readonly secrets?: readonly string[];
  };
}

export interface CicloPluginConfigEntry {
  readonly package: string;
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly path?: string;
  readonly installedAt?: string;
  readonly manifest?: CicloPluginManifest;
}

export interface CicloPluginConfig {
  readonly schema: "ciclo.plugins.v1";
  readonly plugins: readonly CicloPluginConfigEntry[];
}

export interface CicloPluginPaths {
  readonly root: string;
  readonly configPath: string;
  readonly pluginDir: string;
}

export interface CicloPluginInstallInput {
  readonly packageName: string;
  readonly path?: string;
  readonly trust?: boolean;
  readonly enable?: boolean;
  readonly now?: string;
}

export interface CicloPluginInstallResult {
  readonly installed: boolean;
  readonly entry: CicloPluginConfigEntry;
  readonly manifest: CicloPluginManifest;
  readonly evidence: readonly string[];
}

export interface CicloPluginActivationResult {
  readonly activated: readonly string[];
  readonly skipped: readonly string[];
  readonly failures: readonly string[];
  readonly evidence: readonly string[];
}

export interface CicloPluginApi {
  readonly remoteRunners: CicloRemoteRunnerPluginApi["remoteRunners"];
  readonly imageResolvers: CicloRemoteRunnerPluginApi["imageResolvers"];
  readonly secretProviders: CicloSecretProviderPluginApi["secretProviders"];
}

type PluginModule = {
  readonly activate?: (api: CicloPluginApi) => void | Promise<void>;
  readonly default?: { readonly activate?: (api: CicloPluginApi) => void | Promise<void> };
};

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalStringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${path} must be a list of non-empty strings`);
  }
  return value as readonly string[];
}

function unsupportedCapabilities(capabilities: readonly string[]): readonly string[] {
  const supported = new Set(["remote-runner", "image-resolver", "secret-provider"]);
  return capabilities.filter((capability) => !supported.has(capability));
}

function optionalStringList(record: Record<string, unknown>, key: string, path: string): readonly string[] | undefined {
  const value = record[key];
  return value === undefined ? undefined : stringList(value, path);
}

export function defaultPluginPaths(root = process.cwd()): CicloPluginPaths {
  const base = resolve(root, ".ciclo", "plugins");
  return {
    root: resolve(root),
    configPath: resolve(root, ".ciclo", "plugins.json"),
    pluginDir: base
  };
}

export function parsePluginManifest(raw: unknown): CicloPluginManifest {
  const record = asRecord(raw, "plugin manifest");
  if (record.schema !== CICLO_PLUGIN_SCHEMA) {
    throw new Error(`plugin manifest schema must be ${CICLO_PLUGIN_SCHEMA}`);
  }
  const permissionsRecord = record.permissions === undefined
    ? undefined
    : asRecord(record.permissions, "plugin manifest.permissions");
  const manifest: CicloPluginManifest = {
    schema: CICLO_PLUGIN_SCHEMA,
    name: stringValue(record, "name", "plugin manifest"),
    displayName: optionalStringValue(record, "displayName"),
    version: stringValue(record, "version", "plugin manifest"),
    cicloApi: optionalStringValue(record, "cicloApi"),
    entrypoint: stringValue(record, "entrypoint", "plugin manifest"),
    capabilities: stringList(record.capabilities, "plugin manifest.capabilities"),
    runnerKinds: optionalStringList(record, "runnerKinds", "plugin manifest.runnerKinds") ?? [],
    imageResolverStrategies: optionalStringList(record, "imageResolverStrategies", "plugin manifest.imageResolverStrategies") ?? [],
    secretProviderKinds: optionalStringList(record, "secretProviderKinds", "plugin manifest.secretProviderKinds") ?? [],
    permissions: permissionsRecord === undefined
      ? undefined
      : {
          commands: optionalStringList(permissionsRecord, "commands", "plugin manifest.permissions.commands"),
          network: typeof permissionsRecord.network === "boolean" ? permissionsRecord.network : undefined,
          secrets: optionalStringList(permissionsRecord, "secrets", "plugin manifest.permissions.secrets")
        }
  };
  const unsupported = unsupportedCapabilities(manifest.capabilities);
  if (unsupported.length > 0) {
    throw new Error(`plugin manifest includes unsupported capabilities: ${unsupported.join(", ")}`);
  }
  if (!manifest.capabilities.includes("remote-runner") && !manifest.capabilities.includes("image-resolver") && !manifest.capabilities.includes("secret-provider")) {
    throw new Error("plugin manifest must include remote-runner, image-resolver, or secret-provider capability");
  }
  if (manifest.capabilities.includes("remote-runner") && manifest.runnerKinds.length === 0) {
    throw new Error("plugin manifest remote-runner capability requires runnerKinds");
  }
  if (manifest.capabilities.includes("secret-provider") && manifest.secretProviderKinds.length === 0) {
    throw new Error("plugin manifest secret-provider capability requires secretProviderKinds");
  }
  if (manifest.capabilities.includes("image-resolver") && manifest.imageResolverStrategies.length === 0) {
    throw new Error("plugin manifest image-resolver capability requires imageResolverStrategies");
  }
  if (manifest.entrypoint.startsWith("/") || manifest.entrypoint.includes("..")) {
    throw new Error("plugin manifest entrypoint must be a package-relative path");
  }
  return manifest;
}

export function readPluginManifest(pluginPath: string): CicloPluginManifest {
  const manifestPath = resolve(pluginPath, "ciclo.plugin.json");
  return parsePluginManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
}

function emptyConfig(): CicloPluginConfig {
  return { schema: "ciclo.plugins.v1", plugins: [] };
}

export function readPluginConfig(paths: CicloPluginPaths = defaultPluginPaths()): CicloPluginConfig {
  if (!existsSync(paths.configPath)) return emptyConfig();
  const raw = JSON.parse(readFileSync(paths.configPath, "utf8")) as unknown;
  const record = asRecord(raw, "plugin config");
  if (record.schema !== "ciclo.plugins.v1") {
    throw new Error("plugin config schema must be ciclo.plugins.v1");
  }
  const plugins = Array.isArray(record.plugins) ? record.plugins : [];
  return {
    schema: "ciclo.plugins.v1",
    plugins: plugins.map((item, index) => {
      const plugin = asRecord(item, `plugin config.plugins[${index}]`);
      return {
        package: stringValue(plugin, "package", `plugin config.plugins[${index}]`),
        enabled: plugin.enabled === true,
        trusted: plugin.trusted === true,
        path: optionalStringValue(plugin, "path"),
        installedAt: optionalStringValue(plugin, "installedAt"),
        manifest: plugin.manifest === undefined ? undefined : parsePluginManifest(plugin.manifest)
      };
    })
  };
}

export function writePluginConfig(
  config: CicloPluginConfig,
  paths: CicloPluginPaths = defaultPluginPaths()
): void {
  mkdirSync(dirname(paths.configPath), { recursive: true });
  writeFileSync(`${paths.configPath}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(`${paths.configPath}.tmp`, paths.configPath);
}

function packageInstallPath(packageName: string, paths: CicloPluginPaths): string {
  return resolve(paths.pluginDir, "node_modules", ...packageName.split("/"));
}

function installPackage(packageName: string, paths: CicloPluginPaths): string {
  mkdirSync(paths.pluginDir, { recursive: true });
  const result = spawnSync("npm", ["install", "--ignore-scripts", "--prefix", paths.pluginDir, packageName], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `npm install failed for ${packageName}`);
  }
  return packageInstallPath(packageName, paths);
}

function upsertPlugin(config: CicloPluginConfig, entry: CicloPluginConfigEntry): CicloPluginConfig {
  const plugins = config.plugins.filter((plugin) => plugin.package !== entry.package);
  return { schema: "ciclo.plugins.v1", plugins: [...plugins, entry].sort((left, right) => left.package.localeCompare(right.package)) };
}

export function installPlugin(
  input: CicloPluginInstallInput,
  paths: CicloPluginPaths = defaultPluginPaths()
): CicloPluginInstallResult {
  const packageName = clean(input.packageName);
  if (packageName === undefined) throw new Error("plugin package name is required");
  const pluginPath = input.path === undefined ? installPackage(packageName, paths) : resolve(paths.root, input.path);
  const manifest = readPluginManifest(pluginPath);
  if (manifest.name !== packageName) {
    throw new Error(`plugin manifest name ${manifest.name} does not match install package ${packageName}`);
  }
  const entry: CicloPluginConfigEntry = {
    package: packageName,
    enabled: input.enable ?? true,
    trusted: input.trust === true,
    path: pluginPath,
    installedAt: input.now ?? new Date().toISOString(),
    manifest
  };
  writePluginConfig(upsertPlugin(readPluginConfig(paths), entry), paths);
  return {
    installed: true,
    entry,
    manifest,
    evidence: [
      `plugin.installed:${packageName}`,
      `plugin.enabled:${entry.enabled}`,
      `plugin.trusted:${entry.trusted}`,
      ...manifest.runnerKinds.map((kind) => `plugin.runner_kind:${kind}`),
      ...manifest.imageResolverStrategies.map((strategy) => `plugin.image_resolver_strategy:${strategy}`),
      ...manifest.secretProviderKinds.map((kind) => `plugin.secret_provider_kind:${kind}`)
    ]
  };
}

export function setPluginEnabled(
  packageName: string,
  enabled: boolean,
  paths: CicloPluginPaths = defaultPluginPaths()
): CicloPluginConfigEntry {
  const config = readPluginConfig(paths);
  const entry = config.plugins.find((plugin) => plugin.package === packageName);
  if (entry === undefined) throw new Error(`plugin is not installed: ${packageName}`);
  const updated = { ...entry, enabled };
  writePluginConfig(upsertPlugin(config, updated), paths);
  return updated;
}

async function activateEntry(
  entry: CicloPluginConfigEntry,
  registry: RemoteRunnerPluginRegistry,
  imageResolverRegistry?: RemoteRunnerImageResolverRegistry,
  secretProviderRegistry?: SecretProviderRegistry
): Promise<void> {
  if (!entry.trusted) throw new Error(`plugin is not trusted: ${entry.package}`);
  const pluginPath = entry.path;
  if (pluginPath === undefined) throw new Error(`plugin path is missing: ${entry.package}`);
  const manifest = entry.manifest ?? readPluginManifest(pluginPath);
  const modulePath = resolve(pluginPath, manifest.entrypoint);
  const module = await import(pathToFileURL(modulePath).href) as PluginModule;
  const activate = module.activate ?? module.default?.activate;
  if (activate === undefined) throw new Error(`plugin does not export activate(api): ${entry.package}`);
  const remoteApi = createRemoteRunnerPluginApi(registry, imageResolverRegistry);
  const secretApi = createSecretProviderPluginApi(secretProviderRegistry ?? new SecretProviderRegistry());
  await activate({
    remoteRunners: remoteApi.remoteRunners,
    imageResolvers: remoteApi.imageResolvers,
    secretProviders: secretApi.secretProviders
  });
}

export async function activateConfiguredPlugins(
  registry: RemoteRunnerPluginRegistry,
  paths: CicloPluginPaths = defaultPluginPaths(),
  secretProviderRegistry?: SecretProviderRegistry,
  imageResolverRegistry?: RemoteRunnerImageResolverRegistry
): Promise<CicloPluginActivationResult> {
  const config = readPluginConfig(paths);
  const activated: string[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];
  const evidence: string[] = [];
  for (const entry of config.plugins) {
    if (!entry.enabled) {
      skipped.push(entry.package);
      evidence.push(`plugin.skipped.disabled:${entry.package}`);
      continue;
    }
    try {
      await activateEntry(entry, registry, imageResolverRegistry, secretProviderRegistry);
      activated.push(entry.package);
      evidence.push(`plugin.activated:${entry.package}`);
    } catch (error) {
      failures.push(`${entry.package}:${error instanceof Error ? error.message : String(error)}`);
      evidence.push(`plugin.failed:${entry.package}`);
    }
  }
  return { activated, skipped, failures, evidence };
}
