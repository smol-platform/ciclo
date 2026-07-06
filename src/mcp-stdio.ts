import { Readable, Writable } from "node:stream";

import { buildStandaloneStatus, type CicloStandaloneStatus } from "./app.js";
import { buildAuthorizationAuditRecord, type AuthorizationAuditRecord } from "./access-audit-log.js";
import { DeviceAuthorizationFlow, type DeviceClientKind } from "./auth-device-flow.js";
import { BeadsClient, BeadsError, type BeadsTaskSnapshot } from "./beads-adapter.js";
import {
  closeBeadsTaskWithPolicy,
  recordBeadsProgress,
  type BeadsProgressClient,
  type BeadsProgressKind,
  type BeadsProgressSync,
  type ValidationEvidence
} from "./beads-progress.js";
import { BeadsRemoteTrackerSync, type BeadsRemoteTrackerSyncInput } from "./beads-tracker-sync.js";
import { selectAndClaimBeadsWork, type BeadsWorkClaimClient } from "./beads-work-queue.js";
import { runtimeDecision, type HarnessId, type LoopConfig } from "./ciclo-core.js";
import { cicloEventLogPath, CicloEventStore, type CicloEventInput } from "./ciclo-events.js";
import { CicloCronScheduler } from "./ciclo-cron.js";
import { CicloMemoryStore } from "./ciclo-memory.js";
import {
  authorizeClientRequest,
  clientAccessView,
  clientWhoami,
  defaultClientAuthContext,
  type ClientAuthContext
} from "./client-auth.js";
import type { AccessScope } from "./access-grants.js";
import { cicloMcpPrompts, cicloMcpResources, cicloMcpTools, type McpPromptContract } from "./mcp-contract.js";
import {
  acquireMcpSessionLeadership,
  mcpLeadershipView,
  ownsMcpAutomation,
  type McpSessionLeadership
} from "./mcp-leadership.js";
import type { CicloMcpAdditionalServerConfig, CicloMcpInstallClient, CicloMcpSecretEnvBinding } from "./mcp-install.js";
import {
  resolveMcpAdditionalServerSecretPlaceholders,
  type CicloMcpAdditionalServerSecretEnvInstall
} from "./mcp-secret-placeholders.js";
import {
  OperatorRoutingStore,
  type FeedbackSeverity,
  type QuestionUrgency
} from "./operator-routing.js";
import type { AuthorizationResult } from "./access-enforcement.js";
import type { PolicyConfig } from "./loop-config.js";
import { evaluatePolicy } from "./policy-gate.js";
import type { SessionAccessAction } from "./session-access.js";
import { TokenRegistry } from "./token-store.js";
import {
  WorkerSessionSupervisor,
  type WorkerHarnessId
} from "./worker-session-supervisor.js";
import { UserControlPaneNotifier, userControlPaneTargetFromEnv } from "./user-pane-notifier.js";
import {
  buildCicloAttachPlan,
  createDefaultRemoteRunnerPluginRegistry,
  createDefaultRemoteRunnerImageResolverRegistry,
  RemoteRunnerRegistry,
  type RemoteRunnerKind,
  type RemoteRunnerEgressPolicyRequest,
  type RemoteRunnerImageResolverRequest,
  type RemoteRunnerPreflightRequest,
  type RemoteRunnerRepoBootstrapRequest,
  type WireGuardTunnelRequest
} from "./remote-runner.js";
import type { RemoteHeartbeatClient, RemoteSessionRegistry } from "./remote-session-registry.js";
import { activateConfiguredPlugins, defaultPluginPaths } from "./plugin-manager.js";
import { GitHubCliRepoBoardProvider, type RepoBoardProvider, type RepoBoardStatus } from "./repo-board.js";
import {
  createDefaultSecretProviderRegistry,
  SecretProviderRegistry,
  secretRefHash,
  type SecretProviderResult
} from "./secret-provider.js";
import {
  launchTaskReviewSession,
  type TaskReviewSessionResult
} from "./task-review-session.js";
import { CicloInternalHeartbeat } from "./internal-heartbeat.js";
import {
  openAiDecisionPurposes,
  openAiBrainPolicy,
  PiSdkOpenAiBrain,
  type OpenAiBrain,
  type OpenAiDecisionPurpose
} from "./openai-brain.js";
import { CICLO_VERSION } from "./version.js";
import {
  configMcpSecretBindingParams,
  configWorkerSecretBindingParams,
  createSecretProviderRegistryFromConfig,
  loadCicloProjectConfig,
  mergeRemoteRunnerLaunchWithConfig,
  mergeWorkerLaunchWithConfig,
  redactedCicloProjectConfig,
  type CicloProjectConfig
} from "./ciclo-config.js";

export interface PendingQuestion {
  readonly questionId: string;
  readonly loopId?: string;
  readonly beadId?: string;
  readonly workerSessionId?: string;
  readonly question: string;
  readonly urgency: "low" | "normal" | "high" | "blocking";
  readonly createdAt?: string;
}

export interface OperatorFeedback {
  readonly feedbackId: string;
  readonly loopId?: string;
  readonly beadId?: string;
  readonly severity: "info" | "warning" | "error" | "critical";
  readonly message: string;
  readonly evidence: readonly string[];
  readonly createdAt?: string;
}

export interface LoopStatus {
  readonly loop: {
    readonly id: string;
    readonly kind: string;
    readonly state: string;
    readonly harnesses: readonly string[];
    readonly dryRun: boolean;
  };
  readonly goal: string;
  readonly policy: {
    readonly mutations: string;
    readonly networkListener: boolean;
    readonly access: string;
  };
  readonly currentWork: unknown;
  readonly evidence: readonly string[];
}

export interface ReadyWorkView {
  readonly selected: BeadsTaskSnapshot | null;
  readonly work: readonly BeadsTaskSnapshot[];
  readonly skipped: readonly unknown[];
  readonly evidence: readonly string[];
}

export interface CicloMcpReadService {
  status(): Promise<CicloStandaloneStatus>;
  loopStatus(loopId: string): Promise<LoopStatus>;
  readyWork(limit?: number): Promise<ReadyWorkView>;
  questions(): Promise<readonly PendingQuestion[]>;
  feedback(): Promise<readonly OperatorFeedback[]>;
}

export interface CicloMcpRuntimeContext {
  readonly auth: ClientAuthContext;
  readonly projectConfig?: CicloProjectConfig;
  readonly projectConfigEvidence?: readonly string[];
  readonly claudeChannel?: CicloClaudeChannelRuntimeConfig;
  readonly eventStore?: CicloEventStore;
  readonly cronScheduler?: CicloCronScheduler;
  readonly memoryStore?: CicloMemoryStore;
  readonly deviceFlow?: DeviceAuthorizationFlow;
  readonly beadsClient?: BeadsWorkClaimClient & BeadsProgressClient;
  readonly sync?: BeadsProgressSync;
  readonly loop?: LoopConfig;
  readonly policy?: PolicyConfig;
  readonly promptSendConfigured?: boolean;
  readonly mutationIdempotencyStore?: Set<string>;
  readonly auditLog?: CicloMcpAuditEntry[];
  readonly accessAuditLog?: AuthorizationAuditRecord[];
  readonly operatorRouting?: OperatorRoutingStore;
  readonly remoteTrackerSync?: BeadsRemoteTrackerSync;
  readonly workerSupervisor?: WorkerSessionSupervisor;
  readonly remoteSessionRegistry?: RemoteSessionRegistry;
  readonly remoteHeartbeatClient?: RemoteHeartbeatClient;
  readonly remoteRunnerRegistry?: RemoteRunnerRegistry;
  readonly secretProviderRegistry?: SecretProviderRegistry;
  readonly openAiBrain?: OpenAiBrain;
  readonly internalHeartbeat?: CicloInternalHeartbeat;
  readonly mcpLeadership?: McpSessionLeadership;
  readonly userPaneNotifier?: UserControlPaneNotifier;
  readonly repoBoardProvider?: RepoBoardProvider;
  readonly repoBoardEventKeys?: Set<string>;
}

export interface CicloClaudeChannelRuntimeConfig {
  readonly enabled: boolean;
}

export interface CicloMcpAuditEntry {
  readonly event: string;
  readonly tool: string;
  readonly action: SessionAccessAction;
  readonly principalId?: string;
  readonly decision: "allow" | "deny";
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface JsonRpcRequest {
  readonly jsonrpc?: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringParam(params: unknown, key: string, fallback = ""): string {
  const value = asRecord(params)[key];
  return typeof value === "string" ? value : fallback;
}

function numberParam(params: unknown, key: string, fallback: number): number {
  const value = asRecord(params)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumberParam(params: unknown, key: string): number | undefined {
  const value = asRecord(params)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanParam(params: unknown, key: string, fallback = false): boolean {
  const value = asRecord(params)[key];
  return typeof value === "boolean" ? value : fallback;
}

function optionalBooleanParam(params: unknown, key: string): boolean | undefined {
  const value = asRecord(params)[key];
  return typeof value === "boolean" ? value : undefined;
}

function urgencyParam(value: string): QuestionUrgency {
  if (value === "low" || value === "high" || value === "blocking") return value;
  return "normal";
}

function severityParam(value: string): FeedbackSeverity {
  if (value === "warning" || value === "error" || value === "critical") return value;
  return "info";
}

function workerHarnessParam(value: string): WorkerHarnessId {
  if (value === "claude-code" || value === "codex") return value;
  throw new Error("harness_id must be claude-code or codex for worker sessions");
}

function signalParam(value: string): NodeJS.Signals {
  if (value === "SIGINT" || value === "SIGKILL" || value === "SIGHUP") return value;
  return "SIGTERM";
}

function remoteRunnerKindParam(value: string): RemoteRunnerKind {
  if (value.trim().length > 0) return value;
  throw new Error("runner_kind must be a non-empty remote runner kind");
}

function openAiDecisionPurposeParam(value: string): OpenAiDecisionPurpose {
  if ((openAiDecisionPurposes as readonly string[]).includes(value)) return value as OpenAiDecisionPurpose;
  throw new Error(`purpose must be one of ${openAiDecisionPurposes.join(", ")}`);
}

function stringRecordParam(params: unknown, key: string): Record<string, string> | undefined {
  const value = asRecord(params)[key];
  if (value === undefined) return undefined;
  const record = asRecord(value);
  const entries = Object.entries(record).flatMap(([entryKey, entryValue]) =>
    typeof entryValue === "string" ? [[entryKey, entryValue] as const] : []
  );
  return Object.fromEntries(entries);
}

function wireGuardParam(params: unknown): WireGuardTunnelRequest | undefined {
  const value = asRecord(params).wireguard;
  if (value === undefined) return undefined;
  const record = asRecord(value);
  const hostRouting = asRecord(record.host_routing);
  const serviceCidrs = stringListParam(hostRouting, "service_cidrs");
  return {
    interfaceName: stringParam(record, "interface_name") || undefined,
    networkCidr: stringParam(record, "network_cidr") || undefined,
    cicloAddress: stringParam(record, "ciclo_address") || undefined,
    runnerAddress: stringParam(record, "runner_address") || undefined,
    cicloEndpoint: stringParam(record, "ciclo_endpoint") || undefined,
    cicloPublicKeySecretRef: stringParam(record, "ciclo_public_key_secret_ref") || undefined,
    cicloPrivateKeySecretRef: stringParam(record, "ciclo_private_key_secret_ref") || undefined,
    runnerPrivateKeySecretRef: stringParam(record, "runner_private_key_secret_ref") || undefined,
    runnerPublicKeySecretRef: stringParam(record, "runner_public_key_secret_ref") || undefined,
    existingConfigSecretName: stringParam(record, "existing_config_secret_name") || undefined,
    runnerPrivateKeyValue: stringParam(record, "runner_private_key_value") || undefined,
    cicloPublicKeyValue: stringParam(record, "ciclo_public_key_value") || undefined,
    cicloPrivateKeyValue: stringParam(record, "ciclo_private_key_value") || undefined,
    runnerPublicKeyValue: stringParam(record, "runner_public_key_value") || undefined,
    persistentKeepaliveSeconds: numberParam(record, "persistent_keepalive_seconds", 25),
    ...(record.host_routing === undefined ? {} : {
      hostRouting: {
        enabled: optionalBooleanParam(hostRouting, "enabled"),
        ...(serviceCidrs.length === 0 ? {} : { serviceCidrs }),
        routeAllTraffic: optionalBooleanParam(hostRouting, "route_all_traffic"),
        egressInterface: stringParam(hostRouting, "egress_interface") || undefined,
        masquerade: optionalBooleanParam(hostRouting, "masquerade")
      }
    })
  };
}

function remoteRunnerImageResolverParam(params: unknown): RemoteRunnerImageResolverRequest | undefined {
  const value = asRecord(params).image_resolver;
  if (value === undefined) return undefined;
  const record = asRecord(value);
  const harnessPackagesValue = asRecord(record.harness_packages);
  const harnessPackages = Object.fromEntries(
    Object.entries(harnessPackagesValue).flatMap(([key, item]) =>
      Array.isArray(item) ? [[key, item.filter((entry): entry is string => typeof entry === "string")]] : []
    )
  ) as RemoteRunnerImageResolverRequest["harnessPackages"];
  const strategy = stringParam(record, "strategy");
  const basePackages = stringListParam(record, "base_packages");
  const extraPackages = stringListParam(record, "extra_packages");
  return {
    ...(strategy.length === 0 ? {} : { strategy: strategy as RemoteRunnerImageResolverRequest["strategy"] }),
    image: stringParam(record, "image") || undefined,
    registry: stringParam(record, "registry") || undefined,
    repository: stringParam(record, "repository") || undefined,
    tag: stringParam(record, "tag") || undefined,
    variant: stringParam(record, "variant") || undefined,
    ...(basePackages.length === 0 ? {} : { basePackages }),
    ...(Object.keys(harnessPackages ?? {}).length === 0 ? {} : { harnessPackages }),
    ...(extraPackages.length === 0 ? {} : { extraPackages })
  };
}

function remoteRunnerPreflightParam(params: unknown): RemoteRunnerPreflightRequest | undefined {
  const value = asRecord(params).preflight;
  if (value === undefined) return undefined;
  const record = asRecord(value);
  const enabled = optionalBooleanParam(record, "enabled");
  const claude = optionalBooleanParam(record, "claude");
  const build = optionalBooleanParam(record, "build");
  const reportPath = stringParam(record, "report_path") || undefined;
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(claude === undefined ? {} : { claude }),
    ...(build === undefined ? {} : { build }),
    ...(reportPath === undefined ? {} : { reportPath })
  };
}

function remoteRunnerRepoBootstrapParam(params: unknown): RemoteRunnerRepoBootstrapRequest | undefined {
  const value = asRecord(params).repo_bootstrap;
  if (value === undefined) return undefined;
  const record = asRecord(value);
  const enabled = optionalBooleanParam(record, "enabled");
  const useDevenv = optionalBooleanParam(record, "use_devenv");
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(useDevenv === undefined ? {} : { useDevenv })
  };
}

function remoteRunnerEgressParam(params: unknown): RemoteRunnerEgressPolicyRequest | undefined {
  const value = asRecord(params).egress;
  if (value === undefined) return undefined;
  const record = asRecord(value);
  const enabled = optionalBooleanParam(record, "enabled");
  const name = stringParam(record, "name") || undefined;
  const cidrs = stringListParam(record, "cidrs");
  const domains = stringListParam(record, "domains");
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(name === undefined ? {} : { name }),
    ...(cidrs.length === 0 ? {} : { cidrs }),
    ...(domains.length === 0 ? {} : { domains })
  };
}

function stringListParam(params: unknown, key: string): readonly string[] {
  const value = asRecord(params)[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mcpClientListParam(params: unknown, key: string): readonly CicloMcpInstallClient[] | undefined {
  const clients = stringListParam(params, key).filter((client): client is CicloMcpInstallClient =>
    client === "claude" || client === "codex"
  );
  return clients.length === 0 ? undefined : [...new Set(clients)];
}

function assertMcpEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`MCP env name must be a shell-safe environment variable name: ${name}`);
  }
  if (name === "CICLO_PROJECT_ROOT" || name === "CICLO_CLAUDE_CHANNEL") {
    throw new Error(`MCP env name is reserved by Ciclo: ${name}`);
  }
}

function mcpEnvParam(params: unknown): Record<string, string> | undefined {
  const input = asRecord(params).mcp_env;
  if (input === undefined) return undefined;
  const env = asRecord(input);
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    assertMcpEnvName(name);
    if (typeof value !== "string") throw new Error(`mcp_env.${name} must be a string`);
    output[name] = value;
  }
  return output;
}

function workerEnvParam(params: unknown): Record<string, string> | undefined {
  const input = asRecord(params).worker_env;
  if (input === undefined) return undefined;
  const env = asRecord(input);
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    assertMcpEnvName(name);
    if (typeof value !== "string") throw new Error(`worker_env.${name} must be a string`);
    output[name] = value;
  }
  return output;
}

function mcpAdditionalServersParam(params: unknown): Record<string, CicloMcpAdditionalServerConfig> | undefined {
  const input = asRecord(params).mcp_additional_servers;
  if (input === undefined) return undefined;
  const servers = asRecord(input);
  const output: Record<string, CicloMcpAdditionalServerConfig> = {};
  for (const [name, value] of Object.entries(servers)) {
    const server = asRecord(value);
    const command = stringParam(server, "command");
    if (command.length === 0) throw new Error(`mcp_additional_servers.${name}.command is required`);
    output[name] = {
      command,
      args: stringListParam(server, "args"),
      env: stringRecordParam(server, "env") ?? {}
    };
  }
  return output;
}

interface McpSecretEnvRequest {
  readonly name: string;
  readonly providerId: string;
  readonly secretRef: string;
  readonly field?: string;
  readonly format?: string;
  readonly reason?: string;
}

function mcpSecretEnvRequests(params: unknown): readonly McpSecretEnvRequest[] {
  const input = asRecord(params).mcp_secret_env;
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("mcp_secret_env must be an array");
  return input.map((item) => {
    const record = asRecord(item);
    const name = stringParam(record, "env_name") || stringParam(record, "name");
    const providerId = stringParam(record, "provider_id");
    const secretRef = stringParam(record, "secret_ref") || stringParam(record, "ref");
    assertMcpEnvName(name);
    if (providerId.length === 0) throw new Error(`mcp_secret_env.${name} requires provider_id`);
    if (secretRef.length === 0) throw new Error(`mcp_secret_env.${name} requires secret_ref`);
    return {
      name,
      providerId,
      secretRef,
      field: stringParam(record, "field") || undefined,
      format: stringParam(record, "format") || stringParam(record, "value_format") || stringParam(record, "valueFormat") || undefined,
      reason: stringParam(record, "reason") || undefined
    };
  });
}

function workerSecretEnvRequests(params: unknown): readonly McpSecretEnvRequest[] {
  const input = asRecord(params).worker_secret_env;
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("worker_secret_env must be an array");
  return mcpSecretEnvRequests({ mcp_secret_env: input });
}

function worktreeParam(params: unknown):
  | { readonly create: boolean; readonly path?: string; readonly branch?: string; readonly base?: string; readonly force?: boolean }
  | undefined {
  const create = booleanParam(params, "create_worktree", false);
  const path = stringParam(params, "worktree_path") || undefined;
  const branch = stringParam(params, "worktree_branch") || undefined;
  const base = stringParam(params, "worktree_base") || undefined;
  const force = booleanParam(params, "worktree_force", false);
  if (!create && path === undefined && branch === undefined && base === undefined && !force) return undefined;
  return {
    create: create || path !== undefined || branch !== undefined || base !== undefined || force,
    ...(path === undefined ? {} : { path }),
    ...(branch === undefined ? {} : { branch }),
    ...(base === undefined ? {} : { base }),
    ...(force ? { force } : {})
  };
}

function isolationParam(params: unknown): "none" | "worktree" | undefined {
  const value = stringParam(params, "isolation");
  if (value === "none" || value === "worktree") return value;
  return undefined;
}

function heartbeatStateParam(params: unknown): "running" | "waiting_on_operator" | undefined {
  const value = stringParam(params, "state");
  if (value === "running" || value === "waiting_on_operator") return value;
  return undefined;
}

function staleAfterMs(params: unknown): number {
  return numberParam(params, "stale_after_ms", 10 * 60 * 1000);
}

function expectedPrAfterMs(params: unknown): number {
  return numberParam(params, "expected_pr_after_ms", 30 * 60 * 1000);
}

function memoryKindParam(params: unknown): "observation" | "learning" | "decision" | "summary" | undefined {
  const value = stringParam(params, "kind");
  if (value === "observation" || value === "learning" || value === "decision" || value === "summary") return value;
  return undefined;
}

function memoryImportanceParam(params: unknown): "low" | "normal" | "high" | undefined {
  const value = stringParam(params, "importance");
  if (value === "low" || value === "normal" || value === "high") return value;
  return undefined;
}

function memoryStateParam(params: unknown): "active" | "compacted" | "archived" | undefined {
  const value = stringParam(params, "state");
  if (value === "active" || value === "compacted" || value === "archived") return value;
  return undefined;
}

function responseId(request: JsonRpcRequest | undefined): string | number | null {
  return request?.id ?? null;
}

function success(request: JsonRpcRequest, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id: responseId(request), result };
}

function failure(request: JsonRpcRequest | undefined, code: number, message: string, data?: unknown): JsonRpcFailure {
  return { jsonrpc: "2.0", id: responseId(request), error: { code, message, data } };
}

function textContent(payload: unknown): { readonly content: readonly [{ readonly type: "text"; readonly text: string }]; readonly structuredContent: unknown } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

const defaultPolicy: PolicyConfig = {
  mode: "supervised",
  requireApprovalFor: [],
  allowCommands: []
};

function normalizeHarnessId(value: string): HarnessId {
  if (value === "claude-code" || value === "codex" || value === "pi" || value === "unknown") return value;
  return "unknown";
}

function loopFromParams(params: unknown, runtime: CicloMcpRuntimeContext): LoopConfig {
  const harnessId = normalizeHarnessId(stringParam(params, "harness_id", "unknown"));
  const runtimeLoop = runtime.loop;
  const loopId = stringParam(params, "loop_id", runtimeLoop?.id ?? "mcp-work");
  if (runtimeLoop !== undefined && runtimeLoop.id === loopId) return runtimeLoop;
  return {
    id: loopId,
    kind: "beads_work",
    goal: "MCP requested work mutation.",
    harnesses: harnessId === "unknown" ? ["codex", "claude-code"] : [harnessId],
    dryRun: runtimeLoop?.dryRun ?? false
  };
}

function reviewHarnessParam(params: unknown): WorkerHarnessId {
  const value = stringParam(params, "review_harness_id") || stringParam(params, "harness_id");
  return value === "claude-code" || value === "codex" ? value : "codex";
}

function reviewSessionCwd(params: unknown, runtime: CicloMcpRuntimeContext, beadId: string): string {
  const explicit = stringParam(params, "review_cwd");
  if (explicit.length > 0) return explicit;
  const worker = [...runtimeWorkers(runtime)].reverse().find((candidate) => candidate.beadId === beadId);
  return worker?.cwd ?? runtime.auth.session.projectRoot;
}

function validationEvidence(value: unknown): readonly ValidationEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const command = typeof record.command === "string" ? record.command : "";
    if (command.length === 0) return [];
    return [
      {
        command,
        passed: typeof record.passed === "boolean" ? record.passed : false,
        summary: typeof record.summary === "string" ? record.summary : ""
      }
    ];
  });
}

function runtimeBeadsClient(runtime: CicloMcpRuntimeContext): BeadsWorkClaimClient & BeadsProgressClient {
  return runtime.beadsClient ?? new BeadsClient(runtime.auth.session.projectRoot);
}

function idempotencyKey(tool: string, params: unknown): string | undefined {
  const explicit = stringParam(params, "idempotency_key");
  if (explicit.length > 0) return explicit;
  const beadId = stringParam(params, "bead_id");
  if (tool === "ciclo_update_work") {
    const kind = stringParam(params, "kind");
    const message = stringParam(params, "message");
    return beadId.length === 0 || kind.length === 0 ? undefined : `${tool}:${beadId}:${kind}:${message}`;
  }
  if (tool === "ciclo_close_work") {
    const summary = stringParam(params, "final_summary");
    return beadId.length === 0 || summary.length === 0 ? undefined : `${tool}:${beadId}:${summary}`;
  }
  if (tool === "ciclo_claim_work") {
    return beadId.length === 0 ? undefined : `${tool}:${beadId}`;
  }
  if (tool === "ciclo_sync_remote_trackers") {
    const dryRun = booleanParam(params, "dry_run", false);
    const loopId = stringParam(params, "loop_id");
    const beadPart = beadId.length === 0 ? "all" : beadId;
    const loopPart = loopId.length === 0 ? "default" : loopId;
    return `${tool}:${loopPart}:${beadPart}:${dryRun}`;
  }
  return undefined;
}

function idempotentResult(
  tool: string,
  params: unknown,
  runtime: CicloMcpRuntimeContext
): { readonly skipped: true; readonly payload: unknown } | undefined {
  const key = idempotencyKey(tool, params);
  if (key === undefined || runtime.mutationIdempotencyStore === undefined) return undefined;
  if (!runtime.mutationIdempotencyStore.has(key)) return undefined;
  return {
    skipped: true,
    payload: {
      mutated: false,
      idempotent: true,
      reason: "mutation skipped because idempotency key was already recorded",
      evidence: [`mcp.idempotent:${key}`]
    }
  };
}

function recordIdempotency(tool: string, params: unknown, runtime: CicloMcpRuntimeContext): void {
  const key = idempotencyKey(tool, params);
  if (key !== undefined) runtime.mutationIdempotencyStore?.add(key);
}

function trackerSyncInput(params: unknown): BeadsRemoteTrackerSyncInput {
  return {
    beadId: stringParam(params, "bead_id") || undefined,
    loopId: stringParam(params, "loop_id") || undefined,
    dryRun: booleanParam(params, "dry_run", false),
    force: booleanParam(params, "force", false),
    idempotencyKey: stringParam(params, "idempotency_key") || idempotencyKey("ciclo_sync_remote_trackers", params)
  };
}

function auditMutation(input: {
  readonly runtime: CicloMcpRuntimeContext;
  readonly tool: string;
  readonly action: SessionAccessAction;
  readonly authorization: AuthorizationResult;
  readonly reason: string;
  readonly evidence: readonly string[];
}): void {
  input.runtime.auditLog?.push({
    event: `mcp.${input.tool}`,
    tool: input.tool,
    action: input.action,
    principalId: input.authorization.principalId,
    decision: input.authorization.decision,
    reason: input.reason,
    evidence: input.evidence
  });
}

async function resolveMcpSecretEnvBindings(input: {
  readonly params: unknown;
  readonly runtime: CicloMcpRuntimeContext;
  readonly loopId?: string;
  readonly beadId?: string;
  readonly workerSessionId?: string;
  readonly dryRun: boolean;
}): Promise<readonly CicloMcpSecretEnvBinding[]> {
  const requests = [
    ...mcpSecretEnvRequests({ mcp_secret_env: configMcpSecretBindingParams(input.runtime.projectConfig ?? {}) }),
    ...mcpSecretEnvRequests(input.params)
  ];
  if (requests.length === 0) return [];

  const resolved: CicloMcpSecretEnvBinding[] = [];
  for (const request of requests) {
    const accessRequest = {
      action: "request_secret" as const,
      scope: { loopId: input.loopId, beadId: input.beadId },
      allowUnauthenticated: false
    };
    const authorization = authorizeClientRequest(input.runtime.auth, accessRequest);
    input.runtime.accessAuditLog?.push(buildAuthorizationAuditRecord(input.runtime.auth, accessRequest, authorization));
    if (authorization.decision === "deny") {
      throw new Error(`access denied for MCP secret env ${request.name}: ${authorization.reason}`);
    }

    auditMutation({
      runtime: input.runtime,
      tool: "ciclo_launch_worker_session.mcp_secret_env",
      action: "request_secret",
      authorization,
      reason: request.reason ?? `provide ${request.name} to configured MCP server`,
      evidence: [
        `secret.provider:${request.providerId}`,
        `secret.ref_hash:${secretRefHash(request.secretRef)}`,
        "mcp.secret_env:runtime_exec"
      ]
    });
    appendRuntimeEvent(input.runtime, {
      type: "secret.requested",
      loopId: input.loopId,
      beadId: input.beadId,
      workerSessionId: input.workerSessionId,
      evidence: [
        `secret.provider:${request.providerId}`,
        `secret.ref_hash:${secretRefHash(request.secretRef)}`,
        "mcp.secret_env:runtime_exec",
        ...(request.format === undefined ? [] : ["mcp.secret_env.format:applied"])
      ],
      data: {
        provider_id: request.providerId,
        provider_kind: "runtime",
        secret_ref_hash: secretRefHash(request.secretRef),
        field: request.field,
        env_name: request.name,
        target: "mcp_env",
        format_applied: request.format !== undefined,
        resolved: false,
        delivery: "runtime_exec"
      }
    });

    resolved.push({
      name: request.name,
      providerId: request.providerId,
      secretRef: request.secretRef,
      providerKind: "runtime",
      secretRefHash: secretRefHash(request.secretRef),
      field: request.field,
      format: request.format,
      evidence: [
        `secret.provider:${request.providerId}`,
        `secret.ref_hash:${secretRefHash(request.secretRef)}`,
        `mcp.secret_env:${request.name}`,
        ...(request.format === undefined ? [] : ["mcp.secret_env.format:applied"]),
        "mcp.secret_env:runtime_exec"
      ]
    });
  }
  return resolved;
}

async function resolveWorkerSecretEnvBindings(input: {
  readonly params: unknown;
  readonly runtime: CicloMcpRuntimeContext;
  readonly loopId?: string;
  readonly beadId?: string;
  readonly workerSessionId?: string;
}): Promise<readonly CicloMcpSecretEnvBinding[]> {
  const requests = [
    ...workerSecretEnvRequests({ worker_secret_env: configWorkerSecretBindingParams(input.runtime.projectConfig ?? {}) }),
    ...workerSecretEnvRequests(input.params)
  ];
  if (requests.length === 0) return [];

  const resolved: CicloMcpSecretEnvBinding[] = [];
  for (const request of requests) {
    const accessRequest = {
      action: "request_secret" as const,
      scope: { loopId: input.loopId, beadId: input.beadId },
      allowUnauthenticated: false
    };
    const authorization = authorizeClientRequest(input.runtime.auth, accessRequest);
    input.runtime.accessAuditLog?.push(buildAuthorizationAuditRecord(input.runtime.auth, accessRequest, authorization));
    if (authorization.decision === "deny") {
      throw new Error(`access denied for worker secret env ${request.name}: ${authorization.reason}`);
    }
    const evidence = [
      `secret.provider:${request.providerId}`,
      `secret.ref_hash:${secretRefHash(request.secretRef)}`,
      "worker.secret_env:runtime_exec",
      ...(request.format === undefined ? [] : ["worker.secret_env.format:applied"])
    ];
    auditMutation({
      runtime: input.runtime,
      tool: "ciclo_launch_worker_session.worker_secret_env",
      action: "request_secret",
      authorization,
      reason: request.reason ?? `provide ${request.name} to worker process`,
      evidence
    });
    appendRuntimeEvent(input.runtime, {
      type: "secret.requested",
      loopId: input.loopId,
      beadId: input.beadId,
      workerSessionId: input.workerSessionId,
      evidence,
      data: {
        provider_id: request.providerId,
        provider_kind: "runtime",
        secret_ref_hash: secretRefHash(request.secretRef),
        field: request.field,
        env_name: request.name,
        target: "worker_process_env",
        format_applied: request.format !== undefined,
        resolved: false,
        delivery: "runtime_exec"
      }
    });
    resolved.push({
      name: request.name,
      providerId: request.providerId,
      secretRef: request.secretRef,
      providerKind: "runtime",
      secretRefHash: secretRefHash(request.secretRef),
      field: request.field,
      format: request.format,
      evidence: [
        `secret.provider:${request.providerId}`,
        `secret.ref_hash:${secretRefHash(request.secretRef)}`,
        `worker.secret_env:${request.name}`,
        ...(request.format === undefined ? [] : ["worker.secret_env.format:applied"]),
        "worker.secret_env:runtime_exec"
      ]
    });
  }
  return resolved;
}

async function resolveAdditionalMcpServerSecretEnv(input: {
  readonly additionalServers?: Record<string, CicloMcpAdditionalServerConfig>;
  readonly runtime: CicloMcpRuntimeContext;
  readonly loopId?: string;
  readonly beadId?: string;
  readonly workerSessionId?: string;
  readonly dryRun: boolean;
}): Promise<{
  readonly additionalServers?: Record<string, CicloMcpAdditionalServerConfig>;
  readonly secretEnv: readonly CicloMcpAdditionalServerSecretEnvInstall[];
}> {
  const registry = input.runtime.secretProviderRegistry ?? createDefaultSecretProviderRegistry();
  return await resolveMcpAdditionalServerSecretPlaceholders({
    additionalServers: input.additionalServers,
    dryRun: input.dryRun,
    loopId: input.loopId,
    beadId: input.beadId,
    workerSessionId: input.workerSessionId,
    resolveSecret: async (request): Promise<SecretProviderResult> => {
      const accessRequest = {
        action: "request_secret" as const,
        scope: { loopId: input.loopId, beadId: input.beadId },
        allowUnauthenticated: false
      };
      const authorization = authorizeClientRequest(input.runtime.auth, accessRequest);
      input.runtime.accessAuditLog?.push(buildAuthorizationAuditRecord(input.runtime.auth, accessRequest, authorization));
      if (authorization.decision === "deny") {
        throw new Error(`access denied for MCP additional server secret ${request.providerId}: ${authorization.reason}`);
      }
      const result = await registry.resolve({
        providerId: request.providerId,
        secretRef: request.secretRef,
        field: request.field,
        loopId: input.loopId,
        beadId: input.beadId,
        workerSessionId: input.workerSessionId,
        principalId: authorization.principalId,
        reason: request.reason,
        dryRun: input.dryRun
      });
      auditMutation({
        runtime: input.runtime,
        tool: "mcp.additional_server.secret",
        action: "request_secret",
        authorization,
        reason: result.reason,
        evidence: result.evidence
      });
      appendRuntimeEvent(input.runtime, {
        type: "secret.requested",
        loopId: input.loopId,
        beadId: input.beadId,
        workerSessionId: input.workerSessionId,
        evidence: result.evidence,
        data: {
          provider_id: result.providerId,
          provider_kind: result.providerKind,
          secret_ref_hash: result.secretRefHash,
          field: result.field,
          target: "mcp_additional_server_env",
          resolved: result.resolved
        }
      });
      return result;
    }
  });
}

function promptArguments(prompt: McpPromptContract): readonly { readonly name: string; readonly required: boolean }[] {
  const properties = prompt.argumentsSchema.properties ?? {};
  const required = new Set(prompt.argumentsSchema.required ?? []);
  return Object.keys(properties).map((name) => ({ name, required: required.has(name) }));
}

function promptText(prompt: McpPromptContract, args: JsonRecord): string {
  const formattedArgs = Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
  return [
    prompt.description,
    "",
    `Purpose: ${prompt.outputPurpose}`,
    formattedArgs.length > 0 ? `Arguments:\n${formattedArgs}` : "Arguments: none supplied",
    "",
    "Return concise status, evidence, uncertainty, and the next safe action."
  ].join("\n");
}

function loopsFromStatus(status: CicloStandaloneStatus): readonly LoopStatus[] {
  return [
    {
      loop: {
        id: status.plan.loopId,
        kind: "review",
        state: status.plan.response,
        harnesses: ["pi", "codex", "claude-code"],
        dryRun: status.plan.dryRun
      },
      goal: "Review completed agent work and preserve evidence before mutating the repo.",
      policy: {
        mutations: "disabled_in_local_status_mode",
        networkListener: false,
        access: "single_user"
      },
      currentWork: null,
      evidence: status.plan.evidence
    }
  ];
}

function workerStateCounts(workers: readonly ReturnType<WorkerSessionSupervisor["list"]>[number][]): Record<string, number> {
  return workers.reduce<Record<string, number>>((counts, worker) => {
    counts[worker.state] = (counts[worker.state] ?? 0) + 1;
    return counts;
  }, {});
}

function workerUsageTotals(workers: readonly ReturnType<WorkerSessionSupervisor["list"]>[number][]): Record<string, number> {
  return workers.reduce<{ input_tokens: number; output_tokens: number; cost_usd: number }>((totals, worker) => ({
    input_tokens: totals.input_tokens + (worker.usage?.inputTokens ?? 0),
    output_tokens: totals.output_tokens + (worker.usage?.outputTokens ?? 0),
    cost_usd: totals.cost_usd + (worker.usage?.costUsd ?? 0)
  }), { input_tokens: 0, output_tokens: 0, cost_usd: 0 });
}

function timeInCurrentStateMs(worker: ReturnType<WorkerSessionSupervisor["list"]>[number], now = new Date().toISOString()): number {
  const enteredAt = Date.parse(worker.stateEnteredAt ?? worker.startedAt ?? now);
  const endAt = worker.stoppedAt === undefined ? Date.parse(now) : Date.parse(worker.stoppedAt);
  return Number.isFinite(enteredAt) && Number.isFinite(endAt) ? Math.max(0, endAt - enteredAt) : 0;
}

function timeSinceWorkerStartMs(worker: ReturnType<WorkerSessionSupervisor["list"]>[number], now = new Date().toISOString()): number {
  const startedAt = Date.parse(worker.startedAt ?? worker.stateEnteredAt ?? now);
  const nowMs = Date.parse(now);
  return Number.isFinite(startedAt) && Number.isFinite(nowMs) ? Math.max(0, nowMs - startedAt) : 0;
}

function refreshRuntimeStalled(runtime: CicloMcpRuntimeContext, thresholdMs: number): void {
  runtime.workerSupervisor?.refreshStalled(thresholdMs);
}

function recordValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventKey(...parts: readonly (string | number | undefined)[]): string {
  return parts.map((part) => String(part ?? "none")).join(":");
}

function appendDedupeRuntimeEvent(runtime: CicloMcpRuntimeContext, key: string, input: CicloEventInput): void {
  const keys = runtime.repoBoardEventKeys;
  if (keys !== undefined) {
    if (keys.has(key)) return;
    keys.add(key);
  }
  appendRuntimeEvent(runtime, input);
}

function emitRepoBoardEvents(
  runtime: CicloMcpRuntimeContext,
  worker: ReturnType<WorkerSessionSupervisor["list"]>[number],
  status: RepoBoardStatus,
  expectedPrAfterMsValue: number,
  now = new Date().toISOString()
): void {
  for (const pullRequest of status.pullRequests) {
    const state = recordValue(pullRequest, "state")?.toUpperCase();
    const url = recordValue(pullRequest, "url");
    const number = typeof pullRequest.number === "number" ? pullRequest.number : undefined;
    if (state === "OPEN") {
      appendDedupeRuntimeEvent(runtime, eventKey("pull_request.opened", worker.sessionId, url, number), {
        type: "pull_request.opened",
        workerSessionId: worker.sessionId,
        loopId: worker.loopId,
        beadId: worker.beadId,
        evidence: ["repo_board.pull_request.opened", ...status.evidence],
        data: { pull_request: pullRequest, branch: worker.worktree?.branch }
      });
    }
    if (state === "MERGED") {
      appendDedupeRuntimeEvent(runtime, eventKey("pull_request.merged", worker.sessionId, url, number), {
        type: "pull_request.merged",
        workerSessionId: worker.sessionId,
        loopId: worker.loopId,
        beadId: worker.beadId,
        evidence: ["repo_board.pull_request.merged", ...status.evidence],
        data: { pull_request: pullRequest, branch: worker.worktree?.branch }
      });
    }
  }

  for (const check of status.ci) {
    const conclusion = recordValue(check, "conclusion")?.toUpperCase();
    const name = recordValue(check, "name");
    if (conclusion === "SUCCESS") {
      appendDedupeRuntimeEvent(runtime, eventKey("validation.passed", worker.sessionId, name, conclusion), {
        type: "validation.passed",
        workerSessionId: worker.sessionId,
        loopId: worker.loopId,
        beadId: worker.beadId,
        evidence: ["repo_board.validation.passed", ...status.evidence],
        data: { check, branch: worker.worktree?.branch }
      });
    }
    if (conclusion !== undefined && ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(conclusion)) {
      appendDedupeRuntimeEvent(runtime, eventKey("validation.failed", worker.sessionId, name, conclusion), {
        type: "validation.failed",
        workerSessionId: worker.sessionId,
        loopId: worker.loopId,
        beadId: worker.beadId,
        evidence: ["repo_board.validation.failed", ...status.evidence],
        data: { check, branch: worker.worktree?.branch }
      });
    }
  }

  if (
    worker.worktree?.branch !== undefined &&
    status.pullRequests.length === 0 &&
    worker.state !== "planned" &&
    Number.isFinite(expectedPrAfterMsValue) &&
    expectedPrAfterMsValue > 0 &&
    timeSinceWorkerStartMs(worker, now) >= expectedPrAfterMsValue
  ) {
    appendDedupeRuntimeEvent(runtime, eventKey("expected_pr.missing", worker.sessionId, worker.worktree.branch), {
      type: "blocker.raised",
      workerSessionId: worker.sessionId,
      loopId: worker.loopId,
      beadId: worker.beadId,
      evidence: [
        "repo_board.expected_pr:missing",
        `repo_board.expected_pr_after_ms:${expectedPrAfterMsValue}`,
        `repo_board.branch:${worker.worktree.branch}`,
        ...status.evidence
      ],
      data: {
        kind: "expected_pr_missing",
        branch: worker.worktree.branch,
        worker_state: worker.state,
        recovery_actions: [
          "inspect worker transcript through ciclo_attach_plan or Herdr",
          "stop the stale worker with ciclo_stop_worker_session",
          "relaunch the bead with ciclo_launch_worker_session and isolation:worktree"
        ]
      }
    });
  }
}

function loopState(workers: readonly ReturnType<WorkerSessionSupervisor["list"]>[number][], pendingQuestions: readonly PendingQuestion[]): string {
  if (pendingQuestions.length > 0) return "waiting_on_operator";
  if (workers.some((worker) => worker.state === "running")) return "running";
  if (workers.some((worker) => worker.state === "failed")) return "failed";
  if (workers.length > 0 && workers.every((worker) => worker.state === "completed")) return "completed";
  if (workers.some((worker) => worker.state === "planned")) return "planned";
  if (workers.some((worker) => worker.state === "stopped")) return "stopped";
  return "idle";
}

function runtimeWorkers(runtime: CicloMcpRuntimeContext): readonly ReturnType<WorkerSessionSupervisor["list"]>[number][] {
  return runtime.workerSupervisor?.list() ?? [];
}

function publicMcpConfig(
  config: ReturnType<WorkerSessionSupervisor["list"]>[number]["mcpConfig"]
): Record<string, unknown> | undefined {
  if (config === undefined) return undefined;
  const { env: _env, secretEnvBindings: _secretEnvBindings, additionalServerSecretEnv: _additionalServerSecretEnv, ...safeConfig } = config;
  const additionalServers: Record<string, CicloMcpAdditionalServerConfig> = {};
  for (const [name, server] of Object.entries(config.additionalServers)) {
    additionalServers[name] = {
      command: server.command,
      args: [...server.args],
      env: { ...server.env }
    };
  }
  for (const binding of config.additionalServerSecretEnv) {
    const server = additionalServers[binding.serverName];
    if (server !== undefined) server.env[binding.envName] = "[redacted secret]";
  }
  return { ...safeConfig, additionalServers };
}

function publicWorkerSession(
  worker: ReturnType<WorkerSessionSupervisor["list"]>[number]
): Record<string, unknown> {
  return {
    ...worker,
    ...(worker.mcpConfig === undefined ? {} : { mcpConfig: publicMcpConfig(worker.mcpConfig) })
  };
}

function pendingQuestions(runtime: CicloMcpRuntimeContext): readonly PendingQuestion[] {
  return runtime.operatorRouting?.listQuestions() ?? [];
}

function runtimeOwnsAutomation(runtime: CicloMcpRuntimeContext): boolean {
  return ownsMcpAutomation(runtime.mcpLeadership);
}

function loopIdsFromRuntime(runtime: CicloMcpRuntimeContext, workers: readonly ReturnType<WorkerSessionSupervisor["list"]>[number][]): readonly string[] {
  return [...new Set([
    ...(runtime.loop === undefined ? [] : [runtime.loop.id]),
    ...workers.map((worker) => worker.loopId),
    ...pendingQuestions(runtime).flatMap((question) => question.loopId === undefined ? [] : [question.loopId])
  ])];
}

function liveLoop(loopId: string, runtime: CicloMcpRuntimeContext): LoopStatus | undefined {
  const workers = runtimeWorkers(runtime).filter((worker) => worker.loopId === loopId);
  const questions = pendingQuestions(runtime).filter((question) => question.loopId === loopId);
  const configured = runtime.loop?.id === loopId ? runtime.loop : undefined;
  if (configured === undefined && workers.length === 0 && questions.length === 0) return undefined;
  return {
    loop: {
      id: loopId,
      kind: configured?.kind ?? "worker_session",
      state: loopState(workers, questions),
      harnesses: configured?.harnesses ?? [...new Set(workers.map((worker) => worker.harnessId))],
      dryRun: configured?.dryRun ?? workers.every((worker) => worker.state === "planned")
    },
    goal: configured?.goal ?? `Coordinate ${loopId} worker sessions.`,
    policy: {
      mutations: "mcp_runtime",
      networkListener: false,
      access: runtime.auth.session.mode
    },
    currentWork: workers.find((worker) => worker.state === "running") ?? workers[0] ?? null,
    evidence: [
      `loop.live:${loopId}`,
      `loop.workers:${workers.length}`,
      `loop.questions.pending:${questions.length}`
    ]
  };
}

async function liveLoopStatus(loopId: string, service: CicloMcpReadService, runtime: CicloMcpRuntimeContext): Promise<LoopStatus> {
  const live = liveLoop(loopId, runtime);
  if (live !== undefined) return live;
  return await service.loopStatus(loopId);
}

function boardRows(
  runtime: CicloMcpRuntimeContext,
  ready: ReadyWorkView,
  repoStatuses: ReadonlyMap<string, RepoBoardStatus>,
  expectedPrAfterMsValue: number
): readonly Record<string, unknown>[] {
  const workers = runtimeWorkers(runtime);
  const now = new Date().toISOString();
  const workerBeads = new Set(workers.flatMap((worker) => worker.beadId === undefined ? [] : [worker.beadId]));
  const workerRows = workers.map((worker) => ({
    bead_id: worker.beadId,
    loop_id: worker.loopId,
    worker_session_id: worker.sessionId,
    worker_state: worker.state,
    harness_id: worker.harnessId,
    session_name: worker.sessionName,
    tracking_mode: worker.trackingMode,
    launch_mode: worker.launchMode,
    agent_ref: worker.agentRef,
    cwd: worker.cwd,
    worktree: worker.worktree,
    branch: worker.worktree?.branch,
    state_entered_at: worker.stateEnteredAt,
    time_in_state_ms: timeInCurrentStateMs(worker, now),
    last_heartbeat_at: worker.lastHeartbeatAt,
    usage: worker.usage,
    pull_requests: repoStatuses.get(worker.sessionId)?.pullRequests ?? [],
    ci: repoStatuses.get(worker.sessionId)?.ci ?? [],
    merge_state: repoStatuses.get(worker.sessionId)?.mergeState,
    validation: repoStatuses.get(worker.sessionId)?.ci ?? [],
    artifact_status: worker.worktree?.branch !== undefined &&
      (repoStatuses.get(worker.sessionId)?.pullRequests.length ?? 0) === 0 &&
      worker.state !== "planned" &&
      timeSinceWorkerStartMs(worker, now) >= expectedPrAfterMsValue
        ? "expected_pr_missing"
        : "ok",
    recovery_actions: worker.worktree?.branch !== undefined &&
      (repoStatuses.get(worker.sessionId)?.pullRequests.length ?? 0) === 0 &&
      worker.state !== "planned" &&
      timeSinceWorkerStartMs(worker, now) >= expectedPrAfterMsValue
        ? [
            "inspect worker transcript through ciclo_attach_plan or Herdr",
            "stop the stale worker with ciclo_stop_worker_session",
            "relaunch the bead with ciclo_launch_worker_session and isolation:worktree"
          ]
        : [],
    needs_operator: pendingQuestions(runtime).some((question) =>
      question.workerSessionId === worker.sessionId || question.loopId === worker.loopId || question.beadId === worker.beadId
    )
  }));
  const readyRows = ready.work
    .filter((work) => !workerBeads.has(work.id))
    .map((work) => ({
      bead_id: work.id,
      loop_id: null,
      worker_session_id: null,
      worker_state: "queued",
      harness_id: null,
      title: work.title,
      priority: work.priority,
      pull_requests: [],
      validation: [],
      needs_operator: pendingQuestions(runtime).some((question) => question.beadId === work.id)
    }));
  return [...workerRows, ...readyRows];
}

async function liveBoard(
  service: CicloMcpReadService,
  runtime: CicloMcpRuntimeContext,
  thresholdMs = 10 * 60 * 1000,
  expectedPrAfterMsValue = 30 * 60 * 1000
): Promise<Record<string, unknown>> {
  refreshRuntimeStalled(runtime, thresholdMs);
  const ready = await service.readyWork();
  const workers = runtimeWorkers(runtime);
  const questions = pendingQuestions(runtime);
  const supervisorMetrics = runtime.workerSupervisor?.metrics();
  const repoStatuses = new Map(workers.map((worker) => [
    worker.sessionId,
    (runtime.repoBoardProvider ?? new GitHubCliRepoBoardProvider()).statusForBranch(worker.worktree?.branch, worker.cwd)
  ]));
  for (const worker of workers) {
    const status = repoStatuses.get(worker.sessionId);
    if (status !== undefined) emitRepoBoardEvents(runtime, worker, status, expectedPrAfterMsValue);
  }
  return {
    rows: boardRows(runtime, ready, repoStatuses, expectedPrAfterMsValue),
    rollup: {
      workers: {
        total: workers.length,
        by_state: supervisorMetrics?.byState ?? workerStateCounts(workers),
        time_in_state_ms: supervisorMetrics?.timeInStateMs ?? {},
        usage: supervisorMetrics === undefined ? workerUsageTotals(workers) : {
          input_tokens: supervisorMetrics.usage.inputTokens,
          output_tokens: supervisorMetrics.usage.outputTokens,
          cost_usd: supervisorMetrics.usage.costUsd
        }
      },
      ready_beads: ready.work.length,
      pending_questions: questions.length
    },
    evidence: [
      "board.live:true",
      `board.workers:${workers.length}`,
      `board.ready_beads:${ready.work.length}`,
      `board.pending_questions:${questions.length}`,
      ...[...repoStatuses.values()].flatMap((status) => status.evidence)
    ]
  };
}

async function liveStatus(service: CicloMcpReadService, runtime: CicloMcpRuntimeContext, thresholdMs = 10 * 60 * 1000): Promise<Record<string, unknown>> {
  refreshRuntimeStalled(runtime, thresholdMs);
  const workers = runtimeWorkers(runtime);
  const ready = await service.readyWork();
  const questions = pendingQuestions(runtime);
  const feedback = runtime.operatorRouting?.listFeedback() ?? [];
  const loopIds = loopIdsFromRuntime(runtime, workers);
  const supervisorMetrics = runtime.workerSupervisor?.metrics();
  return {
    ok: true,
    app: "ciclo",
    runtime: runtimeDecision.runtime,
    mcp: mcpLeadershipView(runtime.mcpLeadership),
    brain: runtime.openAiBrain?.status() ?? openAiBrainPolicy,
    live: true,
    heartbeat: runtime.internalHeartbeat?.status() ?? {
      running: false,
      intervalMs: 0,
      claudeChannel: {
        enabled: runtime.claudeChannel?.enabled === true,
        communicationReady: false,
        connectedWorkers: 0
      },
      monologue: [],
      evidence: ["heartbeat.internal:unavailable"]
    },
    cron: runtime.cronScheduler?.status(runtime.projectConfig?.cron?.jobs ?? [], new Date().toISOString()) ?? {
      jobs: [],
      due: [],
      recent_runs: [],
      evidence: ["cron.scheduler:unavailable"]
    },
    memory: runtime.memoryStore?.status() ?? {
      total: 0,
      active: 0,
      evidence: ["memory.store:unavailable"]
    },
    loops: loopIds.map((loopId) => liveLoop(loopId, runtime)).filter((loop): loop is LoopStatus => loop !== undefined),
    workers: {
      total: workers.length,
      by_state: supervisorMetrics?.byState ?? workerStateCounts(workers),
      time_in_state_ms: supervisorMetrics?.timeInStateMs ?? {},
      usage: supervisorMetrics === undefined ? workerUsageTotals(workers) : {
        input_tokens: supervisorMetrics.usage.inputTokens,
        output_tokens: supervisorMetrics.usage.outputTokens,
        cost_usd: supervisorMetrics.usage.costUsd
      },
      sessions: workers
    },
    beads: {
      ready_count: ready.work.length,
      selected: ready.selected,
      work: ready.work,
      skipped: ready.skipped,
      evidence: ready.evidence
    },
    questions: {
      pending: questions.length,
      items: questions
    },
    feedback: {
      count: feedback.length,
      items: feedback
    },
    remotes: runtime.remoteRunnerRegistry?.list() ?? [],
    config: {
      loaded: runtime.projectConfig !== undefined,
      value: runtime.projectConfig === undefined ? undefined : redactedCicloProjectConfig(runtime.projectConfig),
      evidence: runtime.projectConfigEvidence ?? []
    },
    access: clientAccessView(runtime.auth),
    evidence: [
      "status.live:true",
      `status.workers:${workers.length}`,
      `status.ready_beads:${ready.work.length}`,
      `status.pending_questions:${questions.length}`
    ]
  };
}

export function createLocalMcpReadService(root = process.cwd()): CicloMcpReadService {
  return {
    async status() {
      return buildStandaloneStatus();
    },
    async loopStatus(loopId) {
      const status = buildStandaloneStatus();
      const loop = loopsFromStatus(status).find((entry) => entry.loop.id === loopId);
      if (loop !== undefined) return loop;
      return {
        loop: {
          id: loopId,
          kind: "unknown",
          state: "unknown",
          harnesses: [],
          dryRun: true
        },
        goal: "Unknown loop.",
        policy: {
          mutations: "disabled_in_local_status_mode",
          networkListener: false,
          access: "single_user"
        },
        currentWork: null,
        evidence: [`loop:${loopId}:not_found`]
      };
    },
    async readyWork(limit = 20) {
      const client = new BeadsClient(root);
      try {
        const work = await client.ready(limit);
        return {
          selected: work[0] ?? null,
          work,
          skipped: [],
          evidence: ["beads.ready:queried"]
        };
      } catch (error) {
        const reason = error instanceof BeadsError ? error.kind : "unknown";
        return {
          selected: null,
          work: [],
          skipped: [],
          evidence: [`beads.ready:unavailable:${reason}`]
        };
      }
    },
    async questions() {
      return [];
    },
    async feedback() {
      return [];
    }
  };
}

export function createLocalMcpRuntimeContext(root = process.cwd()): CicloMcpRuntimeContext {
  const loadedConfig = loadCicloProjectConfig(root);
  const tokenRegistry = new TokenRegistry();
  const auth = {
    ...defaultClientAuthContext(root),
    tokenRegistry
  };
  const leadership = acquireMcpSessionLeadership({
    projectRoot: auth.session.projectRoot,
    sessionId: auth.session.id,
    sessionName: auth.session.name
  });
  const userPaneTarget = userControlPaneTargetFromEnv();
  const userPaneNotifier = userPaneTarget === undefined ? undefined : new UserControlPaneNotifier(userPaneTarget);
  const eventStore = new CicloEventStore({
    persistPath: cicloEventLogPath(root),
    ...(userPaneNotifier === undefined ? {} : { onAppend: (event) => { userPaneNotifier.notify(event); } })
  });
  eventStore.append({
    type: "mcp.leadership",
    evidence: leadership.evidence,
    data: mcpLeadershipView(leadership)
  });
  const cronScheduler = new CicloCronScheduler({ projectRoot: root });
  const memoryStore = new CicloMemoryStore({ projectRoot: root, eventSink: eventStore });
  const runtime: CicloMcpRuntimeContext = {
    auth,
    projectConfig: loadedConfig.found ? loadedConfig.config : undefined,
    projectConfigEvidence: loadedConfig.evidence,
    claudeChannel: {
      enabled: process.env.CICLO_CLAUDE_CHANNEL === "true"
    },
    eventStore,
    cronScheduler,
    memoryStore,
    deviceFlow: new DeviceAuthorizationFlow({
      verificationUri: "http://127.0.0.1:0/oauth/device"
    }),
    operatorRouting: new OperatorRoutingStore(),
    beadsClient: new BeadsClient(root),
    workerSupervisor: new WorkerSessionSupervisor(root, undefined, undefined, eventStore),
    remoteRunnerRegistry: new RemoteRunnerRegistry(),
    secretProviderRegistry: createDefaultSecretProviderRegistry(),
    openAiBrain: new PiSdkOpenAiBrain({ promptInjections: loadedConfig.config.prompts?.systemInjections }),
    mcpLeadership: leadership,
    ...(userPaneNotifier === undefined ? {} : { userPaneNotifier }),
    repoBoardProvider: new GitHubCliRepoBoardProvider(),
    repoBoardEventKeys: new Set<string>()
  };
  return {
    ...runtime,
    internalHeartbeat: new CicloInternalHeartbeat(runtime)
  };
}

function appendRuntimeEvent(runtime: CicloMcpRuntimeContext, input: CicloEventInput): void {
  runtime.eventStore?.append(input);
}

export async function createLocalMcpRuntimeContextWithPlugins(root = process.cwd()): Promise<CicloMcpRuntimeContext> {
  const loadedConfig = loadCicloProjectConfig(root);
  const pluginRegistry = createDefaultRemoteRunnerPluginRegistry();
  const imageResolverRegistry = createDefaultRemoteRunnerImageResolverRegistry();
  const secretProviderRegistry = createSecretProviderRegistryFromConfig(loadedConfig.config);
  await activateConfiguredPlugins(pluginRegistry, defaultPluginPaths(root), secretProviderRegistry, imageResolverRegistry);
  const base = createLocalMcpRuntimeContext(root);
  const runtime: CicloMcpRuntimeContext = {
    ...base,
    projectConfig: loadedConfig.found ? loadedConfig.config : undefined,
    projectConfigEvidence: loadedConfig.evidence,
    remoteRunnerRegistry: new RemoteRunnerRegistry(pluginRegistry, imageResolverRegistry),
    secretProviderRegistry,
    openAiBrain: new PiSdkOpenAiBrain({ promptInjections: loadedConfig.config.prompts?.systemInjections }),
    userPaneNotifier: base.userPaneNotifier
  };
  return {
    ...runtime,
    internalHeartbeat: new CicloInternalHeartbeat(runtime)
  };
}

function authDeviceStatus(outcome: string): string {
  if (outcome === "access_denied") return "denied";
  if (outcome === "expired_token") return "expired";
  return outcome;
}

function clientKind(value: string): DeviceClientKind {
  if (value === "mcp_http" || value === "remote_worker") return value;
  return "cli";
}

async function callTool(
  name: string,
  params: unknown,
  service: CicloMcpReadService,
  runtime: CicloMcpRuntimeContext,
  authorization: AuthorizationResult
): Promise<unknown> {
  if (name === "ciclo_status") {
    const status = await liveStatus(service, runtime, staleAfterMs(params));
    const statusRecord = asRecord(status);
    const statusLoops = Array.isArray(statusRecord.loops) ? statusRecord.loops : [];
    const statusRemotes = Array.isArray(statusRecord.remotes) ? statusRecord.remotes : [];
    const accessRecord = asRecord(statusRecord.access);
    const heartbeatRecord = asRecord(statusRecord.heartbeat);
    appendRuntimeEvent(runtime, {
      type: "status.checked",
      evidence: ["mcp.status:checked"],
      data: {
        loops: statusLoops.length,
        remote_sessions: statusRemotes.length,
        access_mode: accessRecord.mode,
        heartbeat_running: heartbeatRecord.running === true
      }
    });
    return textContent(status);
  }

  if (name === "ciclo_loop_status") {
    const loopId = stringParam(params, "loop_id", "review-demo");
    const loop = await liveLoopStatus(loopId, service, runtime);
    appendRuntimeEvent(runtime, {
      type: "loop.checked",
      loopId,
      evidence: loop.evidence,
      data: { state: loop.loop.state, kind: loop.loop.kind }
    });
    return textContent(loop);
  }

  if (name === "ciclo_decide") {
    const brain = runtime.openAiBrain ?? new PiSdkOpenAiBrain();
    const purpose = openAiDecisionPurposeParam(stringParam(params, "purpose"));
    const decision = await brain.decide({
      purpose,
      prompt: stringParam(params, "prompt"),
      context: stringListParam(params, "context"),
      evidence: stringListParam(params, "evidence"),
      loopId: stringParam(params, "loop_id") || undefined,
      beadId: stringParam(params, "bead_id") || undefined,
	      harnessId: stringParam(params, "harness_id") || undefined,
	      remoteSessionId: stringParam(params, "remote_session_id") || undefined,
	      workerSessionId: stringParam(params, "worker_session_id") || undefined,
	      promptInjections: runtime.projectConfig?.prompts?.systemInjections,
	      toolExecutor: runtime.internalHeartbeat?.decisionToolExecutor(new Date().toISOString())
	    });
    auditMutation({
      runtime,
      tool: name,
      action: "use_brain",
      authorization,
      reason: `OpenAI brain decision for ${purpose}`,
      evidence: decision.evidence
    });
    appendRuntimeEvent(runtime, {
      type: "brain.decision",
      loopId: stringParam(params, "loop_id") || undefined,
      beadId: stringParam(params, "bead_id") || undefined,
      workerSessionId: stringParam(params, "worker_session_id") || undefined,
      evidence: decision.evidence,
      data: {
        purpose,
        provider: decision.provider,
        adapter: decision.adapter,
        intelligence: decision.intelligence,
	        model_family: decision.modelFamily,
	        model: decision.model,
	        thinking: decision.thinking,
	        tool_results: decision.toolResults?.map((result) => ({
	          name: result.name,
	          ok: result.ok,
	          summary: result.summary,
	          evidence: result.evidence
	        })) ?? []
	      }
	    });
    return textContent({
      decision: decision.text,
      provider: decision.provider,
      adapter: decision.adapter,
      intelligence: decision.intelligence,
      model_family: decision.modelFamily,
	      model: decision.model,
	      thinking: decision.thinking,
	      purpose: decision.purpose,
	      tool_results: decision.toolResults?.map((result) => ({
	        name: result.name,
	        ok: result.ok,
	        summary: result.summary,
	        evidence: result.evidence
	      })) ?? [],
	      evidence: decision.evidence
	    });
  }

  if (name === "ciclo_poll_events") {
    const cursor = numberParam(params, "cursor", 0);
    const limit = numberParam(params, "limit", 100);
    const poll = runtime.eventStore?.poll(cursor, limit) ?? runtime.workerSupervisor?.pollEvents(cursor, limit) ?? {
      cursor,
      nextCursor: cursor,
      events: []
    };
    return textContent({
      cursor: poll.cursor,
      next_cursor: poll.nextCursor,
      events: poll.events
    });
  }

  if (name === "ciclo_remember") {
    if (runtime.memoryStore === undefined) throw new Error("Ciclo memory store is unavailable");
    const entry = runtime.memoryStore.record({
      kind: memoryKindParam(params),
      content: stringParam(params, "content"),
      tags: stringListParam(params, "tags"),
      importance: memoryImportanceParam(params) ?? runtime.projectConfig?.memory?.defaultImportance,
      confidence: numberParam(params, "confidence", 0.7),
      loopId: stringParam(params, "loop_id") || undefined,
      beadId: stringParam(params, "bead_id") || undefined,
      workerSessionId: stringParam(params, "worker_session_id") || undefined,
      remoteSessionId: stringParam(params, "remote_session_id") || undefined,
      evidence: stringListParam(params, "evidence")
    });
    auditMutation({
      runtime,
      tool: name,
      action: "update_beads_progress",
      authorization,
      reason: "Ciclo durable memory recorded",
      evidence: entry.evidence
    });
    return textContent({ memory: entry, evidence: entry.evidence });
  }

  if (name === "ciclo_list_memories") {
    const memories = runtime.memoryStore?.list({
      loopId: stringParam(params, "loop_id") || undefined,
      beadId: stringParam(params, "bead_id") || undefined,
      workerSessionId: stringParam(params, "worker_session_id") || undefined,
      remoteSessionId: stringParam(params, "remote_session_id") || undefined,
      tag: stringParam(params, "tag") || undefined,
      state: memoryStateParam(params),
      limit: numberParam(params, "limit", 100)
    }) ?? [];
    return textContent({ memories, status: runtime.memoryStore?.status() ?? { evidence: ["memory.store:unavailable"] } });
  }

  if (name === "ciclo_compact_memories") {
    if (runtime.memoryStore === undefined) throw new Error("Ciclo memory store is unavailable");
    const result = runtime.memoryStore.compact({
      compactAfterDays: numberParam(params, "compact_after_days", runtime.projectConfig?.memory?.compactAfterDays ?? 14),
      archiveAfterDays: numberParam(params, "archive_after_days", runtime.projectConfig?.memory?.archiveAfterDays ?? 90),
      minCompoundEntries: numberParam(params, "min_compound_entries", runtime.projectConfig?.memory?.minCompoundEntries ?? 3),
      maxSummaryCharacters: numberParam(params, "max_summary_characters", runtime.projectConfig?.memory?.maxSummaryCharacters ?? 1600)
    });
    auditMutation({
      runtime,
      tool: name,
      action: "update_beads_progress",
      authorization,
      reason: "Ciclo memory compaction ran",
      evidence: result.evidence
    });
    return textContent(result);
  }

  if (name === "ciclo_list_cron_jobs") {
    const now = new Date().toISOString();
    return textContent(runtime.cronScheduler?.status(runtime.projectConfig?.cron?.jobs ?? [], now) ?? {
      jobs: [],
      due: [],
      recent_runs: [],
      evidence: ["cron.scheduler:unavailable"]
    });
  }

  if (name === "ciclo_run_due_cron") {
    if (runtime.internalHeartbeat === undefined) throw new Error("Ciclo internal heartbeat is unavailable");
    if (!runtimeOwnsAutomation(runtime)) throw new Error("Ciclo due cron can only run in the MCP automation leader");
    const result = await runtime.internalHeartbeat.tick();
    auditMutation({
      runtime,
      tool: name,
      action: "update_beads_progress",
      authorization,
      reason: "Ciclo due cron evaluated through heartbeat",
      evidence: result.evidence
    });
    return textContent({
      checked_at: result.checkedAt,
      cron_due: result.cronDue,
      cron_runs: result.cronRuns,
      memory_compactions: result.memoryCompactions,
      evidence: result.evidence
    });
  }

  if (name === "ciclo_board") {
    const board = await liveBoard(service, runtime, staleAfterMs(params), expectedPrAfterMs(params));
    const boardRecord = asRecord(board);
    const boardRowsValue = Array.isArray(boardRecord.rows) ? boardRecord.rows : [];
    const boardEvidence = Array.isArray(boardRecord.evidence) ? boardRecord.evidence.filter((item): item is string => typeof item === "string") : [];
    const boardRollup = asRecord(boardRecord.rollup);
    const boardWorkers = asRecord(boardRollup.workers);
    appendRuntimeEvent(runtime, {
      type: "board.checked",
      evidence: ["mcp.board:checked", ...boardEvidence],
      data: {
        rows: boardRowsValue.length,
        workers_total: boardWorkers.total,
        ready_beads: boardRollup.ready_beads,
        pending_questions: boardRollup.pending_questions
      }
    });
    return textContent(board);
  }

  if (name === "ciclo_list_ready_work") {
    const ready = await service.readyWork(numberParam(params, "limit", 20));
    appendRuntimeEvent(runtime, {
      type: "work.ready_listed",
      evidence: ready.evidence,
      data: {
        selected: ready.selected?.id,
        work_count: ready.work.length,
        skipped_count: ready.skipped.length
      }
    });
    return textContent(ready);
  }

  if (name === "ciclo_ask_operator") {
    const routing = runtime.operatorRouting ?? new OperatorRoutingStore();
    const result = routing.ask({
      loopId: stringParam(params, "loop_id") || undefined,
      beadId: stringParam(params, "bead_id") || undefined,
      harnessId: stringParam(params, "harness_id") || undefined,
      remoteSessionId: stringParam(params, "remote_session_id") || undefined,
      workerSessionId: stringParam(params, "worker_session_id") || undefined,
      question: stringParam(params, "question"),
      urgency: urgencyParam(stringParam(params, "urgency")),
      principalId: authorization.principalId,
      evidence: stringListParam(params, "evidence")
    });
    const waitingWorkers = runtime.workerSupervisor?.markWaitingOnOperator({
      sessionId: stringParam(params, "worker_session_id") || undefined,
      loopId: stringParam(params, "loop_id") || undefined,
      beadId: stringParam(params, "bead_id") || undefined
    }, result.evidence) ?? [];
    auditMutation({
      runtime,
      tool: name,
      action: "answer_agent_question",
      authorization,
      reason: result.deduplicated ? "operator question was deduplicated" : "operator question was queued",
      evidence: result.evidence
    });
    appendRuntimeEvent(runtime, {
      type: "question.asked",
      loopId: stringParam(params, "loop_id") || undefined,
      beadId: stringParam(params, "bead_id") || undefined,
      workerSessionId: stringParam(params, "worker_session_id") || undefined,
      evidence: result.evidence,
      data: { question_id: result.questionId, urgency: result.question.urgency, waiting_workers: waitingWorkers.length }
    });
    runtime.userPaneNotifier?.notifyMessage({
      title: result.question.urgency === "blocking" ? "Ciclo needs blocking input" : "Ciclo needs input",
      body: [
        result.question.question,
        `Question ${result.questionId}`,
        result.question.beadId === undefined ? undefined : `Bead ${result.question.beadId}`,
        result.question.loopId === undefined ? undefined : `Loop ${result.question.loopId}`
      ].filter((line): line is string => line !== undefined).join("\n"),
      sound: result.question.urgency === "low" ? "none" : "request"
    });
    if (result.question.urgency === "blocking") {
      appendRuntimeEvent(runtime, {
        type: "blocker.raised",
        loopId: stringParam(params, "loop_id") || undefined,
        beadId: stringParam(params, "bead_id") || undefined,
        evidence: result.evidence,
        data: { question_id: result.questionId }
      });
    }
    return textContent({
      question_id: result.questionId,
      queued: result.queued,
      deduplicated: result.deduplicated,
      question: result.question,
      waiting_workers: waitingWorkers,
      evidence: result.evidence
    });
  }

  if (name === "ciclo_answer_question") {
    const routing = runtime.operatorRouting ?? new OperatorRoutingStore();
    const result = routing.answer({
      questionId: stringParam(params, "question_id"),
      answer: stringParam(params, "answer"),
      principalId: authorization.principalId,
      evidence: stringListParam(params, "evidence")
    });
    const resumedWorkers = result.routedTo === undefined
      ? []
      : runtime.workerSupervisor?.resumeAfterOperator({
          sessionId: result.routedTo.workerSessionId,
          loopId: result.routedTo.loopId,
          beadId: result.routedTo.beadId
        }, result.evidence) ?? [];
    auditMutation({
      runtime,
      tool: name,
      action: "answer_agent_question",
      authorization,
      reason: result.reason,
      evidence: result.evidence
    });
    appendRuntimeEvent(runtime, {
      type: "question.answered",
      evidence: result.evidence,
      data: { question_id: stringParam(params, "question_id"), answered: result.answered, resumed_workers: resumedWorkers.length }
    });
    return textContent({
      answered: result.answered,
      routed_to: result.routedTo,
      question: result.question,
      resumed_workers: resumedWorkers,
      reason: result.reason,
      evidence: result.evidence
    });
  }

  if (name === "ciclo_report_feedback") {
    const routing = runtime.operatorRouting ?? new OperatorRoutingStore();
    const result = routing.reportFeedback({
      loopId: stringParam(params, "loop_id") || undefined,
      beadId: stringParam(params, "bead_id") || undefined,
      harnessId: stringParam(params, "harness_id") || undefined,
      remoteSessionId: stringParam(params, "remote_session_id") || undefined,
      severity: severityParam(stringParam(params, "severity")),
      message: stringParam(params, "message"),
      principalId: authorization.principalId,
      evidence: stringListParam(params, "evidence")
    });
    auditMutation({
      runtime,
      tool: name,
      action: "answer_agent_question",
      authorization,
      reason: result.deduplicated ? "operator feedback was deduplicated" : "operator feedback was queued",
      evidence: result.evidence
    });
    appendRuntimeEvent(runtime, {
      type: "feedback.reported",
      loopId: stringParam(params, "loop_id") || undefined,
      beadId: stringParam(params, "bead_id") || undefined,
      evidence: result.evidence,
      data: { feedback_id: result.feedbackId, severity: result.feedback.severity }
    });
    runtime.userPaneNotifier?.notifyMessage({
      title: `Ciclo feedback: ${result.feedback.severity}`,
      body: [
        result.feedback.message,
        `Feedback ${result.feedbackId}`,
        result.feedback.beadId === undefined ? undefined : `Bead ${result.feedback.beadId}`,
        result.feedback.loopId === undefined ? undefined : `Loop ${result.feedback.loopId}`
      ].filter((line): line is string => line !== undefined).join("\n"),
      sound: result.feedback.severity === "critical" || result.feedback.severity === "error" ? "request" : "none"
    });
    return textContent({
      feedback_id: result.feedbackId,
      deduplicated: result.deduplicated,
      feedback: result.feedback,
      evidence: result.evidence
    });
  }

  if (name === "ciclo_claim_work") {
    const idempotent = idempotentResult(name, params, runtime);
    if (idempotent !== undefined) return textContent(idempotent.payload);
    const loop = loopFromParams(params, runtime);
    const policy = evaluatePolicy({
      loop,
      policy: runtime.policy ?? defaultPolicy,
      action: "claim_beads_task"
    });
    if (policy.decision !== "allow") {
      const payload = {
        claimed: false,
        reason: policy.reason,
        policy,
        evidence: ["mcp.claim.policy:not_allowed", ...policy.evidence]
      };
      auditMutation({
        runtime,
        tool: name,
        action: "claim_beads_task",
        authorization,
        reason: policy.reason,
        evidence: payload.evidence
      });
      return textContent(payload);
    }
    const beadId = stringParam(params, "bead_id");
    const harnessId = normalizeHarnessId(stringParam(params, "harness_id", "unknown"));
    const client = runtimeBeadsClient(runtime);
    const result = await selectAndClaimBeadsWork(
      {
        ready: async () => [await client.show(beadId)],
        show: (id) => client.show(id),
        claim: (id) => client.claim(id),
        note: (id, message) => client.note(id, message)
      },
      {
        selector: { loop },
        harnessId,
        principalId: authorization.principalId,
        sessionId: runtime.auth.session.id,
        authorization
      }
    );
    if (result.claimed) recordIdempotency(name, params, runtime);
    auditMutation({
      runtime,
      tool: name,
      action: "claim_beads_task",
      authorization,
      reason: result.reason,
      evidence: result.evidence
    });
    if (result.claimed) {
      appendRuntimeEvent(runtime, {
        type: "bead.claimed",
        loopId: loop.id,
        beadId,
        evidence: result.evidence,
        data: { harness_id: harnessId }
      });
    }
    return textContent(result);
  }

  if (name === "ciclo_launch_remote_runner") {
    const registry = runtime.remoteRunnerRegistry ?? new RemoteRunnerRegistry();
    const record = asRecord(params);
    const kubernetes = asRecord(record.kubernetes);
    const awsLambda = asRecord(record.aws_lambda);
    const cloudflare = asRecord(record.cloudflare);
    const launchRequest = mergeRemoteRunnerLaunchWithConfig({
      runnerKind: stringParam(params, "runner_kind"),
      runnerId: stringParam(params, "runner_id") || undefined,
      loopId: stringParam(params, "loop_id"),
      beadId: stringParam(params, "bead_id") || undefined,
      harnessId: normalizeHarnessId(stringParam(params, "harness_id")),
      image: stringParam(params, "image"),
      imageResolver: remoteRunnerImageResolverParam(params),
      repoUrl: stringParam(params, "repo_url") || undefined,
      repoPath: stringParam(params, "repo_path"),
      prompt: stringParam(params, "prompt"),
      herdrSession: stringParam(params, "herdr_session") || undefined,
      sshUser: stringParam(params, "ssh_user") || undefined,
      wireGuard: wireGuardParam(params),
      environment: stringRecordParam(params, "environment"),
      configureMcp: optionalBooleanParam(params, "configure_mcp"),
      mcpClients: mcpClientListParam(params, "mcp_clients"),
      mcpServerName: stringParam(params, "mcp_server_name") || undefined,
      mcpCommand: stringParam(params, "mcp_command") || undefined,
      mcpVars: mcpEnvParam(params),
      mcpAdditionalServers: mcpAdditionalServersParam(params),
      mcpClaudeChannel: optionalBooleanParam(params, "mcp_claude_channel"),
      preflightOnly: optionalBooleanParam(params, "preflight_only"),
      preflight: remoteRunnerPreflightParam(params),
      repoBootstrap: remoteRunnerRepoBootstrapParam(params),
      egress: remoteRunnerEgressParam(params),
      kubernetes: {
        namespace: stringParam(kubernetes, "namespace") || undefined,
        serviceAccount: stringParam(kubernetes, "service_account") || undefined,
        jobName: stringParam(kubernetes, "job_name") || undefined,
        mode: stringParam(kubernetes, "mode") === "job" ? "job" : stringParam(kubernetes, "mode") === "statefulset" ? "statefulset" : undefined,
        statefulSetName: stringParam(kubernetes, "statefulset_name") || undefined,
        serviceName: stringParam(kubernetes, "service_name") || undefined,
        replicas: optionalNumberParam(kubernetes, "replicas"),
        storageSize: stringParam(kubernetes, "storage_size") || undefined,
        storageClassName: stringParam(kubernetes, "storage_class_name") || undefined
      },
      awsLambda: {
        microVmImageName: stringParam(awsLambda, "microvm_image_name") || undefined,
        microVmImageIdentifier: stringParam(awsLambda, "microvm_image_identifier") || undefined,
        microVmName: stringParam(awsLambda, "microvm_name") || undefined,
        baseImageArn: stringParam(awsLambda, "base_image_arn") || undefined,
        buildRoleArn: stringParam(awsLambda, "build_role_arn") || undefined,
        executionRoleArn: stringParam(awsLambda, "execution_role_arn") || undefined,
        sourceS3Uri: stringParam(awsLambda, "source_s3_uri") || undefined,
        memoryMb: numberParam(awsLambda, "memory_mb", 2048),
        vcpuCount: numberParam(awsLambda, "vcpu_count", 2)
      },
      cloudflare: {
        accountId: stringParam(cloudflare, "account_id") || undefined,
        workerName: stringParam(cloudflare, "worker_name") || undefined
      },
      dryRun: booleanParam(params, "dry_run", true)
    }, runtime.projectConfig ?? {});
    const mcpSecretEnv = await resolveMcpSecretEnvBindings({
      params,
      runtime,
      loopId: launchRequest.loopId,
      beadId: launchRequest.beadId,
      dryRun: launchRequest.dryRun ?? true
    });
    const workerSecretEnv = await resolveWorkerSecretEnvBindings({
      params,
      runtime,
      loopId: launchRequest.loopId,
      beadId: launchRequest.beadId
    });
    const remoteAdditionalServerSecrets = await resolveAdditionalMcpServerSecretEnv({
      additionalServers: launchRequest.mcpAdditionalServers,
      runtime,
      loopId: launchRequest.loopId,
      beadId: launchRequest.beadId,
      dryRun: launchRequest.dryRun ?? true
    });
    const result = registry.launch({
      ...launchRequest,
      mcpAdditionalServers: remoteAdditionalServerSecrets.additionalServers,
      mcpAdditionalServerSecretEnv: remoteAdditionalServerSecrets.secretEnv,
      mcpSecretEnv,
      workerSecretEnv,
      runnerKind: remoteRunnerKindParam(launchRequest.runnerKind)
    });
    auditMutation({
      runtime,
      tool: name,
      action: "register_remote_session",
      authorization,
      reason: result.reason,
      evidence: result.evidence
    });
    if (result.accepted) {
      appendRuntimeEvent(runtime, {
        type: "remote_runner.launched",
        loopId: stringParam(params, "loop_id"),
        beadId: stringParam(params, "bead_id") || undefined,
        evidence: result.evidence,
        data: { runner_id: result.plan?.runnerId, runner_kind: result.plan?.runnerKind }
      });
    }
    const plan = result.plan;
    return textContent({
      accepted: result.accepted,
      reason: result.reason,
      runner_id: plan?.runnerId,
      runner_kind: plan?.runnerKind,
      provider_name: plan?.providerName,
      execution_model: plan?.executionModel,
      state: plan?.state,
      herdr_remote_target: plan?.herdrRemoteTarget,
      attach: plan?.attach,
      image_resolution: plan?.imageResolution,
      repo_bootstrap: plan?.repoBootstrap,
      egress: plan?.egress,
      mcp_config: plan?.mcpConfig,
      worker_secret_env: plan?.workerSecretEnv,
      wireguard: plan?.wireGuard,
      preflight: plan?.preflight,
      commands: plan?.commands ?? [],
      artifacts: plan?.artifacts ?? [],
      warnings: plan?.warnings ?? [],
      evidence: result.evidence
    });
  }

  if (name === "ciclo_list_remote_runners") {
    const remoteRunners = runtime.remoteRunnerRegistry?.list() ?? [];
    appendRuntimeEvent(runtime, {
      type: "remote_runner.listed",
      evidence: ["remote_runner.listed"],
      data: { count: remoteRunners.length }
    });
    return textContent({ remote_runners: remoteRunners });
  }

  if (name === "ciclo_list_secret_providers") {
    const registry = runtime.secretProviderRegistry ?? createDefaultSecretProviderRegistry();
    const providers = registry.list();
    appendRuntimeEvent(runtime, {
      type: "secret_providers.listed",
      evidence: ["secret.providers:list", `secret.providers.count:${providers.length}`],
      data: { count: providers.length, provider_ids: providers.map((provider) => provider.id) }
    });
    return textContent({
      secret_providers: providers,
      evidence: [
        "secret.providers:list",
        `secret.providers.count:${providers.length}`
      ]
    });
  }

  if (name === "ciclo_request_secret") {
    const registry = runtime.secretProviderRegistry ?? createDefaultSecretProviderRegistry();
    const result = await registry.resolve({
      providerId: stringParam(params, "provider_id"),
      secretRef: stringParam(params, "secret_ref"),
      field: stringParam(params, "field") || undefined,
      loopId: stringParam(params, "loop_id") || undefined,
      beadId: stringParam(params, "bead_id") || undefined,
      workerSessionId: stringParam(params, "worker_session_id") || undefined,
      principalId: authorization.principalId,
      reason: stringParam(params, "reason"),
      dryRun: booleanParam(params, "dry_run", false)
    });
    auditMutation({
      runtime,
      tool: name,
      action: "request_secret",
      authorization,
      reason: result.reason,
      evidence: result.evidence
    });
    appendRuntimeEvent(runtime, {
      type: "secret.requested",
      loopId: stringParam(params, "loop_id") || undefined,
      beadId: stringParam(params, "bead_id") || undefined,
      workerSessionId: stringParam(params, "worker_session_id") || undefined,
      evidence: result.evidence,
      data: {
        provider_id: result.providerId,
        provider_kind: result.providerKind,
        secret_ref_hash: result.secretRefHash,
        field: result.field,
        resolved: result.resolved
      }
    });
    return textContent({
      resolved: result.resolved,
      provider_id: result.providerId,
      provider_kind: result.providerKind,
      secret_ref_hash: result.secretRefHash,
      field: result.field,
      value: booleanParam(params, "dry_run", false) ? undefined : result.value,
      reason: result.reason,
      evidence: result.evidence
    });
  }

  if (name === "ciclo_attach_plan") {
    const plan = buildCicloAttachPlan({
      remoteTarget: stringParam(params, "herdr_target") || undefined,
      session: stringParam(params, "herdr_session") || undefined,
      target: stringParam(params, "agent_target") || undefined
    });
    appendRuntimeEvent(runtime, {
      type: "attach.plan_created",
      evidence: plan.evidence,
      data: {
        command: plan.command,
        remote: plan.remoteTarget !== undefined,
        session: plan.session,
        target: plan.target
      }
    });
    return textContent(plan);
  }

  if (name === "ciclo_launch_worker_session") {
    const supervisor = runtime.workerSupervisor ?? new WorkerSessionSupervisor(runtime.auth.session.projectRoot);
    const loopId = stringParam(params, "loop_id");
    const beadId = stringParam(params, "bead_id") || undefined;
    const dryRun = booleanParam(params, "dry_run", false);
    const mcpSecretEnv = await resolveMcpSecretEnvBindings({
      params,
      runtime,
      loopId,
      beadId,
      dryRun
    });
    const workerSecretEnv = await resolveWorkerSecretEnvBindings({
      params,
      runtime,
      loopId,
      beadId
    });
    const mergedLaunch = mergeWorkerLaunchWithConfig({
      harnessId: workerHarnessParam(stringParam(params, "harness_id")),
      loopId,
      beadId,
      prompt: stringParam(params, "prompt"),
      extraArgs: stringListParam(params, "extra_args"),
      model: stringParam(params, "model") || undefined,
      effort: stringParam(params, "effort") || undefined,
      cwd: stringParam(params, "cwd") || runtime.auth.session.projectRoot,
      sessionName: stringParam(params, "session_name") || undefined,
      dryRun,
      permissionMode: stringParam(params, "permission_mode") || undefined,
      sandbox: stringParam(params, "sandbox") || undefined,
      approvalPolicy: stringParam(params, "approval_policy") || undefined,
      isolation: isolationParam(params),
      worktree: worktreeParam(params),
      configureMcp: optionalBooleanParam(params, "configure_mcp"),
      mcpClients: mcpClientListParam(params, "mcp_clients"),
      mcpServerName: stringParam(params, "mcp_server_name") || undefined,
      mcpCommand: stringParam(params, "mcp_command") || undefined,
      mcpEnv: mcpEnvParam(params),
      workerEnv: workerEnvParam(params),
      mcpAdditionalServers: mcpAdditionalServersParam(params),
      mcpSecretEnv,
      workerSecretEnv,
      mcpClaudeChannel: optionalBooleanParam(params, "mcp_claude_channel")
    }, runtime.projectConfig ?? {});
    const additionalServerSecrets = await resolveAdditionalMcpServerSecretEnv({
      additionalServers: mergedLaunch.mcpAdditionalServers,
      runtime,
      loopId,
      beadId,
      dryRun
    });
    const result = supervisor.launch({
      ...mergedLaunch,
      mcpAdditionalServers: additionalServerSecrets.additionalServers,
      mcpAdditionalServerSecretEnv: additionalServerSecrets.secretEnv
    });
    auditMutation({
      runtime,
      tool: name,
      action: "send_prompt",
      authorization,
      reason: result.state === "planned" ? "worker session launch planned" : "worker session launched",
      evidence: result.evidence
    });
    return textContent({
      session_id: result.sessionId,
      harness_id: result.harnessId,
      state: result.state,
      command: result.command,
      args: result.args,
      extra_args: result.extraArgs,
      cwd: result.cwd,
      worktree: result.worktree,
      mcp_config: publicMcpConfig(result.mcpConfig),
      worker_env: result.workerEnv,
      worker_secret_env: result.workerSecretEnv,
      pid: result.pid,
      session_name: result.sessionName,
      launch_mode: result.launchMode,
      model: result.model,
      effort: result.effort,
      loop_id: result.loopId,
      bead_id: result.beadId,
      evidence: result.evidence
    });
  }

  if (name === "ciclo_heartbeat_worker_session") {
    const supervisor = runtime.workerSupervisor ?? new WorkerSessionSupervisor(runtime.auth.session.projectRoot);
    const result = supervisor.heartbeat(stringParam(params, "worker_session_id"), {
      state: heartbeatStateParam(params),
      evidence: stringListParam(params, "evidence"),
      usage: {
        inputTokens: numberParam(params, "input_tokens", 0),
        outputTokens: numberParam(params, "output_tokens", 0),
        costUsd: numberParam(params, "cost_usd", 0)
      }
    });
    auditMutation({
      runtime,
      tool: name,
      action: "send_prompt",
      authorization,
      reason: "worker session heartbeat recorded",
      evidence: result.evidence
    });
    return textContent({
      session_id: result.sessionId,
      state: result.state,
      last_heartbeat_at: result.lastHeartbeatAt,
      state_entered_at: result.stateEnteredAt,
      usage: result.usage,
      evidence: result.evidence
    });
  }

  if (name === "ciclo_list_worker_sessions") {
    const supervisor = runtime.workerSupervisor ?? new WorkerSessionSupervisor(runtime.auth.session.projectRoot);
    const stalled = supervisor.refreshStalled(staleAfterMs(params));
    const workerSessions = supervisor.list().map(publicWorkerSession);
    appendRuntimeEvent(runtime, {
      type: "worker.listed",
      evidence: ["worker.sessions:list", `worker.sessions.count:${workerSessions.length}`],
      data: { count: workerSessions.length, stalled: stalled.length }
    });
    return textContent({ worker_sessions: workerSessions });
  }

  if (name === "ciclo_stop_worker_session") {
    const supervisor = runtime.workerSupervisor ?? new WorkerSessionSupervisor(runtime.auth.session.projectRoot);
    const result = supervisor.stop(
      stringParam(params, "worker_session_id"),
      stringParam(params, "reason"),
      signalParam(stringParam(params, "signal"))
    );
    auditMutation({
      runtime,
      tool: name,
      action: "send_prompt",
      authorization,
      reason: result.cleanupReason ?? "worker session stopped",
      evidence: result.evidence
    });
    return textContent({
      session_id: result.sessionId,
      state: result.state,
      cleanup_reason: result.cleanupReason,
      signal: result.signal,
      evidence: result.evidence
    });
  }

  if (name === "ciclo_gc_worker_workspaces") {
    const supervisor = runtime.workerSupervisor ?? new WorkerSessionSupervisor(runtime.auth.session.projectRoot);
    const result = supervisor.gcOrphanedWorkspaces({
      herdrSession: stringParam(params, "herdr_session") || undefined,
      dryRun: booleanParam(params, "dry_run", true)
    });
    auditMutation({
      runtime,
      tool: name,
      action: "send_prompt",
      authorization,
      reason: result.dryRun ? "worker workspace GC planned" : "worker workspace GC executed",
      evidence: result.evidence
    });
    appendRuntimeEvent(runtime, {
      type: "worker.workspace_gc",
      evidence: result.evidence,
      data: {
        dry_run: result.dryRun,
        herdr_session: result.herdrSession,
        candidates: result.candidates.length,
        skipped: result.candidates.filter((candidate) => candidate.skipped).length
      }
    });
    return textContent(result);
  }

  if (name === "ciclo_start_work") {
    const loop = loopFromParams(params, runtime);
    const policy = evaluatePolicy({
      loop,
      policy: runtime.policy ?? defaultPolicy,
      action: "send_prompt",
      promptSendConfigured: runtime.promptSendConfigured ?? booleanParam(params, "dry_run", false)
    });
    const payload = {
      prompt: [
        `Continue Ciclo loop ${loop.id}.`,
        `Beads issue: ${stringParam(params, "bead_id")}.`,
        `Harness: ${stringParam(params, "harness_id", "unknown")}.`,
        "Report progress, validation, blockers, and final summary through Ciclo MCP tools."
      ].join("\n"),
      dispatched: policy.decision === "allow" && !booleanParam(params, "dry_run", false),
      policy,
      evidence: policy.evidence
    };
    auditMutation({
      runtime,
      tool: name,
      action: "send_prompt",
      authorization,
      reason: policy.reason,
      evidence: policy.evidence
    });
    appendRuntimeEvent(runtime, {
      type: "work.started",
      loopId: loop.id,
      beadId: stringParam(params, "bead_id") || undefined,
      evidence: payload.evidence,
      data: {
        dispatched: payload.dispatched,
        policy_decision: policy.decision,
        dry_run: booleanParam(params, "dry_run", false),
        harness_id: stringParam(params, "harness_id", "unknown")
      }
    });
    return textContent(payload);
  }

  if (name === "ciclo_update_work") {
    const idempotent = idempotentResult(name, params, runtime);
    if (idempotent !== undefined) return textContent(idempotent.payload);
    const loop = loopFromParams(params, runtime);
    const kind = stringParam(params, "kind", "progress") as BeadsProgressKind;
    const result = await recordBeadsProgress(runtimeBeadsClient(runtime), {
      id: stringParam(params, "bead_id"),
      kind,
      message: stringParam(params, "message"),
      loop,
      policy: runtime.policy ?? defaultPolicy,
      authorization,
      principalId: authorization.principalId,
      harnessId: stringParam(params, "harness_id") || undefined,
      sessionId: runtime.auth.session.id,
      validation:
        kind === "validation"
          ? {
              command: stringParam(params, "validation_command"),
              passed: booleanParam(params, "validation_passed"),
              summary: stringParam(params, "message")
            }
          : undefined,
      sync: runtime.sync
    });
    if (result.mutated) recordIdempotency(name, params, runtime);
    auditMutation({
      runtime,
      tool: name,
      action: "update_beads_progress",
      authorization,
      reason: result.reason,
      evidence: result.evidence
    });
    if (result.mutated) {
      appendRuntimeEvent(runtime, {
        type: kind === "validation"
          ? (booleanParam(params, "validation_passed") ? "validation.passed" : "validation.failed")
          : kind === "blocker"
            ? "blocker.raised"
            : "work.updated",
        loopId: loop.id,
        beadId: stringParam(params, "bead_id"),
        evidence: result.evidence,
        data: {
          kind,
          validation_command: stringParam(params, "validation_command") || undefined
        }
      });
    }
    return textContent(result);
  }

  if (name === "ciclo_close_work") {
    const idempotent = idempotentResult(name, params, runtime);
    if (idempotent !== undefined) return textContent(idempotent.payload);
    const record = asRecord(params);
    const beadId = stringParam(params, "bead_id");
    const loop = loopFromParams(params, runtime);
    const finalSummary = stringParam(params, "final_summary");
    const acceptanceEvidence = stringListParam(params, "acceptance_evidence");
    const validations = validationEvidence(record.validation_evidence);
    const result = await closeBeadsTaskWithPolicy(runtimeBeadsClient(runtime), {
      id: beadId,
      loop,
      policy: runtime.policy ?? defaultPolicy,
      finalSummary,
      acceptanceEvidence,
      validationEvidence: validations,
      authorization,
      principalId: authorization.principalId,
      harnessId: stringParam(params, "harness_id") || undefined,
      sessionId: runtime.auth.session.id,
      sync: runtime.sync
    });
    if (result.mutated) recordIdempotency(name, params, runtime);
    auditMutation({
      runtime,
      tool: name,
      action: "close_beads_task",
      authorization,
      reason: result.reason,
      evidence: result.evidence
    });
    if (result.mutated) {
      appendRuntimeEvent(runtime, {
        type: "bead.closed",
        loopId: loop.id,
        beadId,
        evidence: result.evidence
      });
    }
    let reviewSession: TaskReviewSessionResult | undefined;
    if (result.mutated) {
      if (!booleanParam(params, "launch_review", true)) {
        reviewSession = {
          launched: false,
          reason: "review launch disabled by request",
          evidence: ["review.session.skipped:disabled"]
        };
      } else {
        const reviewHarnessId = reviewHarnessParam(params);
        const reviewAccessRequest = {
          action: "send_prompt" as const,
          scope: { loopId: loop.id, beadId, harnessId: reviewHarnessId },
          allowUnauthenticated: false
        };
        const reviewAuthorization = authorizeClientRequest(runtime.auth, reviewAccessRequest);
        runtime.accessAuditLog?.push(buildAuthorizationAuditRecord(runtime.auth, reviewAccessRequest, reviewAuthorization));
        if (reviewAuthorization.decision === "deny") {
          reviewSession = {
            launched: false,
            reason: reviewAuthorization.reason,
            evidence: ["review.session.skipped:access_denied", ...reviewAuthorization.evidence]
          };
        } else {
          reviewSession = launchTaskReviewSession({
            supervisor: runtime.workerSupervisor,
            loopId: loop.id,
            beadId,
            finalSummary,
            acceptanceEvidence,
            validationEvidence: validations,
            cwd: reviewSessionCwd(params, runtime, beadId),
            harnessId: reviewHarnessId,
            model: stringParam(params, "review_model") || undefined,
            effort: stringParam(params, "review_effort") || undefined,
            dryRun: booleanParam(params, "review_dry_run", false),
            configureMcp: booleanParam(params, "review_configure_mcp", true),
            promptInjections: runtime.projectConfig?.prompts?.systemInjections
          });
        }
        auditMutation({
          runtime,
          tool: `${name}.review`,
          action: "send_prompt",
          authorization: reviewAuthorization,
          reason: reviewSession.reason,
          evidence: reviewSession.evidence
        });
      }
      appendRuntimeEvent(runtime, {
        type: reviewSession.launched ? "review_session.launched" : "review_session.skipped",
        loopId: loop.id,
        beadId,
        evidence: reviewSession.evidence,
        data: {
          launched: reviewSession.launched,
          reason: reviewSession.reason,
          session_id: reviewSession.sessionId,
          harness_id: reviewSession.harnessId,
          state: reviewSession.state,
          dry_run: reviewSession.dryRun
        }
      });
    }
    return textContent(reviewSession === undefined ? result : { ...result, review_session: reviewSession });
  }

  if (name === "ciclo_sync_remote_trackers") {
    const idempotent = idempotentResult(name, params, runtime);
    if (idempotent !== undefined) return textContent(idempotent.payload);
    const trackerSync = runtime.remoteTrackerSync;
    const input = trackerSyncInput(params);
    const policy = evaluatePolicy({
      loop: loopFromParams(params, runtime),
      policy: runtime.policy ?? defaultPolicy,
      action: "remote_tracker_sync",
      remoteTrackerSyncConfigured: trackerSync?.isConfigured() ?? false
    });
    if (policy.decision !== "allow" || trackerSync === undefined) {
      const payload = {
        synced: false,
        provider: "beads-native",
        dry_run: input.dryRun,
        policy,
        evidence: [
          ...policy.evidence,
          trackerSync === undefined ? "beads.tracker_sync:not_configured" : "beads.tracker_sync:policy_guarded"
        ]
      };
      auditMutation({
        runtime,
        tool: name,
        action: "remote_tracker_sync",
        authorization,
        reason: policy.reason,
        evidence: payload.evidence
      });
      return textContent(payload);
    }

    const result = await trackerSync.trigger(input);
    if (input.dryRun || result.synced) recordIdempotency(name, params, runtime);
    const payload = {
      ...result,
      policy,
      evidence: [...policy.evidence, ...result.evidence]
    };
    auditMutation({
      runtime,
      tool: name,
      action: "remote_tracker_sync",
      authorization,
      reason: result.synced || input.dryRun ? policy.reason : "Beads remote tracker sync did not complete",
      evidence: payload.evidence
    });
    if (result.synced || input.dryRun) {
      appendRuntimeEvent(runtime, {
        type: "tracker.synced",
        loopId: input.loopId,
        beadId: input.beadId,
        evidence: payload.evidence,
        data: { dry_run: input.dryRun, synced: result.synced }
      });
    }
    return textContent(payload);
  }

  if (name === "ciclo_whoami") {
    return textContent(clientWhoami(runtime.auth));
  }

  if (name === "ciclo_auth_device_start") {
    if (runtime.deviceFlow === undefined) {
      throw new Error("device authorization flow is not configured");
    }
    const deviceClientId = stringParam(params, "client_id", "mcp-client");
    const deviceClientKind = clientKind(stringParam(params, "client_kind", "cli"));
    const requestedScopes = stringListParam(params, "requested_scopes");
    const start = runtime.deviceFlow.start({
      sessionId: runtime.auth.session.id,
      clientId: deviceClientId,
      clientKind: deviceClientKind,
      scopes: requestedScopes
    });
    appendRuntimeEvent(runtime, {
      type: "auth.device_started",
      evidence: ["auth.device:start", `auth.device.client_kind:${deviceClientKind}`],
      data: {
        client_id: deviceClientId,
        client_kind: deviceClientKind,
        requested_scopes: requestedScopes,
        expires_at: start.expiresAt,
        interval_seconds: start.intervalSeconds
      }
    });
    return textContent({
      device_code: start.deviceCode,
      user_code: start.userCode,
      verification_uri: start.verificationUri,
      verification_uri_complete: start.verificationUriComplete,
      expires_at: start.expiresAt,
      interval_seconds: start.intervalSeconds
    });
  }

  if (name === "ciclo_auth_device_poll") {
    if (runtime.deviceFlow === undefined) {
      throw new Error("device authorization flow is not configured");
    }
    const result = runtime.deviceFlow.poll(stringParam(params, "device_code"));
    if (result.token !== undefined) {
      runtime.auth.tokenRegistry?.store(result.token);
    }
    appendRuntimeEvent(runtime, {
      type: "auth.device_polled",
      evidence: result.evidence,
      data: {
        status: authDeviceStatus(result.outcome),
        interval_seconds: result.intervalSeconds,
        token_issued: result.token !== undefined
      }
    });
    return textContent({
      status: authDeviceStatus(result.outcome),
      token_set: result.token,
      interval_seconds: result.intervalSeconds,
      reason: result.reason,
      evidence: result.evidence
    });
  }

  return {
    content: [
      {
        type: "text",
        text: `Tool ${name} is declared but not implemented by the read-only local stdio server.`
      }
    ],
    isError: true
  };
}

async function readResource(
  uri: string,
  service: CicloMcpReadService,
  runtime: CicloMcpRuntimeContext
): Promise<unknown> {
  let payload: unknown;
  if (uri === "ciclo://status") {
    payload = { status: await liveStatus(service, runtime) };
  } else if (uri === "ciclo://loops") {
    const workers = runtimeWorkers(runtime);
    const loopIds = loopIdsFromRuntime(runtime, workers);
    payload = { loops: loopIds.map((loopId) => liveLoop(loopId, runtime)).filter((loop): loop is LoopStatus => loop !== undefined) };
  } else if (uri.startsWith("ciclo://loops/")) {
    payload = await liveLoopStatus(uri.slice("ciclo://loops/".length), service, runtime);
  } else if (uri === "ciclo://events") {
    const poll = runtime.eventStore?.poll(0) ?? runtime.workerSupervisor?.pollEvents(0) ?? { cursor: 0, nextCursor: 0, events: [] };
    payload = { cursor: poll.cursor, next_cursor: poll.nextCursor, events: poll.events };
  } else if (uri === "ciclo://heartbeat") {
    payload = {
      heartbeat: runtime.internalHeartbeat?.status() ?? {
        running: false,
        intervalMs: 0,
        claudeChannel: {
          enabled: runtime.claudeChannel?.enabled === true,
          communicationReady: false,
          connectedWorkers: 0
        },
        monologue: [],
        evidence: ["heartbeat.internal:unavailable"]
      }
    };
  } else if (uri === "ciclo://cron") {
    payload = {
      cron: runtime.cronScheduler?.status(runtime.projectConfig?.cron?.jobs ?? [], new Date().toISOString()) ?? {
        jobs: [],
        due: [],
        recent_runs: [],
        evidence: ["cron.scheduler:unavailable"]
      }
    };
  } else if (uri === "ciclo://memory") {
    payload = {
      memory: runtime.memoryStore?.status() ?? { evidence: ["memory.store:unavailable"] },
      memories: runtime.memoryStore?.list({ limit: 100 }) ?? []
    };
  } else if (uri === "ciclo://board") {
    payload = await liveBoard(service, runtime);
  } else if (uri === "ciclo://work/ready") {
    payload = await service.readyWork();
  } else if (uri === "ciclo://questions") {
    payload = { questions: runtime.operatorRouting?.listQuestions() ?? await service.questions() };
  } else if (uri === "ciclo://feedback") {
    payload = { feedback: runtime.operatorRouting?.listFeedback() ?? await service.feedback() };
  } else if (uri === "ciclo://remote-sessions") {
    payload = { remote_sessions: [] };
  } else if (uri === "ciclo://remote-runners") {
    payload = { remote_runners: runtime.remoteRunnerRegistry?.list() ?? [] };
  } else if (uri === "ciclo://secret-providers") {
    payload = { secret_providers: (runtime.secretProviderRegistry ?? createDefaultSecretProviderRegistry()).list() };
  } else if (uri === "ciclo://worker-sessions") {
    runtime.workerSupervisor?.refreshStalled(10 * 60 * 1000);
    payload = { worker_sessions: runtime.workerSupervisor?.list().map(publicWorkerSession) ?? [] };
  } else if (uri === "ciclo://session/access") {
    payload = { access: clientAccessView(runtime.auth) };
  } else if (uri === "ciclo://users/me") {
    payload = { principal: clientWhoami(runtime.auth) };
  } else if (uri === "ciclo://benchmarks/latest") {
    payload = { benchmarks: { status: "not_run" } };
  } else {
    throw new Error(`unknown resource: ${uri}`);
  }

  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function toolAction(name: string): SessionAccessAction {
  return cicloMcpTools.find((tool) => tool.name === name)?.permission.action ?? "read_status";
}

function resourceAction(uri: string): SessionAccessAction {
  const exact = cicloMcpResources.find((resource) => resource.uriTemplate === uri);
  if (exact !== undefined) return exact.permission.action;
  if (uri.startsWith("ciclo://loops/")) return "read_loop";
  if (uri.startsWith("ciclo://work/")) return "read_ready_work";
  return "read_status";
}

function promptAction(name: string): SessionAccessAction {
  return cicloMcpPrompts.find((prompt) => prompt.name === name)?.permission.action ?? "read_status";
}

function requestAction(request: JsonRpcRequest): SessionAccessAction {
  if (request.method === "tools/call") {
    const params = asRecord(request.params);
    return toolAction(typeof params.name === "string" ? params.name : "");
  }
  if (request.method === "resources/read") {
    return resourceAction(stringParam(request.params, "uri"));
  }
  if (request.method === "prompts/get") {
    return promptAction(stringParam(request.params, "name"));
  }
  if (request.method === "tools/list" || request.method === "resources/list" || request.method === "prompts/list") {
    return "read_status";
  }
  return "read_status";
}

function allowsUnauthenticatedAuthBootstrap(request: JsonRpcRequest): boolean {
  if (request.method !== "tools/call") return false;
  const params = asRecord(request.params);
  return params.name === "ciclo_auth_device_start" || params.name === "ciclo_auth_device_poll";
}

function requestScope(request: JsonRpcRequest): AccessScope | undefined {
  const params = asRecord(request.params);
  const args = request.method === "tools/call" ? asRecord(params.arguments) : params;
  const loopId = stringParam(args, "loop_id");
  const beadId = stringParam(args, "bead_id");
  const harnessId = stringParam(args, "harness_id");
  const remoteSessionId = stringParam(args, "remote_session_id");
  if (loopId.length === 0 && beadId.length === 0 && harnessId.length === 0 && remoteSessionId.length === 0) {
    return undefined;
  }
  return {
    loopId: loopId.length === 0 ? undefined : loopId,
    beadId: beadId.length === 0 ? undefined : beadId,
    harnessId: harnessId.length === 0 ? undefined : harnessId,
    remoteSessionId: remoteSessionId.length === 0 ? undefined : remoteSessionId
  };
}

function mcpCapabilities(runtime: CicloMcpRuntimeContext): Record<string, unknown> {
  return {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: { listChanged: false },
    ...(runtime.claudeChannel?.enabled === true
      ? {
          experimental: {
            "claude/channel": {}
          }
        }
      : {})
  };
}

export async function handleMcpRequest(
  request: JsonRpcRequest,
  service: CicloMcpReadService = createLocalMcpReadService(),
  runtime: CicloMcpRuntimeContext = createLocalMcpRuntimeContext()
): Promise<JsonRpcResponse | undefined> {
  if (request.method === "notifications/initialized") {
    return undefined;
  }

  try {
    const accessRequest = {
      action: requestAction(request),
      scope: requestScope(request),
      allowUnauthenticated: allowsUnauthenticatedAuthBootstrap(request)
    };
    const authorization = authorizeClientRequest(runtime.auth, accessRequest);
    runtime.accessAuditLog?.push(buildAuthorizationAuditRecord(runtime.auth, accessRequest, authorization));
    if (authorization.decision === "deny") {
      return failure(request, -32001, "access denied", {
        reason: authorization.reason,
        capability: authorization.capability,
        evidence: authorization.evidence
      });
    }

    if (request.method === "initialize") {
      return success(request, {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "ciclo", version: CICLO_VERSION },
        capabilities: mcpCapabilities(runtime)
      });
    }

    if (request.method === "tools/list") {
      return success(request, {
        tools: cicloMcpTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      });
    }

    if (request.method === "tools/call") {
      const params = asRecord(request.params);
      const name = typeof params.name === "string" ? params.name : "";
      return success(request, await callTool(name, params.arguments, service, runtime, authorization));
    }

    if (request.method === "resources/list") {
      return success(request, {
        resources: cicloMcpResources
          .filter((resource) => !resource.uriTemplate.includes("{"))
          .map((resource) => ({
            uri: resource.uriTemplate,
            name: resource.uriTemplate.replace("ciclo://", ""),
            description: resource.description,
            mimeType: "application/json"
          })),
        resourceTemplates: cicloMcpResources
          .filter((resource) => resource.uriTemplate.includes("{"))
          .map((resource) => ({
            uriTemplate: resource.uriTemplate,
            name: resource.uriTemplate.replace("ciclo://", ""),
            description: resource.description,
            mimeType: "application/json"
          }))
      });
    }

    if (request.method === "resources/read") {
      const uri = stringParam(request.params, "uri");
      return success(request, await readResource(uri, service, runtime));
    }

    if (request.method === "prompts/list") {
      return success(request, {
        prompts: cicloMcpPrompts.map((prompt) => ({
          name: prompt.name,
          description: prompt.description,
          arguments: promptArguments(prompt)
        }))
      });
    }

    if (request.method === "prompts/get") {
      const params = asRecord(request.params);
      const name = typeof params.name === "string" ? params.name : "";
      const prompt = cicloMcpPrompts.find((entry) => entry.name === name);
      if (prompt === undefined) {
        return failure(request, -32602, `unknown prompt: ${name}`);
      }
      return success(request, {
        description: prompt.description,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: promptText(prompt, asRecord(params.arguments))
            }
          }
        ]
      });
    }

    return failure(request, -32601, `method not found: ${request.method}`);
  } catch (error) {
    return failure(request, -32000, error instanceof Error ? error.message : "internal MCP error");
  }
}

export async function runMcpStdioServer(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  service: CicloMcpReadService = createLocalMcpReadService(),
  runtime: CicloMcpRuntimeContext = createLocalMcpRuntimeContext()
): Promise<void> {
  input.setEncoding("utf8");
  let buffer = "";
  if (runtimeOwnsAutomation(runtime)) {
    runtime.internalHeartbeat?.start();
  } else {
    runtime.eventStore?.append({
      type: "mcp.leadership",
      evidence: ["mcp.leadership:follower", "mcp.automation:skipped"],
      data: mcpLeadershipView(runtime.mcpLeadership)
    });
  }
  try {
    for await (const chunk of input) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          let request: JsonRpcRequest | undefined;
          try {
            request = JSON.parse(line) as JsonRpcRequest;
            const response = await handleMcpRequest(request, service, runtime);
            if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
          } catch (error) {
            const response = failure(
              request,
              -32700,
              error instanceof Error ? error.message : "parse error"
            );
            output.write(`${JSON.stringify(response)}\n`);
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    if (runtimeOwnsAutomation(runtime)) runtime.internalHeartbeat?.stop();
    runtime.mcpLeadership?.release();
  }
}
