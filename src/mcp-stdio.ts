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
import type { HarnessId, LoopConfig } from "./ciclo-core.js";
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
import {
  buildCicloAttachPlan,
  createDefaultRemoteRunnerPluginRegistry,
  RemoteRunnerRegistry,
  type RemoteRunnerKind,
  type WireGuardTunnelRequest
} from "./remote-runner.js";
import { activateConfiguredPlugins, defaultPluginPaths } from "./plugin-manager.js";

export interface PendingQuestion {
  readonly questionId: string;
  readonly loopId?: string;
  readonly beadId?: string;
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
    readonly mutations: "disabled_in_local_status_mode";
    readonly networkListener: false;
    readonly access: "single_user";
  };
  readonly currentWork: null;
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
  readonly remoteRunnerRegistry?: RemoteRunnerRegistry;
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

function booleanParam(params: unknown, key: string, fallback = false): boolean {
  const value = asRecord(params)[key];
  return typeof value === "boolean" ? value : fallback;
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
  return {
    interfaceName: stringParam(record, "interface_name") || undefined,
    networkCidr: stringParam(record, "network_cidr") || undefined,
    cicloAddress: stringParam(record, "ciclo_address") || undefined,
    runnerAddress: stringParam(record, "runner_address") || undefined,
    cicloEndpoint: stringParam(record, "ciclo_endpoint") || undefined,
    cicloPublicKeySecretRef: stringParam(record, "ciclo_public_key_secret_ref") || undefined,
    runnerPrivateKeySecretRef: stringParam(record, "runner_private_key_secret_ref") || undefined,
    persistentKeepaliveSeconds: numberParam(record, "persistent_keepalive_seconds", 25)
  };
}

function stringListParam(params: unknown, key: string): readonly string[] {
  const value = asRecord(params)[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
  const tokenRegistry = new TokenRegistry();
  return {
    auth: {
      ...defaultClientAuthContext(root),
      tokenRegistry
    },
    deviceFlow: new DeviceAuthorizationFlow({
      verificationUri: "http://127.0.0.1:0/oauth/device"
    }),
    operatorRouting: new OperatorRoutingStore(),
    workerSupervisor: new WorkerSessionSupervisor(root),
    remoteRunnerRegistry: new RemoteRunnerRegistry()
  };
}

export async function createLocalMcpRuntimeContextWithPlugins(root = process.cwd()): Promise<CicloMcpRuntimeContext> {
  const pluginRegistry = createDefaultRemoteRunnerPluginRegistry();
  await activateConfiguredPlugins(pluginRegistry, defaultPluginPaths(root));
  return {
    ...createLocalMcpRuntimeContext(root),
    remoteRunnerRegistry: new RemoteRunnerRegistry(pluginRegistry)
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
    return textContent(await service.status());
  }

  if (name === "ciclo_loop_status") {
    return textContent(await service.loopStatus(stringParam(params, "loop_id", "review-demo")));
  }

  if (name === "ciclo_list_ready_work") {
    return textContent(await service.readyWork(numberParam(params, "limit", 20)));
  }

  if (name === "ciclo_ask_operator") {
    const routing = runtime.operatorRouting ?? new OperatorRoutingStore();
    const result = routing.ask({
      loopId: stringParam(params, "loop_id") || undefined,
      beadId: stringParam(params, "bead_id") || undefined,
      harnessId: stringParam(params, "harness_id") || undefined,
      remoteSessionId: stringParam(params, "remote_session_id") || undefined,
      question: stringParam(params, "question"),
      urgency: urgencyParam(stringParam(params, "urgency")),
      principalId: authorization.principalId,
      evidence: stringListParam(params, "evidence")
    });
    auditMutation({
      runtime,
      tool: name,
      action: "answer_agent_question",
      authorization,
      reason: result.deduplicated ? "operator question was deduplicated" : "operator question was queued",
      evidence: result.evidence
    });
    return textContent({
      question_id: result.questionId,
      queued: result.queued,
      deduplicated: result.deduplicated,
      question: result.question,
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
    auditMutation({
      runtime,
      tool: name,
      action: "answer_agent_question",
      authorization,
      reason: result.reason,
      evidence: result.evidence
    });
    return textContent({
      answered: result.answered,
      routed_to: result.routedTo,
      question: result.question,
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
    return textContent(result);
  }

  if (name === "ciclo_launch_remote_runner") {
    const registry = runtime.remoteRunnerRegistry ?? new RemoteRunnerRegistry();
    const record = asRecord(params);
    const kubernetes = asRecord(record.kubernetes);
    const awsLambda = asRecord(record.aws_lambda);
    const cloudflare = asRecord(record.cloudflare);
    const result = registry.launch({
      runnerKind: remoteRunnerKindParam(stringParam(params, "runner_kind")),
      runnerId: stringParam(params, "runner_id") || undefined,
      loopId: stringParam(params, "loop_id"),
      beadId: stringParam(params, "bead_id") || undefined,
      harnessId: normalizeHarnessId(stringParam(params, "harness_id")),
      image: stringParam(params, "image"),
      repoUrl: stringParam(params, "repo_url") || undefined,
      repoPath: stringParam(params, "repo_path"),
      prompt: stringParam(params, "prompt"),
      herdrSession: stringParam(params, "herdr_session") || undefined,
      sshUser: stringParam(params, "ssh_user") || undefined,
      wireGuard: wireGuardParam(params),
      environment: stringRecordParam(params, "environment"),
      kubernetes: {
        namespace: stringParam(kubernetes, "namespace") || undefined,
        serviceAccount: stringParam(kubernetes, "service_account") || undefined,
        jobName: stringParam(kubernetes, "job_name") || undefined
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
    });
    auditMutation({
      runtime,
      tool: name,
      action: "register_remote_session",
      authorization,
      reason: result.reason,
      evidence: result.evidence
    });
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
      wireguard: plan?.wireGuard,
      commands: plan?.commands ?? [],
      artifacts: plan?.artifacts ?? [],
      warnings: plan?.warnings ?? [],
      evidence: result.evidence
    });
  }

  if (name === "ciclo_list_remote_runners") {
    return textContent({ remote_runners: runtime.remoteRunnerRegistry?.list() ?? [] });
  }

  if (name === "ciclo_attach_plan") {
    return textContent(buildCicloAttachPlan({
      remoteTarget: stringParam(params, "herdr_target") || undefined,
      session: stringParam(params, "herdr_session") || undefined,
      target: stringParam(params, "agent_target") || undefined
    }));
  }

  if (name === "ciclo_launch_worker_session") {
    const supervisor = runtime.workerSupervisor ?? new WorkerSessionSupervisor(runtime.auth.session.projectRoot);
    const result = supervisor.launch({
      harnessId: workerHarnessParam(stringParam(params, "harness_id")),
      loopId: stringParam(params, "loop_id"),
      beadId: stringParam(params, "bead_id") || undefined,
      prompt: stringParam(params, "prompt"),
      model: stringParam(params, "model") || undefined,
      effort: stringParam(params, "effort") || undefined,
      cwd: stringParam(params, "cwd") || runtime.auth.session.projectRoot,
      sessionName: stringParam(params, "session_name") || undefined,
      dryRun: booleanParam(params, "dry_run", false),
      permissionMode: stringParam(params, "permission_mode") || undefined,
      sandbox: stringParam(params, "sandbox") || undefined,
      approvalPolicy: stringParam(params, "approval_policy") || undefined
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
      cwd: result.cwd,
      pid: result.pid,
      session_name: result.sessionName,
      model: result.model,
      effort: result.effort,
      loop_id: result.loopId,
      bead_id: result.beadId,
      evidence: result.evidence
    });
  }

  if (name === "ciclo_list_worker_sessions") {
    const supervisor = runtime.workerSupervisor ?? new WorkerSessionSupervisor(runtime.auth.session.projectRoot);
    return textContent({ worker_sessions: supervisor.list() });
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
    return textContent(result);
  }

  if (name === "ciclo_close_work") {
    const idempotent = idempotentResult(name, params, runtime);
    if (idempotent !== undefined) return textContent(idempotent.payload);
    const record = asRecord(params);
    const result = await closeBeadsTaskWithPolicy(runtimeBeadsClient(runtime), {
      id: stringParam(params, "bead_id"),
      loop: loopFromParams(params, runtime),
      policy: runtime.policy ?? defaultPolicy,
      finalSummary: stringParam(params, "final_summary"),
      acceptanceEvidence: stringListParam(params, "acceptance_evidence"),
      validationEvidence: validationEvidence(record.validation_evidence),
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
    return textContent(result);
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
    return textContent(payload);
  }

  if (name === "ciclo_whoami") {
    return textContent(clientWhoami(runtime.auth));
  }

  if (name === "ciclo_auth_device_start") {
    if (runtime.deviceFlow === undefined) {
      throw new Error("device authorization flow is not configured");
    }
    const start = runtime.deviceFlow.start({
      sessionId: runtime.auth.session.id,
      clientId: stringParam(params, "client_id", "mcp-client"),
      clientKind: clientKind(stringParam(params, "client_kind", "cli")),
      scopes: stringListParam(params, "requested_scopes")
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
    payload = { status: await service.status() };
  } else if (uri === "ciclo://loops") {
    payload = { loops: loopsFromStatus(await service.status()) };
  } else if (uri.startsWith("ciclo://loops/")) {
    payload = await service.loopStatus(uri.slice("ciclo://loops/".length));
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
  } else if (uri === "ciclo://worker-sessions") {
    payload = { worker_sessions: runtime.workerSupervisor?.list() ?? [] };
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
        serverInfo: { name: "ciclo", version: "0.1.0" },
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false }
        }
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
}
