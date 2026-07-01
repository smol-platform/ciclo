import { createHash } from "node:crypto";

export type QuestionUrgency = "low" | "normal" | "high" | "blocking";
export type FeedbackSeverity = "info" | "warning" | "error" | "critical";

export interface OperatorRouteContext {
  readonly loopId?: string;
  readonly beadId?: string;
  readonly harnessId?: string;
  readonly remoteSessionId?: string;
  readonly workerSessionId?: string;
}

export interface PendingQuestionRecord extends OperatorRouteContext {
  readonly questionId: string;
  readonly question: string;
  readonly urgency: QuestionUrgency;
  readonly status: "pending" | "answered";
  readonly dedupeKey: string;
  readonly askedByPrincipalId?: string;
  readonly createdAt: string;
  readonly evidence: readonly string[];
  readonly answer?: {
    readonly answer: string;
    readonly answeredByPrincipalId?: string;
    readonly answeredAt: string;
    readonly evidence: readonly string[];
  };
}

export interface OperatorFeedbackRecord extends OperatorRouteContext {
  readonly feedbackId: string;
  readonly severity: FeedbackSeverity;
  readonly message: string;
  readonly dedupeKey: string;
  readonly reportedByPrincipalId?: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly duplicateCount: number;
  readonly evidence: readonly string[];
}

export interface AskOperatorInput extends OperatorRouteContext {
  readonly question: string;
  readonly urgency?: QuestionUrgency;
  readonly principalId?: string;
  readonly evidence?: readonly string[];
  readonly now?: string;
}

export interface AskOperatorResult {
  readonly questionId: string;
  readonly queued: boolean;
  readonly deduplicated: boolean;
  readonly question: PendingQuestionRecord;
  readonly evidence: readonly string[];
}

export interface AnswerQuestionInput {
  readonly questionId: string;
  readonly answer: string;
  readonly principalId?: string;
  readonly evidence?: readonly string[];
  readonly now?: string;
}

export interface AnswerQuestionResult {
  readonly answered: boolean;
  readonly routedTo?: OperatorRouteContext;
  readonly question?: PendingQuestionRecord;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface ReportFeedbackInput extends OperatorRouteContext {
  readonly severity: FeedbackSeverity;
  readonly message: string;
  readonly principalId?: string;
  readonly evidence?: readonly string[];
  readonly now?: string;
}

export interface ReportFeedbackResult {
  readonly feedbackId: string;
  readonly deduplicated: boolean;
  readonly feedback: OperatorFeedbackRecord;
  readonly evidence: readonly string[];
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function cleanLines(values: readonly string[] | undefined): readonly string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

function now(input: string | undefined): string {
  return input ?? new Date().toISOString();
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function context(input: OperatorRouteContext): OperatorRouteContext {
  const route: {
    loopId?: string;
    beadId?: string;
    harnessId?: string;
    remoteSessionId?: string;
    workerSessionId?: string;
  } = {};
  const loopId = clean(input.loopId);
  const beadId = clean(input.beadId);
  const harnessId = clean(input.harnessId);
  const remoteSessionId = clean(input.remoteSessionId);
  const workerSessionId = clean(input.workerSessionId);
  if (loopId !== undefined) route.loopId = loopId;
  if (beadId !== undefined) route.beadId = beadId;
  if (harnessId !== undefined) route.harnessId = harnessId;
  if (remoteSessionId !== undefined) route.remoteSessionId = remoteSessionId;
  if (workerSessionId !== undefined) route.workerSessionId = workerSessionId;
  return route;
}

function questionDedupeKey(input: AskOperatorInput): string {
  return hash({ kind: "question", context: context(input), question: normalizedText(input.question) });
}

function feedbackDedupeKey(input: ReportFeedbackInput): string {
  return hash({
    kind: "feedback",
    context: context(input),
    severity: input.severity,
    message: normalizedText(input.message)
  });
}

function routeEvidence(prefix: string, route: OperatorRouteContext): readonly string[] {
  return [
    route.loopId === undefined ? undefined : `${prefix}.loop:${route.loopId}`,
    route.beadId === undefined ? undefined : `${prefix}.bead:${route.beadId}`,
    route.harnessId === undefined ? undefined : `${prefix}.harness:${route.harnessId}`,
    route.remoteSessionId === undefined ? undefined : `${prefix}.remote_session:${route.remoteSessionId}`,
    route.workerSessionId === undefined ? undefined : `${prefix}.worker_session:${route.workerSessionId}`
  ].filter((item): item is string => item !== undefined);
}

export class OperatorRoutingStore {
  private readonly questions = new Map<string, PendingQuestionRecord>();
  private readonly questionDedupe = new Map<string, string>();
  private readonly feedback = new Map<string, OperatorFeedbackRecord>();
  private readonly feedbackDedupe = new Map<string, string>();

  ask(input: AskOperatorInput): AskOperatorResult {
    const question = clean(input.question);
    if (question === undefined) {
      throw new Error("operator question must be non-empty");
    }

    const dedupeKey = questionDedupeKey({ ...input, question });
    const existingId = this.questionDedupe.get(dedupeKey);
    const existing = existingId === undefined ? undefined : this.questions.get(existingId);
    if (existing !== undefined && existing.status === "pending") {
      return {
        questionId: existing.questionId,
        queued: false,
        deduplicated: true,
        question: existing,
        evidence: [`operator.question.deduplicated:${existing.questionId}`]
      };
    }

    const createdAt = now(input.now);
    const route = context(input);
    const questionId = `q_${hash({ dedupeKey, createdAt })}`;
    const record: PendingQuestionRecord = {
      questionId,
      ...route,
      question,
      urgency: input.urgency ?? "normal",
      status: "pending",
      dedupeKey,
      askedByPrincipalId: clean(input.principalId),
      createdAt,
      evidence: [
        `operator.question.queued:${questionId}`,
        ...routeEvidence("operator.question.route", route),
        ...cleanLines(input.evidence)
      ]
    };
    this.questions.set(questionId, record);
    this.questionDedupe.set(dedupeKey, questionId);
    return {
      questionId,
      queued: true,
      deduplicated: false,
      question: record,
      evidence: record.evidence
    };
  }

  answer(input: AnswerQuestionInput): AnswerQuestionResult {
    const record = this.questions.get(input.questionId);
    if (record === undefined) {
      return {
        answered: false,
        reason: "question was not found",
        evidence: [`operator.question.missing:${input.questionId}`]
      };
    }

    const answer = clean(input.answer);
    if (answer === undefined) {
      return {
        answered: false,
        question: record,
        routedTo: context(record),
        reason: "answer must be non-empty",
        evidence: [`operator.question.answer.empty:${input.questionId}`]
      };
    }

    if (record.status === "answered") {
      return {
        answered: false,
        question: record,
        routedTo: context(record),
        reason: "question was already answered",
        evidence: [`operator.question.answer.idempotent:${input.questionId}`]
      };
    }

    const route = context(record);
    const answered: PendingQuestionRecord = {
      ...record,
      status: "answered",
      answer: {
        answer,
        answeredByPrincipalId: clean(input.principalId),
        answeredAt: now(input.now),
        evidence: cleanLines(input.evidence)
      },
      evidence: [
        ...record.evidence,
        `operator.question.answered:${record.questionId}`,
        ...routeEvidence("operator.question.answer.route", route)
      ]
    };
    this.questions.set(record.questionId, answered);
    return {
      answered: true,
      question: answered,
      routedTo: route,
      reason: "answer was recorded and routed to the waiting context",
      evidence: [
        `operator.question.answered:${record.questionId}`,
        ...routeEvidence("operator.question.answer.route", route),
        ...cleanLines(input.evidence)
      ]
    };
  }

  reportFeedback(input: ReportFeedbackInput): ReportFeedbackResult {
    const message = clean(input.message);
    if (message === undefined) {
      throw new Error("operator feedback message must be non-empty");
    }

    const dedupeKey = feedbackDedupeKey({ ...input, message });
    const existingId = this.feedbackDedupe.get(dedupeKey);
    const existing = existingId === undefined ? undefined : this.feedback.get(existingId);
    if (existing !== undefined) {
      const updated: OperatorFeedbackRecord = {
        ...existing,
        lastSeenAt: now(input.now),
        duplicateCount: existing.duplicateCount + 1,
        evidence: [
          ...existing.evidence,
          `operator.feedback.deduplicated:${existing.feedbackId}`,
          ...cleanLines(input.evidence)
        ]
      };
      this.feedback.set(existing.feedbackId, updated);
      return {
        feedbackId: updated.feedbackId,
        deduplicated: true,
        feedback: updated,
        evidence: [`operator.feedback.deduplicated:${updated.feedbackId}`]
      };
    }

    const route = context(input);
    const createdAt = now(input.now);
    const feedbackId = `f_${hash({ dedupeKey, createdAt })}`;
    const record: OperatorFeedbackRecord = {
      feedbackId,
      ...route,
      severity: input.severity,
      message,
      dedupeKey,
      reportedByPrincipalId: clean(input.principalId),
      createdAt,
      lastSeenAt: createdAt,
      duplicateCount: 0,
      evidence: [
        `operator.feedback.queued:${feedbackId}`,
        ...routeEvidence("operator.feedback.route", route),
        ...cleanLines(input.evidence)
      ]
    };
    this.feedback.set(feedbackId, record);
    this.feedbackDedupe.set(dedupeKey, feedbackId);
    return {
      feedbackId,
      deduplicated: false,
      feedback: record,
      evidence: record.evidence
    };
  }

  listQuestions(includeAnswered = false): readonly PendingQuestionRecord[] {
    return [...this.questions.values()]
      .filter((question) => includeAnswered || question.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listFeedback(): readonly OperatorFeedbackRecord[] {
    return [...this.feedback.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}
