export type BeadsRemoteMode = "local" | "shared_dolt_server" | "dolt_remote_sync";

export type BeadsRemoteHealth = "healthy" | "degraded" | "unavailable" | "unknown";

export interface SharedDoltServerConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user?: string;
}

export interface DoltRemoteSyncConfig {
  readonly remote: string;
  readonly pullBeforeSelect: boolean;
  readonly pushAfterClaim: boolean;
  readonly pushAfterUpdate: boolean;
  readonly failClosedOnSyncError: boolean;
}

export interface BeadsRemoteConfig {
  readonly enabled: boolean;
  readonly mode: BeadsRemoteMode;
  readonly requireRemoteForMultiAgent: boolean;
  readonly sharedDoltServer?: SharedDoltServerConfig;
  readonly doltRemoteSync?: DoltRemoteSyncConfig;
}

export interface BeadsRemoteModeState {
  readonly mode: BeadsRemoteMode;
  readonly databaseIdentity: string;
  readonly remoteName?: string;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly health: BeadsRemoteHealth;
  readonly centralizedCoordinationRequired: boolean;
  readonly evidence: readonly string[];
}

export function defaultLocalBeadsRemoteConfig(): BeadsRemoteConfig {
  return {
    enabled: true,
    mode: "local",
    requireRemoteForMultiAgent: false
  };
}

function stringValue(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(data: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = data[key];
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function beadsRemoteConfigFromObject(raw: Record<string, unknown>): BeadsRemoteConfig {
  const modeRaw = stringValue(raw, "mode") ?? "local";
  if (
    modeRaw !== "local" &&
    modeRaw !== "shared_dolt_server" &&
    modeRaw !== "dolt_remote_sync"
  ) {
    throw new Error(`unsupported Beads remote mode: ${modeRaw}`);
  }

  const shared = asRecord(raw.shared_dolt_server);
  const remote = asRecord(raw.dolt_remote_sync);
  return {
    enabled: booleanValue(raw, "enabled", true),
    mode: modeRaw,
    requireRemoteForMultiAgent: booleanValue(raw, "require_remote_for_multi_agent", false),
    sharedDoltServer:
      shared === undefined
        ? undefined
        : {
            host: stringValue(shared, "host") ?? "127.0.0.1",
            port: numberValue(shared, "port") ?? 3306,
            database: stringValue(shared, "database") ?? "beads",
            user: stringValue(shared, "user")
          },
    doltRemoteSync:
      remote === undefined
        ? undefined
        : {
            remote: stringValue(remote, "remote") ?? "origin",
            pullBeforeSelect: booleanValue(remote, "pull_before_select", true),
            pushAfterClaim: booleanValue(remote, "push_after_claim", true),
            pushAfterUpdate: booleanValue(remote, "push_after_update", true),
            failClosedOnSyncError: booleanValue(remote, "fail_closed_on_sync_error", true)
          }
  };
}

export function detectBeadsRemoteMode(config: BeadsRemoteConfig): BeadsRemoteModeState {
  if (!config.enabled || config.mode === "local") {
    return {
      mode: "local",
      databaseIdentity: "local-beads",
      health: "healthy",
      centralizedCoordinationRequired: config.requireRemoteForMultiAgent,
      evidence: [
        "beads.remote.mode:local",
        `beads.remote.required:${config.requireRemoteForMultiAgent}`
      ]
    };
  }

  if (config.mode === "shared_dolt_server") {
    const server = config.sharedDoltServer;
    const health: BeadsRemoteHealth = server === undefined ? "unavailable" : "unknown";
    return {
      mode: "shared_dolt_server",
      databaseIdentity:
        server === undefined ? "shared-dolt-server:unconfigured" : `${server.host}:${server.port}/${server.database}`,
      host: server?.host,
      port: server?.port,
      database: server?.database,
      health,
      centralizedCoordinationRequired: true,
      evidence: [
        "beads.remote.mode:shared_dolt_server",
        `beads.remote.health:${health}`,
        "beads.remote.required:true"
      ]
    };
  }

  const remote = config.doltRemoteSync;
  const health: BeadsRemoteHealth = remote === undefined ? "unavailable" : "unknown";
  return {
    mode: "dolt_remote_sync",
    databaseIdentity:
      remote === undefined ? "dolt-remote:unconfigured" : `dolt-remote:${remote.remote}`,
    remoteName: remote?.remote,
    health,
    centralizedCoordinationRequired: config.requireRemoteForMultiAgent || remote?.failClosedOnSyncError === true,
    evidence: [
      "beads.remote.mode:dolt_remote_sync",
      `beads.remote.health:${health}`,
      `beads.remote.required:${config.requireRemoteForMultiAgent || remote?.failClosedOnSyncError === true}`
    ]
  };
}
