import { createHash } from "node:crypto";

import { effectiveGrantCapabilities } from "./access-grants.js";
import type { AuthorizationResult } from "./access-enforcement.js";
import { clientWhoami, type ClientAuthContext, type ClientAuthRequest } from "./client-auth.js";
import { redactContextMemory } from "./context-redaction.js";

export type AuthorizationAuditDecision = "accepted" | "denied" | "delegated";

export interface AuthorizationAuditRecord {
  readonly id: string;
  readonly time: string;
  readonly sessionId: string;
  readonly sessionMode: string;
  readonly origin: string;
  readonly action: string;
  readonly capability?: string;
  readonly principalId?: string;
  readonly decision: AuthorizationAuditDecision;
  readonly reason: string;
  readonly operatorRoutePrincipalIds: readonly string[];
  readonly grant?: {
    readonly principalId: string;
    readonly role?: string;
    readonly capabilities: readonly string[];
    readonly scope?: unknown;
    readonly expiresAt?: string;
  };
  readonly token?: {
    readonly active: boolean;
    readonly outcome: string;
    readonly clientId?: string;
    readonly expiresAt?: string;
  };
  readonly evidence: readonly string[];
  readonly redactions: readonly string[];
}

export interface AuthorizationAuditBuildOptions {
  readonly now?: string;
}

function stableString(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
    }
    return item;
  });
}

function id(value: unknown): string {
  return `auth_audit_${createHash("sha256").update(stableString(value)).digest("hex").slice(0, 16)}`;
}

function decisionFor(result: AuthorizationResult): AuthorizationAuditDecision {
  if (result.decision === "allow") return "accepted";
  return result.operatorRoutePrincipalIds.length > 0 ? "delegated" : "denied";
}

function redactedLines(lines: readonly string[]): {
  readonly evidence: readonly string[];
  readonly redactions: readonly string[];
} {
  const redactions = new Map<string, number>();
  const evidence = lines.map((line) => {
    const redacted = redactContextMemory({ text: line, source: "audit" });
    for (const item of redacted.metadata) {
      redactions.set(item.kind, (redactions.get(item.kind) ?? 0) + item.count);
    }
    return redacted.text;
  });
  return {
    evidence,
    redactions: [...redactions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => `access.audit.redaction.${kind}:${count}`)
  };
}

export function buildAuthorizationAuditRecord(
  context: ClientAuthContext,
  request: ClientAuthRequest,
  result: AuthorizationResult,
  options: AuthorizationAuditBuildOptions = {}
): AuthorizationAuditRecord {
  const safeEvidence = redactedLines(result.evidence);
  const whoami = clientWhoami(context);
  const grant = result.grantDecision?.grant;
  const reason = redactContextMemory({ text: result.reason, source: "audit" }).text;
  return {
    id: id({
      sessionId: context.session.id,
      origin: context.origin,
      action: request.action,
      principalId: result.principalId,
      decision: result.decision,
      reason,
      evidence: safeEvidence.evidence
    }),
    time: options.now ?? new Date().toISOString(),
    sessionId: context.session.id,
    sessionMode: context.session.mode,
    origin: context.origin,
    action: request.action,
    capability: result.capability,
    principalId: result.principalId ?? whoami.principal_id,
    decision: decisionFor(result),
    reason,
    operatorRoutePrincipalIds: result.operatorRoutePrincipalIds,
    grant:
      grant === undefined
        ? undefined
        : {
            principalId: grant.principalId,
            role: grant.role,
            capabilities: effectiveGrantCapabilities(grant),
            scope: grant.scope,
            expiresAt: grant.expiresAt
          },
    token: whoami.token === undefined
      ? undefined
      : {
          active: whoami.token.active,
          outcome: whoami.token.outcome,
          clientId: whoami.token.client_id,
          expiresAt: whoami.token.expires_at
        },
    evidence: safeEvidence.evidence,
    redactions: safeEvidence.redactions
  };
}
