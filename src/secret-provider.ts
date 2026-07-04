import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export type SecretProviderKind = "openbao" | "onepassword" | "onepassword-connect" | string;

export interface SecretProviderDescriptor {
  readonly id: string;
  readonly kind: SecretProviderKind;
  readonly name: string;
  readonly supportsFields: boolean;
  readonly evidence: readonly string[];
}

export interface SecretProviderRequest {
  readonly providerId: string;
  readonly secretRef: string;
  readonly field?: string;
  readonly loopId?: string;
  readonly beadId?: string;
  readonly workerSessionId?: string;
  readonly principalId?: string;
  readonly reason?: string;
  readonly dryRun?: boolean;
}

export interface SecretProviderResult {
  readonly resolved: boolean;
  readonly providerId: string;
  readonly providerKind: SecretProviderKind;
  readonly secretRefHash: string;
  readonly field?: string;
  readonly value?: string;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface SecretProviderPlugin {
  readonly id: string;
  readonly kind: SecretProviderKind;
  readonly name: string;
  readonly supportsFields?: boolean;
  resolve(input: SecretProviderRequest): SecretProviderResult | Promise<SecretProviderResult>;
}

export interface SecretCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type SecretCommandRunner = (
  command: string,
  args: readonly string[]
) => SecretCommandResult;

export interface SecretHttpResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}

export type SecretHttpFetcher = (
  url: string,
  init: {
    readonly method: "GET";
    readonly headers: Record<string, string>;
  }
) => Promise<SecretHttpResponse>;

export interface CicloSecretProviderPluginApi {
  readonly secretProviders: {
    register(plugin: SecretProviderPlugin): void;
  };
}

export function secretRefHash(secretRef: string): string {
  return createHash("sha256").update(secretRef).digest("hex").slice(0, 16);
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function defaultRunner(command: string, args: readonly string[]): SecretCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8"
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function baseEvidence(provider: SecretProviderPlugin, input: SecretProviderRequest): readonly string[] {
  return [
    `secret.provider:${provider.id}`,
    `secret.kind:${provider.kind}`,
    `secret.ref_hash:${secretRefHash(input.secretRef)}`,
    input.field === undefined ? "secret.field:default" : `secret.field:${input.field}`,
    input.loopId === undefined ? "secret.loop:none" : `secret.loop:${input.loopId}`,
    input.beadId === undefined ? "secret.bead:none" : `secret.bead:${input.beadId}`,
    input.workerSessionId === undefined ? "secret.worker:none" : `secret.worker:${input.workerSessionId}`
  ];
}

function successResult(
  provider: SecretProviderPlugin,
  input: SecretProviderRequest,
  value: string,
  evidence: readonly string[]
): SecretProviderResult {
  return {
    resolved: true,
    providerId: provider.id,
    providerKind: provider.kind,
    secretRefHash: secretRefHash(input.secretRef),
    field: input.field,
    value,
    reason: "secret was resolved by provider",
    evidence: [...evidence, "secret.resolved:true"]
  };
}

function unresolvedResult(
  provider: SecretProviderPlugin,
  input: SecretProviderRequest,
  reason: string,
  evidence: readonly string[]
): SecretProviderResult {
  return {
    resolved: false,
    providerId: provider.id,
    providerKind: provider.kind,
    secretRefHash: secretRefHash(input.secretRef),
    field: input.field,
    reason,
    evidence: [...evidence, "secret.resolved:false"]
  };
}

function trimSecretOutput(output: string): string {
  return output.replace(/\r?\n$/u, "");
}

async function defaultHttpFetcher(url: string, init: { readonly method: "GET"; readonly headers: Record<string, string> }): Promise<SecretHttpResponse> {
  return await fetch(url, init);
}

export class SecretProviderRegistry {
  private readonly providers = new Map<string, SecretProviderPlugin>();

  constructor(providers: readonly SecretProviderPlugin[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: SecretProviderPlugin): void {
    if (clean(provider.id) === undefined) throw new Error("secret provider id is required");
    if (clean(provider.kind) === undefined) throw new Error("secret provider kind is required");
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): SecretProviderPlugin | undefined {
    return this.providers.get(providerId);
  }

  require(providerId: string): SecretProviderPlugin {
    const provider = this.get(providerId);
    if (provider === undefined) throw new Error(`secret provider is not registered: ${providerId}`);
    return provider;
  }

  list(): readonly SecretProviderDescriptor[] {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      supportsFields: provider.supportsFields ?? true,
      evidence: [`secret.provider:${provider.id}`, `secret.kind:${provider.kind}`]
    }));
  }

  async resolve(input: SecretProviderRequest): Promise<SecretProviderResult> {
    return await this.require(input.providerId).resolve(input);
  }
}

export function createSecretProviderPluginApi(registry: SecretProviderRegistry): CicloSecretProviderPluginApi {
  return {
    secretProviders: {
      register(plugin) {
        registry.register(plugin);
      }
    }
  };
}

export class OpenBaoCliSecretProvider implements SecretProviderPlugin {
  readonly id: string;
  readonly kind = "openbao";
  readonly name: string;
  readonly supportsFields = true;

  constructor(
    input: {
      readonly id?: string;
      readonly name?: string;
      readonly command?: string;
      readonly runner?: SecretCommandRunner;
    } = {}
  ) {
    this.id = input.id ?? "openbao";
    this.name = input.name ?? "OpenBao CLI";
    this.command = input.command ?? "bao";
    this.runner = input.runner ?? defaultRunner;
  }

  private readonly command: string;
  private readonly runner: SecretCommandRunner;

  resolve(input: SecretProviderRequest): SecretProviderResult {
    const evidence = baseEvidence(this, input);
    if (input.dryRun === true) {
      return unresolvedResult(this, input, "dry run: secret provider was not invoked", [
        ...evidence,
        "secret.provider.invoke:dry_run"
      ]);
    }
    if (clean(input.field) === undefined) {
      return unresolvedResult(this, input, "OpenBao provider requires an explicit field", [
        ...evidence,
        "secret.provider.openbao.field:missing"
      ]);
    }
    const result = this.runner(this.command, ["kv", "get", `-field=${input.field}`, input.secretRef]);
    if (result.status !== 0) {
      return unresolvedResult(this, input, "OpenBao CLI command failed", [
        ...evidence,
        `secret.provider.exit_status:${result.status ?? "signal"}`
      ]);
    }
    return successResult(this, input, trimSecretOutput(result.stdout), [
      ...evidence,
      "secret.provider.openbao.command:kv_get_field"
    ]);
  }
}

export class OnePasswordCliSecretProvider implements SecretProviderPlugin {
  readonly id: string;
  readonly kind = "onepassword";
  readonly name: string;
  readonly supportsFields = false;

  constructor(
    input: {
      readonly id?: string;
      readonly name?: string;
      readonly command?: string;
      readonly runner?: SecretCommandRunner;
    } = {}
  ) {
    this.id = input.id ?? "onepassword";
    this.name = input.name ?? "1Password CLI";
    this.command = input.command ?? "op";
    this.runner = input.runner ?? defaultRunner;
  }

  private readonly command: string;
  private readonly runner: SecretCommandRunner;

  resolve(input: SecretProviderRequest): SecretProviderResult {
    const evidence = baseEvidence(this, input);
    if (input.dryRun === true) {
      return unresolvedResult(this, input, "dry run: secret provider was not invoked", [
        ...evidence,
        "secret.provider.invoke:dry_run"
      ]);
    }
    const result = this.runner(this.command, ["read", input.secretRef]);
    if (result.status !== 0) {
      return unresolvedResult(this, input, "1Password CLI command failed", [
        ...evidence,
        `secret.provider.exit_status:${result.status ?? "signal"}`
      ]);
    }
    return successResult(this, input, trimSecretOutput(result.stdout), [
      ...evidence,
      "secret.provider.onepassword.command:read"
    ]);
  }
}

interface OnePasswordConnectSecretRef {
  readonly vault: string;
  readonly item: string;
  readonly field?: string;
}

function parseOnePasswordConnectSecretRef(secretRef: string, defaultVault?: string): OnePasswordConnectSecretRef | undefined {
  const cleaned = clean(secretRef);
  if (cleaned === undefined) return undefined;
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol === "op-connect:" || parsed.protocol === "onepassword-connect:") {
      const parts = [parsed.hostname, ...parsed.pathname.split("/")]
        .map((part) => decodeURIComponent(part).trim())
        .filter((part) => part.length > 0);
      const queryField = clean(parsed.searchParams.get("field") ?? undefined);
      if (parts.length < 2) return undefined;
      const field = queryField ?? parts[2];
      return {
        vault: parts[0]!,
        item: parts[1]!,
        ...(field === undefined ? {} : { field })
      };
    }
  } catch {
    // Fall through to slash-delimited refs.
  }
  const parts = cleaned.split("/").map((part) => part.trim()).filter((part) => part.length > 0);
  const vault = clean(defaultVault);
  if (vault !== undefined && parts.length === 2) {
    return { vault, item: parts[0]!, field: parts[1] };
  }
  if (parts.length >= 2) {
    return {
      vault: parts[0]!,
      item: parts[1]!,
      ...(parts[2] === undefined ? {} : { field: parts[2] })
    };
  }
  if (vault !== undefined && parts.length === 1) {
    return { vault, item: parts[0]! };
  }
  return undefined;
}

function fieldValueFromConnectItem(itemText: string, fieldName: string): string | undefined {
  const parsed = JSON.parse(itemText) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const fields = (parsed as { readonly fields?: unknown }).fields;
  if (!Array.isArray(fields)) return undefined;
  for (const field of fields) {
    if (field === null || typeof field !== "object" || Array.isArray(field)) continue;
    const record = field as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    const label = typeof record.label === "string" ? record.label : undefined;
    const purpose = typeof record.purpose === "string" ? record.purpose : undefined;
    if (id !== fieldName && label !== fieldName && purpose !== fieldName) continue;
    return typeof record.value === "string" ? record.value : undefined;
  }
  return undefined;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

export class OnePasswordConnectSecretProvider implements SecretProviderPlugin {
  readonly id: string;
  readonly kind = "onepassword-connect";
  readonly name: string;
  readonly supportsFields = true;

  constructor(
    input: {
      readonly id?: string;
      readonly name?: string;
      readonly endpoint?: string;
      readonly endpointEnv?: string;
      readonly tokenEnv?: string;
      readonly defaultVaultId?: string;
      readonly fetcher?: SecretHttpFetcher;
    } = {}
  ) {
    this.id = input.id ?? "onepassword-connect";
    this.name = input.name ?? "1Password Connect Server";
    this.endpoint = clean(input.endpoint);
    this.endpointEnv = input.endpointEnv ?? "OP_CONNECT_HOST";
    this.tokenEnv = input.tokenEnv ?? "OP_CONNECT_TOKEN";
    this.defaultVaultId = clean(input.defaultVaultId);
    this.fetcher = input.fetcher ?? defaultHttpFetcher;
  }

  private readonly endpoint: string | undefined;
  private readonly endpointEnv: string;
  private readonly tokenEnv: string;
  private readonly defaultVaultId: string | undefined;
  private readonly fetcher: SecretHttpFetcher;

  async resolve(input: SecretProviderRequest): Promise<SecretProviderResult> {
    const evidence = baseEvidence(this, input);
    const parsedRef = parseOnePasswordConnectSecretRef(input.secretRef, this.defaultVaultId);
    const field = clean(input.field) ?? parsedRef?.field;
    if (input.dryRun === true) {
      return unresolvedResult(this, input, "dry run: secret provider was not invoked", [
        ...evidence,
        "secret.provider.invoke:dry_run",
        "secret.provider.onepassword_connect:configured"
      ]);
    }
    if (parsedRef === undefined) {
      return unresolvedResult(this, input, "1Password Connect secret ref must identify vault and item", [
        ...evidence,
        "secret.provider.onepassword_connect.ref:invalid"
      ]);
    }
    if (field === undefined) {
      return unresolvedResult(this, input, "1Password Connect provider requires an explicit field", [
        ...evidence,
        "secret.provider.onepassword_connect.field:missing"
      ]);
    }
    const endpoint = this.endpoint ?? clean(process.env[this.endpointEnv]);
    if (endpoint === undefined) {
      return unresolvedResult(this, input, `1Password Connect endpoint is not configured; set ${this.endpointEnv} or provider endpoint`, [
        ...evidence,
        "secret.provider.onepassword_connect.endpoint:missing"
      ]);
    }
    const token = clean(process.env[this.tokenEnv]);
    if (token === undefined) {
      return unresolvedResult(this, input, `1Password Connect token is not configured; set ${this.tokenEnv}`, [
        ...evidence,
        "secret.provider.onepassword_connect.token:missing"
      ]);
    }
    const url = joinUrl(endpoint, `/v1/vaults/${encodeURIComponent(parsedRef.vault)}/items/${encodeURIComponent(parsedRef.item)}`);
    let response: SecretHttpResponse;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      });
    } catch {
      return unresolvedResult(this, input, "1Password Connect request failed", [
        ...evidence,
        "secret.provider.onepassword_connect.request:error"
      ]);
    }
    const body = await response.text();
    if (!response.ok) {
      return unresolvedResult(this, input, "1Password Connect request failed", [
        ...evidence,
        `secret.provider.http_status:${response.status}`
      ]);
    }
    let value: string | undefined;
    try {
      value = fieldValueFromConnectItem(body, field);
    } catch {
      return unresolvedResult(this, input, "1Password Connect response was not valid item JSON", [
        ...evidence,
        "secret.provider.onepassword_connect.response:invalid_json"
      ]);
    }
    if (value === undefined) {
      return unresolvedResult(this, input, "1Password Connect item field was not found or has no string value", [
        ...evidence,
        "secret.provider.onepassword_connect.field:not_found"
      ]);
    }
    return successResult(this, { ...input, field }, value, [
      ...evidence,
      "secret.provider.onepassword_connect.request:get_item",
      `secret.provider.onepassword_connect.vault_hash:${secretRefHash(parsedRef.vault)}`,
      `secret.provider.onepassword_connect.item_hash:${secretRefHash(parsedRef.item)}`
    ]);
  }
}

export function createDefaultSecretProviderRegistry(): SecretProviderRegistry {
  return new SecretProviderRegistry([
    new OpenBaoCliSecretProvider(),
    new OnePasswordCliSecretProvider(),
    new OnePasswordConnectSecretProvider()
  ]);
}
