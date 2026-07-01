import { createHash, randomBytes } from "node:crypto";

import type { DeviceTokenSet } from "./auth-device-flow.js";
import type { PrincipalId } from "./session-access.js";

export type TokenLifecycleOutcome =
  | "active"
  | "expired"
  | "revoked"
  | "not_found"
  | "refreshed";

export interface TokenTargetConstraints {
  readonly remoteTarget?: string;
}

export interface TokenRecordMetadata {
  readonly tokenId: string;
  readonly principalId: PrincipalId;
  readonly sessionId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly refreshExpiresAt: string;
  readonly targetConstraints?: TokenTargetConstraints;
  readonly revokedAt?: string;
}

export interface TokenIntrospection {
  readonly active: boolean;
  readonly outcome: TokenLifecycleOutcome;
  readonly principalId?: PrincipalId;
  readonly sessionId?: string;
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly expiresAt?: string;
  readonly targetConstraints?: TokenTargetConstraints;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface PrincipalIntrospection {
  readonly principalId: PrincipalId;
  readonly sessionId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly evidence: readonly string[];
}

export interface TokenRefreshResult {
  readonly outcome: TokenLifecycleOutcome;
  readonly token?: DeviceTokenSet;
  readonly metadata?: TokenRecordMetadata;
  readonly reason: string;
  readonly evidence: readonly string[];
}

interface StoredTokenRecord {
  readonly metadata: TokenRecordMetadata;
  readonly accessTokenHash: string;
  readonly refreshTokenHash: string;
}

export interface TokenRegistryOptions {
  readonly nowMs?: () => number;
  readonly tokenBytes?: () => Buffer;
  readonly accessTokenTtlSeconds?: number;
  readonly refreshTokenTtlSeconds?: number;
}

function defaultTokenBytes(): Buffer {
  return randomBytes(32);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenIdFromHash(hash: string): string {
  return hash.slice(0, 16);
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function sanitizeScopes(scopes: readonly string[]): readonly string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0))];
}

export class TokenRegistry {
  private readonly records = new Map<string, StoredTokenRecord>();
  private readonly nowMs: () => number;
  private readonly tokenBytes: () => Buffer;
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlSeconds: number;

  constructor(options: TokenRegistryOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.tokenBytes = options.tokenBytes ?? defaultTokenBytes;
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 3600;
    this.refreshTokenTtlSeconds = options.refreshTokenTtlSeconds ?? 30 * 24 * 3600;
  }

  store(token: DeviceTokenSet): TokenRecordMetadata {
    const accessTokenHash = tokenHash(token.accessToken);
    const refreshTokenHash = tokenHash(token.refreshToken);
    const tokenId = tokenIdFromHash(accessTokenHash);
    const metadata: TokenRecordMetadata = {
      tokenId,
      principalId: token.principalId,
      sessionId: token.sessionId,
      clientId: token.clientId,
      scopes: sanitizeScopes(token.scopes),
      expiresAt: token.expiresAt,
      refreshExpiresAt: iso(this.nowMs() + this.refreshTokenTtlSeconds * 1000),
      targetConstraints: token.targetConstraints
    };
    this.records.set(tokenId, {
      metadata,
      accessTokenHash,
      refreshTokenHash
    });
    return metadata;
  }

  introspect(accessToken: string): TokenIntrospection {
    const record = this.findByAccessToken(accessToken);
    if (record === undefined) {
      return {
        active: false,
        outcome: "not_found",
        reason: "access token is unknown",
        evidence: ["auth.token:not_found"]
      };
    }

    if (record.metadata.revokedAt !== undefined) {
      return this.inactive(record, "revoked", "access token was revoked");
    }

    if (Date.parse(record.metadata.expiresAt) <= this.nowMs()) {
      return this.inactive(record, "expired", "access token expired");
    }

    return {
      active: true,
      outcome: "active",
      principalId: record.metadata.principalId,
      sessionId: record.metadata.sessionId,
      clientId: record.metadata.clientId,
      scopes: record.metadata.scopes,
      expiresAt: record.metadata.expiresAt,
      targetConstraints: record.metadata.targetConstraints,
      reason: "access token is active",
      evidence: this.evidence(record, "active")
    };
  }

  whoami(accessToken: string): PrincipalIntrospection | undefined {
    const introspection = this.introspect(accessToken);
    if (!introspection.active || introspection.principalId === undefined) return undefined;
    return {
      principalId: introspection.principalId,
      sessionId: introspection.sessionId ?? "",
      clientId: introspection.clientId ?? "",
      scopes: introspection.scopes ?? [],
      evidence: introspection.evidence
    };
  }

  refresh(refreshToken: string): TokenRefreshResult {
    const record = this.findByRefreshToken(refreshToken);
    if (record === undefined) {
      return {
        outcome: "not_found",
        reason: "refresh token is unknown",
        evidence: ["auth.refresh:not_found"]
      };
    }

    if (record.metadata.revokedAt !== undefined) {
      return {
        outcome: "revoked",
        reason: "refresh token was revoked",
        evidence: this.evidence(record, "revoked")
      };
    }

    if (Date.parse(record.metadata.refreshExpiresAt) <= this.nowMs()) {
      return {
        outcome: "expired",
        reason: "refresh token expired",
        evidence: this.evidence(record, "expired")
      };
    }

    const token = this.issueReplacement(record.metadata);
    const metadata = this.store(token);
    this.records.set(record.metadata.tokenId, {
      ...record,
      metadata: { ...record.metadata, revokedAt: iso(this.nowMs()) }
    });
    return {
      outcome: "refreshed",
      token,
      metadata,
      reason: "refresh token exchanged for a new token set",
      evidence: this.evidence({ ...record, metadata }, "refreshed")
    };
  }

  revoke(token: string): TokenIntrospection {
    const record = this.findByAccessToken(token) ?? this.findByRefreshToken(token);
    if (record === undefined) {
      return {
        active: false,
        outcome: "not_found",
        reason: "token is unknown",
        evidence: ["auth.token:not_found"]
      };
    }

    const revoked = {
      ...record,
      metadata: { ...record.metadata, revokedAt: iso(this.nowMs()) }
    };
    this.records.set(record.metadata.tokenId, revoked);
    return this.inactive(revoked, "revoked", "token was revoked");
  }

  redactedMetadata(tokenId: string): TokenRecordMetadata | undefined {
    return this.records.get(tokenId)?.metadata;
  }

  private issueReplacement(metadata: TokenRecordMetadata): DeviceTokenSet {
    return {
      tokenType: "Bearer",
      accessToken: `ciclo_at_${base64Url(this.tokenBytes())}`,
      refreshToken: `ciclo_rt_${base64Url(this.tokenBytes())}`,
      expiresAt: iso(this.nowMs() + this.accessTokenTtlSeconds * 1000),
      principalId: metadata.principalId,
      sessionId: metadata.sessionId,
      clientId: metadata.clientId,
      scopes: metadata.scopes,
      targetConstraints: metadata.targetConstraints
    };
  }

  private findByAccessToken(accessToken: string): StoredTokenRecord | undefined {
    const hash = tokenHash(accessToken);
    return [...this.records.values()].find((record) => record.accessTokenHash === hash);
  }

  private findByRefreshToken(refreshToken: string): StoredTokenRecord | undefined {
    const hash = tokenHash(refreshToken);
    return [...this.records.values()].find((record) => record.refreshTokenHash === hash);
  }

  private inactive(
    record: StoredTokenRecord,
    outcome: "expired" | "revoked",
    reason: string
  ): TokenIntrospection {
    return {
      active: false,
      outcome,
      principalId: record.metadata.principalId,
      sessionId: record.metadata.sessionId,
      clientId: record.metadata.clientId,
      scopes: record.metadata.scopes,
      expiresAt: record.metadata.expiresAt,
      targetConstraints: record.metadata.targetConstraints,
      reason,
      evidence: this.evidence(record, outcome)
    };
  }

  private evidence(record: StoredTokenRecord, state: string): readonly string[] {
    return [
      `auth.token:${state}`,
      `auth.token.id:${record.metadata.tokenId}`,
      `auth.token.session:${record.metadata.sessionId}`,
      `auth.token.client:${record.metadata.clientId}`
    ];
  }
}
