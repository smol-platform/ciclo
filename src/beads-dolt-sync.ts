import { BeadsClient, BeadsError, type BeadsTaskSnapshot } from "./beads-adapter.js";
import type { DoltRemoteSyncConfig } from "./beads-remote.js";

export class BeadsDoltSyncError extends Error {
  constructor(
    message: string,
    readonly operation: "pull" | "push" | "claim" | "select",
    readonly failClosed: boolean
  ) {
    super(message);
    this.name = "BeadsDoltSyncError";
  }
}

export interface ClaimResult {
  readonly before: BeadsTaskSnapshot;
  readonly after: BeadsTaskSnapshot;
  readonly pushed: boolean;
  readonly evidence: readonly string[];
}

function wrapSyncError(
  error: unknown,
  operation: "pull" | "push" | "claim" | "select",
  config: DoltRemoteSyncConfig
): BeadsDoltSyncError {
  const message = error instanceof Error ? error.message : String(error);
  return new BeadsDoltSyncError(message, operation, config.failClosedOnSyncError);
}

function ensureReadyForClaim(snapshot: BeadsTaskSnapshot): void {
  if (snapshot.status !== "open") {
    throw new BeadsDoltSyncError(
      `cannot claim ${snapshot.id}; status is ${snapshot.status}`,
      "claim",
      true
    );
  }
}

export class DoltRemoteSyncCoordinator {
  constructor(
    readonly client: BeadsClient,
    readonly config: DoltRemoteSyncConfig
  ) {}

  async pullBeforeSelect(): Promise<void> {
    if (!this.config.pullBeforeSelect) return;
    try {
      await this.client.doltPull(this.config.remote);
    } catch (error) {
      throw wrapSyncError(error, "pull", this.config);
    }
  }

  async ready(limit = 20): Promise<readonly BeadsTaskSnapshot[]> {
    await this.pullBeforeSelect();
    try {
      return await this.client.ready(limit);
    } catch (error) {
      throw wrapSyncError(error, "select", this.config);
    }
  }

  async claimAfterRecheck(id: string): Promise<ClaimResult> {
    let before: BeadsTaskSnapshot;
    try {
      before = await this.client.show(id);
      ensureReadyForClaim(before);
      const after = await this.client.claim(id);
      let pushed = false;
      if (this.config.pushAfterClaim) {
        await this.client.doltPush(this.config.remote);
        pushed = true;
      }
      return {
        before,
        after,
        pushed,
        evidence: [
          `beads.rechecked:${id}`,
          `beads.claimed:${after.id}`,
          `beads.pushed_after_claim:${pushed}`
        ]
      };
    } catch (error) {
      if (error instanceof BeadsDoltSyncError) throw error;
      if (error instanceof BeadsError || error instanceof Error) {
        throw wrapSyncError(error, "claim", this.config);
      }
      throw error;
    }
  }

  async pushAfterUpdate(): Promise<boolean> {
    if (!this.config.pushAfterUpdate) return false;
    try {
      await this.client.doltPush(this.config.remote);
      return true;
    } catch (error) {
      throw wrapSyncError(error, "push", this.config);
    }
  }
}
