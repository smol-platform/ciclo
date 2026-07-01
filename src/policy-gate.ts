import type { LoopConfig } from "./ciclo-core.js";
import type { PolicyConfig } from "./loop-config.js";

export type PolicyAction =
  | "create_beads_task"
  | "pull_beads_ready"
  | "claim_beads_task"
  | "update_beads_progress"
  | "close_beads_task"
  | "send_prompt"
  | "run_test"
  | "run_command"
  | "deploy"
  | "approve_permission"
  | "register_remote_session"
  | "remote_tracker_sync"
  | "answer_agent_question";

export type PolicyDecision = "allow" | "deny" | "ask_operator" | "dry_run_only";

export interface PolicyRequest {
  readonly loop: LoopConfig;
  readonly policy: PolicyConfig;
  readonly action: PolicyAction;
  readonly command?: string;
  readonly promptSendConfigured?: boolean;
  readonly testsConfigured?: boolean;
  readonly deployConfigured?: boolean;
  readonly remoteSessionConfigured?: boolean;
  readonly remoteTrackerSyncConfigured?: boolean;
  readonly deterministicAnswer?: boolean;
  readonly hasAcceptanceEvidence?: boolean;
}

export interface PolicyOutcome {
  readonly decision: PolicyDecision;
  readonly reason: string;
  readonly evidence: readonly string[];
}

const mutatingActions = new Set<PolicyAction>([
  "create_beads_task",
  "claim_beads_task",
  "update_beads_progress",
  "close_beads_task",
  "send_prompt",
  "run_test",
  "run_command",
  "deploy",
  "approve_permission",
  "register_remote_session",
  "remote_tracker_sync",
  "answer_agent_question"
]);

function actionRequiresApproval(policy: PolicyConfig, ...keys: readonly string[]): boolean {
  return keys.some((key) => policy.requireApprovalFor.includes(key));
}

function allowedCommand(policy: PolicyConfig, command: string | undefined): boolean {
  return command !== undefined && policy.allowCommands.includes(command);
}

function outcome(decision: PolicyDecision, reason: string, evidence: readonly string[]): PolicyOutcome {
  return { decision, reason, evidence };
}

export function evaluatePolicy(request: PolicyRequest): PolicyOutcome {
  const evidence = [
    `policy.mode:${request.policy.mode}`,
    `loop:${request.loop.id}`,
    `action:${request.action}`
  ];

  if (request.loop.dryRun && mutatingActions.has(request.action)) {
    return outcome("dry_run_only", "loop is configured for dry-run responses only", evidence);
  }

  switch (request.action) {
    case "create_beads_task":
      return outcome("allow", "local Beads task creation is allowed by default", evidence);

    case "pull_beads_ready":
      return outcome("allow", "reading ready Beads work is allowed", evidence);

    case "claim_beads_task":
      return outcome("allow", "claiming ready Beads work is allowed when configured upstream", evidence);

    case "update_beads_progress":
      return outcome("allow", "progress notes are allowed when configured upstream", evidence);

    case "close_beads_task":
      if (!request.hasAcceptanceEvidence) {
        return outcome("deny", "task close requires acceptance and validation evidence", evidence);
      }
      if (actionRequiresApproval(request.policy, "task_close", "close_work")) {
        return outcome("ask_operator", "task close requires operator approval", evidence);
      }
      return outcome("allow", "task close has evidence and no approval requirement", evidence);

    case "send_prompt":
      if (!request.promptSendConfigured) {
        return outcome("deny", "prompt sending is disabled until configured", evidence);
      }
      if (actionRequiresApproval(request.policy, "prompt_send", "send_prompt")) {
        return outcome("ask_operator", "prompt sending requires operator approval", evidence);
      }
      return outcome("allow", "prompt sending is configured and allowed", evidence);

    case "run_test":
      if (!request.testsConfigured) {
        return outcome("deny", "test execution is disabled until configured", evidence);
      }
      if (!allowedCommand(request.policy, request.command)) {
        return outcome("deny", "test command is not in policy.allow_commands", evidence);
      }
      return outcome("allow", "test command is configured and allowlisted", evidence);

    case "run_command":
      if (!allowedCommand(request.policy, request.command)) {
        return outcome("deny", "command is not in policy.allow_commands", evidence);
      }
      return outcome("allow", "command is explicitly allowlisted", evidence);

    case "deploy":
      if (!request.deployConfigured) {
        return outcome("deny", "deploys are disabled until configured", evidence);
      }
      if (actionRequiresApproval(request.policy, "deploy")) {
        return outcome("ask_operator", "deploy requires operator approval", evidence);
      }
      return outcome("allow", "deploy is configured and policy does not require approval", evidence);

    case "approve_permission":
      return outcome("deny", "harness permission prompts are never auto-approved", evidence);

    case "register_remote_session":
      if (!request.remoteSessionConfigured) {
        return outcome("deny", "remote session registration requires configured Herdr target and path", evidence);
      }
      return outcome("allow", "remote session registration is configured", evidence);

    case "remote_tracker_sync":
      if (!request.remoteTrackerSyncConfigured) {
        return outcome("deny", "remote tracker sync is disabled until Beads integration is configured", evidence);
      }
      if (actionRequiresApproval(request.policy, "remote_tracker_sync")) {
        return outcome("ask_operator", "remote tracker sync requires operator approval", evidence);
      }
      return outcome("allow", "Beads remote tracker sync is configured and allowed", evidence);

    case "answer_agent_question":
      if (!request.deterministicAnswer) {
        return outcome("ask_operator", "agent question is not deterministic", evidence);
      }
      return outcome("allow", "deterministic answer is allowed by policy", evidence);
  }
}
