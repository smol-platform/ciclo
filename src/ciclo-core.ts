export type HarnessId = "claude-code" | "codex" | "pi" | "unknown";

export type AgentState = "working" | "blocked" | "done" | "idle" | "unknown";

export type CicloResponseKind =
  | "wait"
  | "nudge_agent"
  | "claim_task"
  | "ask_operator"
  | "build_context_pack"
  | "report_feedback";

export interface HerdrObservation {
  readonly source: "herdr" | "fixture";
  readonly target: string;
  readonly harness: HarnessId;
  readonly state: AgentState;
  readonly cwd?: string;
  readonly agentLabel?: string;
  readonly evidence: readonly string[];
}

export interface LoopConfig {
  readonly id: string;
  readonly kind: "review" | "deploy" | "triage" | "benchmark" | "beads_work";
  readonly goal: string;
  readonly harnesses: readonly HarnessId[];
  readonly dryRun: boolean;
}

export interface CicloPlan {
  readonly loopId: string;
  readonly response: CicloResponseKind;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly dryRun: boolean;
}

export const runtimeDecision = {
  runtime: "Standalone TypeScript Ciclo orchestrator agent",
  entrypoints: [
    "standalone CLI: ./src/cli.ts",
    "npm script: ciclo-demo",
    "Pi brain adapter: ./src/pi-extension.ts",
    "local MCP stdio server: ./src/mcp-stdio.ts",
    "future benchmark runner"
  ],
  packageRoots: [
    "src/app.ts",
    "src/cli.ts",
    "src/pi-extension.ts",
    "src/ciclo-core.ts",
    "src/demo.ts",
    "src/mcp-stdio.ts",
    "future src/adapters",
    "future src/harnesses",
    "future src/mcp",
    "future src/bench"
  ],
  rationale: [
    "Ciclo is a standalone orchestrator agent for loops, sessions, MCP, Beads, Herdr, safety policy, and agent clouds.",
    "Pi is used under the covers as one brain provider that helps Ciclo choose high-quality next actions.",
    "The Pi adapter remains an internal brain/integration surface, but it does not define Ciclo's product boundary.",
    "Herdr and Beads remain external adapters behind the Ciclo planner boundary.",
    "Quint continues to model high-risk coordination invariants outside the runtime language."
  ]
} as const;

export function normalizeHarness(label: string | undefined): HarnessId {
  const normalized = (label ?? "").toLowerCase();
  if (normalized.includes("claude")) return "claude-code";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("pi")) return "pi";
  return "unknown";
}

export function planNext(loop: LoopConfig, observation: HerdrObservation): CicloPlan {
  const evidence = [...observation.evidence, `harness:${observation.harness}`];

  if (observation.state === "working") {
    return {
      loopId: loop.id,
      response: "wait",
      summary: `Wait for ${observation.target}; Herdr reports active work.`,
      evidence,
      dryRun: loop.dryRun
    };
  }

  if (observation.state === "blocked") {
    return {
      loopId: loop.id,
      response: "ask_operator",
      summary: `Surface the blocked ${observation.harness} session to the operator.`,
      evidence,
      dryRun: loop.dryRun
    };
  }

  if (observation.state === "done") {
    return {
      loopId: loop.id,
      response: loop.kind === "review" ? "build_context_pack" : "nudge_agent",
      summary: `Prepare the next ${loop.kind} loop step for ${observation.harness}.`,
      evidence,
      dryRun: loop.dryRun
    };
  }

  return {
    loopId: loop.id,
    response: "wait",
    summary: `Observe ${observation.target}; no safe action is available from state ${observation.state}.`,
    evidence,
    dryRun: loop.dryRun
  };
}
