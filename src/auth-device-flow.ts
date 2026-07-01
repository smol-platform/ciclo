import { createHash, randomBytes } from "node:crypto";

import type { PrincipalId } from "./session-access.js";

export type DeviceClientKind = "cli" | "mcp_http" | "remote_worker";

export type DeviceAuthorizationStatus = "pending" | "approved" | "denied" | "expired";

export type DevicePollOutcome =
  | "authorization_pending"
  | "approved"
  | "access_denied"
  | "expired_token"
  | "slow_down";

export interface DeviceAuthorizationRequest {
  readonly sessionId: string;
  readonly clientId: string;
  readonly clientKind: DeviceClientKind;
  readonly scopes: readonly string[];
  readonly remoteTarget?: string;
}

export interface DeviceAuthorizationStart {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}

export interface DeviceTokenSet {
  readonly tokenType: "Bearer";
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly principalId: PrincipalId;
  readonly sessionId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly targetConstraints?: {
    readonly remoteTarget?: string;
  };
}

export interface DevicePollResult {
  readonly outcome: DevicePollOutcome;
  readonly intervalSeconds: number;
  readonly token?: DeviceTokenSet;
  readonly reason: string;
  readonly evidence: readonly string[];
}

interface DeviceAuthorizationRecord {
  readonly request: DeviceAuthorizationRequest;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresAtMs: number;
  readonly createdAtMs: number;
  readonly verificationUri: string;
  status: DeviceAuthorizationStatus;
  intervalSeconds: number;
  lastPollAtMs?: number;
  principalId?: PrincipalId;
  deniedReason?: string;
}

export interface DeviceAuthorizationFlowOptions {
  readonly verificationUri: string;
  readonly nowMs?: () => number;
  readonly codeBytes?: () => Buffer;
  readonly tokenBytes?: () => Buffer;
  readonly ttlSeconds?: number;
  readonly intervalSeconds?: number;
  readonly accessTokenTtlSeconds?: number;
}

function defaultCodeBytes(): Buffer {
  return randomBytes(24);
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function formatUserCode(bytes: Buffer): string {
  return bytes.toString("hex").slice(0, 8).toUpperCase().replace(/(.{4})/, "$1-");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function sanitizeScopes(scopes: readonly string[]): readonly string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0))];
}

export class DeviceAuthorizationFlow {
  private readonly records = new Map<string, DeviceAuthorizationRecord>();
  private readonly nowMs: () => number;
  private readonly codeBytes: () => Buffer;
  private readonly tokenBytes: () => Buffer;
  private readonly ttlSeconds: number;
  private readonly defaultIntervalSeconds: number;
  private readonly accessTokenTtlSeconds: number;

  constructor(readonly options: DeviceAuthorizationFlowOptions) {
    this.nowMs = options.nowMs ?? Date.now;
    this.codeBytes = options.codeBytes ?? defaultCodeBytes;
    this.tokenBytes = options.tokenBytes ?? defaultCodeBytes;
    this.ttlSeconds = options.ttlSeconds ?? 600;
    this.defaultIntervalSeconds = options.intervalSeconds ?? 5;
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 3600;
  }

  start(request: DeviceAuthorizationRequest): DeviceAuthorizationStart {
    const createdAtMs = this.nowMs();
    const deviceCode = base64Url(this.codeBytes());
    const userCode = formatUserCode(this.codeBytes());
    const expiresAtMs = createdAtMs + this.ttlSeconds * 1000;
    const verificationUriComplete = `${this.options.verificationUri}?user_code=${encodeURIComponent(userCode)}`;

    this.records.set(deviceCode, {
      request: { ...request, scopes: sanitizeScopes(request.scopes) },
      deviceCode,
      userCode,
      expiresAtMs,
      createdAtMs,
      verificationUri: this.options.verificationUri,
      status: "pending",
      intervalSeconds: this.defaultIntervalSeconds
    });

    return {
      deviceCode,
      userCode,
      verificationUri: this.options.verificationUri,
      verificationUriComplete,
      expiresAt: iso(expiresAtMs),
      intervalSeconds: this.defaultIntervalSeconds
    };
  }

  approve(deviceCode: string, principalId: PrincipalId): boolean {
    const record = this.records.get(deviceCode);
    if (record === undefined || this.isExpired(record) || record.status !== "pending") return false;
    record.status = "approved";
    record.principalId = principalId;
    return true;
  }

  deny(deviceCode: string, reason = "user denied device authorization"): boolean {
    const record = this.records.get(deviceCode);
    if (record === undefined || this.isExpired(record) || record.status !== "pending") return false;
    record.status = "denied";
    record.deniedReason = reason;
    return true;
  }

  poll(deviceCode: string): DevicePollResult {
    const record = this.records.get(deviceCode);
    if (record === undefined) {
      return {
        outcome: "expired_token",
        intervalSeconds: this.defaultIntervalSeconds,
        reason: "device authorization was not found or is no longer available",
        evidence: ["auth.device:missing"]
      };
    }

    if (this.isExpired(record)) {
      record.status = "expired";
      return this.result(record, "expired_token", "device authorization expired");
    }

    const now = this.nowMs();
    if (
      record.lastPollAtMs !== undefined &&
      now - record.lastPollAtMs < record.intervalSeconds * 1000
    ) {
      record.intervalSeconds += 5;
      record.lastPollAtMs = now;
      return this.result(record, "slow_down", "client polled before the allowed interval");
    }
    record.lastPollAtMs = now;

    if (record.status === "denied") {
      return this.result(record, "access_denied", record.deniedReason ?? "authorization denied");
    }

    if (record.status === "approved" && record.principalId !== undefined) {
      const result = this.result(record, "approved", "device authorization approved", this.issueTokens(record));
      this.records.delete(deviceCode);
      return result;
    }

    return this.result(record, "authorization_pending", "authorization is still pending");
  }

  redactedAuditEvidence(deviceCode: string): readonly string[] {
    const record = this.records.get(deviceCode);
    if (record === undefined) return ["auth.device:missing"];
    return this.evidence(record);
  }

  private isExpired(record: DeviceAuthorizationRecord): boolean {
    return this.nowMs() >= record.expiresAtMs;
  }

  private issueTokens(record: DeviceAuthorizationRecord): DeviceTokenSet {
    return {
      tokenType: "Bearer",
      accessToken: `ciclo_at_${base64Url(this.tokenBytes())}`,
      refreshToken: `ciclo_rt_${base64Url(this.tokenBytes())}`,
      expiresAt: iso(this.nowMs() + this.accessTokenTtlSeconds * 1000),
      principalId: record.principalId ?? "unknown",
      sessionId: record.request.sessionId,
      clientId: record.request.clientId,
      scopes: record.request.scopes,
      targetConstraints:
        record.request.remoteTarget === undefined
          ? undefined
          : { remoteTarget: record.request.remoteTarget }
    };
  }

  private result(
    record: DeviceAuthorizationRecord,
    outcome: DevicePollOutcome,
    reason: string,
    token?: DeviceTokenSet
  ): DevicePollResult {
    return {
      outcome,
      intervalSeconds: record.intervalSeconds,
      token,
      reason,
      evidence: this.evidence(record)
    };
  }

  private evidence(record: DeviceAuthorizationRecord): readonly string[] {
    return [
      `auth.device.session:${record.request.sessionId}`,
      `auth.device.client:${record.request.clientKind}:${record.request.clientId}`,
      `auth.device.status:${record.status}`,
      `auth.device.code_hash:${shortHash(record.deviceCode)}`,
      `auth.device.user_code_hash:${shortHash(record.userCode)}`
    ];
  }
}
