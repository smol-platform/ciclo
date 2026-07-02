import type { CicloMcpAdditionalServerConfig } from "./mcp-install.js";
import type { SecretProviderResult } from "./secret-provider.js";

export interface McpSecretPlaceholderRequest {
  readonly providerId: string;
  readonly secretRef: string;
  readonly field?: string;
  readonly reason: string;
}

export interface CicloMcpAdditionalServerSecretEnvInstall {
  readonly serverName: string;
  readonly envName: string;
  readonly providerId: string;
  readonly providerKind: string;
  readonly secretRefHash: string;
  readonly field?: string;
  readonly evidence: readonly string[];
}

export interface ResolvedMcpAdditionalServerSecretPlaceholders {
  readonly additionalServers?: Record<string, CicloMcpAdditionalServerConfig>;
  readonly secretEnv: readonly CicloMcpAdditionalServerSecretEnvInstall[];
}

const secretPlaceholderPattern = /\$\{(secret:\/\/[^}]+)\}/gu;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`invalid percent-encoding in MCP secret placeholder: ${value}`);
  }
}

function parseQuery(query: string): URLSearchParams {
  return new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
}

function parseSecretPlaceholder(uri: string, serverName: string, envName: string): McpSecretPlaceholderRequest {
  const withoutScheme = uri.slice("secret://".length);
  const hashIndex = withoutScheme.indexOf("#");
  const beforeHash = hashIndex === -1 ? withoutScheme : withoutScheme.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : withoutScheme.slice(hashIndex + 1);
  const queryIndex = beforeHash.indexOf("?");
  const beforeQuery = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : beforeHash.slice(queryIndex + 1);
  const slashIndex = beforeQuery.indexOf("/");
  const providerId = decode(slashIndex === -1 ? beforeQuery : beforeQuery.slice(0, slashIndex)).trim();
  const pathRef = slashIndex === -1 ? "" : beforeQuery.slice(slashIndex + 1);
  const params = parseQuery(query);
  const secretRef = decode(params.get("ref") ?? pathRef).trim();
  const field = (params.get("field") ?? fragment).trim();
  if (providerId.length === 0) throw new Error(`MCP secret placeholder for ${serverName}.${envName} requires a provider id`);
  if (secretRef.length === 0) throw new Error(`MCP secret placeholder for ${serverName}.${envName} requires a secret ref`);
  return {
    providerId,
    secretRef,
    ...(field.length === 0 ? {} : { field: decode(field) }),
    reason: `provide ${serverName}.${envName} to configured MCP server`
  };
}

function placeholderUris(value: string): readonly string[] {
  return [...value.matchAll(secretPlaceholderPattern)].map((match) => match[1] ?? "");
}

export function hasMcpSecretPlaceholders(value: string): boolean {
  return placeholderUris(value).length > 0;
}

export async function resolveMcpAdditionalServerSecretPlaceholders(input: {
  readonly additionalServers?: Record<string, CicloMcpAdditionalServerConfig>;
  readonly dryRun: boolean;
  readonly loopId?: string;
  readonly beadId?: string;
  readonly workerSessionId?: string;
  readonly principalId?: string;
  readonly resolveSecret: (request: McpSecretPlaceholderRequest) => Promise<SecretProviderResult>;
}): Promise<ResolvedMcpAdditionalServerSecretPlaceholders> {
  const servers = input.additionalServers;
  if (servers === undefined) return { additionalServers: undefined, secretEnv: [] };

  const resolvedServers: Record<string, CicloMcpAdditionalServerConfig> = {};
  const secretEnv: CicloMcpAdditionalServerSecretEnvInstall[] = [];
  for (const [serverName, server] of Object.entries(servers)) {
    const env: Record<string, string> = {};
    for (const [envName, value] of Object.entries(server.env ?? {})) {
      let resolvedValue = value;
      for (const uri of placeholderUris(value)) {
        const request = parseSecretPlaceholder(uri, serverName, envName);
        const result = await input.resolveSecret(request);
        if (!input.dryRun && (!result.resolved || result.value === undefined)) {
          throw new Error(`MCP additional server secret ${serverName}.${envName} was not resolved: ${result.reason}`);
        }
        const replacement = input.dryRun ? "[ciclo secret unresolved]" : result.value ?? "";
        resolvedValue = resolvedValue.replace(`\${${uri}}`, replacement);
        secretEnv.push({
          serverName,
          envName,
          providerId: result.providerId,
          providerKind: result.providerKind,
          secretRefHash: result.secretRefHash,
          field: result.field,
          evidence: [
            ...result.evidence,
            `mcp.additional_server:${serverName}`,
            `mcp.additional_server.env:${envName}`,
            input.dryRun ? "mcp.additional_server.secret:dry_run" : "mcp.additional_server.secret:resolved"
          ]
        });
      }
      env[envName] = resolvedValue;
    }
    resolvedServers[serverName] = {
      command: server.command,
      args: [...(server.args ?? [])],
      env
    };
  }
  return {
    additionalServers: resolvedServers,
    secretEnv
  };
}
