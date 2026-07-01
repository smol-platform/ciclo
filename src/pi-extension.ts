import { planNext, runtimeDecision, type HerdrObservation, type LoopConfig } from "./ciclo-core.js";
import { createDefaultRegistry } from "./harness-registry.js";
import type { PiExtensionApi, PiExtensionContext } from "./pi-types.js";

const demoLoop: LoopConfig = {
  id: "review-demo",
  kind: "review",
  goal: "Review completed agent work and preserve evidence before mutating the repo.",
  harnesses: ["pi", "codex", "claude-code"],
  dryRun: true
};

const demoObservation: HerdrObservation = {
  source: "fixture",
  target: "local-demo",
  harness: "pi",
  state: "done",
  evidence: ["fixture:pi-session-done", "repo:unverified"]
};

export interface CicloExtensionRegistration {
  readonly name: "ciclo";
  readonly runtime: typeof runtimeDecision.runtime;
  readonly commands: readonly string[];
  readonly tools: readonly string[];
}

export default function cicloExtension(
  pi: PiExtensionApi = {},
  ctx: PiExtensionContext = {}
): CicloExtensionRegistration {
  const registry = createDefaultRegistry();
  const pluginMatch = registry.select(demoObservation, demoLoop);

  pi.registerTool?.({
    name: "ciclo_status",
    description: "Return Ciclo loop supervision status for the current Pi session.",
    execute: () => ({
      runtime: runtimeDecision.runtime,
      cwd: ctx.cwd ?? process.cwd(),
      idle: ctx.isIdle?.() ?? null,
      contextUsage: ctx.getContextUsage?.() ?? null,
      pluginMatch,
      plan: planNext(demoLoop, demoObservation)
    })
  });

  pi.registerCommand?.("ciclo-status", {
    description: "Show Ciclo dry-run supervision status.",
    handler: () => planNext(demoLoop, demoObservation)
  });

  pi.on?.("shutdown", () => undefined);

  return {
    name: "ciclo",
    runtime: runtimeDecision.runtime,
    commands: ["ciclo-status"],
    tools: ["ciclo_status"]
  };
}
