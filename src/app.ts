import { planNext, runtimeDecision, type HerdrObservation, type LoopConfig } from "./ciclo-core.js";
import { createDefaultRegistry } from "./harness-registry.js";

export interface CicloStandaloneStatus {
  readonly ok: true;
  readonly app: "ciclo";
  readonly runtime: typeof runtimeDecision.runtime;
  readonly orchestratorAgent: true;
  readonly brain: {
    readonly provider: "pi";
    readonly role: "internal_brain_provider";
  };
  readonly pluginMatch: ReturnType<ReturnType<typeof createDefaultRegistry>["select"]>;
  readonly plan: ReturnType<typeof planNext>;
}

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
  evidence: ["fixture:pi-decision-engine", "repo:unverified"]
};

export function buildStandaloneStatus(
  loop: LoopConfig = demoLoop,
  observation: HerdrObservation = demoObservation
): CicloStandaloneStatus {
  const registry = createDefaultRegistry();
  return {
    ok: true,
    app: "ciclo",
    runtime: runtimeDecision.runtime,
    orchestratorAgent: true,
    brain: {
      provider: "pi",
      role: "internal_brain_provider"
    },
    pluginMatch: registry.select(observation, loop),
    plan: planNext(loop, observation)
  };
}
