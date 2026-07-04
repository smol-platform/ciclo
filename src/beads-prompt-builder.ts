import type { BeadsTaskSnapshot } from "./beads-adapter.js";
import type { HerdrObservation, LoopConfig } from "./ciclo-core.js";
import type {
  HarnessPlugin,
  HarnessPromptRequest
} from "./harness-registry.js";
import { applyPromptInjections, type CicloPromptInjection } from "./prompt-injection.js";

export interface BeadsPromptBuildInput {
  readonly task: BeadsTaskSnapshot;
  readonly loop: LoopConfig;
  readonly observation: HerdrObservation;
  readonly plugin: HarnessPlugin;
  readonly action?: HarnessPromptRequest["action"];
  readonly repoSummary?: string;
  readonly validationCommands?: readonly string[];
  readonly context?: readonly string[];
  readonly defaultSpecId?: string;
  readonly promptInjections?: readonly CicloPromptInjection[];
}

export interface BeadsPromptBuildResult {
  readonly request: HarnessPromptRequest;
  readonly prompt: string;
  readonly evidence: readonly string[];
}

function linesFromText(text: string): readonly string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/^[-*]\s*/u, "").trim())
    .filter((line) => line.length > 0);
}

function acceptanceCriteria(task: BeadsTaskSnapshot): readonly string[] {
  const parsed = linesFromText(task.acceptanceCriteria);
  return parsed.length > 0 ? parsed : ["Report which acceptance criteria are missing from the Beads task."];
}

function dependencyLines(task: BeadsTaskSnapshot): readonly string[] {
  if (task.dependencies.length === 0) return ["Known blockers: none from Beads snapshot."];
  return [
    "Known blockers/dependencies:",
    ...task.dependencies.map((dependency) => {
      const status = dependency.status ?? "unknown";
      const title = dependency.title === undefined ? "" : ` ${dependency.title}`;
      return `- ${dependency.id}${title} [${status}]`;
    })
  ];
}

function taskBody(input: BeadsPromptBuildInput): string {
  return [
    input.task.description.length === 0 ? "No Beads description was provided." : input.task.description,
    ...dependencyLines(input.task),
    input.context === undefined || input.context.length === 0
      ? "Additional context: none provided."
      : `Additional context:\n${input.context.map((item) => `- ${item}`).join("\n")}`
  ].join("\n\n");
}

function validationCommands(input: BeadsPromptBuildInput): readonly string[] {
  if (input.validationCommands !== undefined && input.validationCommands.length > 0) {
    return input.validationCommands;
  }
  return ["just check"];
}

export function buildBeadsHarnessPrompt(input: BeadsPromptBuildInput): BeadsPromptBuildResult {
  const specId = input.task.specId ?? input.defaultSpecId ?? "SPEC-CICLO-001";
  const request: HarnessPromptRequest = {
    loop: input.loop,
    observation: input.observation,
    action: input.action ?? "implement",
    specId,
    taskTitle: input.task.title,
    taskBody: taskBody(input),
    beadId: input.task.id,
    repoSummary: input.repoSummary,
    acceptanceCriteria: acceptanceCriteria(input.task),
    validationCommands: validationCommands(input)
  };
  const injectedPrompt = applyPromptInjections(input.plugin.buildPrompt(request), input.promptInjections, "beads");
  return {
    request,
    prompt: injectedPrompt.prompt,
    evidence: [
      `beads.prompt.task:${input.task.id}`,
      `beads.prompt.spec:${specId}`,
      `beads.prompt.harness:${input.plugin.id}`,
      `beads.prompt.acceptance:${request.acceptanceCriteria.length}`,
      `beads.prompt.validation:${request.validationCommands.join(",")}`,
      ...injectedPrompt.evidence
    ]
  };
}
