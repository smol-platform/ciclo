import type { OperatorFeedbackRecord } from "./operator-routing.js";
import { OperatorRoutingStore, type FeedbackSeverity } from "./operator-routing.js";
import type { RemoteSessionRecord, RemoteSessionState } from "./remote-session-registry.js";

export type RemoteSessionHandoffState = Extract<
  RemoteSessionState,
  "blocked" | "detached" | "done" | "lost"
>;

export interface RemoteSessionHandoffInput {
  readonly session: RemoteSessionRecord;
  readonly finalSummary?: string;
  readonly artifacts?: readonly string[];
  readonly blockers?: readonly string[];
  readonly requestedNextAction?: string;
  readonly now?: string;
  readonly principalId?: string;
}

export interface RemoteSessionHandoffSummary {
  readonly remoteSessionId: string;
  readonly loopId?: string;
  readonly beadId?: string;
  readonly harnessId: string;
  readonly state: RemoteSessionHandoffState;
  readonly severity: FeedbackSeverity;
  readonly finalSummary: string;
  readonly artifacts: readonly string[];
  readonly blockers: readonly string[];
  readonly requestedNextAction: string;
  readonly evidence: readonly string[];
}

export interface RemoteSessionHandoffResult {
  readonly handedOff: boolean;
  readonly reason: string;
  readonly summary?: RemoteSessionHandoffSummary;
  readonly feedback?: OperatorFeedbackRecord;
  readonly evidence: readonly string[];
}

const handoffStates = new Set<RemoteSessionState>(["blocked", "detached", "done", "lost"]);

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function cleanList(values: readonly string[] | undefined): readonly string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

function primaryHarness(session: RemoteSessionRecord): string {
  return session.lastObservation?.harness ?? session.harnesses[0] ?? "unknown";
}

function severityFor(state: RemoteSessionHandoffState): FeedbackSeverity {
  switch (state) {
    case "lost":
      return "error";
    case "blocked":
      return "warning";
    case "detached":
      return "info";
    case "done":
      return "info";
  }
}

function defaultSummary(session: RemoteSessionRecord, state: RemoteSessionHandoffState): string {
  switch (state) {
    case "done":
      return `Remote session ${session.id} reports work is done.`;
    case "lost":
      return `Remote session ${session.id} was lost before Ciclo could confirm completion.`;
    case "detached":
      return `Remote session ${session.id} detached and needs operator review.`;
    case "blocked":
      return `Remote session ${session.id} is blocked.`;
  }
}

function defaultRequestedNextAction(state: RemoteSessionHandoffState): string {
  switch (state) {
    case "done":
      return "Review final evidence, run required validation, and close or continue the Beads task.";
    case "lost":
      return "Inspect the remote session, restore Herdr connectivity, then decide whether to resume or reassign the Beads task.";
    case "detached":
      return "Review the detached session summary and either resume, reassign, or close the Beads task.";
    case "blocked":
      return "Answer the blocker or reassign the work through Ciclo.";
  }
}

function blockersFromSession(session: RemoteSessionRecord, explicit: readonly string[]): readonly string[] {
  const derived = [
    session.lastAttachError,
    ...(session.state === "blocked" ? session.lastObservation?.evidence ?? [] : [])
  ];
  return [...new Set([...explicit, ...derived].flatMap((item) => {
    const value = clean(item);
    return value === undefined ? [] : [value];
  }))];
}

export function buildRemoteSessionHandoff(input: RemoteSessionHandoffInput): RemoteSessionHandoffResult {
  if (!handoffStates.has(input.session.state)) {
    return {
      handedOff: false,
      reason: `remote session state ${input.session.state} does not require handoff`,
      evidence: [`remote.handoff.skipped:${input.session.id}:${input.session.state}`]
    };
  }

  const state = input.session.state as RemoteSessionHandoffState;
  const harnessId = primaryHarness(input.session);
  const blockers = blockersFromSession(input.session, cleanList(input.blockers));
  const summary: RemoteSessionHandoffSummary = {
    remoteSessionId: input.session.id,
    loopId: input.session.activeLoopId,
    beadId: input.session.activeBeadId,
    harnessId,
    state,
    severity: severityFor(state),
    finalSummary: clean(input.finalSummary) ?? defaultSummary(input.session, state),
    artifacts: cleanList(input.artifacts),
    blockers,
    requestedNextAction: clean(input.requestedNextAction) ?? defaultRequestedNextAction(state),
    evidence: [
      `remote.handoff:${input.session.id}`,
      `remote.handoff.state:${state}`,
      ...(input.session.activeLoopId === undefined ? [] : [`remote.handoff.loop:${input.session.activeLoopId}`]),
      ...(input.session.activeBeadId === undefined ? [] : [`remote.handoff.bead:${input.session.activeBeadId}`]),
      `remote.handoff.harness:${harnessId}`,
      ...input.session.evidence,
      ...(input.session.lastObservation?.evidence ?? [])
    ]
  };

  return {
    handedOff: true,
    reason: "remote session handoff summary built",
    summary,
    evidence: summary.evidence
  };
}

export function reportRemoteSessionHandoff(
  routing: OperatorRoutingStore,
  input: RemoteSessionHandoffInput
): RemoteSessionHandoffResult {
  const built = buildRemoteSessionHandoff(input);
  if (!built.handedOff || built.summary === undefined) return built;

  const feedback = routing.reportFeedback({
    loopId: built.summary.loopId,
    beadId: built.summary.beadId,
    harnessId: built.summary.harnessId,
    remoteSessionId: built.summary.remoteSessionId,
    severity: built.summary.severity,
    message: JSON.stringify({
      type: "remote_session_handoff",
      remote_session_id: built.summary.remoteSessionId,
      loop_id: built.summary.loopId,
      bead_id: built.summary.beadId,
      harness_id: built.summary.harnessId,
      state: built.summary.state,
      final_summary: built.summary.finalSummary,
      artifacts: built.summary.artifacts,
      blockers: built.summary.blockers,
      requested_next_action: built.summary.requestedNextAction
    }),
    principalId: input.principalId,
    evidence: built.summary.evidence,
    now: input.now
  });

  return {
    ...built,
    feedback: feedback.feedback,
    reason: feedback.deduplicated
      ? "remote session handoff feedback was deduplicated"
      : "remote session handoff feedback was queued",
    evidence: [...built.evidence, ...feedback.evidence]
  };
}
