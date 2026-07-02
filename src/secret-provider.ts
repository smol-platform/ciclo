import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export type SecretProviderKind = "openbao" | "onepassword" | string;

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

export function createDefaultSecretProviderRegistry(): SecretProviderRegistry {
  return new SecretProviderRegistry([
    new OpenBaoCliSecretProvider(),
    new OnePasswordCliSecretProvider()
  ]);
}
