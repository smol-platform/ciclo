import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { HarnessId } from "./ciclo-core.js";
import {
  FileClaudeBackgroundAgentResolver,
  type ClaudeBackgroundAgentRecord,
  type ClaudeBackgroundAgentResolver
} from "./claude-background-agent.js";
import { CicloEventStore, type CicloEventPollResult } from "./ciclo-events.js";
import {
  installCicloMcp,
  type CicloMcpAdditionalServerConfig,
  type CicloMcpInstallClient,
  type CicloMcpInstallResult,
  type CicloMcpSecretEnvBinding,
  type CicloMcpSecretEnvInstall
} from "./mcp-install.js";
import type { CicloMcpAdditionalServerSecretEnvInstall } from "./mcp-secret-placeholders.js";
import { applyPromptInjections, type CicloPromptInjection } from "./prompt-injection.js";
import { activeHerdrSessionName, repoSessionName } from "./repo-session-name.js";
import { secretExecArgs, type RuntimeSecretEnvBinding } from "./secret-env-runtime.js";

export type WorkerHarnessId = Extract<HarnessId, "claude-code" | "codex">;

export type WorkerSessionState =
  | "planned"
  | "running"
  | "waiting_on_operator"
  | "stalled"
  | "stopped"
  | "failed"
  | "completed";
export type WorkerTrackingMode = "process" | "detached_agent" | "herdr_agent";
export type WorkerLaunchMode = "process" | "herdr_pane";

const defaultClaudePermissionMode = "bypassPermissions";
const defaultCodexApprovalPolicy = "never";
const defaultCodexSandbox = "danger-full-access";

export interface WorkerSessionLaunchRequest {
  readonly harnessId: WorkerHarnessId;
  readonly loopId: string;
  readonly prompt: string;
  readonly extraArgs?: readonly string[];
  readonly beadId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly cwd?: string;
  readonly sessionName?: string;
  readonly dryRun?: boolean;
  readonly permissionMode?: string;
  readonly sandbox?: string;
  readonly approvalPolicy?: string;
  readonly isolation?: WorkerIsolationMode;
  readonly worktree?: WorkerWorktreeRequest;
  readonly configureMcp?: boolean;
  readonly mcpClients?: readonly CicloMcpInstallClient[];
  readonly mcpServerName?: string;
  readonly mcpCommand?: string;
  readonly mcpEnv?: Record<string, string>;
  readonly workerEnv?: Record<string, string>;
  readonly mcpAdditionalServers?: Record<string, CicloMcpAdditionalServerConfig>;
  readonly mcpAdditionalServerSecretEnv?: readonly CicloMcpAdditionalServerSecretEnvInstall[];
  readonly mcpSecretEnv?: readonly CicloMcpSecretEnvBinding[];
  readonly workerSecretEnv?: readonly CicloMcpSecretEnvBinding[];
  readonly mcpClaudeChannel?: boolean;
  readonly promptInjections?: readonly CicloPromptInjection[];
}

export type WorkerIsolationMode = "none" | "worktree";

export interface WorkerWorktreeRequest {
  readonly create?: boolean;
  readonly path?: string;
  readonly branch?: string;
  readonly base?: string;
  readonly force?: boolean;
}

export interface WorkerWorktreePlan {
  readonly create: boolean;
  readonly path: string;
  readonly branch?: string;
  readonly base?: string;
  readonly force: boolean;
  readonly herdrWorkspaceId?: string;
}

export interface WorkerLaunchPlan {
  readonly sessionId: string;
  readonly harnessId: WorkerHarnessId;
  readonly command: string;
  readonly args: readonly string[];
  readonly extraArgs: readonly string[];
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
  readonly worktree?: WorkerWorktreePlan;
  readonly mcpConfig?: WorkerMcpConfigPlan;
  readonly workerEnv?: WorkerEnvironmentPlan;
  readonly workerSecretEnv?: WorkerSecretEnvPlan;
  readonly loopId: string;
  readonly beadId?: string;
  readonly sessionName: string;
  readonly trackingMode: WorkerTrackingMode;
  readonly launchMode: WorkerLaunchMode;
  readonly agentRef?: WorkerAgentRef;
  readonly prompt: string;
  readonly evidence: readonly string[];
}

export interface WorkerMcpConfigPlan {
  readonly enabled: boolean;
  readonly projectRoot: string;
  readonly clients: readonly CicloMcpInstallClient[];
  readonly serverName: string;
  readonly command: string;
  readonly env: Record<string, string>;
  readonly envKeys: readonly string[];
  readonly additionalServers: Record<string, CicloMcpAdditionalServerConfig>;
  readonly additionalServerNames: readonly string[];
  readonly additionalServerSecretEnv: readonly CicloMcpAdditionalServerSecretEnvInstall[];
  readonly secretEnv: readonly CicloMcpSecretEnvInstall[];
  readonly secretEnvBindings: readonly CicloMcpSecretEnvBinding[];
  readonly claudeChannel?: boolean;
  readonly install: CicloMcpInstallResult;
  readonly evidence: readonly string[];
}

export interface WorkerSecretEnvPlan {
  readonly envNames: readonly string[];
  readonly bindings: readonly CicloMcpSecretEnvInstall[];
  readonly evidence: readonly string[];
}

export interface WorkerEnvironmentPlan {
  readonly values: Record<string, string>;
  readonly envNames: readonly string[];
  readonly evidence: readonly string[];
}

export interface WorkerAgentRef {
  readonly kind: "process" | "claude_background_session" | "herdr_agent";
  readonly id: string;
  readonly herdrSession?: string;
  readonly target?: string;
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly pid?: number;
  readonly status?: string;
  readonly waitingFor?: string;
  readonly ptyHost?: string;
  readonly rendezvousHost?: string;
  readonly registrySource?: string;
}

export interface WorkerUsageMetrics {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

export interface WorkerSessionHeartbeatInput {
  readonly evidence?: readonly string[];
  readonly usage?: WorkerUsageMetrics;
  readonly state?: Extract<WorkerSessionState, "running" | "waiting_on_operator">;
}

export interface WorkerSessionMatch {
  readonly sessionId?: string;
  readonly loopId?: string;
  readonly beadId?: string;
}

export interface WorkerSessionRecord {
  readonly sessionId: string;
  readonly harnessId: WorkerHarnessId;
  readonly state: WorkerSessionState;
  readonly command: string;
  readonly args: readonly string[];
  readonly extraArgs: readonly string[];
  readonly cwd: string;
  readonly pid?: number;
  readonly loopId: string;
  readonly beadId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly worktree?: WorkerWorktreePlan;
  readonly mcpConfig?: WorkerMcpConfigPlan;
  readonly workerEnv?: WorkerEnvironmentPlan;
  readonly workerSecretEnv?: WorkerSecretEnvPlan;
  readonly sessionName: string;
  readonly trackingMode: WorkerTrackingMode;
  readonly launchMode: WorkerLaunchMode;
  readonly agentRef?: WorkerAgentRef;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
  readonly stateEnteredAt?: string;
  readonly lastHeartbeatAt?: string;
  readonly usage?: WorkerUsageMetrics;
  readonly cleanupReason?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly evidence: readonly string[];
}

export interface WorkerSessionMetrics {
  readonly total: number;
  readonly byState: Record<string, number>;
  readonly timeInStateMs: Record<string, number>;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
  };
}

export interface WorkerProcessHandle {
  readonly pid?: number;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  stop(signal?: NodeJS.Signals): boolean;
}

export interface WorkerProcessLauncher {
  launch(command: string, args: readonly string[], options: SpawnOptions): WorkerProcessHandle;
}

export interface WorkerCommandRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WorkerCommandRunner {
  run(command: string, args: readonly string[], options?: { readonly cwd?: string }): WorkerCommandRunResult;
}

export interface WorkerClock {
  now(): string;
}

const defaultClock: WorkerClock = {
  now: () => new Date().toISOString()
};

class NodeWorkerProcessHandle implements WorkerProcessHandle {
  constructor(private readonly child: ChildProcess) {}

  get pid(): number | undefined {
    return this.child.pid;
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.child.once("exit", listener);
  }

  stop(signal: NodeJS.Signals = "SIGTERM"): boolean {
    return this.child.kill(signal);
  }
}

export class NodeWorkerProcessLauncher implements WorkerProcessLauncher {
  launch(command: string, args: readonly string[], options: SpawnOptions): WorkerProcessHandle {
    const child = spawn(command, [...args], options);
    child.unref();
    return new NodeWorkerProcessHandle(child);
  }
}

export class NodeWorkerCommandRunner implements WorkerCommandRunner {
  run(command: string, args: readonly string[], options: { readonly cwd?: string } = {}): WorkerCommandRunResult {
    const result = spawnSync(command, [...args], { cwd: options.cwd, encoding: "utf8" });
    return {
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : ""
    };
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function cleanArgs(values: readonly string[] | undefined): readonly string[] {
  return (values ?? []).filter((value) => value.length > 0);
}

function normalizeClaudeModel(value: string | undefined): string | undefined {
  const cleaned = clean(value);
  if (cleaned === undefined) return undefined;
  const alias = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (alias === "fable-5" || alias === "claude-fable-5") return "claude-fable-5";
  return cleaned;
}

function normalizeWorkerModel(harnessId: WorkerHarnessId, value: string | undefined): string | undefined {
  return harnessId === "claude-code" ? normalizeClaudeModel(value) : clean(value);
}

function safePathSegment(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length === 0 ? "worker" : cleaned.slice(0, 80);
}

function sessionName(input: WorkerSessionLaunchRequest, root: string): string {
  const explicit = clean(input.sessionName);
  if (explicit !== undefined) return explicit;
  const herdrSession = repoSessionName(clean(input.cwd) ?? root);
  return [
    herdrSession,
    input.loopId,
    input.beadId ?? "unassigned",
    input.harnessId
  ].join("-");
}

function appendIfValue(args: string[], flag: string, value: string | undefined): void {
  const cleaned = clean(value);
  if (cleaned !== undefined) args.push(flag, cleaned);
}

function worktreePlan(
  input: WorkerSessionLaunchRequest,
  baseCwd: string,
  name: string,
  sessionId: string
): WorkerWorktreePlan | undefined {
  const isolation = input.isolation ?? "none";
  if (input.worktree === undefined && isolation !== "worktree") return undefined;
  const request = input.worktree ?? {};
  const create = request.create ?? true;
  if (!create) return undefined;
  const requestedPath = clean(request.path);
  const resolvedBaseCwd = resolve(baseCwd);
  const defaultPath = join(
    dirname(resolvedBaseCwd),
    ".ciclo-worktrees",
    basename(resolvedBaseCwd),
    safePathSegment(`${name}-${sessionId}`)
  );
  const path = requestedPath === undefined ? defaultPath : resolve(baseCwd, requestedPath);
  const branch = clean(request.branch) ?? (isolation === "worktree" && input.beadId !== undefined ? `ciclo/${safePathSegment(input.beadId)}` : undefined);
  const base = clean(request.base);
  return {
    create: true,
    path,
    ...(branch === undefined ? {} : { branch }),
    ...(base === undefined ? {} : { base }),
    force: request.force === true
  };
}

function codexArgs(input: WorkerSessionLaunchRequest, cwd: string, extraArgs: readonly string[]): readonly string[] {
  const args: string[] = [];
  appendIfValue(args, "--model", input.model);
  args.push("--cd", cwd);
  args.push("--ask-for-approval", effectiveCodexApprovalPolicy(input));
  args.push("--sandbox", effectiveCodexSandbox(input));
  args.push(...extraArgs);
  args.push(input.prompt);
  return args;
}

function effectiveClaudePermissionMode(input: WorkerSessionLaunchRequest): string {
  return clean(input.permissionMode) ?? defaultClaudePermissionMode;
}

function effectiveCodexApprovalPolicy(input: WorkerSessionLaunchRequest): string {
  return clean(input.approvalPolicy) ?? defaultCodexApprovalPolicy;
}

function effectiveCodexSandbox(input: WorkerSessionLaunchRequest): string {
  return clean(input.sandbox) ?? defaultCodexSandbox;
}

function appendClaudePermissionMode(args: string[], input: WorkerSessionLaunchRequest): void {
  const mode = effectiveClaudePermissionMode(input);
  if (mode === undefined || mode === "default") return;
  args.push("--permission-mode", mode);
}

function claudeArgs(input: WorkerSessionLaunchRequest, name: string, extraArgs: readonly string[]): readonly string[] {
  const args: string[] = ["--bg", "--name", name];
  appendIfValue(args, "--model", input.model);
  appendIfValue(args, "--effort", input.effort);
  appendClaudePermissionMode(args, input);
  args.push(...extraArgs);
  args.push(input.prompt);
  return args;
}

function claudePaneArgs(input: WorkerSessionLaunchRequest, name: string, extraArgs: readonly string[]): readonly string[] {
  const args: string[] = ["--name", name];
  appendIfValue(args, "--model", input.model);
  appendIfValue(args, "--effort", input.effort);
  appendClaudePermissionMode(args, input);
  args.push(...extraArgs);
  args.push(input.prompt);
  return args;
}

function directTrackingMode(input: WorkerSessionLaunchRequest): WorkerTrackingMode {
  return input.harnessId === "claude-code" ? "detached_agent" : "process";
}

function herdrPaneLaunchEnabled(_input: WorkerSessionLaunchRequest): string | undefined {
  return activeHerdrSessionName();
}

function workerCommand(input: WorkerSessionLaunchRequest): string {
  return input.harnessId === "codex" ? "codex" : "claude";
}

function directWorkerArgs(input: WorkerSessionLaunchRequest, cwd: string, name: string, extraArgs: readonly string[]): readonly string[] {
  return input.harnessId === "codex" ? codexArgs(input, cwd, extraArgs) : claudeArgs(input, name, extraArgs);
}

function paneWorkerArgs(input: WorkerSessionLaunchRequest, cwd: string, name: string, extraArgs: readonly string[]): readonly string[] {
  return input.harnessId === "codex" ? codexArgs(input, cwd, extraArgs) : claudePaneArgs(input, name, extraArgs);
}

function runtimeSecretBindings(secretEnv: readonly CicloMcpSecretEnvBinding[] | undefined, target: string): readonly RuntimeSecretEnvBinding[] {
  return (secretEnv ?? []).map((binding) => {
    if (binding.secretRef === undefined) {
      throw new Error(`${target} secret env ${binding.name} requires a provider secret reference for runtime-scoped delivery`);
    }
    return {
      name: binding.name,
      providerId: binding.providerId,
      secretRef: binding.secretRef,
      ...(binding.field === undefined ? {} : { field: binding.field }),
      ...(binding.format === undefined ? {} : { format: binding.format }),
      reason: `provide ${binding.name} to ${target} process`
    };
  });
}

function workerSecretEnvPlan(input: WorkerSessionLaunchRequest): WorkerSecretEnvPlan | undefined {
  const bindings = input.workerSecretEnv ?? [];
  if (bindings.length === 0) return undefined;
  return {
    envNames: bindings.map((binding) => binding.name),
    bindings: bindings.map((binding) => ({
      name: binding.name,
      providerId: binding.providerId,
      providerKind: binding.providerKind,
      secretRefHash: binding.secretRefHash,
      field: binding.field,
      ...(binding.format === undefined ? {} : { formatApplied: true }),
      evidence: binding.evidence
    })),
    evidence: [
      "worker.secret_env:runtime_exec",
      `worker.secret_env.count:${bindings.length}`,
      `worker.secret_env.names:${bindings.map((binding) => binding.name).join(",")}`
    ]
  };
}

function workerEnvironmentPlan(input: WorkerSessionLaunchRequest): WorkerEnvironmentPlan | undefined {
  const values = input.workerEnv ?? {};
  const envNames = Object.keys(values);
  if (envNames.length === 0) return undefined;
  return {
    values,
    envNames,
    evidence: [
      `worker_environment.count:${envNames.length}`,
      `worker_environment.names:${envNames.join(",")}`
    ]
  };
}

function herdrEnvironmentArgs(environment: WorkerEnvironmentPlan | undefined): readonly string[] {
  if (environment === undefined) return [];
  return environment.envNames.flatMap((name) => ["--env", `${name}=${environment.values[name] ?? ""}`]);
}

function mcpClientsForHarness(input: WorkerSessionLaunchRequest): readonly CicloMcpInstallClient[] {
  if (input.mcpClients !== undefined && input.mcpClients.length > 0) return [...new Set(input.mcpClients)];
  return ["claude", "codex"];
}

function mcpConfigPlan(input: WorkerSessionLaunchRequest, cwd: string): WorkerMcpConfigPlan | undefined {
  if (input.configureMcp !== true) return undefined;
  const requestedClients = mcpClientsForHarness(input);
  const serverName = clean(input.mcpServerName) ?? "ciclo";
  const command = clean(input.mcpCommand) ?? "ciclo";
  const claudeChannel = input.mcpClaudeChannel === true;
  const clients = claudeChannel && !requestedClients.includes("claude")
    ? [...requestedClients, "claude" as const]
    : requestedClients;
  const install = installCicloMcp({
    projectRoot: cwd,
    clients,
    serverName,
    command,
    env: input.mcpEnv,
    additionalServers: input.mcpAdditionalServers,
    additionalServerSecretEnv: input.mcpAdditionalServerSecretEnv,
    secretEnv: input.mcpSecretEnv,
    ...(claudeChannel ? { claudeChannel } : {}),
    dryRun: true
  });
  return {
    enabled: true,
    projectRoot: cwd,
    clients,
    serverName,
    command,
    env: input.mcpEnv ?? {},
    envKeys: Object.keys(input.mcpEnv ?? {}),
    additionalServers: input.mcpAdditionalServers ?? {},
    additionalServerNames: Object.keys(input.mcpAdditionalServers ?? {}),
    additionalServerSecretEnv: input.mcpAdditionalServerSecretEnv ?? [],
    secretEnv: install.secretEnv,
    secretEnvBindings: input.mcpSecretEnv ?? [],
    ...(claudeChannel ? { claudeChannel } : {}),
    install,
    evidence: [
      "worker.mcp_config:planned",
      `worker.mcp_config.server:${serverName}`,
      `worker.mcp_config.clients:${clients.join(",")}`,
      `worker.mcp_config.project_root:${cwd}`,
      `worker.mcp_config.env_keys:${Object.keys(input.mcpEnv ?? {}).length}`,
      `worker.mcp_config.additional_servers:${Object.keys(input.mcpAdditionalServers ?? {}).length}`,
      `worker.mcp_config.additional_server_secret_env:${install.additionalServerSecretEnv.length}`,
      `worker.mcp_config.secret_env:${install.secretEnv.length}`,
      `worker.mcp_config.changed:${install.targets.some((target) => target.changed)}`
    ]
  };
}

function herdrPaneArgs(
  session: string,
  name: string,
  cwd: string,
  environment: WorkerEnvironmentPlan | undefined,
  command: string,
  args: readonly string[]
): readonly string[] {
  return [
    "--session",
    session,
    "agent",
    "start",
    name,
    "--cwd",
    cwd,
    ...herdrEnvironmentArgs(environment),
    "--no-focus",
    "--",
    command,
    ...args
  ];
}

function herdrWorkspacePaneArgs(args: readonly string[], workspaceId: string): readonly string[] {
  const cwdIndex = args.indexOf("--cwd");
  if (cwdIndex < 0) return args;
  return [
    ...args.slice(0, cwdIndex),
    "--workspace",
    workspaceId,
    ...args.slice(cwdIndex)
  ];
}

function launchMode(herdrSession: string | undefined): WorkerLaunchMode {
  return herdrSession === undefined ? "process" : "herdr_pane";
}

function agentRef(input: WorkerSessionLaunchRequest, name: string, mode: WorkerLaunchMode, herdrSession?: string): WorkerAgentRef {
  if (mode === "herdr_pane") {
    return {
      kind: "herdr_agent",
      id: name,
      target: name,
      herdrSession
    };
  }
  if (input.harnessId === "claude-code") {
    return { kind: "claude_background_session", id: name };
  }
  return { kind: "process", id: name };
}

function agentRefFromClaude(record: ClaudeBackgroundAgentRecord, fallbackId: string): WorkerAgentRef {
  return {
    kind: "claude_background_session",
    id: record.sessionId ?? record.jobId ?? fallbackId,
    sessionId: record.sessionId,
    jobId: record.jobId,
    pid: record.pid,
    status: record.status,
    waitingFor: record.waitingFor,
    ptyHost: record.ptySock,
    rendezvousHost: record.rendezvousSock,
    registrySource: record.source
  };
}

function stateFromClaudeStatus(record: ClaudeBackgroundAgentRecord, current: WorkerSessionState): WorkerSessionState {
  if (record.waitingFor !== undefined || record.status === "waiting") return "waiting_on_operator";
  if (record.status === "failed" || record.status === "error") return "failed";
  if (record.status === "stopped" || record.status === "killed") return "stopped";
  if (record.status === "done" || record.status === "completed" || record.status === "exited") return "completed";
  if (record.status === "busy" || record.status === "idle" || record.status === "shell" || record.status === "running") return "running";
  return current;
}

function terminalReason(state: WorkerSessionState, record: ClaudeBackgroundAgentRecord): string | undefined {
  if (state === "completed") return "claude background agent completed";
  if (state === "failed") return `claude background agent failed${record.status === undefined ? "" : `:${record.status}`}`;
  if (state === "stopped") return "claude background agent stopped";
  return undefined;
}

export function buildWorkerLaunchPlan(
  input: WorkerSessionLaunchRequest,
  root = process.cwd(),
  sessionId = `worker-${randomUUID()}`
): WorkerLaunchPlan {
  const model = normalizeWorkerModel(input.harnessId, input.model);
  const injectedPrompt = applyPromptInjections(input.prompt, input.promptInjections, "worker");
  const launchInput: WorkerSessionLaunchRequest = { ...input, model, prompt: injectedPrompt.prompt };
  const requestedCwd = clean(input.cwd) ?? root;
  const name = sessionName(launchInput, root);
  const worktree = worktreePlan(launchInput, requestedCwd, name, sessionId);
  const cwd = worktree?.path ?? requestedCwd;
  const extraArgs = cleanArgs(input.extraArgs);
  const mcpConfig = mcpConfigPlan(launchInput, cwd);
  const workerEnv = workerEnvironmentPlan(launchInput);
  const secretEnv = workerSecretEnvPlan(launchInput);
  const herdrSession = herdrPaneLaunchEnabled(launchInput);
  const localLaunchMode = launchMode(herdrSession);
  const mode = localLaunchMode === "herdr_pane" ? "herdr_agent" : directTrackingMode(launchInput);
  const harnessCommand = workerCommand(launchInput);
  const harnessArgs = localLaunchMode === "herdr_pane"
    ? paneWorkerArgs(launchInput, cwd, name, extraArgs)
    : directWorkerArgs(launchInput, cwd, name, extraArgs);
  const workerRuntimeSecrets = runtimeSecretBindings(launchInput.workerSecretEnv, "worker");
  const underlyingCommand = workerRuntimeSecrets.length === 0 ? harnessCommand : "ciclo";
  const underlyingArgs = workerRuntimeSecrets.length === 0 ? harnessArgs : secretExecArgs(workerRuntimeSecrets, harnessCommand, harnessArgs);
  const command = localLaunchMode === "herdr_pane" ? "herdr" : underlyingCommand;
  const args = localLaunchMode === "herdr_pane"
    ? herdrPaneArgs(herdrSession!, name, cwd, workerEnv, underlyingCommand, underlyingArgs)
    : underlyingArgs;
  return {
    sessionId,
    harnessId: input.harnessId,
    command,
    args,
    extraArgs,
    cwd,
    model,
    effort: clean(input.effort),
    ...(worktree === undefined ? {} : { worktree }),
    ...(mcpConfig === undefined ? {} : { mcpConfig }),
    ...(workerEnv === undefined ? {} : { workerEnv }),
    ...(secretEnv === undefined ? {} : { workerSecretEnv: secretEnv }),
    loopId: input.loopId,
    beadId: clean(input.beadId),
    sessionName: name,
    trackingMode: mode,
    launchMode: localLaunchMode,
    agentRef: agentRef(launchInput, name, localLaunchMode, herdrSession),
    prompt: launchInput.prompt,
    evidence: [
      `worker.session.plan:${sessionId}`,
      `worker.session.harness:${input.harnessId}`,
      `worker.session.loop:${input.loopId}`,
      `worker.session.tracking:${mode}`,
      `worker.session.launch_mode:${localLaunchMode}`,
      ...(launchInput.harnessId === "claude-code"
        ? [`worker.session.permission_mode:${effectiveClaudePermissionMode(launchInput)}`]
        : [
            `worker.session.approval_policy:${effectiveCodexApprovalPolicy(launchInput)}`,
            `worker.session.sandbox:${effectiveCodexSandbox(launchInput)}`
          ]),
      ...(model === undefined ? [] : [`worker.session.model:${model}`]),
      ...(herdrSession === undefined ? [] : [`worker.session.herdr_session:${herdrSession}`]),
      ...(input.beadId === undefined ? [] : [`worker.session.bead:${input.beadId}`]),
      ...(extraArgs.length === 0 ? [] : [`worker.session.extra_args:${extraArgs.length}`]),
      ...(worktree === undefined
        ? []
        : [
            "worker.worktree:create:true",
            `worker.worktree.path:${worktree.path}`,
            ...(worktree.branch === undefined ? [] : [`worker.worktree.branch:${worktree.branch}`]),
            ...(worktree.base === undefined ? [] : [`worker.worktree.base:${worktree.base}`]),
            `worker.worktree.force:${worktree.force}`
          ]),
      ...(mcpConfig === undefined ? [] : mcpConfig.evidence),
      ...(workerEnv === undefined ? [] : workerEnv.evidence),
      ...(secretEnv === undefined ? [] : secretEnv.evidence),
      ...injectedPrompt.evidence,
      input.dryRun === true ? "worker.session.dry_run:true" : "worker.session.dry_run:false"
    ]
  };
}

function installMcpConfig(plan: WorkerLaunchPlan): WorkerMcpConfigPlan | undefined {
  const mcpConfig = plan.mcpConfig;
  if (mcpConfig === undefined) return undefined;
  const install = installCicloMcp({
    projectRoot: mcpConfig.projectRoot,
    clients: mcpConfig.clients,
    serverName: mcpConfig.serverName,
    command: mcpConfig.command,
    env: mcpConfig.env,
    additionalServers: mcpConfig.additionalServers,
    additionalServerSecretEnv: mcpConfig.additionalServerSecretEnv,
    secretEnv: mcpConfig.secretEnvBindings,
    ...(mcpConfig.claudeChannel === true ? { claudeChannel: true } : {}),
    dryRun: false
  });
  return {
    ...mcpConfig,
    install,
    evidence: [
      ...mcpConfig.evidence,
      "worker.mcp_config:installed",
      `worker.mcp_config.installed:${install.installed}`,
      ...install.targets.map((target) => `worker.mcp_config.target:${target.client}:${target.changed ? "changed" : "unchanged"}`)
    ]
  };
}

interface PreparedWorktree {
  readonly evidence: readonly string[];
  readonly herdrWorkspaceId?: string;
}

function parseHerdrWorkspaceIdValue(value: unknown): string | undefined {
  if (typeof value === "string") return clean(value);
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = parseHerdrWorkspaceIdValue(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["workspace_id", "workspaceId"]) {
    const found = parseHerdrWorkspaceIdValue(record[key]);
    if (found !== undefined) return found;
  }
  const workspace = parseHerdrWorkspaceIdValue(record.workspace);
  if (workspace !== undefined) return workspace;
  return parseHerdrWorkspaceIdValue(record.id);
}

function parseHerdrWorkspaceId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const workspaceId = parseHerdrWorkspaceIdValue(JSON.parse(trimmed) as unknown);
    return isConcreteHerdrWorkspaceId(workspaceId) ? workspaceId : undefined;
  } catch {
    return undefined;
  }
}

function isConcreteHerdrWorkspaceId(value: string | undefined): value is string {
  return value !== undefined && !value.startsWith("cli:");
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function parseHerdrWorktreeWorkspaceId(stdout: string, worktreePath: string): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== "object") return undefined;
  const result = (payload as Record<string, unknown>).result;
  if (result === null || typeof result !== "object") return undefined;
  const worktrees = (result as Record<string, unknown>).worktrees;
  if (!Array.isArray(worktrees)) return undefined;

  const target = canonicalExistingPath(worktreePath);
  for (const item of worktrees) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string") continue;
    if (canonicalExistingPath(record.path) !== target) continue;
    const workspaceId = typeof record.open_workspace_id === "string" ? clean(record.open_workspace_id) : undefined;
    if (isConcreteHerdrWorkspaceId(workspaceId)) return workspaceId;
  }
  return undefined;
}

function prepareHerdrWorktree(plan: WorkerLaunchPlan, root: string, runner: WorkerCommandRunner): PreparedWorktree {
  const worktree = plan.worktree;
  if (worktree === undefined) return { evidence: [] };
  const session = plan.agentRef?.herdrSession;
  const mode = "create";
  mkdirSync(dirname(worktree.path), { recursive: true });
  const args = [
    ...(session === undefined ? [] : ["--session", session]),
    "worktree",
    mode,
    "--cwd",
    root,
    ...(worktree.branch !== undefined ? ["--branch", worktree.branch] : []),
    ...(worktree.base !== undefined ? ["--base", worktree.base] : []),
    "--path",
    worktree.path,
    "--label",
    plan.sessionName,
    "--no-focus",
    "--json"
  ];
  const result = runner.run("herdr", args, { cwd: root });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "herdr worktree command failed").trim();
    throw new Error(message);
  }
  const listed = runner.run("herdr", [
    ...(session === undefined ? [] : ["--session", session]),
    "worktree",
    "list",
    "--cwd",
    worktree.path,
    "--json"
  ], { cwd: root });
  if (listed.status !== 0) {
    const message = (listed.stderr || listed.stdout || "herdr worktree list failed").trim();
    throw new Error(message);
  }
  const workspaceId = parseHerdrWorkspaceId(result.stdout) ?? parseHerdrWorktreeWorkspaceId(listed.stdout, worktree.path);
  if (workspaceId === undefined) {
    throw new Error("herdr worktree create did not return a workspace id");
  }
  return {
    evidence: [
      `worker.worktree:herdr_${mode}`,
      `worker.worktree.herdr_workspace:${workspaceId}`
    ],
    herdrWorkspaceId: workspaceId
  };
}

function prepareGitWorktree(plan: WorkerLaunchPlan, root: string, runner: WorkerCommandRunner): PreparedWorktree {
  const worktree = plan.worktree;
  if (worktree === undefined) return { evidence: [] };
  if (existsSync(worktree.path)) return { evidence: ["worker.worktree:reused"] };

  mkdirSync(dirname(worktree.path), { recursive: true });
  const args = [
    "-C",
    root,
    "worktree",
    "add",
    ...(worktree.force ? ["--force"] : []),
    ...(worktree.branch === undefined ? [] : ["-b", worktree.branch]),
    worktree.path,
    ...(worktree.base === undefined ? [] : [worktree.base])
  ];
  const result = runner.run("git", args);
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "git worktree add failed").trim();
    throw new Error(message);
  }
  return { evidence: ["worker.worktree:created"] };
}

function prepareWorktree(plan: WorkerLaunchPlan, root: string, runner: WorkerCommandRunner): PreparedWorktree {
  if (plan.worktree === undefined) return { evidence: [] };
  if (plan.launchMode === "herdr_pane") return prepareHerdrWorktree(plan, root, runner);
  return prepareGitWorktree(plan, root, runner);
}

function isTerminalState(state: WorkerSessionState): boolean {
  return state === "completed" || state === "failed" || state === "stopped";
}

function isActiveState(state: WorkerSessionState): boolean {
  return state === "running" || state === "waiting_on_operator" || state === "stalled";
}

function usageValue(value: number | undefined): number {
  return Number.isFinite(value) ? value ?? 0 : 0;
}

function mergeUsage(current: WorkerUsageMetrics | undefined, next: WorkerUsageMetrics | undefined): WorkerUsageMetrics | undefined {
  if (next === undefined) return current;
  return {
    inputTokens: usageValue(current?.inputTokens) + usageValue(next.inputTokens),
    outputTokens: usageValue(current?.outputTokens) + usageValue(next.outputTokens),
    costUsd: usageValue(current?.costUsd) + usageValue(next.costUsd)
  };
}

export class WorkerSessionSupervisor {
  private readonly sessions = new Map<string, WorkerSessionRecord>();
  private readonly handles = new Map<string, WorkerProcessHandle>();
  private readonly launcher: WorkerProcessLauncher;
  private readonly clock: WorkerClock;
  private readonly events: CicloEventStore;

  constructor(
    private readonly root = process.cwd(),
    launcher?: WorkerProcessLauncher,
    clock?: WorkerClock,
    eventSink?: CicloEventStore,
    private readonly claudeAgents: ClaudeBackgroundAgentResolver = new FileClaudeBackgroundAgentResolver(),
    private readonly commandRunner: WorkerCommandRunner = new NodeWorkerCommandRunner()
  ) {
    this.launcher = launcher ?? new NodeWorkerProcessLauncher();
    this.clock = clock ?? defaultClock;
    this.events = eventSink ?? new CicloEventStore(() => this.clock.now());
  }

  private emit(record: WorkerSessionRecord, type: "worker.state_change" | "worker.launcher_exit", evidence: readonly string[] = []): void {
    this.events.append({
      type,
      workerSessionId: record.sessionId,
      loopId: record.loopId,
      beadId: record.beadId,
      state: record.state,
      evidence,
      data: {
        harness_id: record.harnessId,
        session_name: record.sessionName,
        tracking_mode: record.trackingMode,
        launch_mode: record.launchMode,
        agent_ref: record.agentRef,
        cwd: record.cwd,
        worktree: record.worktree,
        state_entered_at: record.stateEnteredAt,
        last_heartbeat_at: record.lastHeartbeatAt,
        usage: record.usage
      }
    });
  }

  private transition(
    session: WorkerSessionRecord,
    state: WorkerSessionState,
    evidence: readonly string[],
    extra: Partial<WorkerSessionRecord> = {},
    eventType: "worker.state_change" | "worker.stalled" = "worker.state_change"
  ): WorkerSessionRecord {
    const now = this.clock.now();
    const updated: WorkerSessionRecord = {
      ...session,
      ...extra,
      state,
      stateEnteredAt: session.state === state ? session.stateEnteredAt : now,
      evidence: [...session.evidence, ...evidence]
    };
    this.sessions.set(session.sessionId, updated);
    if (eventType === "worker.stalled") {
      this.events.append({
        type: "worker.stalled",
        workerSessionId: updated.sessionId,
        loopId: updated.loopId,
        beadId: updated.beadId,
        state: updated.state,
        evidence,
        data: {
          harness_id: updated.harnessId,
          session_name: updated.sessionName,
          last_heartbeat_at: updated.lastHeartbeatAt
        }
      });
    } else {
      this.emit(updated, eventType, evidence);
    }
    return updated;
  }

  private matches(session: WorkerSessionRecord, match: WorkerSessionMatch): boolean {
    if (match.sessionId !== undefined) return session.sessionId === match.sessionId;
    const loopMatches = match.loopId === undefined || session.loopId === match.loopId;
    const beadMatches = match.beadId === undefined || session.beadId === match.beadId;
    return loopMatches && beadMatches;
  }

  private refreshDetachedAgent(session: WorkerSessionRecord): WorkerSessionRecord {
    if (session.trackingMode !== "detached_agent" || session.agentRef?.kind !== "claude_background_session") return session;
    if (isTerminalState(session.state)) return session;
    const resolved = this.claudeAgents.resolve({ name: session.sessionName, cwd: session.cwd });
    if (resolved === undefined) return session;

    const nextState = stateFromClaudeStatus(resolved, session.state);
    const ref = agentRefFromClaude(resolved, session.agentRef.id);
    const activityAt = resolved.statusUpdatedAt ?? resolved.updatedAt;
    if (
      session.state === nextState &&
      session.agentRef?.sessionId === ref.sessionId &&
      session.agentRef?.jobId === ref.jobId &&
      session.agentRef?.status === ref.status &&
      session.agentRef?.waitingFor === ref.waitingFor &&
      session.agentRef?.ptyHost === ref.ptyHost &&
      session.lastHeartbeatAt === (activityAt ?? session.lastHeartbeatAt)
    ) {
      return session;
    }
    const evidence = [
      "worker.session.agent_registry:resolved",
      ...(resolved.status === undefined ? [] : [`worker.session.agent_registry.status:${resolved.status}`]),
      ...(resolved.sessionId === undefined ? [] : [`worker.session.agent_registry.session_id:${resolved.sessionId}`]),
      ...(resolved.jobId === undefined ? [] : [`worker.session.agent_registry.job_id:${resolved.jobId}`]),
      ...(resolved.ptySock === undefined ? [] : ["worker.session.agent_registry.pty:true"])
    ];
    const extra: Partial<WorkerSessionRecord> = {
      agentRef: ref,
      pid: ref.pid ?? session.pid,
      lastHeartbeatAt: activityAt ?? session.lastHeartbeatAt,
      cleanupReason: terminalReason(nextState, resolved) ?? session.cleanupReason,
      stoppedAt: isTerminalState(nextState) ? this.clock.now() : session.stoppedAt
    };
    return this.transition(session, nextState, evidence, extra);
  }

  refreshDetachedAgents(): readonly WorkerSessionRecord[] {
    return [...this.sessions.values()]
      .filter((session) => session.trackingMode === "detached_agent" && !isTerminalState(session.state))
      .map((session) => this.refreshDetachedAgent(session));
  }

  launch(input: WorkerSessionLaunchRequest): WorkerSessionRecord {
    const plan = buildWorkerLaunchPlan(input, this.root);
    if (input.dryRun === true) {
      const now = this.clock.now();
      const record: WorkerSessionRecord = {
        ...plan,
        state: "planned",
        stateEnteredAt: now,
        evidence: [
          ...plan.evidence,
          ...(plan.worktree === undefined ? [] : ["worker.worktree:dry_run"]),
          ...(plan.mcpConfig === undefined ? [] : ["worker.mcp_config:dry_run"]),
          "worker.session.launch:planned"
        ]
      };
      this.sessions.set(plan.sessionId, record);
      this.emit(record, "worker.state_change", ["worker.session.launch:planned"]);
      return record;
    }

    let preparedWorktree: PreparedWorktree = { evidence: [] };
    try {
      preparedWorktree = prepareWorktree(plan, this.root, this.commandRunner);
    } catch (error) {
      const now = this.clock.now();
      const failed: WorkerSessionRecord = {
        ...plan,
        state: "failed",
        startedAt: now,
        stoppedAt: now,
        stateEnteredAt: now,
        cleanupReason: error instanceof Error ? error.message : "worktree creation failed",
        evidence: [...plan.evidence, "worker.worktree:failed"]
      };
      this.sessions.set(plan.sessionId, failed);
      this.emit(failed, "worker.state_change", ["worker.worktree:failed"]);
      return failed;
    }

    const runtimeWorktree = plan.worktree === undefined || preparedWorktree.herdrWorkspaceId === undefined
      ? plan.worktree
      : { ...plan.worktree, herdrWorkspaceId: preparedWorktree.herdrWorkspaceId };
    const launchArgs = preparedWorktree.herdrWorkspaceId === undefined
      ? plan.args
      : herdrWorkspacePaneArgs(plan.args, preparedWorktree.herdrWorkspaceId);

    let mcpConfig: WorkerMcpConfigPlan | undefined;
    try {
      mcpConfig = installMcpConfig(plan);
    } catch (error) {
      const now = this.clock.now();
      const failed: WorkerSessionRecord = {
        ...plan,
        state: "failed",
        startedAt: now,
        stoppedAt: now,
        stateEnteredAt: now,
        cleanupReason: error instanceof Error ? error.message : "MCP configuration failed",
        args: launchArgs,
        worktree: runtimeWorktree,
        evidence: [...plan.evidence, ...preparedWorktree.evidence, "worker.mcp_config:failed"]
      };
      this.sessions.set(plan.sessionId, failed);
      this.emit(failed, "worker.state_change", ["worker.mcp_config:failed"]);
      return failed;
    }

    const startedAt = this.clock.now();
    const handle = this.launcher.launch(plan.command, launchArgs, {
      cwd: plan.cwd,
      env: { ...process.env, ...(plan.workerEnv?.values ?? {}) },
      detached: true,
      stdio: "ignore"
    });
    const started: WorkerSessionRecord = {
      ...plan,
      args: launchArgs,
      worktree: runtimeWorktree,
      ...(mcpConfig === undefined ? {} : { mcpConfig }),
      state: "running",
      pid: handle.pid,
      startedAt,
      stateEnteredAt: startedAt,
      lastHeartbeatAt: startedAt,
      evidence: [
        ...plan.evidence,
        ...preparedWorktree.evidence,
        ...(mcpConfig?.evidence ?? []),
        "worker.session.launch:started",
        ...(handle.pid === undefined ? [] : [`worker.session.pid:${handle.pid}`])
      ]
    };
    this.sessions.set(plan.sessionId, started);
    this.emit(started, "worker.state_change", ["worker.session.launch:started"]);
    this.handles.set(plan.sessionId, handle);
    handle.onExit((exitCode, signal) => {
      const current = this.sessions.get(plan.sessionId);
      if (current === undefined || !isActiveState(current.state)) return;
      if (current.launchMode === "herdr_pane" && exitCode === 0) {
        const updated: WorkerSessionRecord = {
          ...current,
          exitCode,
          signal,
          cleanupReason: "herdr pane launcher exited; pane agent is still tracked",
          evidence: [
            ...current.evidence,
            "worker.session.launcher_exit:herdr_pane_still_running",
            `worker.session.launcher_exit_code:${exitCode ?? "none"}`,
            `worker.session.launcher_signal:${signal ?? "none"}`
          ]
        };
        this.sessions.set(plan.sessionId, updated);
        this.handles.delete(plan.sessionId);
        this.emit(updated, "worker.launcher_exit", ["worker.session.launcher_exit:herdr_pane_still_running"]);
        return;
      }
      if (current.trackingMode === "detached_agent" && exitCode === 0) {
        const updated: WorkerSessionRecord = {
          ...current,
          exitCode,
          signal,
          cleanupReason: "launcher exited; detached agent is still tracked",
          evidence: [
            ...current.evidence,
            "worker.session.launcher_exit:detached_agent_still_running",
            `worker.session.launcher_exit_code:${exitCode ?? "none"}`,
            `worker.session.launcher_signal:${signal ?? "none"}`
          ]
        };
        this.sessions.set(plan.sessionId, updated);
        this.handles.delete(plan.sessionId);
        this.emit(updated, "worker.launcher_exit", ["worker.session.launcher_exit:detached_agent_still_running"]);
        return;
      }
      const state = exitCode === 0 ? "completed" : "failed";
      this.transition(current, state, [
        `worker.session.exit_code:${exitCode ?? "none"}`,
        `worker.session.signal:${signal ?? "none"}`
      ], {
        exitCode,
        signal,
        stoppedAt: this.clock.now(),
        cleanupReason: exitCode === 0 ? "worker exited successfully" : "worker process exited"
      });
      this.handles.delete(plan.sessionId);
    });
    return started;
  }

  list(): readonly WorkerSessionRecord[] {
    this.refreshDetachedAgents();
    return [...this.sessions.values()];
  }

  get(sessionId: string): WorkerSessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : this.refreshDetachedAgent(session);
  }

  stop(sessionId: string, reason: string, signal: NodeJS.Signals = "SIGTERM"): WorkerSessionRecord {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`worker session not found: ${sessionId}`);
    }
    if (!isActiveState(session.state)) {
      const shouldMarkStopped = session.state === "planned";
      if (shouldMarkStopped) {
        return this.transition(session, "stopped", [
          "worker.session.stop:not_running",
          `worker.session.stop.reason:${reason}`
        ], {
          stoppedAt: this.clock.now(),
          cleanupReason: reason
        });
      }
      const updated: WorkerSessionRecord = {
        ...session,
        cleanupReason: reason,
        evidence: [...session.evidence, "worker.session.stop:not_running", `worker.session.stop.reason:${reason}`]
      };
      this.sessions.set(sessionId, updated);
      this.emit(updated, "worker.state_change", ["worker.session.stop:not_running"]);
      return updated;
    }
    const stopped = this.handles.get(sessionId)?.stop(signal) ?? false;
    const updated = this.transition(session, "stopped", [
      `worker.session.stop:${stopped ? "sent" : "missing_handle"}`,
      `worker.session.stop.reason:${reason}`
    ], {
      stoppedAt: this.clock.now(),
      cleanupReason: reason,
      signal
    });
    this.handles.delete(sessionId);
    return updated;
  }

  heartbeat(sessionId: string, input: WorkerSessionHeartbeatInput | readonly string[] = []): WorkerSessionRecord {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`worker session not found: ${sessionId}`);
    const heartbeatInput = (Array.isArray(input)
      ? { evidence: input as readonly string[] }
      : input) as WorkerSessionHeartbeatInput;
    const evidence = ["worker.session.heartbeat", ...(heartbeatInput.evidence ?? [])];
    const requestedState = heartbeatInput.state ?? (session.state === "stalled" ? "running" : session.state);
    if (requestedState === "running" || requestedState === "waiting_on_operator") {
      return this.transition(session, requestedState, evidence, {
        lastHeartbeatAt: this.clock.now(),
        usage: mergeUsage(session.usage, heartbeatInput.usage)
      });
    }
    const updated: WorkerSessionRecord = {
      ...session,
      lastHeartbeatAt: this.clock.now(),
      usage: mergeUsage(session.usage, heartbeatInput.usage),
      evidence: [...session.evidence, ...evidence]
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  markWaitingOnOperator(match: WorkerSessionMatch, evidence: readonly string[] = []): readonly WorkerSessionRecord[] {
    const matched = this.list().filter((session) => isActiveState(session.state) && this.matches(session, match));
    return matched.map((session) =>
      this.transition(session, "waiting_on_operator", [
        "worker.session.waiting_on_operator",
        ...evidence
      ])
    );
  }

  resumeAfterOperator(match: WorkerSessionMatch, evidence: readonly string[] = []): readonly WorkerSessionRecord[] {
    const matched = this.list().filter((session) => session.state === "waiting_on_operator" && this.matches(session, match));
    return matched.map((session) =>
      this.transition(session, "running", [
        "worker.session.operator_answered",
        ...evidence
      ], {
        lastHeartbeatAt: this.clock.now()
      })
    );
  }

  refreshStalled(staleAfterMs: number, now = this.clock.now()): readonly WorkerSessionRecord[] {
    const nowMs = Date.parse(now);
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0 || !Number.isFinite(nowMs)) return [];
    const stalled: WorkerSessionRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.state !== "running") continue;
      const activityAt = Date.parse(session.lastHeartbeatAt ?? session.startedAt ?? session.stateEnteredAt ?? now);
      if (!Number.isFinite(activityAt) || nowMs - activityAt < staleAfterMs) continue;
      stalled.push(this.transition(session, "stalled", [
        `worker.session.stalled_after_ms:${staleAfterMs}`,
        `worker.session.last_activity_at:${session.lastHeartbeatAt ?? session.startedAt ?? "unknown"}`
      ], {}, "worker.stalled"));
    }
    return stalled;
  }

  recordAgentExit(
    sessionId: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    reason = "detached agent exited"
  ): WorkerSessionRecord {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`worker session not found: ${sessionId}`);
    const updated = this.transition(session, exitCode === 0 ? "completed" : "failed", [
        `worker.session.agent_exit_code:${exitCode ?? "none"}`,
        `worker.session.agent_signal:${signal ?? "none"}`
      ], {
        exitCode,
        signal,
        stoppedAt: this.clock.now(),
        cleanupReason: reason
      });
    this.handles.delete(sessionId);
    return updated;
  }

  metrics(now = this.clock.now()): WorkerSessionMetrics {
    const nowMs = Date.parse(now);
    const byState: Record<string, number> = {};
    const timeInStateMs: Record<string, number> = {};
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    for (const session of this.sessions.values()) {
      byState[session.state] = (byState[session.state] ?? 0) + 1;
      const enteredAtMs = Date.parse(session.stateEnteredAt ?? session.startedAt ?? now);
      const endAtMs = session.stoppedAt === undefined ? nowMs : Date.parse(session.stoppedAt);
      const duration = Number.isFinite(enteredAtMs) && Number.isFinite(endAtMs)
        ? Math.max(0, endAtMs - enteredAtMs)
        : 0;
      timeInStateMs[session.state] = (timeInStateMs[session.state] ?? 0) + duration;
      usage.inputTokens += usageValue(session.usage?.inputTokens);
      usage.outputTokens += usageValue(session.usage?.outputTokens);
      usage.costUsd += usageValue(session.usage?.costUsd);
    }
    return {
      total: this.sessions.size,
      byState,
      timeInStateMs,
      usage
    };
  }

  pollEvents(cursor = 0, limit = 100): CicloEventPollResult {
    return this.events.poll(cursor, limit);
  }
}
