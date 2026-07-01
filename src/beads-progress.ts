import type { BeadsTaskSnapshot } from "./beads-adapter.js";
import type { AuthorizationResult } from "./access-enforcement.js";
import { formatCicloBeadsMetadata, type CicloBeadsRemoteMetadata } from "./beads-metadata.js";
import type { LoopConfig } from "./ciclo-core.js";
import type { PolicyConfig } from "./loop-config.js";
import { evaluatePolicy, type PolicyOutcome } from "./policy-gate.js";

export type BeadsProgressKind = "progress" | "blocker" | "validation" | "final_summary";

export interface ValidationEvidence {
  readonly command: string;
  readonly passed: boolean;
  readonly summary: string;
}

export interface BeadsProgressClient {
  show(id: string): Promise<BeadsTaskSnapshot>;
  note(id: string, message: string): Promise<void>;
  close(id: string, reason: string): Promise<BeadsTaskSnapshot>;
}

export interface BeadsProgressSync {
  pushAfterUpdate(): Promise<boolean>;
}

export interface BeadsProgressRecordInput {
  readonly id: string;
  readonly kind: BeadsProgressKind;
  readonly message: string;
  readonly loop: LoopConfig;
  readonly policy: PolicyConfig;
  readonly authorization?: AuthorizationResult;
  readonly principalId?: string;
  readonly harnessId?: string;
  readonly sessionId?: string;
  readonly remoteSession?: CicloBeadsRemoteMetadata;
  readonly validation?: ValidationEvidence;
  readonly blockerId?: string;
  readonly sync?: BeadsProgressSync;
}

export interface BeadsCloseInput {
  readonly id: string;
  readonly loop: LoopConfig;
  readonly policy: PolicyConfig;
  readonly finalSummary: string;
  readonly acceptanceEvidence: readonly string[];
  readonly validationEvidence: readonly ValidationEvidence[];
  readonly authorization?: AuthorizationResult;
  readonly principalId?: string;
  readonly harnessId?: string;
  readonly sessionId?: string;
  readonly remoteSession?: CicloBeadsRemoteMetadata;
  readonly sync?: BeadsProgressSync;
}

export interface BeadsMutationResult {
  readonly mutated: boolean;
  readonly action: "update_beads_progress" | "close_beads_task";
  readonly reason: string;
  readonly policy: PolicyOutcome;
  readonly pushed: boolean;
  readonly evidence: readonly string[];
  readonly task?: BeadsTaskSnapshot;
}

function deniedPolicy(action: BeadsMutationResult["action"], reason: string, evidence: readonly string[]): PolicyOutcome {
  return {
    decision: "deny",
    reason,
    evidence: [`action:${action}`, ...evidence]
  };
}

function authorizationAllowed(
  action: BeadsMutationResult["action"],
  authorization: AuthorizationResult | undefined
): PolicyOutcome | undefined {
  if (authorization === undefined || authorization.decision === "allow") return undefined;
  return deniedPolicy(action, authorization.reason, authorization.evidence);
}

function mutationBlockedResult(input: {
  readonly action: BeadsMutationResult["action"];
  readonly reason: string;
  readonly policy: PolicyOutcome;
  readonly evidence: readonly string[];
}): BeadsMutationResult {
  return {
    mutated: false,
    action: input.action,
    reason: input.reason,
    policy: input.policy,
    pushed: false,
    evidence: [...input.evidence, ...input.policy.evidence]
  };
}

function nonEmptyLines(values: readonly string[]): readonly string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function hasCloseEvidence(input: Pick<BeadsCloseInput, "acceptanceEvidence" | "validationEvidence">): boolean {
  return nonEmptyLines(input.acceptanceEvidence).length > 0 && input.validationEvidence.some((item) => item.passed);
}

function evidenceLine(prefix: string, values: readonly string[]): string {
  return `${prefix}: ${nonEmptyLines(values).join("; ")}`;
}

function formatProgressNote(input: BeadsProgressRecordInput): string {
  const metadata = [
    `ciclo.${input.kind}`,
    `loop=${input.loop.id}`,
    input.harnessId === undefined ? undefined : `harness=${input.harnessId}`,
    input.principalId === undefined ? undefined : `principal=${input.principalId}`,
    input.blockerId === undefined ? undefined : `blocker=${input.blockerId}`
  ].filter((value): value is string => value !== undefined);

  const lines = [
    `${metadata.join(" ")}: ${input.message.trim()}`,
    formatCicloBeadsMetadata({
      action: input.kind,
      beadId: input.id,
      loopId: input.loop.id,
      harnessId: input.harnessId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      remoteSession: input.remoteSession,
      blockerId: input.blockerId
    })
  ];
  if (input.validation !== undefined) {
    lines.push(
      `validation command=${input.validation.command}`,
      `validation passed=${input.validation.passed}`,
      `validation summary=${input.validation.summary}`
    );
  }
  return lines.join("\n");
}

function formatCloseNote(input: BeadsCloseInput): string {
  const metadata = [
    "ciclo.final_summary",
    `loop=${input.loop.id}`,
    input.harnessId === undefined ? undefined : `harness=${input.harnessId}`,
    input.principalId === undefined ? undefined : `principal=${input.principalId}`
  ].filter((value): value is string => value !== undefined);
  const validation = input.validationEvidence.map(
    (item) => `${item.command} => ${item.passed ? "passed" : "failed"} (${item.summary})`
  );
  return [
    `${metadata.join(" ")}: ${input.finalSummary.trim()}`,
    formatCicloBeadsMetadata({
      action: "final_summary",
      beadId: input.id,
      loopId: input.loop.id,
      harnessId: input.harnessId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      remoteSession: input.remoteSession
    }),
    evidenceLine("acceptance evidence", input.acceptanceEvidence),
    evidenceLine("validation evidence", validation)
  ].join("\n");
}

async function pushIfConfigured(sync: BeadsProgressSync | undefined): Promise<boolean> {
  return sync === undefined ? false : sync.pushAfterUpdate();
}

export async function recordBeadsProgress(
  client: BeadsProgressClient,
  input: BeadsProgressRecordInput
): Promise<BeadsMutationResult> {
  const action = "update_beads_progress";
  const authorizationPolicy = authorizationAllowed(action, input.authorization);
  if (authorizationPolicy !== undefined) {
    return mutationBlockedResult({
      action,
      reason: authorizationPolicy.reason,
      policy: authorizationPolicy,
      evidence: ["beads.progress.access:denied"]
    });
  }

  if (input.message.trim().length === 0) {
    const policy = deniedPolicy(action, "progress message must be non-empty", ["beads.progress:empty"]);
    return mutationBlockedResult({ action, reason: policy.reason, policy, evidence: ["beads.progress:empty"] });
  }

  const policy = evaluatePolicy({
    loop: input.loop,
    policy: input.policy,
    action
  });
  if (policy.decision !== "allow") {
    return mutationBlockedResult({
      action,
      reason: policy.reason,
      policy,
      evidence: ["beads.progress.policy:not_allowed"]
    });
  }

  await client.note(input.id, formatProgressNote(input));
  const pushed = await pushIfConfigured(input.sync);
  return {
    mutated: true,
    action,
    reason: "recorded Beads progress note",
    policy,
    pushed,
    evidence: [
      `beads.progress.recorded:${input.id}`,
      `beads.progress.kind:${input.kind}`,
      "beads.progress.metadata:standard",
      `beads.progress.pushed:${pushed}`
    ]
  };
}

export async function closeBeadsTaskWithPolicy(
  client: BeadsProgressClient,
  input: BeadsCloseInput
): Promise<BeadsMutationResult> {
  const action = "close_beads_task";
  const authorizationPolicy = authorizationAllowed(action, input.authorization);
  if (authorizationPolicy !== undefined) {
    return mutationBlockedResult({
      action,
      reason: authorizationPolicy.reason,
      policy: authorizationPolicy,
      evidence: ["beads.close.access:denied"]
    });
  }

  if (input.finalSummary.trim().length === 0) {
    const policy = deniedPolicy(action, "final summary must be non-empty", ["beads.close:empty_summary"]);
    return mutationBlockedResult({ action, reason: policy.reason, policy, evidence: ["beads.close:empty_summary"] });
  }

  const closeEvidence = hasCloseEvidence(input);
  const policy = evaluatePolicy({
    loop: input.loop,
    policy: input.policy,
    action,
    hasAcceptanceEvidence: closeEvidence
  });
  if (policy.decision !== "allow") {
    return mutationBlockedResult({
      action,
      reason: policy.reason,
      policy,
      evidence: [
        `beads.close.acceptance_evidence:${nonEmptyLines(input.acceptanceEvidence).length}`,
        `beads.close.passing_validation:${input.validationEvidence.filter((item) => item.passed).length}`
      ]
    });
  }

  const before = await client.show(input.id);
  if (before.status === "closed") {
    const alreadyClosed = deniedPolicy(action, "task is already closed", [`beads.close.status:${before.status}`]);
    return mutationBlockedResult({
      action,
      reason: alreadyClosed.reason,
      policy: alreadyClosed,
      evidence: [`beads.close.status:${before.status}`]
    });
  }

  await client.note(input.id, formatCloseNote(input));
  const after = await client.close(input.id, input.finalSummary.trim());
  const pushed = await pushIfConfigured(input.sync);

  return {
    mutated: true,
    action,
    reason: "closed Beads task with acceptance and validation evidence",
    policy,
    pushed,
    task: after,
    evidence: [
      `beads.close.rechecked:${before.id}`,
      `beads.close.status_before:${before.status}`,
      `beads.close.closed:${after.id}`,
      "beads.close.metadata:standard",
      `beads.close.pushed:${pushed}`
    ]
  };
}
