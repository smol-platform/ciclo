import {
  capabilitiesForRole,
  effectiveGrantCapabilities,
  type AccessCapability,
  type AccessGrant,
  type AccessScope
} from "./access-grants.js";
import {
  authorizeCicloAction,
  type AuthorizationResult
} from "./access-enforcement.js";
import {
  createSingleUserSession,
  type CicloSession,
  type PrincipalId,
  type SessionAccessAction,
  type SessionRequestOrigin
} from "./session-access.js";
import { repoSessionName } from "./repo-session-name.js";
import { TokenRegistry, type TokenIntrospection } from "./token-store.js";

export interface ClientAuthContext {
  readonly session: CicloSession;
  readonly origin: SessionRequestOrigin;
  readonly grants: readonly AccessGrant[];
  readonly principalId?: PrincipalId;
  readonly authorizationHeader?: string;
  readonly accessToken?: string;
  readonly tokenRegistry?: TokenRegistry;
  readonly now?: string;
}

export interface ClientAuthRequest {
  readonly action: SessionAccessAction;
  readonly scope?: AccessScope;
  readonly allowUnauthenticated?: boolean;
}

export interface EffectiveGrantView {
  readonly principalId: PrincipalId;
  readonly role?: string;
  readonly capabilities: readonly AccessCapability[];
  readonly scope?: AccessScope;
  readonly expiresAt?: string;
}

export interface ClientPrincipalView {
  readonly principal_id?: PrincipalId;
  readonly authenticated: boolean;
  readonly session_id: string;
  readonly session_name?: string;
  readonly session_mode: CicloSession["mode"];
  readonly origin: SessionRequestOrigin;
  readonly capabilities: readonly AccessCapability[];
  readonly token?: {
    readonly active: boolean;
    readonly outcome: string;
    readonly client_id?: string;
    readonly expires_at?: string;
  };
  readonly evidence: readonly string[];
}

export interface ClientAccessView {
  readonly mode: CicloSession["mode"];
  readonly session_id: string;
  readonly session_name?: string;
  readonly principal_id?: PrincipalId;
  readonly authenticated: boolean;
  readonly effective_grants: readonly EffectiveGrantView[];
  readonly capabilities: readonly AccessCapability[];
  readonly evidence: readonly string[];
}

function unique<T>(items: readonly T[]): readonly T[] {
  return [...new Set(items)];
}

export function defaultClientAuthContext(root = process.cwd()): ClientAuthContext {
  const sessionName = repoSessionName(root);
  return {
    session: createSingleUserSession({
      id: process.env.CICLO_SESSION_ID ?? sessionName,
      name: sessionName,
      ownerPrincipalId: process.env.CICLO_OWNER_PRINCIPAL_ID ?? "owner:local",
      projectRoot: root
    }),
    origin: "mcp_stdio",
    grants: [],
    principalId: process.env.CICLO_PRINCIPAL_ID,
    accessToken: process.env.CICLO_ACCESS_TOKEN
  };
}

export function bearerTokenFromAuthorizationHeader(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1];
}

function tokenFromContext(context: ClientAuthContext): string | undefined {
  return context.accessToken ?? bearerTokenFromAuthorizationHeader(context.authorizationHeader);
}

function introspectToken(context: ClientAuthContext): TokenIntrospection | undefined {
  const token = tokenFromContext(context);
  if (token === undefined) return undefined;
  return context.tokenRegistry?.introspect(token) ?? {
    active: false,
    outcome: "not_found",
    reason: "token registry unavailable for supplied bearer token",
    evidence: ["auth.token:registry_unavailable"]
  };
}

function requiresBearer(context: ClientAuthContext): boolean {
  return context.session.mode === "multiuser" && (context.origin === "mcp_http" || context.origin === "api");
}

export function authorizeClientRequest(
  context: ClientAuthContext,
  request: ClientAuthRequest
): AuthorizationResult {
  if (requiresBearer(context) && tokenFromContext(context) === undefined && request.allowUnauthenticated === true) {
    return {
      decision: "allow",
      capability: "status.read",
      operatorRoutePrincipalIds: [],
      audit: {
        event: "access.accepted",
        action: request.action,
        sessionId: context.session.id,
        reason: "multiuser MCP HTTP/API auth bootstrap request is allowed without an existing bearer token",
        evidence: [
          `session:${context.session.id}`,
          `session.mode:${context.session.mode}`,
          `session.origin:${context.origin}`,
          "auth.bootstrap:allowed"
        ]
      },
      reason: "multiuser MCP HTTP/API auth bootstrap request is allowed without an existing bearer token",
      evidence: [
        `session:${context.session.id}`,
        `session.mode:${context.session.mode}`,
        `session.origin:${context.origin}`,
        "auth.bootstrap:allowed"
      ]
    };
  }

  if (requiresBearer(context) && tokenFromContext(context) === undefined) {
    return {
      decision: "deny",
      capability: "status.read",
      operatorRoutePrincipalIds: [],
      audit: {
        event: "access.denied",
        action: request.action,
        sessionId: context.session.id,
        reason: "multiuser MCP HTTP/API clients require bearer token authentication",
        evidence: [
          `session:${context.session.id}`,
          `session.mode:${context.session.mode}`,
          `session.origin:${context.origin}`,
          "auth.token:missing"
        ]
      },
      reason: "multiuser MCP HTTP/API clients require bearer token authentication",
      evidence: [
        `session:${context.session.id}`,
        `session.mode:${context.session.mode}`,
        `session.origin:${context.origin}`,
        "auth.token:missing"
      ]
    };
  }

  const token = introspectToken(context);
  return authorizeCicloAction({
    session: context.session,
    request: {
      origin: context.origin,
      principalId: context.principalId
    },
    token,
    action: request.action,
    grants: context.grants,
    scope: request.scope,
    now: context.now
  });
}

function grantsForPrincipal(
  context: ClientAuthContext,
  principalId: PrincipalId | undefined
): readonly EffectiveGrantView[] {
  if (principalId === undefined) return [];
  if (context.session.mode === "single" && principalId === context.session.ownerPrincipalId) {
    return [
      {
        principalId,
        role: "owner",
        capabilities: capabilitiesForRole("owner"),
        scope: { sessionId: context.session.id }
      }
    ];
  }
  return context.grants
    .filter((grant) => grant.principalId === principalId)
    .map((grant) => ({
      principalId: grant.principalId,
      role: grant.role,
      capabilities: effectiveGrantCapabilities(grant),
      scope: grant.scope,
      expiresAt: grant.expiresAt
    }));
}

function principalFromContext(context: ClientAuthContext): {
  readonly principalId?: PrincipalId;
  readonly token?: TokenIntrospection;
  readonly evidence: readonly string[];
} {
  const token = introspectToken(context);
  if (context.session.mode === "single") {
    return {
      principalId: context.session.ownerPrincipalId,
      token,
      evidence: [`principal:${context.session.ownerPrincipalId}`, "session.mode:single"]
    };
  }
  if (token?.active === true && token.principalId !== undefined) {
    return {
      principalId: token.principalId,
      token,
      evidence: token.evidence
    };
  }
  if (context.principalId !== undefined && context.principalId.trim().length > 0) {
    return {
      principalId: context.principalId,
      token,
      evidence: [`principal:${context.principalId}`, "principal.source:launcher"]
    };
  }
  return {
    token,
    evidence: token?.evidence ?? ["principal:anonymous"]
  };
}

export function clientWhoami(context: ClientAuthContext): ClientPrincipalView {
  const principal = principalFromContext(context);
  const grants = grantsForPrincipal(context, principal.principalId);
  const capabilities = unique(grants.flatMap((grant) => grant.capabilities));
  return {
    principal_id: principal.principalId,
    authenticated: principal.principalId !== undefined,
    session_id: context.session.id,
    session_name: context.session.name,
    session_mode: context.session.mode,
    origin: context.origin,
    capabilities,
    token:
      principal.token === undefined
        ? undefined
        : {
            active: principal.token.active,
            outcome: principal.token.outcome,
            client_id: principal.token.clientId,
            expires_at: principal.token.expiresAt
          },
    evidence: principal.evidence
  };
}

export function clientAccessView(context: ClientAuthContext): ClientAccessView {
  const whoami = clientWhoami(context);
  const grants = grantsForPrincipal(context, whoami.principal_id);
  const capabilities = unique(grants.flatMap((grant) => grant.capabilities));
  return {
    mode: context.session.mode,
    session_id: context.session.id,
    session_name: context.session.name,
    principal_id: whoami.principal_id,
    authenticated: whoami.authenticated,
    effective_grants: grants,
    capabilities,
    evidence: whoami.evidence
  };
}
