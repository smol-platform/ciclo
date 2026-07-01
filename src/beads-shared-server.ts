import { BeadsClient, BeadsError, type BeadsTaskSnapshot } from "./beads-adapter.js";
import type { BeadsRemoteHealth, SharedDoltServerConfig } from "./beads-remote.js";

export interface SharedServerHealth {
  readonly health: BeadsRemoteHealth;
  readonly databaseIdentity: string;
  readonly evidence: readonly string[];
}

export type SharedServerProbe = (
  config: SharedDoltServerConfig,
  timeoutMs: number
) => Promise<SharedServerHealth>;

export class SharedDoltServerError extends Error {
  constructor(
    message: string,
    readonly operation: "health" | "select" | "claim" | "update",
    readonly failClosed: boolean
  ) {
    super(message);
    this.name = "SharedDoltServerError";
  }
}

export const defaultSharedServerProbe: SharedServerProbe = async (config) => ({
  health: "unknown",
  databaseIdentity: `${config.host}:${config.port}/${config.database}`,
  evidence: ["beads.shared.health:unknown"]
});

function ensureHealthy(health: SharedServerHealth, failClosed: boolean): void {
  if (health.health === "unavailable" && failClosed) {
    throw new SharedDoltServerError(
      `shared Beads database unavailable: ${health.databaseIdentity}`,
      "health",
      true
    );
  }
}

function ensureReadyForClaim(snapshot: BeadsTaskSnapshot): void {
  if (snapshot.status !== "open") {
    throw new SharedDoltServerError(
      `cannot claim ${snapshot.id}; status is ${snapshot.status}`,
      "claim",
      true
    );
  }
}

export class SharedDoltServerCoordinator {
  constructor(
    readonly client: BeadsClient,
    readonly config: SharedDoltServerConfig,
    readonly probe: SharedServerProbe = defaultSharedServerProbe,
    readonly timeoutMs = 3000,
    readonly failClosed = true
  ) {}

  async health(): Promise<SharedServerHealth> {
    return this.probe(this.config, this.timeoutMs);
  }

  async ready(limit = 20): Promise<readonly BeadsTaskSnapshot[]> {
    const health = await this.health();
    ensureHealthy(health, this.failClosed);
    try {
      return await this.client.ready(limit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SharedDoltServerError(message, "select", this.failClosed);
    }
  }

  async claimAfterRecheck(id: string): Promise<{
    readonly before: BeadsTaskSnapshot;
    readonly after: BeadsTaskSnapshot;
    readonly health: SharedServerHealth;
    readonly evidence: readonly string[];
  }> {
    const health = await this.health();
    ensureHealthy(health, this.failClosed);
    try {
      const before = await this.client.show(id);
      ensureReadyForClaim(before);
      const after = await this.client.claim(id);
      return {
        before,
        after,
        health,
        evidence: [
          ...health.evidence,
          `beads.shared.rechecked:${id}`,
          `beads.shared.claimed:${after.id}`
        ]
      };
    } catch (error) {
      if (error instanceof SharedDoltServerError) throw error;
      const message = error instanceof BeadsError || error instanceof Error ? error.message : String(error);
      throw new SharedDoltServerError(message, "claim", this.failClosed);
    }
  }

  async recordProgress(id: string, message: string): Promise<void> {
    const health = await this.health();
    ensureHealthy(health, this.failClosed);
    if (message.trim().length === 0) {
      throw new SharedDoltServerError("progress message must be non-empty", "update", this.failClosed);
    }
    await this.client.note(id, message);
  }
}
