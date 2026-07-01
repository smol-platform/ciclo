import type { AuthorizationResult } from "./access-enforcement.js";
import type { HarnessId, HerdrObservation } from "./ciclo-core.js";
import {
  classifyHerdrRemoteSetupBlocker,
  HerdrError,
  herdrRemoteAuditEvidence,
  type HerdrRemoteAttachConfig
} from "./herdr-adapter.js";

export type RemoteSessionState =
  | "connected"
  | "working"
  | "blocked"
  | "done"
  | "detached"
  | "stale"
  | "lost";

export const duplicateClaimBlockingStates: readonly RemoteSessionState[] = [
  "connected",
  "working",
  "blocked",
  "done",
  "stale"
];

export interface RepoIdentity {
  readonly root: string;
  readonly branch?: string;
  readonly gitRemote?: string;
}

export interface RemoteSessionRecord {
  readonly id: string;
  readonly transport: "herdr_remote_ssh";
  readonly herdrRemote: string;
  readonly herdrSession?: string;
  readonly herdrAgentTarget?: string;
  readonly projectPath: string;
  readonly repoIdentity: RepoIdentity;
  readonly ownerPrincipalId: string;
  readonly harnesses: readonly HarnessId[];
  readonly capabilities: readonly string[];
  readonly state: RemoteSessionState;
  readonly activeBeadId?: string;
  readonly activeLoopId?: string;
  readonly lastHeartbeatAt?: string;
  readonly lastAttachError?: string;
  readonly lastObservation?: HerdrObservation;
  readonly evidence: readonly string[];
}

export interface RegisterRemoteSessionInput {
  readonly id: string;
  readonly herdrRemote: string;
  readonly herdrSession?: string;
  readonly herdrAgentTarget?: string;
  readonly projectPath: string;
  readonly repoIdentity: RepoIdentity;
  readonly ownerPrincipalId: string;
  readonly harnesses: readonly HarnessId[];
  readonly capabilities?: readonly string[];
  readonly activeBeadId?: string;
  readonly activeLoopId?: string;
  readonly now: string;
  readonly authorization?: AuthorizationResult;
}

export interface RemoteHeartbeatClient {
  explainRemote(config: HerdrRemoteAttachConfig, target: string): Promise<HerdrObservation>;
}

export interface RemoteSessionMutationResult {
  readonly accepted: boolean;
  readonly session?: RemoteSessionRecord;
  readonly reason: string;
  readonly evidence: readonly string[];
}

function deniedByAuthorization(authorization: AuthorizationResult | undefined): RemoteSessionMutationResult | undefined {
  if (authorization === undefined || authorization.decision === "allow") return undefined;
  return {
    accepted: false,
    reason: authorization.reason,
    evidence: ["remote.session.access:denied", ...authorization.evidence]
  };
}

function stateFromObservation(observation: HerdrObservation): RemoteSessionState {
  switch (observation.state) {
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    case "idle":
    case "unknown":
      return "connected";
  }
}

function heartbeatTarget(session: RemoteSessionRecord): string {
  return session.herdrAgentTarget ?? session.id;
}

function remoteConfig(session: RemoteSessionRecord): HerdrRemoteAttachConfig {
  return {
    target: session.herdrRemote,
    session: session.herdrSession
  };
}

function withEvidence(session: RemoteSessionRecord, evidence: readonly string[]): RemoteSessionRecord {
  return {
    ...session,
    evidence: [...session.evidence, ...evidence]
  };
}

export class RemoteSessionRegistry {
  private readonly sessions = new Map<string, RemoteSessionRecord>();

  register(input: RegisterRemoteSessionInput): RemoteSessionMutationResult {
    const denied = deniedByAuthorization(input.authorization);
    if (denied !== undefined) return denied;
    if (input.herdrRemote.trim().length === 0 || input.projectPath.trim().length === 0) {
      return {
        accepted: false,
        reason: "remote session registration requires configured Herdr target and project path",
        evidence: ["remote.session.register:missing_config"]
      };
    }

    const session: RemoteSessionRecord = {
      id: input.id,
      transport: "herdr_remote_ssh",
      herdrRemote: input.herdrRemote,
      herdrSession: input.herdrSession,
      herdrAgentTarget: input.herdrAgentTarget,
      projectPath: input.projectPath,
      repoIdentity: input.repoIdentity,
      ownerPrincipalId: input.ownerPrincipalId,
      harnesses: input.harnesses,
      capabilities: input.capabilities ?? [],
      state: "connected",
      activeBeadId: input.activeBeadId,
      activeLoopId: input.activeLoopId,
      lastHeartbeatAt: input.now,
      evidence: [
        `remote.session.registered:${input.id}`,
        ...herdrRemoteAuditEvidence(
          { target: input.herdrRemote, session: input.herdrSession },
          ["agent", "explain", input.herdrAgentTarget ?? input.id, "--json"]
        )
      ]
    };
    this.sessions.set(input.id, session);
    return {
      accepted: true,
      session,
      reason: "remote session registered",
      evidence: session.evidence
    };
  }

  get(id: string): RemoteSessionRecord | undefined {
    return this.sessions.get(id);
  }

  list(): readonly RemoteSessionRecord[] {
    return [...this.sessions.values()];
  }

  activeOwnersForBead(beadId: string): readonly RemoteSessionRecord[] {
    return this.list().filter(
      (session) =>
        session.activeBeadId === beadId &&
        duplicateClaimBlockingStates.includes(session.state)
    );
  }

  assignWork(input: {
    readonly sessionId: string;
    readonly beadId: string;
    readonly loopId?: string;
  }): RemoteSessionMutationResult {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      return {
        accepted: false,
        reason: "remote session is not registered",
        evidence: [`remote.session.missing:${input.sessionId}`]
      };
    }
    const updated = withEvidence(
      {
        ...session,
        activeBeadId: input.beadId,
        activeLoopId: input.loopId ?? session.activeLoopId
      },
      [`remote.session.assigned:${input.sessionId}:${input.beadId}`]
    );
    this.sessions.set(input.sessionId, updated);
    return {
      accepted: true,
      session: updated,
      reason: "remote session work ownership recorded",
      evidence: updated.evidence
    };
  }

  async heartbeat(
    id: string,
    client: RemoteHeartbeatClient,
    now: string
  ): Promise<RemoteSessionMutationResult> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return {
        accepted: false,
        reason: "remote session is not registered",
        evidence: [`remote.session.missing:${id}`]
      };
    }

    try {
      const observation = await client.explainRemote(remoteConfig(session), heartbeatTarget(session));
      const updated = withEvidence(
        {
          ...session,
          state: stateFromObservation(observation),
          lastHeartbeatAt: now,
          lastAttachError: undefined,
          lastObservation: observation
        },
        [`remote.session.heartbeat:${id}`, `remote.session.state:${observation.state}`, ...observation.evidence]
      );
      this.sessions.set(id, updated);
      return {
        accepted: true,
        session: updated,
        reason: "remote session heartbeat accepted",
        evidence: updated.evidence
      };
    } catch (error) {
      const herdrError =
        error instanceof HerdrError
          ? error
          : new HerdrError(error instanceof Error ? error.message : String(error), "command_failed");
      const blocker = classifyHerdrRemoteSetupBlocker(herdrError);
      const updated = withEvidence(
        {
          ...session,
          state: "lost",
          lastHeartbeatAt: session.lastHeartbeatAt,
          lastAttachError: blocker.operatorMessage
        },
        [`remote.session.lost:${id}`, ...blocker.evidence]
      );
      this.sessions.set(id, updated);
      return {
        accepted: false,
        session: updated,
        reason: blocker.operatorMessage,
        evidence: updated.evidence
      };
    }
  }

  detach(id: string, reason: string, now: string): RemoteSessionMutationResult {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return {
        accepted: false,
        reason: "remote session is not registered",
        evidence: [`remote.session.missing:${id}`]
      };
    }
    const updated = withEvidence(
      {
        ...session,
        state: "detached",
        lastHeartbeatAt: now,
        lastAttachError: reason
      },
      [`remote.session.detached:${id}`]
    );
    this.sessions.set(id, updated);
    return {
      accepted: true,
      session: updated,
      reason: "remote session detached",
      evidence: updated.evidence
    };
  }

  markExpired(now: string, staleAfterMs: number, lostAfterMs: number): readonly RemoteSessionRecord[] {
    const nowMs = Date.parse(now);
    const updated: RemoteSessionRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.state === "detached" || session.state === "lost" || session.lastHeartbeatAt === undefined) {
        continue;
      }
      const ageMs = nowMs - Date.parse(session.lastHeartbeatAt);
      const nextState: RemoteSessionState | undefined =
        ageMs >= lostAfterMs ? "lost" : ageMs >= staleAfterMs ? "stale" : undefined;
      if (nextState === undefined || session.state === nextState) continue;
      const next = withEvidence(
        {
          ...session,
          state: nextState,
          lastAttachError: nextState === "lost" ? "remote session heartbeat timed out" : session.lastAttachError
        },
        [`remote.session.${nextState}:${session.id}`]
      );
      this.sessions.set(session.id, next);
      updated.push(next);
    }
    return updated;
  }
}
