export type CicloSessionMode = "single" | "multiuser";

export type PrincipalId = string;

export type SessionRequestOrigin =
  | "cli"
  | "mcp_stdio"
  | "mcp_http"
  | "api"
  | "remote_session";

export type SessionAccessAction =
  | "read_status"
  | "read_loop"
  | "read_ready_work"
  | "create_beads_task"
  | "claim_beads_task"
  | "update_beads_progress"
  | "close_beads_task"
  | "send_prompt"
  | "run_test"
  | "run_command"
  | "deploy"
  | "approve_permission"
  | "register_remote_session"
  | "remote_tracker_sync"
  | "answer_agent_question"
  | "request_secret"
  | "use_brain"
  | "grant_access"
  | "revoke_access";

export interface CicloSession {
  readonly id: string;
  readonly name?: string;
  readonly mode: CicloSessionMode;
  readonly ownerPrincipalId: PrincipalId;
  readonly projectRoot: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface SessionRequestContext {
  readonly origin: SessionRequestOrigin;
  readonly principalId?: PrincipalId;
  readonly remoteSessionId?: string;
}

export type SessionAccessDecision = "allow" | "deny";

export interface SessionPrincipalResolution {
  readonly decision: SessionAccessDecision;
  readonly principalId?: PrincipalId;
  readonly reason: string;
  readonly evidence: readonly string[];
}

const mutatingSessionActions = new Set<SessionAccessAction>([
  "create_beads_task",
  "claim_beads_task",
  "update_beads_progress",
  "close_beads_task",
  "send_prompt",
  "run_test",
  "run_command",
  "deploy",
  "approve_permission",
  "register_remote_session",
  "remote_tracker_sync",
  "answer_agent_question",
  "request_secret",
  "use_brain",
  "grant_access",
  "revoke_access"
]);

function cleanPrincipal(value: PrincipalId | undefined): PrincipalId | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function isMutatingSessionAction(action: SessionAccessAction): boolean {
  return mutatingSessionActions.has(action);
}

export function createSingleUserSession(input: {
  readonly id: string;
  readonly name?: string;
  readonly ownerPrincipalId: PrincipalId;
  readonly projectRoot: string;
  readonly now?: string;
}): CicloSession {
  return {
    id: input.id,
    name: input.name,
    mode: "single",
    ownerPrincipalId: input.ownerPrincipalId,
    projectRoot: input.projectRoot,
    createdAt: input.now,
    updatedAt: input.now
  };
}

export function resolveSessionPrincipal(input: {
  readonly session: CicloSession;
  readonly request: SessionRequestContext;
  readonly action: SessionAccessAction;
}): SessionPrincipalResolution {
  const evidence = [
    `session:${input.session.id}`,
    `session.mode:${input.session.mode}`,
    `session.origin:${input.request.origin}`,
    `session.action:${input.action}`
  ];

  if (input.session.mode === "single") {
    return {
      decision: "allow",
      principalId: input.session.ownerPrincipalId,
      reason: "single-user mode maps local actions to the owner principal",
      evidence: [...evidence, `principal:${input.session.ownerPrincipalId}`]
    };
  }

  const principalId = cleanPrincipal(input.request.principalId);
  if (principalId === undefined && isMutatingSessionAction(input.action)) {
    return {
      decision: "deny",
      reason: "multiuser mode requires an authenticated principal for mutating actions",
      evidence: [...evidence, "principal:missing"]
    };
  }

  if (principalId === undefined) {
    return {
      decision: "allow",
      reason: "multiuser read-only action does not require a principal at the session-mode layer",
      evidence: [...evidence, "principal:anonymous"]
    };
  }

  return {
    decision: "allow",
    principalId,
    reason: "multiuser request supplied a principal for session-mode evaluation",
    evidence: [...evidence, `principal:${principalId}`]
  };
}
