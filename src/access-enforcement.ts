import {
  effectiveGrantCapabilities,
  evaluateAccessGrant,
  scopeMatches,
  type AccessCapability,
  type AccessGrant,
  type AccessGrantDecision,
  type AccessScope
} from "./access-grants.js";
import {
  isMutatingSessionAction,
  resolveSessionPrincipal,
  type CicloSession,
  type PrincipalId,
  type SessionAccessAction,
  type SessionRequestContext
} from "./session-access.js";
import type { TokenIntrospection } from "./token-store.js";

export type AuthorizationDecision = "allow" | "deny";

export interface AccessAuditRecord {
  readonly event: "access.accepted" | "access.denied";
  readonly action: SessionAccessAction;
  readonly sessionId: string;
  readonly principalId?: PrincipalId;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface AuthorizationResult {
  readonly decision: AuthorizationDecision;
  readonly principalId?: PrincipalId;
  readonly capability?: AccessCapability;
  readonly grantDecision?: AccessGrantDecision;
  readonly operatorRoutePrincipalIds: readonly PrincipalId[];
  readonly audit: AccessAuditRecord;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface AuthorizeCicloActionInput {
  readonly session: CicloSession;
  readonly request: SessionRequestContext;
  readonly action: SessionAccessAction;
  readonly grants: readonly AccessGrant[];
  readonly scope?: AccessScope;
  readonly now?: string;
  readonly token?: TokenIntrospection;
}

const actionCapabilities: Partial<Record<SessionAccessAction, AccessCapability>> = {
  read_status: "status.read",
  read_loop: "status.read",
  read_ready_work: "status.read",
  create_beads_task: "work.update",
  claim_beads_task: "work.claim",
  update_beads_progress: "work.update",
  close_beads_task: "work.close",
  send_prompt: "work.update",
  run_test: "command.approve",
  run_command: "command.approve",
  deploy: "command.approve",
  approve_permission: "command.approve",
  register_remote_session: "remote.register",
  remote_tracker_sync: "access.admin",
  answer_agent_question: "question.answer",
  request_secret: "secret.read",
  use_brain: "brain.decide",
  grant_access: "access.admin",
  revoke_access: "access.admin"
};

function capabilityForAction(action: SessionAccessAction): AccessCapability {
  const capability = actionCapabilities[action];
  if (capability === undefined) {
    throw new Error(`no access capability mapped for action: ${action}`);
  }
  return capability;
}

function audit(input: {
  readonly event: AccessAuditRecord["event"];
  readonly action: SessionAccessAction;
  readonly sessionId: string;
  readonly principalId?: PrincipalId;
  readonly reason: string;
  readonly evidence: readonly string[];
}): AccessAuditRecord {
  return input;
}

function denied(input: {
  readonly action: SessionAccessAction;
  readonly sessionId: string;
  readonly principalId?: PrincipalId;
  readonly capability?: AccessCapability;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly operatorRoutePrincipalIds?: readonly PrincipalId[];
  readonly grantDecision?: AccessGrantDecision;
}): AuthorizationResult {
  return {
    decision: "deny",
    principalId: input.principalId,
    capability: input.capability,
    grantDecision: input.grantDecision,
    operatorRoutePrincipalIds: input.operatorRoutePrincipalIds ?? [],
    audit: audit({
      event: "access.denied",
      action: input.action,
      sessionId: input.sessionId,
      principalId: input.principalId,
      reason: input.reason,
      evidence: input.evidence
    }),
    reason: input.reason,
    evidence: input.evidence
  };
}

function allowed(input: {
  readonly action: SessionAccessAction;
  readonly sessionId: string;
  readonly principalId: PrincipalId;
  readonly capability: AccessCapability;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly grantDecision?: AccessGrantDecision;
}): AuthorizationResult {
  return {
    decision: "allow",
    principalId: input.principalId,
    capability: input.capability,
    grantDecision: input.grantDecision,
    operatorRoutePrincipalIds: [],
    audit: audit({
      event: "access.accepted",
      action: input.action,
      sessionId: input.sessionId,
      principalId: input.principalId,
      reason: input.reason,
      evidence: input.evidence
    }),
    reason: input.reason,
    evidence: input.evidence
  };
}

function operatorRoutes(input: {
  readonly grants: readonly AccessGrant[];
  readonly capability: AccessCapability;
  readonly scope?: AccessScope;
  readonly now?: string;
  readonly excludePrincipalId?: PrincipalId;
}): readonly PrincipalId[] {
  const operators = input.grants.filter((grant) => {
    if (grant.principalId === input.excludePrincipalId) return false;
    if (grant.role !== "owner" && grant.role !== "operator") return false;
    if (grant.expiresAt !== undefined && input.now !== undefined && Date.parse(grant.expiresAt) <= Date.parse(input.now)) {
      return false;
    }
    return (
      effectiveGrantCapabilities(grant).includes(input.capability) &&
      scopeMatches(grant.scope, input.scope)
    );
  });
  return [...new Set(operators.map((grant) => grant.principalId))];
}

function requestWithTokenPrincipal(
  request: SessionRequestContext,
  token: TokenIntrospection | undefined
): SessionRequestContext {
  if (request.principalId !== undefined || token?.active !== true || token.principalId === undefined) {
    return request;
  }
  return { ...request, principalId: token.principalId };
}

function tokenEvidence(token: TokenIntrospection | undefined): readonly string[] {
  if (token === undefined) return ["auth.token:not_provided"];
  return token.evidence;
}

export function authorizeCicloAction(input: AuthorizeCicloActionInput): AuthorizationResult {
  const capability = capabilityForAction(input.action);
  const scope = {
    sessionId: input.session.id,
    ...input.scope
  };
  const evidence = [
    `access.enforce.action:${input.action}`,
    `access.enforce.capability:${capability}`,
    ...tokenEvidence(input.token)
  ];

  if (input.session.mode === "multiuser" && input.token !== undefined && !input.token.active) {
    return denied({
      action: input.action,
      sessionId: input.session.id,
      capability,
      reason: "multiuser request used an inactive token",
      evidence: [...evidence, "access.enforce:inactive_token"]
    });
  }

  if (
    input.session.mode === "multiuser" &&
    input.token?.active === true &&
    input.request.principalId !== undefined &&
    input.token.principalId !== input.request.principalId
  ) {
    return denied({
      action: input.action,
      sessionId: input.session.id,
      capability,
      principalId: input.request.principalId,
      reason: "multiuser request principal does not match active token principal",
      evidence: [...evidence, "access.enforce:principal_token_mismatch"]
    });
  }

  const principal = resolveSessionPrincipal({
    session: input.session,
    request: requestWithTokenPrincipal(input.request, input.token),
    action: input.action
  });

  if (principal.decision === "deny" || principal.principalId === undefined) {
    return denied({
      action: input.action,
      sessionId: input.session.id,
      capability,
      reason: principal.reason,
      evidence: [...evidence, ...principal.evidence],
      operatorRoutePrincipalIds: operatorRoutes({
        grants: input.grants,
        capability,
        scope,
        now: input.now
      })
    });
  }

  if (input.session.mode === "single" || !isMutatingSessionAction(input.action)) {
    return allowed({
      action: input.action,
      sessionId: input.session.id,
      principalId: principal.principalId,
      capability,
      reason:
        input.session.mode === "single"
          ? "single mode authorizes the owner principal without grant checks"
          : "read-only request resolved a principal without requiring a mutating grant",
      evidence: [...evidence, ...principal.evidence]
    });
  }

  const grantDecision = evaluateAccessGrant(input.grants, {
    principalId: principal.principalId,
    capability,
    scope,
    now: input.now
  });

  if (!grantDecision.allowed) {
    return denied({
      action: input.action,
      sessionId: input.session.id,
      principalId: principal.principalId,
      capability,
      grantDecision,
      reason: "principal lacks an unexpired grant for this action and scope",
      evidence: [...evidence, ...principal.evidence, ...grantDecision.evidence],
      operatorRoutePrincipalIds: operatorRoutes({
        grants: input.grants,
        capability,
        scope,
        now: input.now,
        excludePrincipalId: principal.principalId
      })
    });
  }

  return allowed({
    action: input.action,
    sessionId: input.session.id,
    principalId: principal.principalId,
    capability,
    grantDecision,
    reason: "principal is authenticated and has a matching scoped grant",
    evidence: [...evidence, ...principal.evidence, ...grantDecision.evidence]
  });
}
