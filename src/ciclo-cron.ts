import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type CicloCronTaskKind =
  | "heartbeat_tick"
  | "dispatch_ready_work"
  | "memory_compact"
  | "worker_launch"
  | "brain_decision";

export interface CicloCronSchedule {
  readonly everyMs?: number;
  readonly cron?: string;
  readonly dailyAt?: string;
}

export interface CicloCronTask {
  readonly kind: CicloCronTaskKind;
  readonly params?: Record<string, unknown>;
}

export interface CicloCronJob {
  readonly id: string;
  readonly enabled: boolean;
  readonly schedule: CicloCronSchedule;
  readonly task: CicloCronTask;
  readonly description?: string;
}

export interface CicloCronRunRecord {
  readonly jobId: string;
  readonly startedAt: string;
  readonly status: "due" | "ran" | "failed" | "skipped";
  readonly reason?: string;
  readonly evidence: readonly string[];
}

export interface CicloCronDueJob {
  readonly job: CicloCronJob;
  readonly dueAt: string;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface CicloCronSchedulerOptions {
  readonly projectRoot?: string;
  readonly persistPath?: string;
}

export function cicloCronRunsPath(projectRoot: string): string {
  return join(resolve(projectRoot), ".ciclo", "cron-runs.jsonl");
}

function parseRunLine(line: string): CicloCronRunRecord | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<CicloCronRunRecord>;
    if (typeof parsed.jobId !== "string" || typeof parsed.startedAt !== "string" || typeof parsed.status !== "string") return undefined;
    return {
      jobId: parsed.jobId,
      startedAt: parsed.startedAt,
      status: parsed.status as CicloCronRunRecord["status"],
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter((item): item is string => typeof item === "string") : []
    };
  } catch {
    return undefined;
  }
}

function minuteKey(value: string): string {
  return value.slice(0, 16);
}

function matchesCronField(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) {
    const step = Number.parseInt(field.slice(2), 10);
    return Number.isInteger(step) && step > 0 && value % step === 0;
  }
  return field.split(",").some((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isInteger(parsed) && parsed === value;
  });
}

function matchesCron(expression: string, now: Date): boolean {
  const parts = expression.trim().split(/\s+/u);
  if (parts.length !== 5) throw new Error(`cron expression must have five fields: ${expression}`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];
  return matchesCronField(minute, now.getUTCMinutes()) &&
    matchesCronField(hour, now.getUTCHours()) &&
    matchesCronField(dayOfMonth, now.getUTCDate()) &&
    matchesCronField(month, now.getUTCMonth() + 1) &&
    matchesCronField(dayOfWeek, now.getUTCDay());
}

function matchesDailyAt(dailyAt: string, now: Date): boolean {
  const match = dailyAt.match(/^([01]\d|2[0-3]):([0-5]\d)$/u);
  if (match === null) throw new Error(`dailyAt must be HH:MM in UTC: ${dailyAt}`);
  return now.getUTCHours() === Number.parseInt(match[1]!, 10) && now.getUTCMinutes() === Number.parseInt(match[2]!, 10);
}

export class CicloCronScheduler {
  private readonly runs: CicloCronRunRecord[] = [];
  private readonly persistPath: string;

  constructor(options: CicloCronSchedulerOptions = {}) {
    const projectRoot = options.projectRoot ?? process.cwd();
    this.persistPath = options.persistPath ?? cicloCronRunsPath(projectRoot);
    this.load();
  }

  listRuns(limit = 100): readonly CicloCronRunRecord[] {
    return this.runs.slice(-Math.max(1, Math.min(limit, 500))).reverse();
  }

  dueJobs(jobs: readonly CicloCronJob[], nowIso: string): readonly CicloCronDueJob[] {
    const now = new Date(nowIso);
    if (!Number.isFinite(now.getTime())) throw new Error(`invalid cron timestamp: ${nowIso}`);
    return jobs.flatMap((job) => {
      if (!job.enabled) return [];
      const reason = this.dueReason(job, nowIso, now);
      if (reason === undefined) return [];
      return [{
        job,
        dueAt: nowIso,
        reason,
        evidence: ["cron.job:due", `cron.job:${job.id}`, `cron.reason:${reason}`]
      }];
    });
  }

  recordRun(input: CicloCronRunRecord): CicloCronRunRecord {
    this.runs.push(input);
    mkdirSync(dirname(this.persistPath), { recursive: true });
    appendFileSync(this.persistPath, `${JSON.stringify(input)}\n`, "utf8");
    return input;
  }

  status(jobs: readonly CicloCronJob[], nowIso: string): Record<string, unknown> {
    const due = this.dueJobs(jobs, nowIso);
    return {
      jobs: jobs.map((job) => this.publicJob(job, nowIso)),
      due: due.map((entry) => ({ job_id: entry.job.id, reason: entry.reason, evidence: entry.evidence })),
      recent_runs: this.listRuns(20),
      path: this.persistPath,
      evidence: ["cron.scheduler:loaded", `cron.jobs:${jobs.length}`, `cron.due:${due.length}`]
    };
  }

  private publicJob(job: CicloCronJob, nowIso: string): Record<string, unknown> {
    const lastRun = this.lastRun(job.id);
    return {
      id: job.id,
      enabled: job.enabled,
      description: job.description,
      schedule: job.schedule,
      task: job.task,
      last_run_at: lastRun?.startedAt,
      due_now: this.dueReason(job, nowIso, new Date(nowIso)) !== undefined
    };
  }

  private dueReason(job: CicloCronJob, nowIso: string, now: Date): string | undefined {
    const lastRun = this.lastRun(job.id);
    if (job.schedule.everyMs !== undefined) {
      if (lastRun === undefined) return "interval:first_run";
      if (Date.parse(nowIso) - Date.parse(lastRun.startedAt) >= job.schedule.everyMs) return "interval:elapsed";
    }
    if (job.schedule.dailyAt !== undefined && matchesDailyAt(job.schedule.dailyAt, now)) {
      if (lastRun === undefined || minuteKey(lastRun.startedAt) !== minuteKey(nowIso)) return "daily_at:matched";
    }
    if (job.schedule.cron !== undefined && matchesCron(job.schedule.cron, now)) {
      if (lastRun === undefined || minuteKey(lastRun.startedAt) !== minuteKey(nowIso)) return "cron:matched";
    }
    return undefined;
  }

  private lastRun(jobId: string): CicloCronRunRecord | undefined {
    return [...this.runs].reverse().find((run) => run.jobId === jobId && (run.status === "ran" || run.status === "failed" || run.status === "skipped"));
  }

  private load(): void {
    if (!existsSync(this.persistPath)) return;
    const content = readFileSync(this.persistPath, "utf8");
    for (const line of content.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      const run = parseRunLine(line);
      if (run !== undefined) this.runs.push(run);
    }
  }
}
