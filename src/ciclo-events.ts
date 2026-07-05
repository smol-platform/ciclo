import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type CicloEventType =
  | "cli.command"
  | "status.checked"
  | "loop.checked"
  | "board.checked"
  | "work.ready_listed"
  | "work.started"
  | "work.updated"
  | "worker.state_change"
  | "worker.launcher_exit"
  | "worker.cleaned_up"
  | "worker.listed"
  | "worker.stalled"
  | "worker.nudged"
  | "worker.prompt_submitted"
  | "worker.capacity_released"
  | "bead.claimed"
  | "bead.closed"
  | "review_session.launched"
  | "review_session.skipped"
  | "blocker.raised"
  | "validation.passed"
  | "validation.failed"
  | "pull_request.opened"
  | "pull_request.merged"
  | "question.asked"
  | "question.answered"
  | "feedback.reported"
  | "attach.plan_created"
  | "remote_runner.launched"
  | "remote_runner.listed"
  | "remote_session.heartbeat"
  | "remote_session.stale"
  | "remote_session.lost"
  | "heartbeat.tick"
  | "heartbeat.monologue"
  | "cron.due"
  | "cron.ran"
  | "memory.recorded"
  | "memory.compacted"
  | "mcp.leadership"
  | "brain.decision"
  | "brain.action"
  | "brain.tool_call"
  | "brain.verification"
  | "secret.requested"
  | "secret_providers.listed"
  | "auth.device_started"
  | "auth.device_polled"
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

export interface CicloEventStoreOptions {
  readonly now?: () => string;
  readonly persistPath?: string;
  readonly onAppend?: (event: CicloEvent) => void;
}

function parseEventLine(line: string): CicloEvent | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<CicloEvent>;
    if (
      typeof parsed.cursor !== "number" ||
      typeof parsed.type !== "string" ||
      typeof parsed.at !== "string"
    ) {
      return undefined;
    }
    return {
      ...parsed,
      cursor: parsed.cursor,
      type: parsed.type as CicloEventType,
      at: parsed.at,
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter((item): item is string => typeof item === "string") : []
    };
  } catch {
    return undefined;
  }
}

export function cicloEventLogPath(root: string): string {
  return join(resolve(root), ".ciclo", "events.jsonl");
}

export class CicloEventStore implements CicloEventSink {
  private cursor = 0;
  private readonly events: CicloEvent[] = [];
  private readonly now: () => string;
  private readonly persistPath?: string;
  private readonly onAppend?: (event: CicloEvent) => void;

  constructor(nowOrOptions: (() => string) | CicloEventStoreOptions = () => new Date().toISOString()) {
    if (typeof nowOrOptions === "function") {
      this.now = nowOrOptions;
    } else {
      this.now = nowOrOptions.now ?? (() => new Date().toISOString());
      this.persistPath = nowOrOptions.persistPath;
      this.onAppend = nowOrOptions.onAppend;
      this.loadPersistedEvents();
    }
  }

  append(input: CicloEventInput): CicloEvent {
    this.cursor += 1;
    const event: CicloEvent = {
      ...input,
      cursor: this.cursor,
      at: input.at ?? this.now(),
      evidence: input.evidence ?? []
    };
    this.events.push(event);
    this.persist(event);
    this.onAppend?.(event);
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

  private loadPersistedEvents(): void {
    if (this.persistPath === undefined || !existsSync(this.persistPath)) return;
    const content = readFileSync(this.persistPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const event = parseEventLine(line);
      if (event === undefined) continue;
      this.events.push(event);
      this.cursor = Math.max(this.cursor, event.cursor);
    }
  }

  private persist(event: CicloEvent): void {
    if (this.persistPath === undefined) return;
    mkdirSync(dirname(this.persistPath), { recursive: true });
    appendFileSync(this.persistPath, `${JSON.stringify(event)}\n`, "utf8");
  }
}
