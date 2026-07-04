import type { ValidationEvidence } from "./beads-progress.js";
import { applyPromptInjections, promptInjectionEvidence, type CicloPromptInjection } from "./prompt-injection.js";
import type { WorkerHarnessId, WorkerSessionRecord, WorkerSessionSupervisor } from "./worker-session-supervisor.js";

export interface TaskReviewSessionRequest {
  readonly supervisor?: WorkerSessionSupervisor;
  readonly loopId: string;
  readonly beadId: string;
  readonly finalSummary: string;
  readonly acceptanceEvidence: readonly string[];
  readonly validationEvidence: readonly ValidationEvidence[];
  readonly cwd: string;
  readonly harnessId?: WorkerHarnessId;
  readonly model?: string;
  readonly effort?: string;
  readonly dryRun?: boolean;
  readonly configureMcp?: boolean;
  readonly promptInjections?: readonly CicloPromptInjection[];
}

export interface TaskReviewSessionResult {
  readonly launched: boolean;
  readonly reason: string;
  readonly sessionId?: string;
  readonly harnessId?: WorkerHarnessId;
  readonly state?: WorkerSessionRecord["state"];
  readonly cwd?: string;
  readonly dryRun?: boolean;
  readonly evidence: readonly string[];
}

function evidenceLines(title: string, values: readonly string[]): string {
  if (values.length === 0) return `${title}\n- none provided`;
  return `${title}\n${values.map((value) => `- ${value}`).join("\n")}`;
}

function validationLines(values: readonly ValidationEvidence[]): string {
  if (values.length === 0) return "Validation evidence\n- none provided";
  return `Validation evidence\n${values
    .map((value) => `- ${value.command}: ${value.passed ? "passed" : "failed"}${value.summary.length === 0 ? "" : ` - ${value.summary}`}`)
    .join("\n")}`;
}

export function buildTaskReviewPrompt(input: TaskReviewSessionRequest): string {
  const prompt = [
    `Review finished Beads task ${input.beadId} for loop ${input.loopId}.`,
    "",
    "You are a bounded review worker launched by Ciclo after the implementation task closed.",
    "Verify the code, acceptance evidence, and validation evidence before the operator treats the task as done.",
    "",
    "Ground rules:",
    "- Do not mutate implementation code unless the controlling operator explicitly authorizes it.",
    "- Prefer read-only inspection, targeted tests, and concise file/line comments.",
    "- Use Ciclo MCP to report findings, validation, blockers, and questions.",
    "- Use ciclo_report_feedback for review comments and ciclo_update_work with kind=validation for checks you run.",
    "- Use ciclo_ask_operator when a risk needs human decision, and request secrets only through ciclo_request_secret by reference.",
    "- If the review passes, report a passing validation update and include the commands or checks used.",
    "",
    `Final summary\n${input.finalSummary}`,
    "",
    evidenceLines("Acceptance evidence", input.acceptanceEvidence),
    "",
    validationLines(input.validationEvidence)
  ].join("\n");
  return applyPromptInjections(prompt, input.promptInjections, "review").prompt;
}

export function launchTaskReviewSession(input: TaskReviewSessionRequest): TaskReviewSessionResult {
  if (input.supervisor === undefined) {
    return {
      launched: false,
      reason: "worker supervisor is not configured",
      evidence: ["review.session.skipped:missing_worker_supervisor"]
    };
  }

  const harnessId = input.harnessId ?? "codex";
  const dryRun = input.dryRun ?? false;
  const record = input.supervisor.launch({
    harnessId,
    loopId: input.loopId,
    beadId: input.beadId,
    cwd: input.cwd,
    prompt: buildTaskReviewPrompt(input),
    sessionName: `${input.loopId}-${input.beadId}-review-${harnessId}`,
    model: input.model,
    effort: input.effort,
    dryRun,
    configureMcp: input.configureMcp ?? true
  });

  return {
    launched: true,
    reason: dryRun ? "review session launch planned" : "review session launched",
    sessionId: record.sessionId,
    harnessId: record.harnessId,
    state: record.state,
    cwd: record.cwd,
    dryRun,
    evidence: [
      "review.session.reason:task_finished",
      `review.session.harness:${record.harnessId}`,
      `review.session.state:${record.state}`,
      ...record.evidence,
      ...promptInjectionEvidence(input.promptInjections, "review")
    ]
  };
}
