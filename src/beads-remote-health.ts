import type { BeadsRemoteModeState } from "./beads-remote.js";

export type BeadsRemoteProblemKind = "connectivity" | "divergence" | "schema_skew" | "conflict";

export interface BeadsRemoteProblem {
  readonly kind: BeadsRemoteProblemKind;
  readonly summary: string;
  readonly details?: string;
}

export interface BeadsBlockerDraft {
  readonly title: string;
  readonly description: string;
  readonly labels: readonly string[];
}

export interface BeadsRemoteHealthDecision {
  readonly dispatchAllowed: boolean;
  readonly loopBlocked: boolean;
  readonly operatorFeedback: readonly string[];
  readonly beadsBlocker?: BeadsBlockerDraft;
  readonly evidence: readonly string[];
}

export interface EvaluateBeadsRemoteHealthInput {
  readonly state: BeadsRemoteModeState;
  readonly problems?: readonly BeadsRemoteProblem[];
  readonly createBeadsBlocker?: boolean;
}

function blockingProblems(problems: readonly BeadsRemoteProblem[]): readonly BeadsRemoteProblem[] {
  return problems.filter((problem) => problem.kind === "conflict" || problem.kind === "schema_skew");
}

function problemEvidence(problem: BeadsRemoteProblem): string {
  return `beads.remote.problem:${problem.kind}:${problem.summary}`;
}

function blockerDraft(
  state: BeadsRemoteModeState,
  problems: readonly BeadsRemoteProblem[],
  reason: string
): BeadsBlockerDraft {
  return {
    title: `Resolve Beads remote DB blocker for ${state.databaseIdentity}`,
    description: [
      reason,
      `Mode: ${state.mode}`,
      `Database: ${state.databaseIdentity}`,
      ...problems.map((problem) => `- ${problem.kind}: ${problem.summary}${problem.details === undefined ? "" : ` (${problem.details})`}`)
    ].join("\n"),
    labels: ["beads", "remote-db", "blocker", "spec-ciclo-001"]
  };
}

export function evaluateBeadsRemoteHealth(
  input: EvaluateBeadsRemoteHealthInput
): BeadsRemoteHealthDecision {
  const problems = input.problems ?? [];
  const evidence = [
    ...input.state.evidence,
    `beads.remote.identity:${input.state.databaseIdentity}`,
    ...problems.map(problemEvidence)
  ];
  const operatorFeedback: string[] = [];

  if (
    input.state.centralizedCoordinationRequired &&
    input.state.health === "unavailable"
  ) {
    const reason = `Beads remote DB is required but unavailable: ${input.state.databaseIdentity}`;
    operatorFeedback.push(reason);
    return {
      dispatchAllowed: false,
      loopBlocked: true,
      operatorFeedback,
      beadsBlocker: input.createBeadsBlocker ? blockerDraft(input.state, problems, reason) : undefined,
      evidence: [...evidence, "beads.remote.dispatch:block"]
    };
  }

  const blockers = blockingProblems(problems);
  if (blockers.length > 0) {
    const reason = `Beads remote DB has blocking ${blockers.map((problem) => problem.kind).join(", ")} state`;
    operatorFeedback.push(reason, ...blockers.map((problem) => problem.summary));
    return {
      dispatchAllowed: false,
      loopBlocked: true,
      operatorFeedback,
      beadsBlocker: input.createBeadsBlocker ? blockerDraft(input.state, blockers, reason) : undefined,
      evidence: [...evidence, "beads.remote.dispatch:block"]
    };
  }

  if (input.state.health === "degraded") {
    operatorFeedback.push(`Beads remote DB is degraded: ${input.state.databaseIdentity}`);
  }

  return {
    dispatchAllowed: true,
    loopBlocked: false,
    operatorFeedback,
    evidence: [...evidence, "beads.remote.dispatch:allow"]
  };
}
