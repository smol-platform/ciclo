export type CicloEventType =
  | "worker.state_change"
  | "worker.launcher_exit"
  | "worker.stalled"
  | "bead.claimed"
  | "bead.closed"
  | "blocker.raised"
  | "validation.passed"
  | "validation.failed"
  | "pull_request.opened"
  | "pull_request.merged"
  | "question.asked"
  | "question.answered"
  | "feedback.reported"
  | "remote_runner.launched"
  | "remote_session.heartbeat"
  | "remote_session.stale"
  | "remote_session.lost"
  | "heartbeat.tick"
  | "brain.decision"
  | "secret.requested"
  | "tracker.synced";

export interface CicloEventInput {
  readonly type: CicloEventType;
  readonly at?: string;
  readonly workerSessionId?: string;
  readonly loopId?: string;
  readonly beadId?: string;
  readonly state?: string;
  readonly evidence?: readonly string[];
  readonly data?: Record<string, unknown>;
}

export interface CicloEvent extends CicloEventInput {
  readonly cursor: number;
  readonly at: string;
  readonly evidence: readonly string[];
}

export interface CicloEventPollResult {
  readonly cursor: number;
  readonly nextCursor: number;
  readonly events: readonly CicloEvent[];
}

export interface CicloEventSink {
  append(input: CicloEventInput): CicloEvent;
}

export class CicloEventStore implements CicloEventSink {
  private cursor = 0;
  private readonly events: CicloEvent[] = [];

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  append(input: CicloEventInput): CicloEvent {
    this.cursor += 1;
    const event: CicloEvent = {
      ...input,
      cursor: this.cursor,
      at: input.at ?? this.now(),
      evidence: input.evidence ?? []
    };
    this.events.push(event);
    return event;
  }

  poll(cursor = 0, limit = 100): CicloEventPollResult {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const events = this.events.filter((event) => event.cursor > cursor).slice(0, boundedLimit);
    return {
      cursor,
      nextCursor: events.at(-1)?.cursor ?? cursor,
      events
    };
  }
}
