import type { AuthorizationResult } from "./access-enforcement.js";
import type { BeadsTaskSnapshot } from "./beads-adapter.js";
import { formatCicloBeadsMetadata, type CicloBeadsRemoteMetadata } from "./beads-metadata.js";
import type { HarnessId, LoopConfig } from "./ciclo-core.js";
import type { RemoteSessionRecord } from "./remote-session-registry.js";
import type { PrincipalId } from "./session-access.js";

export interface BeadsWorkCapacity {
  readonly activeCount: number;
  readonly maxConcurrent: number;
}

export interface BeadsWorkSelector {
  readonly loop: LoopConfig;
  readonly requiredLabels?: readonly string[];
  readonly excludedLabels?: readonly string[];
  readonly issueTypes?: readonly string[];
  readonly specId?: string;
  readonly capacity?: BeadsWorkCapacity;
}

export interface BeadsWorkSkip {
  readonly id: string;
  readonly reason: string;
}

export interface BeadsWorkSelection {
  readonly selected?: BeadsTaskSnapshot;
  readonly skipped: readonly BeadsWorkSkip[];
  readonly evidence: readonly string[];
}

export interface BeadsWorkClaimClient {
  ready(limit?: number): Promise<readonly BeadsTaskSnapshot[]>;
  show(id: string): Promise<BeadsTaskSnapshot>;
  claim(id: string): Promise<BeadsTaskSnapshot>;
  note(id: string, message: string): Promise<void>;
}

export interface BeadsWorkClaimRequest {
  readonly selector: BeadsWorkSelector;
  readonly limit?: number;
  readonly harnessId?: HarnessId;
  readonly harnessForTask?: (task: BeadsTaskSnapshot) => HarnessId;
  readonly principalId?: PrincipalId;
  readonly sessionId?: string;
  readonly remoteSession?: CicloBeadsRemoteMetadata;
  readonly activeOwners?: readonly RemoteSessionRecord[];
  readonly recordSessionOwnership?: (input: {
    readonly sessionId: string;
    readonly beadId: string;
    readonly loopId?: string;
  }) => { readonly accepted: boolean; readonly reason: string; readonly evidence: readonly string[] };
  readonly authorization?: AuthorizationResult;
}

export interface BeadsWorkClaimResult {
  readonly claimed: boolean;
  readonly before?: BeadsTaskSnapshot;
  readonly after?: BeadsTaskSnapshot;
  readonly selection: BeadsWorkSelection;
  readonly selectedHarness?: HarnessId;
  readonly reason: string;
  readonly evidence: readonly string[];
}

function includesAll(values: readonly string[], required: readonly string[] | undefined): boolean {
  if (required === undefined || required.length === 0) return true;
  const set = new Set(values);
  return required.every((item) => set.has(item));
}

function includesAny(values: readonly string[], excluded: readonly string[] | undefined): boolean {
  if (excluded === undefined || excluded.length === 0) return false;
  const set = new Set(values);
  return excluded.some((item) => set.has(item));
}

function hasBlockingDependency(task: BeadsTaskSnapshot): boolean {
  return task.dependencies.some((dependency) => {
    const status = dependency.status;
    return status !== undefined && status !== "closed";
  });
}

function harnessFor(loop: LoopConfig, requested: HarnessId | undefined): HarnessId {
  if (requested !== undefined && loop.harnesses.includes(requested)) return requested;
  return loop.harnesses[0] ?? "unknown";
}

function capacityReached(capacity: BeadsWorkCapacity | undefined): boolean {
  return capacity !== undefined && capacity.activeCount >= capacity.maxConcurrent;
}

function eligible(task: BeadsTaskSnapshot, selector: BeadsWorkSelector): string | undefined {
  if (task.status !== "open") return `status is ${task.status}`;
  if (hasBlockingDependency(task)) return "task has an unresolved dependency";
  if (!includesAll(task.labels, selector.requiredLabels)) return "missing required selector labels";
  if (includesAny(task.labels, selector.excludedLabels)) return "has an excluded selector label";
  if (selector.issueTypes !== undefined && selector.issueTypes.length > 0 && !selector.issueTypes.includes(task.issueType)) {
    return `issue type ${task.issueType} is not selected`;
  }
  if (selector.specId !== undefined && task.specId !== selector.specId) {
    return `spec ${task.specId ?? "unset"} does not match ${selector.specId}`;
  }
  return undefined;
}

export function selectBeadsWork(
  readyTasks: readonly BeadsTaskSnapshot[],
  selector: BeadsWorkSelector
): BeadsWorkSelection {
  const evidence = [
    `beads.select.loop:${selector.loop.id}`,
    `beads.select.capacity:${selector.capacity?.activeCount ?? 0}/${selector.capacity?.maxConcurrent ?? "unbounded"}`
  ];

  if (capacityReached(selector.capacity)) {
    return {
      skipped: readyTasks.map((task) => ({ id: task.id, reason: "loop capacity is full" })),
      evidence: [...evidence, "beads.select:none:capacity_full"]
    };
  }

  const skipped: BeadsWorkSkip[] = [];
  const eligibleTasks: BeadsTaskSnapshot[] = [];
  for (const task of readyTasks) {
    const reason = eligible(task, selector);
    if (reason === undefined) {
      eligibleTasks.push(task);
    } else {
      skipped.push({ id: task.id, reason });
    }
  }

  eligibleTasks.sort((left, right) => {
    const priorityDelta = left.priority - right.priority;
    return priorityDelta === 0 ? left.id.localeCompare(right.id) : priorityDelta;
  });

  const selected = eligibleTasks[0];
  return {
    selected,
    skipped,
    evidence: [
      ...evidence,
      selected === undefined ? "beads.select:none:no_eligible_work" : `beads.select.selected:${selected.id}`
    ]
  };
}

function metadataNote(input: {
  readonly beadId: string;
  readonly loop: LoopConfig;
  readonly harnessId: HarnessId;
  readonly principalId?: PrincipalId;
  readonly sessionId?: string;
  readonly remoteSession?: CicloBeadsRemoteMetadata;
}): string {
  const legacy = [
    "Ciclo claim metadata",
    `loop=${input.loop.id}`,
    `harness=${input.harnessId}`,
    input.sessionId === undefined ? undefined : `session=${input.sessionId}`,
    input.principalId === undefined ? undefined : `principal=${input.principalId}`
  ]
    .filter((line): line is string => line !== undefined)
    .join("; ");
  return [
    legacy,
    formatCicloBeadsMetadata({
      action: "claim",
      beadId: input.beadId,
      loopId: input.loop.id,
      harnessId: input.harnessId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      remoteSession: input.remoteSession
    })
  ].join("\n");
}

function conflictingOwners(
  beadId: string,
  sessionId: string | undefined,
  owners: readonly RemoteSessionRecord[] | undefined
): readonly RemoteSessionRecord[] {
  if (owners === undefined) return [];
  return owners.filter((owner) => owner.activeBeadId === beadId && owner.id !== sessionId);
}

function conflictEvidence(owners: readonly RemoteSessionRecord[]): readonly string[] {
  return owners.map((owner) => `beads.claim.conflict:${owner.activeBeadId}:session=${owner.id}:state=${owner.state}`);
}

export async function selectAndClaimBeadsWork(
  client: BeadsWorkClaimClient,
  request: BeadsWorkClaimRequest
): Promise<BeadsWorkClaimResult> {
  if (request.authorization !== undefined && request.authorization.decision !== "allow") {
    const selection: BeadsWorkSelection = {
      skipped: [],
      evidence: ["beads.claim:block:unauthorized", ...request.authorization.evidence]
    };
    return {
      claimed: false,
      selection,
      reason: request.authorization.reason,
      evidence: selection.evidence
    };
  }

  const ready = await client.ready(request.limit);
  const selection = selectBeadsWork(ready, request.selector);
  if (selection.selected === undefined) {
    return {
      claimed: false,
      selection,
      reason: "no eligible Beads work matched the selector",
      evidence: selection.evidence
    };
  }

  const before = await client.show(selection.selected.id);
  const recheckReason = eligible(before, request.selector);
  if (recheckReason !== undefined) {
    return {
      claimed: false,
      before,
      selection,
      reason: `selected Beads work failed recheck: ${recheckReason}`,
      evidence: [...selection.evidence, `beads.claim.recheck_failed:${before.id}`]
    };
  }

  const conflicts = conflictingOwners(before.id, request.sessionId, request.activeOwners);
  if (conflicts.length > 0) {
    return {
      claimed: false,
      before,
      selection,
      reason: `selected Beads work is already owned by active session ${conflicts[0]?.id ?? "unknown"}`,
      evidence: [
        ...selection.evidence,
        `beads.claim.rechecked:${before.id}`,
        "beads.claim:block:duplicate_active_session",
        ...conflictEvidence(conflicts),
        `operator.feedback:duplicate_claim:${before.id}`
      ]
    };
  }

  const selectedHarness = request.harnessForTask?.(before) ?? harnessFor(request.selector.loop, request.harnessId);
  const after = await client.claim(before.id);
  const remoteSession = request.remoteSession ?? request.activeOwners?.find((owner) => owner.id === request.sessionId);
  const ownership =
    request.sessionId === undefined || request.recordSessionOwnership === undefined
      ? undefined
      : request.recordSessionOwnership({
          sessionId: request.sessionId,
          beadId: after.id,
          loopId: request.selector.loop.id
        });
  if (ownership !== undefined && !ownership.accepted) {
    return {
      claimed: false,
      before,
      after,
      selection,
      selectedHarness,
      reason: ownership.reason,
      evidence: [
        ...selection.evidence,
        `beads.claim.rechecked:${before.id}`,
        `beads.claim.claimed:${after.id}`,
        "beads.claim:block:ownership_record_failed",
        ...ownership.evidence
      ]
    };
  }
  await client.note(
    after.id,
    metadataNote({
      beadId: after.id,
      loop: request.selector.loop,
      harnessId: selectedHarness,
      sessionId: request.sessionId,
      principalId: request.principalId,
      remoteSession
    })
  );

  return {
    claimed: true,
    before,
    after,
    selection,
    selectedHarness,
    reason: "selected Beads work was rechecked claimed and annotated",
    evidence: [
      ...selection.evidence,
      `beads.claim.rechecked:${before.id}`,
      `beads.claim.claimed:${after.id}`,
      `beads.claim.harness:${selectedHarness}`,
      "beads.claim.metadata:standard",
      ...(request.sessionId === undefined ? [] : [`beads.claim.session:${request.sessionId}`]),
      ...(ownership?.evidence ?? [])
    ]
  };
}
