import type { HarnessId } from "./ciclo-core.js";
import type { PrincipalId } from "./session-access.js";

export type AccessRole =
  | "owner"
  | "operator"
  | "maintainer"
  | "contributor"
  | "viewer"
  | "agent_service";

export type AccessCapability =
  | "status.read"
  | "work.claim"
  | "work.update"
  | "work.close"
  | "command.approve"
  | "question.answer"
  | "remote.register"
  | "secret.read"
  | "brain.decide"
  | "access.admin";

export type CommandClass = "read_only" | "test" | "build" | "deploy" | "destructive" | string;

export interface RepoIdentityScope {
  readonly root?: string;
  readonly gitRemote?: string;
  readonly gitBranch?: string;
  readonly beadsPrefix?: string;
}

export interface AccessScope {
  readonly sessionId?: string;
  readonly repoIdentity?: RepoIdentityScope;
  readonly loopId?: string;
  readonly beadId?: string;
  readonly beadLabels?: readonly string[];
  readonly harnessId?: HarnessId | string;
  readonly remoteSessionId?: string;
  readonly remoteHerdrTarget?: string;
  readonly commandClasses?: readonly CommandClass[];
}

export interface AccessGrant {
  readonly principalId: PrincipalId;
  readonly role?: AccessRole;
  readonly capabilities?: readonly AccessCapability[];
  readonly scope?: AccessScope;
  readonly expiresAt?: string;
}

export interface AccessRequest {
  readonly principalId: PrincipalId;
  readonly capability: AccessCapability;
  readonly scope?: AccessScope;
  readonly now?: string;
}

export interface AccessGrantDecision {
  readonly allowed: boolean;
  readonly grant?: AccessGrant;
  readonly reason: string;
  readonly evidence: readonly string[];
}

const allCapabilities: readonly AccessCapability[] = [
  "status.read",
  "work.claim",
  "work.update",
  "work.close",
  "command.approve",
  "question.answer",
  "remote.register",
  "secret.read",
  "brain.decide",
  "access.admin"
];

const roleCapabilities: Record<AccessRole, readonly AccessCapability[]> = {
  owner: allCapabilities,
  operator: ["status.read", "question.answer", "command.approve", "remote.register", "brain.decide"],
  maintainer: ["status.read", "work.claim", "work.update", "work.close", "question.answer", "secret.read", "brain.decide"],
  contributor: ["status.read", "work.claim", "work.update"],
  viewer: ["status.read"],
  agent_service: ["status.read", "work.update", "question.answer", "secret.read", "brain.decide"]
};

function unique<T>(items: readonly T[]): readonly T[] {
  return [...new Set(items)];
}

export function capabilitiesForRole(role: AccessRole): readonly AccessCapability[] {
  return roleCapabilities[role];
}

export function effectiveGrantCapabilities(grant: AccessGrant): readonly AccessCapability[] {
  return unique([
    ...(grant.role === undefined ? [] : capabilitiesForRole(grant.role)),
    ...(grant.capabilities ?? [])
  ]);
}

function expired(grant: AccessGrant, now: string | undefined): boolean {
  return now !== undefined && grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= Date.parse(now);
}

function stringMatches(expected: string | undefined, actual: string | undefined): boolean {
  return expected === undefined || expected === actual;
}

function labelsMatch(expected: readonly string[] | undefined, actual: readonly string[] | undefined): boolean {
  if (expected === undefined || expected.length === 0) return true;
  const actualSet = new Set(actual ?? []);
  return expected.every((label) => actualSet.has(label));
}

function commandClassMatches(
  expected: readonly CommandClass[] | undefined,
  actual: readonly CommandClass[] | undefined
): boolean {
  if (expected === undefined || expected.length === 0) return true;
  if (actual === undefined || actual.length === 0) return false;
  return actual.every((commandClass) => expected.includes(commandClass));
}

function repoMatches(expected: RepoIdentityScope | undefined, actual: RepoIdentityScope | undefined): boolean {
  if (expected === undefined) return true;
  return (
    stringMatches(expected.root, actual?.root) &&
    stringMatches(expected.gitRemote, actual?.gitRemote) &&
    stringMatches(expected.gitBranch, actual?.gitBranch) &&
    stringMatches(expected.beadsPrefix, actual?.beadsPrefix)
  );
}

export function scopeMatches(grantScope: AccessScope | undefined, requestScope: AccessScope | undefined): boolean {
  if (grantScope === undefined) return true;
  return (
    stringMatches(grantScope.sessionId, requestScope?.sessionId) &&
    repoMatches(grantScope.repoIdentity, requestScope?.repoIdentity) &&
    stringMatches(grantScope.loopId, requestScope?.loopId) &&
    stringMatches(grantScope.beadId, requestScope?.beadId) &&
    labelsMatch(grantScope.beadLabels, requestScope?.beadLabels) &&
    stringMatches(grantScope.harnessId, requestScope?.harnessId) &&
    stringMatches(grantScope.remoteSessionId, requestScope?.remoteSessionId) &&
    stringMatches(grantScope.remoteHerdrTarget, requestScope?.remoteHerdrTarget) &&
    commandClassMatches(grantScope.commandClasses, requestScope?.commandClasses)
  );
}

export function evaluateAccessGrant(
  grants: readonly AccessGrant[],
  request: AccessRequest
): AccessGrantDecision {
  const evidence = [
    `access.principal:${request.principalId}`,
    `access.capability:${request.capability}`
  ];

  for (const grant of grants) {
    if (grant.principalId !== request.principalId) continue;
    const grantEvidence = [
      ...evidence,
      grant.role === undefined ? "access.role:custom" : `access.role:${grant.role}`
    ];

    if (expired(grant, request.now)) {
      continue;
    }

    if (!effectiveGrantCapabilities(grant).includes(request.capability)) {
      continue;
    }

    if (!scopeMatches(grant.scope, request.scope)) {
      continue;
    }

    return {
      allowed: true,
      grant,
      reason: "principal has a matching scoped grant",
      evidence: [...grantEvidence, "access.decision:allow"]
    };
  }

  return {
    allowed: false,
    reason: "no unexpired grant matched principal capability and scope",
    evidence: [...evidence, "access.decision:deny"]
  };
}
