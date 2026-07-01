import type { HarnessId, HerdrObservation, LoopConfig } from "./ciclo-core.js";

export interface PluginMatch {
  readonly pluginId: HarnessId;
  readonly confidence: number;
  readonly reason: string;
}

export interface HarnessPromptRequest {
  readonly loop: LoopConfig;
  readonly observation: HerdrObservation;
  readonly action: "review" | "implement" | "test" | "deploy-gate" | "summarize";
  readonly specId: string;
  readonly taskTitle: string;
  readonly taskBody?: string;
  readonly beadId?: string;
  readonly repoSummary?: string;
  readonly acceptanceCriteria: readonly string[];
  readonly validationCommands: readonly string[];
}

export interface HarnessPlugin {
  readonly id: HarnessId;
  readonly displayName: string;
  readonly supportedAgents: readonly string[];
  detect(observation: HerdrObservation, loop?: LoopConfig): PluginMatch;
  buildPrompt(request: HarnessPromptRequest): string;
  classifyBlockedReason?(observation: HerdrObservation): string | undefined;
}

function configuredForLoop(plugin: Pick<HarnessPlugin, "id">, loop: LoopConfig | undefined): boolean {
  return loop === undefined || loop.harnesses.includes(plugin.id);
}

function labelIncludes(observation: HerdrObservation, needle: string): boolean {
  return (observation.agentLabel ?? observation.harness).toLowerCase().includes(needle);
}

function detectKnown(
  plugin: Pick<HarnessPlugin, "id">,
  observation: HerdrObservation,
  loop: LoopConfig | undefined
): PluginMatch {
  if (!configuredForLoop(plugin, loop)) {
    return {
      pluginId: plugin.id,
      confidence: 0,
      reason: `${plugin.id} is not enabled for loop ${loop?.id ?? "unknown"}`
    };
  }
  if (observation.harness === plugin.id) {
    return {
      pluginId: plugin.id,
      confidence: 1,
      reason: `Herdr normalized harness as ${plugin.id}`
    };
  }
  const needle = plugin.id === "claude-code" ? "claude" : plugin.id;
  if (labelIncludes(observation, needle)) {
    return {
      pluginId: plugin.id,
      confidence: 0.85,
      reason: `agent label matched ${needle}`
    };
  }
  return {
    pluginId: plugin.id,
    confidence: 0,
    reason: "no matching Herdr metadata"
  };
}

function bulletList(items: readonly string[], fallback: string): string {
  const values = items.length > 0 ? items : [fallback];
  return values.map((item) => `- ${item}`).join("\n");
}

function evidenceLine(observation: HerdrObservation): string {
  return observation.evidence.length > 0 ? observation.evidence.join("; ") : "no evidence";
}

export const codexPlugin: HarnessPlugin = {
  id: "codex",
  displayName: "Codex",
  supportedAgents: ["codex", "OpenAI Codex"],
  detect(observation, loop) {
    return detectKnown(this, observation, loop);
  },
  buildPrompt(request) {
    return [
      `Continue Ciclo loop ${request.loop.id}.`,
      `Spec: ${request.specId}`,
      request.beadId === undefined ? undefined : `Beads task: ${request.beadId}`,
      `Action: ${request.action}`,
      `Task: ${request.taskTitle}`,
      request.taskBody === undefined ? undefined : `Details: ${request.taskBody}`,
      `Known repo state: ${request.repoSummary ?? "not probed"}`,
      `Observed harness state: ${request.observation.state} on ${request.observation.target}`,
      `Evidence: ${evidenceLine(request.observation)}`,
      "Acceptance:",
      bulletList(request.acceptanceCriteria, "State what acceptance evidence is missing."),
      "Validation requested:",
      bulletList(request.validationCommands, "Run the narrowest relevant validation and report it."),
      "Return with tests run, validation evidence, remaining blockers, and any follow-up Beads work needed.",
      "Stop and ask before secrets, destructive changes, deploys, or unclear product intent."
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  },
  classifyBlockedReason(observation) {
    const text = observation.evidence.join(" ").toLowerCase();
    if (text.includes("approval")) return "waiting_for_approval";
    if (text.includes("sandbox")) return "sandbox_blocked";
    if (text.includes("conflict")) return "merge_or_patch_conflict";
    return observation.state === "blocked" ? "codex_blocked" : undefined;
  }
};

export const claudeCodePlugin: HarnessPlugin = {
  id: "claude-code",
  displayName: "Claude Code",
  supportedAgents: ["claude-code", "Claude Code"],
  detect(observation, loop) {
    return detectKnown(this, observation, loop);
  },
  buildPrompt(request) {
    return [
      `You are continuing Ciclo loop ${request.loop.id}.`,
      `Current goal: ${request.loop.goal}`,
      request.beadId === undefined ? undefined : `Beads task: ${request.beadId}`,
      `Required next action: ${request.action} - ${request.taskTitle}`,
      request.taskBody === undefined ? undefined : `Task details: ${request.taskBody}`,
      `Observed state: ${request.observation.state} on ${request.observation.target}`,
      `Repository state: ${request.repoSummary ?? "not probed"}`,
      `Evidence: ${evidenceLine(request.observation)}`,
      "Acceptance criteria:",
      bulletList(request.acceptanceCriteria, "Ask which acceptance criteria should apply."),
      "Validation to run or request:",
      bulletList(request.validationCommands, "Report why validation could not run."),
      "Do not approve permission prompts, deployments, destructive commands, credential use, or remote sync.",
      "Ask the operator when approval, secrets, destructive changes, or unclear product intent are required."
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  },
  classifyBlockedReason(observation) {
    const text = observation.evidence.join(" ").toLowerCase();
    if (text.includes("permission")) return "permission_prompt";
    if (text.includes("approval")) return "waiting_for_approval";
    if (text.includes("input")) return "needs_operator_input";
    return observation.state === "blocked" ? "claude_code_blocked" : undefined;
  }
};

export const piPlugin: HarnessPlugin = {
  id: "pi",
  displayName: "Pi",
  supportedAgents: ["pi", "Pi"],
  detect(observation, loop) {
    return detectKnown(this, observation, loop);
  },
  buildPrompt(request) {
    return [
      `Continue Ciclo goal: ${request.loop.goal}`,
      "Harness: Pi",
      `Observed target: ${request.observation.target}`,
      `Observed state: ${request.observation.state}`,
      `Required next action: ${request.action}`,
      "Stop and ask before secrets, destructive changes, or unclear product intent."
    ].join("\n");
  }
};

export const unknownPlugin: HarnessPlugin = {
  id: "unknown",
  displayName: "Unknown harness",
  supportedAgents: ["unknown"],
  detect() {
    return {
      pluginId: "unknown",
      confidence: 0.05,
      reason: "fallback observe-only plugin"
    };
  },
  buildPrompt(request) {
    return [
      `Observe Ciclo goal: ${request.loop.goal}`,
      `Unknown harness at target ${request.observation.target}`,
      "Do not send harness-specific instructions."
    ].join("\n");
  }
};

export class HarnessRegistry {
  constructor(readonly plugins: readonly HarnessPlugin[]) {}

  select(observation: HerdrObservation, loop?: LoopConfig): PluginMatch {
    const matches = this.plugins.map((plugin, index) => ({
      index,
      match: plugin.detect(observation, loop)
    }));
    matches.sort((left, right) => {
      const confidenceDelta = right.match.confidence - left.match.confidence;
      return confidenceDelta === 0 ? left.index - right.index : confidenceDelta;
    });
    return matches[0]?.match ?? unknownPlugin.detect(observation, loop);
  }

  pluginFor(id: HarnessId): HarnessPlugin {
    return this.plugins.find((plugin) => plugin.id === id) ?? unknownPlugin;
  }
}

export function createDefaultRegistry(): HarnessRegistry {
  return new HarnessRegistry([piPlugin, claudeCodePlugin, codexPlugin, unknownPlugin]);
}
