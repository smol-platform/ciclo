import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager
} from "@earendil-works/pi-coding-agent";

export const defaultOpenAiBrainModel = "openai-codex/gpt-5.5";
export const defaultOpenAiBrainThinking = "high";

export const openAiDecisionPurposes = [
  "remote_session_monitoring",
  "context_insertion",
  "answer_question",
  "user_session_interface"
] as const;

export type OpenAiDecisionPurpose = (typeof openAiDecisionPurposes)[number];
type OpenAiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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
}

export interface OpenAiBrainDecision {
  readonly provider: "openai";
  readonly adapter: "pi-sdk";
  readonly model: string;
  readonly thinking: string;
  readonly purpose: OpenAiDecisionPurpose;
  readonly text: string;
  readonly evidence: readonly string[];
}

export interface OpenAiBrainStatus {
  readonly provider: "openai";
  readonly adapter: "pi-sdk";
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
}) => Promise<string>;

export const openAiBrainPolicy: OpenAiBrainStatus = {
  provider: "openai",
  adapter: "pi-sdk",
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

async function completeWithPiSdk(prompt: string, options: { readonly model: string; readonly thinking: string }): Promise<string> {
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

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model,
    thinkingLevel,
    noTools: "all",
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
  return [
    "You are Ciclo's OpenAI-backed orchestration brain.",
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
    "Return the next safe Ciclo action. Be concise, cite uncertainty, and ask the operator when product intent, secrets, deploy approval, or destructive action is unclear."
  ]
    .filter((item): item is string => item !== undefined)
    .join("\n");
}

export class PiSdkOpenAiBrain implements OpenAiBrain {
  constructor(
    private readonly options: {
      readonly model?: string;
      readonly thinking?: string;
      readonly runner?: OpenAiPromptRunner;
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
    const text = await runner(promptForDecision(input), {
      model: status.model,
      thinking: status.thinking
    });
    return {
      provider: "openai",
      adapter: "pi-sdk",
      model: status.model,
      thinking: status.thinking,
      purpose: input.purpose,
      text,
      evidence: [
        "brain.provider:openai",
        "brain.adapter:pi-sdk",
        `brain.model:${status.model}`,
        `brain.thinking:${status.thinking}`,
        `brain.purpose:${input.purpose}`,
        "brain.fallback:fail_closed",
        ...(input.evidence ?? [])
      ]
    };
  }
}
