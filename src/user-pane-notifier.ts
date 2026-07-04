import { spawnSync } from "node:child_process";

import type { CicloEvent } from "./ciclo-events.js";

export interface UserControlPaneTarget {
  readonly enabled: boolean;
  readonly herdrSession: string;
  readonly paneName?: string;
}

export interface UserControlPaneNotifyResult {
  readonly delivered: boolean;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export type UserControlPaneCommandRunner = (
  command: string,
  args: readonly string[]
) => { readonly status: number | null; readonly stdout?: string; readonly stderr?: string };

export const userControlPaneEnv = {
  enabled: "CICLO_USER_PANE_ENABLED",
  herdrSession: "CICLO_USER_PANE_HERDR_SESSION",
  paneName: "CICLO_USER_PANE_NAME"
} as const;

const notifyEventTypes = new Set([
  "brain.decision",
  "work.started",
  "worker.state_change",
  "worker.nudged",
  "worker.capacity_released",
  "bead.claimed",
  "question.asked",
  "feedback.reported",
  "blocker.raised",
  "validation.passed",
  "validation.failed",
  "remote_runner.launched",
  "remote_session.stale",
  "remote_session.lost"
]);

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

function stringData(event: CicloEvent, key: string): string | undefined {
  const value = event.data?.[key];
  return typeof value === "string" ? clean(value) : undefined;
}

function shouldNotify(event: CicloEvent): boolean {
  if (!notifyEventTypes.has(event.type)) return false;
  if (event.type === "worker.state_change") {
    return event.state === "running" ||
      event.state === "waiting_on_operator" ||
      event.state === "stalled" ||
      event.state === "completed" ||
      event.state === "failed";
  }
  return true;
}

function eventTitle(event: CicloEvent): string {
  switch (event.type) {
    case "brain.decision":
      return "Ciclo decision";
    case "work.started":
      return "Ciclo started work";
    case "worker.nudged":
      return "Ciclo nudged worker";
    case "worker.capacity_released":
      return "Ciclo freed worker capacity";
    case "bead.claimed":
      return "Ciclo claimed a Bead";
    case "question.asked":
      return "Ciclo needs input";
    case "feedback.reported":
      return "Ciclo feedback";
    case "blocker.raised":
      return "Ciclo blocker";
    case "validation.passed":
      return "Ciclo validation passed";
    case "validation.failed":
      return "Ciclo validation failed";
    case "remote_runner.launched":
      return "Ciclo launched remote runner";
    case "remote_session.stale":
      return "Ciclo remote session stale";
    case "remote_session.lost":
      return "Ciclo remote session lost";
    case "worker.state_change":
      return `Ciclo worker ${event.state ?? "changed"}`;
    default:
      return "Ciclo event";
  }
}

function eventBody(event: CicloEvent, target: UserControlPaneTarget): string {
  const parts = [
    event.beadId === undefined ? undefined : `Bead ${event.beadId}`,
    event.loopId === undefined ? undefined : `loop ${event.loopId}`,
    event.workerSessionId === undefined ? undefined : `worker ${event.workerSessionId}`,
    event.state === undefined ? undefined : `state ${event.state}`
  ].filter((item): item is string => item !== undefined);
  const headline = stringData(event, "question") ??
    stringData(event, "message") ??
    stringData(event, "decision") ??
    stringData(event, "reason") ??
    stringData(event, "title");
  const pane = target.paneName === undefined ? undefined : `control pane ${target.paneName}`;
  return compact([
    ...(headline === undefined ? [] : [headline]),
    ...(parts.length === 0 ? [] : [parts.join("; ")]),
    ...(pane === undefined ? [] : [pane])
  ].join("\n"), 800);
}

function eventSound(event: CicloEvent): "none" | "done" | "request" {
  if (event.type === "question.asked" || event.type === "blocker.raised" || event.type === "validation.failed" || event.type === "worker.nudged") return "request";
  if (event.type === "validation.passed" || event.type === "worker.state_change" && event.state === "completed") return "done";
  return "none";
}

export function userControlPaneTargetFromEnv(env: NodeJS.ProcessEnv = process.env): UserControlPaneTarget | undefined {
  if (env[userControlPaneEnv.enabled] === "false") return undefined;
  const herdrSession = clean(env[userControlPaneEnv.herdrSession]);
  if (herdrSession === undefined) return undefined;
  return {
    enabled: true,
    herdrSession,
    ...(clean(env[userControlPaneEnv.paneName]) === undefined ? {} : { paneName: clean(env[userControlPaneEnv.paneName]) })
  };
}

export class UserControlPaneNotifier {
  constructor(
    private readonly target: UserControlPaneTarget,
    private readonly run: UserControlPaneCommandRunner = (command, args) => {
      const result = spawnSync(command, [...args], { encoding: "utf8" });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }
  ) {}

  notifyMessage(input: {
    readonly title: string;
    readonly body: string;
    readonly sound?: "none" | "done" | "request";
  }): UserControlPaneNotifyResult {
    if (!this.target.enabled) {
      return { delivered: false, reason: "user control pane notifications are disabled", evidence: ["user_pane.notify:disabled"] };
    }
    const args = [
      "--session",
      this.target.herdrSession,
      "notification",
      "show",
      compact(input.title, 120),
      "--body",
      compact(input.body, 800),
      "--position",
      "top-right",
      "--sound",
      input.sound ?? "none"
    ];
    const result = this.run("herdr", args);
    if (result.status === 0) {
      return {
        delivered: true,
        reason: "notified user control pane",
        evidence: [
          "user_pane.notify:delivered",
          `user_pane.herdr_session:${this.target.herdrSession}`,
          ...(this.target.paneName === undefined ? [] : [`user_pane.name:${this.target.paneName}`])
        ]
      };
    }
    return {
      delivered: false,
      reason: compact(result.stderr || result.stdout || "herdr notification command failed", 300),
      evidence: ["user_pane.notify:failed", `user_pane.herdr_session:${this.target.herdrSession}`]
    };
  }

  notify(event: CicloEvent): UserControlPaneNotifyResult {
    if (!this.target.enabled) {
      return { delivered: false, reason: "user control pane notifications are disabled", evidence: ["user_pane.notify:disabled"] };
    }
    if (!shouldNotify(event)) {
      return { delivered: false, reason: "event type is not routed to the user control pane", evidence: [`user_pane.notify.skipped:${event.type}`] };
    }
    return this.notifyMessage({
      title: eventTitle(event),
      body: eventBody(event, this.target),
      sound: eventSound(event)
    });
  }
}
