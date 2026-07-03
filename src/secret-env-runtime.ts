import type { SecretProviderRegistry } from "./secret-provider.js";

export interface RuntimeSecretEnvBinding {
  readonly name: string;
  readonly providerId: string;
  readonly secretRef: string;
  readonly field?: string;
  readonly format?: string;
  readonly reason?: string;
}

export function assertRuntimeSecretEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`secret env name must be a shell-safe environment variable name: ${name}`);
  }
}

export function assertRuntimeSecretFormat(name: string, format: string | undefined): void {
  if (format === undefined) return;
  const matches = format.match(/\$\{secret\}/gu) ?? [];
  if (matches.length !== 1) {
    throw new Error(`secret env ${name} format must contain exactly one \${secret} placeholder`);
  }
}

export function formatRuntimeSecretValue(name: string, value: string, format: string | undefined): string {
  assertRuntimeSecretFormat(name, format);
  return format === undefined ? value : format.replace("${secret}", value);
}

export function encodeRuntimeSecretEnvBindings(bindings: readonly RuntimeSecretEnvBinding[]): string {
  return Buffer.from(JSON.stringify(bindings), "utf8").toString("base64url");
}

export function decodeRuntimeSecretEnvBindings(encoded: string): readonly RuntimeSecretEnvBinding[] {
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("secret binding payload must be an array");
  return parsed.map((item, index): RuntimeSecretEnvBinding => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error(`secret binding ${index} must be an object`);
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
    const secretRef = typeof record.secretRef === "string" ? record.secretRef.trim() : "";
    assertRuntimeSecretEnvName(name);
    if (providerId.length === 0) throw new Error(`secret binding ${name} requires providerId`);
    if (secretRef.length === 0) throw new Error(`secret binding ${name} requires secretRef`);
    const field = typeof record.field === "string" && record.field.trim().length > 0 ? record.field.trim() : undefined;
    const format = typeof record.format === "string" && record.format.trim().length > 0 ? record.format : undefined;
    const reason = typeof record.reason === "string" && record.reason.trim().length > 0 ? record.reason : undefined;
    assertRuntimeSecretFormat(name, format);
    return {
      name,
      providerId,
      secretRef,
      ...(field === undefined ? {} : { field }),
      ...(format === undefined ? {} : { format }),
      ...(reason === undefined ? {} : { reason })
    };
  });
}

export async function resolveRuntimeSecretEnv(input: {
  readonly bindings: readonly RuntimeSecretEnvBinding[];
  readonly registry: SecretProviderRegistry;
  readonly dryRun?: boolean;
}): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const binding of input.bindings) {
    assertRuntimeSecretEnvName(binding.name);
    assertRuntimeSecretFormat(binding.name, binding.format);
    const result = await input.registry.resolve({
      providerId: binding.providerId,
      secretRef: binding.secretRef,
      field: binding.field,
      reason: binding.reason ?? `provide ${binding.name} to runtime process`,
      dryRun: input.dryRun ?? false
    });
    if (!result.resolved || result.value === undefined) {
      throw new Error(`secret env ${binding.name} was not resolved: ${result.reason}`);
    }
    env[binding.name] = formatRuntimeSecretValue(binding.name, result.value, binding.format);
  }
  return env;
}

export function secretExecArgs(bindings: readonly RuntimeSecretEnvBinding[], command: string, args: readonly string[]): readonly string[] {
  if (bindings.length === 0) return [command, ...args];
  return ["secret", "exec", "--binding", encodeRuntimeSecretEnvBindings(bindings), "--", command, ...args];
}
