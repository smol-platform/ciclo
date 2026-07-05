import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";

import { applyPromptInjections, promptInjectionEvidence, type CicloPromptInjection } from "./prompt-injection.js";

export const defaultOpenAiBrainModel = "openai-codex/gpt-5.5";
export const defaultOpenAiBrainThinking = "high";
export const openAiBrainModelFamily = "openai";
export const openAiBrainIntelligence = "model_backed";

export const openAiDecisionPurposes = [
  "remote_session_monitoring",
  "context_insertion",
  "answer_question",
  "user_session_interface"
] as const;

export type OpenAiDecisionPurpose = (typeof openAiDecisionPurposes)[number];
type OpenAiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const openAiControlActionKinds = [
  "wait",
  "nudge",
  "inject_context",
  "ask_operator",
  "relaunch_stronger_model",
  "launch_review_worker",
  "launch_debug_worker",
  "launch_test_worker",
  "stop"
] as const;

export type OpenAiControlActionKind = (typeof openAiControlActionKinds)[number];

export interface OpenAiControlAction {
  readonly kind: OpenAiControlActionKind;
  readonly reason?: string;
  readonly message?: string;
  readonly harnessId?: "claude-code" | "codex";
  readonly model?: string;
  readonly effort?: string;
}

export const openAiBrainToolNames = [
  "ciclo_list_workers",
  "ciclo_observe_worker",
  "ciclo_nudge_worker",
  "ciclo_ask_operator",
  "ciclo_stop_worker",
  "ciclo_launch_worker",
  "ciclo_poll_events",
  "ciclo_heartbeat_status"
] as const;

export type OpenAiBrainToolName = (typeof openAiBrainToolNames)[number];

export interface OpenAiBrainToolSpec {
  readonly name: OpenAiBrainToolName;
  readonly description: string;
  readonly mutates: boolean;
}

export interface OpenAiBrainToolRequest {
  readonly name: OpenAiBrainToolName;
  readonly params: Record<string, unknown>;
  readonly reason?: string;
}

export interface OpenAiBrainToolResult {
  readonly name: OpenAiBrainToolName;
  readonly ok: boolean;
  readonly summary: string;
  readonly data?: Record<string, unknown>;
  readonly evidence: readonly string[];
}

export interface OpenAiBrainToolExecutor {
  availableTools(): readonly OpenAiBrainToolSpec[];
  execute(request: OpenAiBrainToolRequest): Promise<OpenAiBrainToolResult>;
}

export interface OpenAiBrainRouteContext {
  readonly loopId?: string;
  readonly beadId?: string;
  readonly harnessId?: string;
  readonly remoteSessionId?: string;
  readonly workerSessionId?: string;
}

export interface OpenAiBrainDecisionInput extends OpenAiBrainRouteContext {
  readonly purpose: OpenAiDecisionPurpose;
  readonly prompt: string;
  readonly context?: readonly string[];
  readonly evidence?: readonly string[];
  readonly promptInjections?: readonly CicloPromptInjection[];
  readonly toolExecutor?: OpenAiBrainToolExecutor;
}

export interface OpenAiBrainDecision {
  readonly provider: "openai";
  readonly adapter: "pi-sdk";
  readonly intelligence: typeof openAiBrainIntelligence;
  readonly modelFamily: typeof openAiBrainModelFamily;
  readonly model: string;
  readonly thinking: string;
  readonly purpose: OpenAiDecisionPurpose;
  readonly text: string;
  readonly action?: OpenAiControlAction;
  readonly toolResults?: readonly OpenAiBrainToolResult[];
  readonly evidence: readonly string[];
}

export interface OpenAiBrainStatus {
  readonly provider: "openai";
  readonly adapter: "pi-sdk";
  readonly intelligence: typeof openAiBrainIntelligence;
  readonly modelFamily: typeof openAiBrainModelFamily;
  readonly model: string;
  readonly thinking: string;
  readonly required_for: readonly OpenAiDecisionPurpose[];
  readonly local_cli_exceptions: readonly string[];
  readonly fallback: "fail_closed";
}

export interface OpenAiBrain {
  status(): OpenAiBrainStatus;
  decide(input: OpenAiBrainDecisionInput): Promise<OpenAiBrainDecision>;
}

export type OpenAiPromptRunner = (prompt: string, options: {
  readonly model: string;
  readonly thinking: string;
  readonly tools?: readonly ToolDefinition[];
}) => Promise<string>;

export const openAiBrainPolicy: OpenAiBrainStatus = {
  provider: "openai",
  adapter: "pi-sdk",
  intelligence: openAiBrainIntelligence,
  modelFamily: openAiBrainModelFamily,
  model: defaultOpenAiBrainModel,
  thinking: defaultOpenAiBrainThinking,
  required_for: openAiDecisionPurposes,
  local_cli_exceptions: [
    "help",
    "version",
    "status",
    "runtime",
    "mcp install",
    "skill install",
    "plugin install/list/enable/disable",
    "attach plan",
    "benchmark --judge scenario"
  ],
  fallback: "fail_closed"
};

function splitModelPattern(pattern: string): { readonly provider: string; readonly modelId: string } {
  const separator = pattern.indexOf("/");
  if (separator <= 0 || separator === pattern.length - 1) {
    throw new Error(`OpenAI brain model must use provider/model format: ${pattern}`);
  }
  return {
    provider: pattern.slice(0, separator),
    modelId: pattern.slice(separator + 1)
  };
}

async function completeWithPiSdk(prompt: string, options: {
  readonly model: string;
  readonly thinking: string;
  readonly tools?: readonly ToolDefinition[];
}): Promise<string> {
  const { provider, modelId } = splitModelPattern(options.model);
  const thinkingLevel = options.thinking as OpenAiThinkingLevel;
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = modelRegistry.find(provider, modelId);
  if (model === undefined) {
    throw new Error(`OpenAI brain model is not available through Pi: ${options.model}`);
  }
  if (!modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`OpenAI brain auth is not configured for provider: ${provider}`);
  }

  const customTools = [...(options.tools ?? [])];
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model,
    thinkingLevel,
    ...(customTools.length === 0
      ? { noTools: "all" as const }
      : {
          tools: customTools.map((tool) => tool.name),
          customTools
        }),
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager: SettingsManager.inMemory(
      {
        defaultProvider: provider,
        defaultModel: modelId,
        defaultThinkingLevel: thinkingLevel,
        compaction: { enabled: false },
        packages: [],
        extensions: [],
        skills: [],
        prompts: [],
        themes: []
      },
      { projectTrusted: false }
    ),
    authStorage,
    modelRegistry
  });

  try {
    await session.prompt(prompt, { expandPromptTemplates: false });
    const text = session.getLastAssistantText();
    if (text === undefined || text.trim().length === 0) {
      throw new Error("OpenAI brain returned no assistant text");
    }
    return text;
  } finally {
    session.dispose();
  }
}

function line(label: string, value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : `${label}: ${value}`;
}

function promptForDecision(input: OpenAiBrainDecisionInput): string {
  const toolSpecs = input.toolExecutor?.availableTools() ?? [];
  const prompt = [
    "You are Ciclo's model-backed OpenAI orchestration brain.",
    `Decision purpose: ${input.purpose}`,
    line("Loop", input.loopId),
    line("Beads task", input.beadId),
    line("Harness", input.harnessId),
    line("Remote session", input.remoteSessionId),
    line("Worker session", input.workerSessionId),
    "",
    "Operator or runtime prompt:",
    input.prompt,
    "",
    "Context:",
    ...(input.context ?? ["none"]).map((item) => `- ${item}`),
    "",
    "Evidence:",
    ...(input.evidence ?? ["none"]).map((item) => `- ${item}`),
    "",
    "Available Ciclo tools:",
    ...(toolSpecs.length === 0
      ? ["- none"]
      : toolSpecs.map((tool) => `- ${tool.name}: ${tool.description}${tool.mutates ? " (mutates Ciclo state)" : " (read-only)"}`)),
    "",
    toolSpecs.length === 0
      ? "No tools are available for this decision; use the bounded context only."
      : "Use Ciclo tools when you need live state or need to apply a safe control-plane action. After a mutating tool call, verify with a read tool before finalizing when possible.",
    "",
    "Return JSON first, optionally followed by concise explanation:",
    "{\"action\":{\"kind\":\"nudge\",\"reason\":\"why\",\"message\":\"operator or worker-facing text\",\"harnessId\":\"codex\",\"model\":\"optional\",\"effort\":\"optional\"},\"decision\":\"short rationale\"}",
    `Allowed action kinds: ${openAiControlActionKinds.join(", ")}.`,
    "Ask the operator when product intent, secrets, deploy approval, or destructive action is unclear."
  ]
    .filter((item): item is string => item !== undefined)
    .join("\n");
  return applyPromptInjections(prompt, input.promptInjections, "brain").prompt;
}

const openAiBrainToolParameterSchemas: Record<OpenAiBrainToolName, ToolDefinition["parameters"]> = {
  ciclo_list_workers: {
    type: "object",
    additionalProperties: false,
    properties: {
      state: {
        type: "string",
        enum: ["planned", "running", "waiting_on_operator", "stalled", "stopped", "failed", "completed"]
      },
      limit: { type: "number", minimum: 1, maximum: 100 }
    }
  } as unknown as ToolDefinition["parameters"],
  ciclo_observe_worker: {
    type: "object",
    additionalProperties: false,
    required: ["worker_session_id"],
    properties: {
      worker_session_id: { type: "string" },
      lines: { type: "number", minimum: 1, maximum: 200 }
    }
  } as unknown as ToolDefinition["parameters"],
  ciclo_nudge_worker: {
    type: "object",
    additionalProperties: false,
    required: ["worker_session_id", "message"],
    properties: {
      worker_session_id: { type: "string" },
      message: { type: "string" }
    }
  } as unknown as ToolDefinition["parameters"],
  ciclo_ask_operator: {
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: {
      worker_session_id: { type: "string" },
      loop_id: { type: "string" },
      bead_id: { type: "string" },
      message: { type: "string" },
      reason: { type: "string" }
    }
  } as unknown as ToolDefinition["parameters"],
  ciclo_stop_worker: {
    type: "object",
    additionalProperties: false,
    required: ["worker_session_id", "reason"],
    properties: {
      worker_session_id: { type: "string" },
      reason: { type: "string" }
    }
  } as unknown as ToolDefinition["parameters"],
  ciclo_launch_worker: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      loop_id: { type: "string" },
      bead_id: { type: "string" },
      harness_id: { type: "string", enum: ["claude-code", "codex"] },
      prompt: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      dry_run: { type: "boolean", default: true }
    }
  } as unknown as ToolDefinition["parameters"],
  ciclo_poll_events: {
    type: "object",
    additionalProperties: false,
    properties: {
      cursor: { type: "number", minimum: 0 },
      limit: { type: "number", minimum: 1, maximum: 100 }
    }
  } as unknown as ToolDefinition["parameters"],
  ciclo_heartbeat_status: {
    type: "object",
    additionalProperties: false,
    properties: {}
  } as unknown as ToolDefinition["parameters"]
};

export function createOpenAiBrainPiTools(
  executor: OpenAiBrainToolExecutor,
  results: OpenAiBrainToolResult[]
): readonly ToolDefinition[] {
  return executor.availableTools().map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    promptSnippet: spec.description,
    promptGuidelines: [
      "Use this Ciclo control-plane tool only for the current heartbeat or cron decision.",
      "Prefer read-only verification after mutating state."
    ],
    parameters: openAiBrainToolParameterSchemas[spec.name],
    executionMode: "sequential" as const,
    execute: async (_toolCallId, params) => {
      const result = await executor.execute({
        name: spec.name,
        params: typeof params === "object" && params !== null ? params as Record<string, unknown> : {}
      });
      results.push(result);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result
      };
    }
  }));
}

function jsonCandidate(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(text);
  const raw = (fence?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).trim();
  if (!raw.startsWith("{") || !raw.endsWith("}")) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function parseOpenAiControlAction(text: string): OpenAiControlAction | undefined {
  const candidate = jsonCandidate(text);
  if (candidate === undefined || typeof candidate !== "object" || candidate === null) return undefined;
  const record = candidate as Record<string, unknown>;
  const actionValue = record.action;
  const actionRecord = typeof actionValue === "string"
    ? { kind: actionValue }
    : typeof actionValue === "object" && actionValue !== null
      ? actionValue as Record<string, unknown>
      : record;
  const kind = stringField(actionRecord, "kind") ?? stringField(actionRecord, "action");
  if (kind === undefined || !openAiControlActionKinds.includes(kind as OpenAiControlActionKind)) return undefined;
  const harnessId = stringField(actionRecord, "harnessId") ?? stringField(actionRecord, "harness_id");
  const reason = stringField(actionRecord, "reason") ?? stringField(record, "reason");
  const message = stringField(actionRecord, "message") ?? stringField(record, "message");
  const model = stringField(actionRecord, "model") ?? stringField(record, "model");
  const effort = stringField(actionRecord, "effort") ?? stringField(record, "effort");
  return {
    kind: kind as OpenAiControlActionKind,
    ...(reason === undefined ? {} : { reason }),
    ...(message === undefined ? {} : { message }),
    ...(harnessId === "claude-code" || harnessId === "codex" ? { harnessId } : {}),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort })
  };
}

export class PiSdkOpenAiBrain implements OpenAiBrain {
  constructor(
    private readonly options: {
      readonly model?: string;
      readonly thinking?: string;
      readonly runner?: OpenAiPromptRunner;
      readonly promptInjections?: readonly CicloPromptInjection[];
    } = {}
  ) {}

  status(): OpenAiBrainStatus {
    return {
      ...openAiBrainPolicy,
      model: this.options.model ?? openAiBrainPolicy.model,
      thinking: this.options.thinking ?? openAiBrainPolicy.thinking
    };
  }

  async decide(input: OpenAiBrainDecisionInput): Promise<OpenAiBrainDecision> {
    const status = this.status();
    const runner = this.options.runner ?? completeWithPiSdk;
    const promptInjections = input.promptInjections ?? this.options.promptInjections;
    const toolResults: OpenAiBrainToolResult[] = [];
    const tools = input.toolExecutor === undefined
      ? []
      : createOpenAiBrainPiTools(input.toolExecutor, toolResults);
    const text = await runner(promptForDecision({ ...input, promptInjections }), {
      model: status.model,
      thinking: status.thinking,
      tools
    });
    const action = parseOpenAiControlAction(text);
    return {
      provider: "openai",
      adapter: "pi-sdk",
      intelligence: openAiBrainIntelligence,
      modelFamily: openAiBrainModelFamily,
      model: status.model,
      thinking: status.thinking,
      purpose: input.purpose,
      text,
      ...(action === undefined ? {} : { action }),
      ...(toolResults.length === 0 ? {} : { toolResults }),
      evidence: [
        "brain.provider:openai",
        "brain.adapter:pi-sdk",
        `brain.intelligence:${openAiBrainIntelligence}`,
        `brain.model_family:${openAiBrainModelFamily}`,
        `brain.model:${status.model}`,
        `brain.thinking:${status.thinking}`,
        `brain.purpose:${input.purpose}`,
        `brain.tools.available:${tools.length}`,
        `brain.tools.used:${toolResults.length}`,
        "brain.fallback:fail_closed",
        ...promptInjectionEvidence(promptInjections, "brain"),
        ...(input.evidence ?? [])
      ]
    };
  }
}
