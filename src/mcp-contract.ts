import type { AccessCapability } from "./access-grants.js";
import type { SessionAccessAction } from "./session-access.js";

export type McpSideEffect =
  | "none"
  | "beads_note"
  | "beads_claim"
  | "beads_close"
  | "beads_sync"
  | "question_queue"
  | "feedback_queue"
  | "remote_session_update"
  | "remote_runner_update"
  | "worker_session_update"
  | "secret_read"
  | "model_call"
  | "auth_token_issue"
  | "access_grant_update"
  | "harness_dispatch";

export interface McpSchema {
  readonly type: "object" | "array" | "string" | "number" | "boolean" | "null";
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, McpSchema>>;
  readonly items?: McpSchema;
  readonly enum?: readonly string[];
  readonly description?: string;
}

export interface McpPermission {
  readonly readOnly: boolean;
  readonly action: SessionAccessAction;
  readonly capability: AccessCapability;
  readonly authentication: "none_in_single_mode" | "principal_required" | "bearer_token_required";
}

export interface McpAuditRequirement {
  readonly event: string;
  readonly includeFields: readonly string[];
  readonly redactFields: readonly string[];
}

export interface McpToolContract {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpSchema;
  readonly outputSchema: McpSchema;
  readonly permission: McpPermission;
  readonly sideEffects: readonly McpSideEffect[];
  readonly audit: McpAuditRequirement;
}

export interface McpResourceContract {
  readonly uriTemplate: string;
  readonly description: string;
  readonly outputSchema: McpSchema;
  readonly permission: McpPermission;
  readonly cachePolicy: "no_store" | "short_poll" | "event_driven";
  readonly audit: McpAuditRequirement;
}

export interface McpPromptContract {
  readonly name: string;
  readonly description: string;
  readonly argumentsSchema: McpSchema;
  readonly outputPurpose: string;
  readonly permission: McpPermission;
  readonly audit: McpAuditRequirement;
}

const stringSchema = (description: string): McpSchema => ({ type: "string", description });
const booleanSchema = (description: string): McpSchema => ({ type: "boolean", description });
const arrayOfStrings = (description: string): McpSchema => ({
  type: "array",
  description,
  items: { type: "string" }
});
const objectSchema = (
  description: string,
  properties: Readonly<Record<string, McpSchema>>,
  required: readonly string[] = []
): McpSchema => ({ type: "object", description, properties, required });

function permission(
  action: SessionAccessAction,
  capability: AccessCapability,
  readOnly = false,
  authentication: McpPermission["authentication"] = readOnly ? "none_in_single_mode" : "principal_required"
): McpPermission {
  return { action, capability, readOnly, authentication };
}

function audit(
  event: string,
  includeFields: readonly string[],
  redactFields: readonly string[] = []
): McpAuditRequirement {
  return { event, includeFields, redactFields };
}

const loopId = stringSchema("Ciclo loop id.");
const beadId = stringSchema("Beads issue id.");
const harnessId = stringSchema("Harness id such as codex or claude-code.");
const remoteSessionId = stringSchema("Ciclo remote session id.");
const remoteRunnerId = stringSchema("Ciclo remote runner id.");
const secretProviderId = stringSchema("Secret provider id such as openbao or onepassword.");
const secretRef = stringSchema("Provider-specific secret reference. Redacted from audit and events.");

export const cicloMcpTools: readonly McpToolContract[] = [
  {
    name: "ciclo_status",
    description: "Return overall loop, Beads, Herdr, sync, access, and remote-session status.",
    inputSchema: objectSchema("Optional status filter.", {
      include_remote: booleanSchema("Include remote sessions."),
      stale_after_ms: { type: "number", description: "Mark running workers stalled after this many milliseconds without heartbeat." }
    }),
    outputSchema: objectSchema("Overall Ciclo status.", {
      loops: { type: "array", items: { type: "object" } },
      beads: { type: "object" },
      remotes: { type: "array", items: { type: "object" } },
      access: { type: "object" }
    }),
    permission: permission("read_status", "status.read", true),
    sideEffects: ["none"],
    audit: audit("mcp.status_read", ["principal_id", "session_id"])
  },
  {
    name: "ciclo_loop_status",
    description: "Return detailed loop state, goal, policy, current work, and recent evidence.",
    inputSchema: objectSchema("Loop status request.", { loop_id: loopId }, ["loop_id"]),
    outputSchema: objectSchema("Loop detail.", {
      loop: { type: "object" },
      goal: stringSchema("Current loop goal."),
      policy: { type: "object" },
      evidence: arrayOfStrings("Recent evidence.")
    }),
    permission: permission("read_loop", "status.read", true),
    sideEffects: ["none"],
    audit: audit("mcp.loop_read", ["principal_id", "loop_id"])
  },
  {
    name: "ciclo_decide",
    description: "Ask Ciclo's OpenAI/Pi brain for a live control-plane decision: remote-session monitoring, context insertion, answerable questions, or user-session interfacing.",
    inputSchema: objectSchema("OpenAI-backed brain decision request.", {
      purpose: {
        type: "string",
        enum: ["remote_session_monitoring", "context_insertion", "answer_question", "user_session_interface"],
        description: "Decision purpose. These routes must use the OpenAI/Pi brain and fail closed if unavailable."
      },
      prompt: stringSchema("Decision prompt for the Ciclo brain."),
      context: arrayOfStrings("Bounded context facts for the decision."),
      evidence: arrayOfStrings("Runtime evidence supporting the request."),
      loop_id: loopId,
      bead_id: beadId,
      harness_id: harnessId,
      remote_session_id: remoteSessionId,
      worker_session_id: stringSchema("Ciclo worker session id.")
    }, ["purpose", "prompt"]),
    outputSchema: objectSchema("OpenAI-backed brain decision.", {
      decision: stringSchema("Brain decision text."),
      provider: stringSchema("Model provider."),
      adapter: stringSchema("Brain adapter."),
      model: stringSchema("Model id."),
      thinking: stringSchema("Thinking effort."),
      evidence: arrayOfStrings("Decision evidence.")
    }),
    permission: permission("use_brain", "brain.decide"),
    sideEffects: ["model_call"],
    audit: audit("mcp.brain_decision", ["principal_id", "purpose", "loop_id", "bead_id", "remote_session_id"], ["prompt", "context"])
  },
  {
    name: "ciclo_poll_events",
    description: "Poll Ciclo runtime events after a cursor: worker state changes, Beads mutations, blockers, validation, questions, feedback, and tracker sync.",
    inputSchema: objectSchema("Event poll request.", {
      cursor: { type: "number", description: "Last seen event cursor. Use 0 for the first poll." },
      limit: { type: "number", description: "Maximum events to return." }
    }),
    outputSchema: objectSchema("Event poll result.", {
      cursor: { type: "number" },
      next_cursor: { type: "number" },
      events: { type: "array", items: { type: "object" } }
    }),
    permission: permission("read_status", "status.read", true),
    sideEffects: ["none"],
    audit: audit("mcp.events_polled", ["principal_id", "session_id"])
  },
  {
    name: "ciclo_board",
    description: "Return a joined board view of Beads work, worker sessions, branches/worktrees, pending questions, PR placeholders, and validation placeholders.",
    inputSchema: objectSchema("Board request.", {
      stale_after_ms: { type: "number", description: "Mark running workers stalled after this many milliseconds without heartbeat." },
      expected_pr_after_ms: { type: "number", description: "Raise a board blocker when a worker branch has no PR after this many milliseconds." }
    }),
    outputSchema: objectSchema("Ciclo board.", {
      rows: { type: "array", items: { type: "object" } },
      rollup: { type: "object" },
      evidence: arrayOfStrings("Board evidence.")
    }),
    permission: permission("read_status", "status.read", true),
    sideEffects: ["none"],
    audit: audit("mcp.board_read", ["principal_id", "session_id"])
  },
  {
    name: "ciclo_list_ready_work",
    description: "Return eligible Beads work for a loop, labels, spec, issue type, or harness.",
    inputSchema: objectSchema("Ready work filter.", {
      loop_id: loopId,
      harness_id: harnessId,
      labels: arrayOfStrings("Required labels."),
      spec_id: stringSchema("Spec id filter."),
      limit: { type: "number", description: "Maximum number of Beads issues." }
    }),
    outputSchema: objectSchema("Ready work selection.", {
      selected: { type: "object" },
      skipped: { type: "array", items: { type: "object" } },
      evidence: arrayOfStrings("Selection evidence.")
    }),
    permission: permission("read_ready_work", "status.read", true),
    sideEffects: ["none"],
    audit: audit("mcp.ready_work_read", ["principal_id", "loop_id", "harness_id"])
  },
  {
    name: "ciclo_claim_work",
    description: "Claim a Beads issue for a loop and harness after re-read, policy, and access checks.",
    inputSchema: objectSchema("Work claim request.", {
      loop_id: loopId,
      bead_id: beadId,
      harness_id: harnessId
    }, ["loop_id", "bead_id", "harness_id"]),
    outputSchema: objectSchema("Claim result.", {
      claimed: { type: "boolean" },
      before: { type: "object" },
      after: { type: "object" },
      evidence: arrayOfStrings("Claim evidence.")
    }),
    permission: permission("claim_beads_task", "work.claim"),
    sideEffects: ["beads_claim", "beads_note"],
    audit: audit("mcp.work_claimed", ["principal_id", "loop_id", "bead_id", "harness_id"])
  },
  {
    name: "ciclo_start_work",
    description: "Build or propose a bounded harness prompt for a claimed Beads issue.",
    inputSchema: objectSchema("Harness start request.", {
      loop_id: loopId,
      bead_id: beadId,
      harness_id: harnessId,
      dry_run: booleanSchema("When true, return prompt without dispatch.")
    }, ["loop_id", "bead_id", "harness_id"]),
    outputSchema: objectSchema("Harness start plan.", {
      prompt: stringSchema("Bounded prompt."),
      dispatched: { type: "boolean" },
      evidence: arrayOfStrings("Prompt and policy evidence.")
    }),
    permission: permission("send_prompt", "work.update"),
    sideEffects: ["harness_dispatch"],
    audit: audit("mcp.work_started", ["principal_id", "loop_id", "bead_id", "harness_id"], ["prompt"])
  },
  {
    name: "ciclo_update_work",
    description: "Append progress, validation, blocker, or final-summary memory to Beads.",
    inputSchema: objectSchema("Work update request.", {
      bead_id: beadId,
      kind: { type: "string", enum: ["progress", "blocker", "validation", "final_summary"] },
      message: stringSchema("Progress message."),
      validation_command: stringSchema("Validation command, when kind is validation."),
      validation_passed: booleanSchema("Validation result.")
    }, ["bead_id", "kind", "message"]),
    outputSchema: objectSchema("Update result.", {
      mutated: { type: "boolean" },
      pushed: { type: "boolean" },
      evidence: arrayOfStrings("Policy, access, and persistence evidence.")
    }),
    permission: permission("update_beads_progress", "work.update"),
    sideEffects: ["beads_note", "beads_sync"],
    audit: audit("mcp.work_updated", ["principal_id", "bead_id", "kind"], ["message"])
  },
  {
    name: "ciclo_close_work",
    description: "Close a Beads issue only with acceptance evidence, passing validation, policy, and access.",
    inputSchema: objectSchema("Work close request.", {
      bead_id: beadId,
      loop_id: loopId,
      harness_id: harnessId,
      final_summary: stringSchema("Final summary."),
      acceptance_evidence: arrayOfStrings("Acceptance evidence."),
      validation_evidence: { type: "array", items: { type: "object" } },
      launch_review: { type: "boolean", description: "Launch a bounded review worker after a successful close. Defaults to true." },
      review_harness_id: { type: "string", enum: ["claude-code", "codex"], description: "Harness for the post-close review worker. Defaults to codex." },
      review_model: stringSchema("Optional model for the review worker. Claude aliases such as fable 5 normalize to claude-fable-5."),
      review_effort: stringSchema("Optional reasoning or effort level for the review worker."),
      review_cwd: stringSchema("Optional cwd for the review worker. Defaults to the matching worker cwd or project root."),
      review_dry_run: { type: "boolean", description: "Plan the review worker without launching it." },
      review_configure_mcp: { type: "boolean", description: "Install Ciclo MCP config into the review worker cwd before launch. Defaults to true." }
    }, ["bead_id", "final_summary", "acceptance_evidence", "validation_evidence"]),
    outputSchema: objectSchema("Close result.", {
      mutated: { type: "boolean" },
      task: { type: "object" },
      evidence: arrayOfStrings("Close evidence."),
      review_session: { type: "object", description: "Post-close review launch result when the task was closed." }
    }),
    permission: permission("close_beads_task", "work.close"),
    sideEffects: ["beads_note", "beads_close", "beads_sync", "harness_dispatch"],
    audit: audit("mcp.work_closed", ["principal_id", "bead_id"], ["final_summary", "acceptance_evidence"])
  },
  {
    name: "ciclo_ask_operator",
    description: "Submit a question from a harness or remote worker to the operator session.",
    inputSchema: objectSchema("Question request.", {
      loop_id: loopId,
      bead_id: beadId,
      worker_session_id: stringSchema("Ciclo worker session asking the question."),
      question: stringSchema("Question text."),
      urgency: { type: "string", enum: ["low", "normal", "high", "blocking"] }
    }, ["question"]),
    outputSchema: objectSchema("Question record.", {
      question_id: stringSchema("Question id."),
      queued: { type: "boolean" },
      evidence: arrayOfStrings("Routing evidence.")
    }),
    permission: permission("answer_agent_question", "question.answer"),
    sideEffects: ["question_queue"],
    audit: audit("mcp.question_asked", ["principal_id", "loop_id", "bead_id", "urgency"], ["question"])
  },
  {
    name: "ciclo_answer_question",
    description: "Answer a pending Ciclo or agent question and route it to the waiting context.",
    inputSchema: objectSchema("Answer request.", {
      question_id: stringSchema("Question id."),
      answer: stringSchema("Operator or authorized agent answer."),
      evidence: arrayOfStrings("Answer evidence.")
    }, ["question_id", "answer"]),
    outputSchema: objectSchema("Answer routing result.", {
      answered: { type: "boolean" },
      routed_to: { type: "object" },
      evidence: arrayOfStrings("Routing evidence.")
    }),
    permission: permission("answer_agent_question", "question.answer"),
    sideEffects: ["question_queue", "beads_note"],
    audit: audit("mcp.question_answered", ["principal_id", "question_id"], ["answer"])
  },
  {
    name: "ciclo_report_feedback",
    description: "Queue findings, warnings, review notes, or benchmark results for the operator session.",
    inputSchema: objectSchema("Feedback request.", {
      loop_id: loopId,
      bead_id: beadId,
      severity: { type: "string", enum: ["info", "warning", "error", "critical"] },
      message: stringSchema("Feedback message."),
      evidence: arrayOfStrings("Feedback evidence.")
    }, ["severity", "message"]),
    outputSchema: objectSchema("Feedback result.", {
      feedback_id: stringSchema("Feedback id."),
      deduplicated: { type: "boolean" },
      evidence: arrayOfStrings("Queue evidence.")
    }),
    permission: permission("answer_agent_question", "question.answer"),
    sideEffects: ["feedback_queue"],
    audit: audit("mcp.feedback_reported", ["principal_id", "loop_id", "bead_id", "severity"], ["message"])
  },
  {
    name: "ciclo_sync_remote_trackers",
    description: "Trigger or dry-run configured Beads-native Jira/Linear tracker sync.",
    inputSchema: objectSchema("Remote tracker sync request.", {
      dry_run: booleanSchema("Preview sync without mutation."),
      force: booleanSchema("Bypass sync idempotency for an intentional retry."),
      loop_id: loopId,
      bead_id: beadId,
      idempotency_key: stringSchema("Stable idempotency key for this tracker sync request.")
    }),
    outputSchema: objectSchema("Sync result.", {
      synced: { type: "boolean" },
      provider: stringSchema("Tracker provider."),
      required_failed: { type: "boolean" },
      targets: { type: "array", items: { type: "object" } },
      evidence: arrayOfStrings("Sync evidence.")
    }),
    permission: permission("remote_tracker_sync", "access.admin"),
    sideEffects: ["beads_sync"],
    audit: audit("mcp.remote_trackers_synced", ["principal_id", "bead_id", "dry_run"])
  },
  {
    name: "ciclo_register_remote_session",
    description: "Register a remote Ciclo, Herdr, or harness session observed through Herdr remote attach over SSH.",
    inputSchema: objectSchema("Remote session registration.", {
      remote_session_id: remoteSessionId,
      herdr_target: stringSchema("Herdr remote target alias or SSH target."),
      repo_path: stringSchema("Remote repository path."),
      harness_id: harnessId,
      bead_id: beadId
    }, ["remote_session_id", "herdr_target", "repo_path", "harness_id"]),
    outputSchema: objectSchema("Remote registration result.", {
      registered: { type: "boolean" },
      evidence: arrayOfStrings("Registration evidence.")
    }),
    permission: permission("register_remote_session", "remote.register"),
    sideEffects: ["remote_session_update"],
    audit: audit("mcp.remote_registered", ["principal_id", "remote_session_id", "harness_id"], ["herdr_target", "repo_path"])
  },
  {
    name: "ciclo_heartbeat_remote_session",
    description: "Update liveness and state for a registered remote session.",
    inputSchema: objectSchema("Remote heartbeat.", {
      remote_session_id: remoteSessionId,
      state: { type: "string", enum: ["working", "blocked", "done", "idle", "unknown"] },
      evidence: arrayOfStrings("Remote liveness evidence.")
    }, ["remote_session_id", "state"]),
    outputSchema: objectSchema("Heartbeat result.", {
      accepted: { type: "boolean" },
      stale: { type: "boolean" },
      evidence: arrayOfStrings("Heartbeat evidence.")
    }),
    permission: permission("register_remote_session", "remote.register"),
    sideEffects: ["remote_session_update"],
    audit: audit("mcp.remote_heartbeat", ["principal_id", "remote_session_id", "state"], ["evidence"])
  },
  {
    name: "ciclo_detach_remote_session",
    description: "Mark a remote session detached, paused, lost, or retired without stealing Beads ownership.",
    inputSchema: objectSchema("Remote detach request.", {
      remote_session_id: remoteSessionId,
      reason: stringSchema("Detach reason."),
      status: { type: "string", enum: ["detached", "paused", "lost", "retired"] }
    }, ["remote_session_id", "reason", "status"]),
    outputSchema: objectSchema("Remote detach result.", {
      detached: { type: "boolean" },
      evidence: arrayOfStrings("Detach evidence.")
    }),
    permission: permission("register_remote_session", "remote.register"),
    sideEffects: ["remote_session_update", "beads_note"],
    audit: audit("mcp.remote_detached", ["principal_id", "remote_session_id", "status"], ["reason"])
  },
  {
    name: "ciclo_launch_remote_runner",
    description: "Plan a Herdr-reachable remote runner on Kubernetes, AWS Lambda MicroVM, or Cloudflare with WireGuard tunnel setup.",
    inputSchema: objectSchema("Remote runner launch request.", {
      runner_kind: stringSchema("Remote runner kind registered by a built-in or third-party plugin."),
      runner_id: remoteRunnerId,
      loop_id: loopId,
      bead_id: beadId,
      harness_id: harnessId,
      image: stringSchema("Runner image containing Ciclo harness dependencies."),
      repo_url: stringSchema("Repository URL to clone or mount."),
      repo_path: stringSchema("Repository path inside the runner."),
      prompt: stringSchema("Bounded worker prompt."),
      herdr_session: stringSchema("Herdr session name, defaults to the repository session name."),
      ssh_user: stringSchema("SSH user exposed over the WireGuard tunnel."),
      wireguard: { type: "object" },
      environment: { type: "object" },
      configure_mcp: booleanSchema("Generate Ciclo MCP client config artifacts for the remote repository path. Defaults to true when project MCP config exists, otherwise true for remote launches."),
      mcp_clients: arrayOfStrings("Remote MCP clients to configure: claude, codex. Defaults to the launched harness client or project config."),
      mcp_server_name: stringSchema("Remote MCP server name. Default: ciclo or project config."),
      mcp_command: stringSchema("Ciclo command for remote MCP clients to run. Default: ciclo or project config."),
      mcp_env: { type: "object", description: "Additional non-secret variables to write into the remote Ciclo MCP server config." },
      mcp_additional_servers: { type: "object", description: "Additional third-party MCP servers to include in generated remote Claude/Codex config. Object keys are server names; values accept command, args, and non-secret env." },
      mcp_claude_channel: booleanSchema("Enable Claude channel capability in the generated remote MCP config."),
      kubernetes: { type: "object" },
      aws_lambda: { type: "object", description: "AWS Lambda MicroVM options such as microvm_image_name, microvm_image_identifier, microvm_name, source_s3_uri, base_image_arn, build_role_arn, execution_role_arn, memory_mb, and vcpu_count." },
      cloudflare: { type: "object" },
      dry_run: booleanSchema("Plan without invoking a provider executor.")
    }, ["runner_kind", "loop_id", "harness_id", "image", "repo_path", "prompt"]),
    outputSchema: objectSchema("Remote runner launch plan.", {
      runner_id: remoteRunnerId,
      runner_kind: stringSchema("Runner provider kind."),
      provider_name: stringSchema("Remote runner plugin name."),
      execution_model: stringSchema("Provider execution model."),
      state: stringSchema("Runner lifecycle state."),
      herdr_remote_target: stringSchema("Herdr remote target reachable over WireGuard."),
      attach: { type: "object" },
      mcp_config: { type: "object" },
      wireguard: { type: "object" },
      commands: arrayOfStrings("Provider commands to apply the plan."),
      artifacts: { type: "array", items: { type: "object" } },
      warnings: arrayOfStrings("Provider limitations or operator warnings."),
      evidence: arrayOfStrings("Launch planning evidence.")
    }),
    permission: permission("register_remote_session", "remote.register"),
    sideEffects: ["remote_runner_update", "remote_session_update"],
    audit: audit("mcp.remote_runner_launched", ["principal_id", "runner_id", "runner_kind", "loop_id", "harness_id"], ["prompt", "wireguard", "environment"])
  },
  {
    name: "ciclo_list_remote_runners",
    description: "List remote runner launch plans and their Herdr/WireGuard attach state.",
    inputSchema: objectSchema("Remote runner list request.", {}),
    outputSchema: objectSchema("Remote runners.", {
      remote_runners: { type: "array", items: { type: "object" } }
    }),
    permission: permission("read_status", "status.read", true),
    sideEffects: ["none"],
    audit: audit("mcp.remote_runners_read", ["principal_id", "session_id"])
  },
  {
    name: "ciclo_list_secret_providers",
    description: "List configured secret provider plugins without returning secret material.",
    inputSchema: objectSchema("Secret provider list request.", {}),
    outputSchema: objectSchema("Secret providers.", {
      secret_providers: { type: "array", items: { type: "object" } },
      evidence: arrayOfStrings("Provider registry evidence.")
    }),
    permission: permission("read_status", "status.read", true),
    sideEffects: ["none"],
    audit: audit("mcp.secret_providers_read", ["principal_id", "session_id"])
  },
  {
    name: "ciclo_request_secret",
    description: "Resolve a task-scoped secret through an authorized provider such as OpenBao or 1Password, returning the value only to the caller and redacting audit evidence.",
    inputSchema: objectSchema("Secret request.", {
      provider_id: secretProviderId,
      secret_ref: secretRef,
      field: stringSchema("Optional provider field. Required by the OpenBao CLI provider."),
      loop_id: loopId,
      bead_id: beadId,
      worker_session_id: stringSchema("Worker session requesting the secret."),
      reason: stringSchema("Why this task needs the secret."),
      dry_run: booleanSchema("Validate routing without invoking the provider or returning a secret value.")
    }, ["provider_id", "secret_ref", "reason"]),
    outputSchema: objectSchema("Secret resolution result.", {
      resolved: { type: "boolean" },
      provider_id: secretProviderId,
      provider_kind: stringSchema("Provider kind."),
      secret_ref_hash: stringSchema("Stable hash of the secret reference."),
      field: stringSchema("Requested provider field."),
      value: stringSchema("Resolved secret value. Present only for successful non-dry-run requests."),
      reason: stringSchema("Resolution reason."),
      evidence: arrayOfStrings("Redacted resolution evidence.")
    }),
    permission: permission("request_secret", "secret.read"),
    sideEffects: ["secret_read"],
    audit: audit("mcp.secret_requested", ["principal_id", "provider_id", "loop_id", "bead_id", "worker_session_id"], ["secret_ref", "value", "reason"])
  },
  {
    name: "ciclo_attach_plan",
    description: "Build the Herdr command for attaching to the overall Ciclo session or a specific agent target.",
    inputSchema: objectSchema("Ciclo attach request.", {
      herdr_target: stringSchema("Optional Herdr remote target."),
      herdr_session: stringSchema("Herdr session name, defaults to the repository session name."),
      agent_target: stringSchema("Optional Herdr agent target inside the session.")
    }),
    outputSchema: objectSchema("Ciclo attach plan.", {
      command: stringSchema("Executable."),
      args: arrayOfStrings("Executable arguments."),
      session: stringSchema("Herdr session name."),
      mode: stringSchema("overview or agent."),
      evidence: arrayOfStrings("Attach planning evidence.")
    }),
    permission: permission("read_status", "status.read", true),
    sideEffects: ["none"],
    audit: audit("mcp.ciclo_attach_planned", ["principal_id", "herdr_session"])
  },
  {
    name: "ciclo_launch_worker_session",
    description: "Launch or dry-run a Ciclo-managed Claude Code or Codex worker session with model and runtime parameters.",
    inputSchema: objectSchema("Worker session launch request.", {
      harness_id: { type: "string", enum: ["claude-code", "codex"] },
      loop_id: loopId,
      bead_id: beadId,
      prompt: stringSchema("Bounded worker prompt."),
      extra_args: arrayOfStrings("Additional harness CLI arguments inserted before the final prompt argument."),
      model: stringSchema("Harness model id. Claude aliases such as fable 5 normalize to claude-fable-5."),
      effort: stringSchema("Reasoning or effort level."),
      cwd: stringSchema("Worker cwd."),
      session_name: stringSchema("Human-readable worker session name."),
      dry_run: booleanSchema("Plan the launch without starting the process."),
      permission_mode: stringSchema("Claude permission mode."),
      sandbox: stringSchema("Codex sandbox mode."),
      approval_policy: stringSchema("Codex approval policy."),
      isolation: { type: "string", enum: ["none", "worktree"], description: "Optional launch isolation mode. worktree creates an isolated worktree for the worker." },
      create_worktree: booleanSchema("Create a git worktree and launch the worker from it."),
      worktree_path: stringSchema("Optional worktree path. Relative paths are resolved from cwd."),
      worktree_branch: stringSchema("Optional branch to create for the worktree."),
      worktree_base: stringSchema("Optional base revision for the worktree."),
      worktree_force: booleanSchema("Pass --force to git worktree add."),
      configure_mcp: booleanSchema("Install Ciclo MCP client config into the worker cwd or worktree before launch."),
      mcp_clients: arrayOfStrings("MCP clients to configure: claude, codex. Defaults to the launched harness client."),
      mcp_server_name: stringSchema("MCP server name to install. Default: ciclo."),
      mcp_command: stringSchema("Ciclo command for MCP clients to run. Default: ciclo."),
      mcp_env: { type: "object", description: "Additional non-secret environment variables to write into the configured MCP server." },
      mcp_additional_servers: { type: "object", description: "Additional third-party MCP servers to install into the launched worker worktree/cwd. Object keys are server names; values accept command, args, and non-secret env." },
      mcp_secret_env: {
        type: "array",
        items: { type: "object" },
        description: "Secret-backed MCP server environment bindings. Each item accepts env_name, provider_id, secret_ref, optional field, optional format with exactly one ${secret} placeholder, and optional reason."
      },
      mcp_claude_channel: booleanSchema("Enable Claude channel capability in the generated MCP config.")
    }, ["harness_id", "loop_id", "prompt"]),
    outputSchema: objectSchema("Worker session launch result.", {
      session_id: stringSchema("Ciclo worker session id."),
      state: stringSchema("Worker lifecycle state."),
      launch_mode: stringSchema("process or herdr_pane."),
      command: stringSchema("Executable."),
      args: arrayOfStrings("Executable arguments."),
      extra_args: arrayOfStrings("Additional caller-supplied harness arguments."),
      cwd: stringSchema("Worker cwd."),
      worktree: objectSchema("Created or planned worktree.", {
        create: booleanSchema("Whether Ciclo creates the worktree."),
        path: stringSchema("Worktree path."),
        branch: stringSchema("Worktree branch."),
        base: stringSchema("Worktree base revision."),
        force: booleanSchema("Whether --force is used.")
      }),
      mcp_config: objectSchema("Installed or planned MCP client config for the worker cwd.", {
        enabled: booleanSchema("Whether MCP config is enabled for this launch."),
        projectRoot: stringSchema("Worker project root receiving MCP config."),
        clients: arrayOfStrings("Configured MCP clients."),
        serverName: stringSchema("Installed MCP server name."),
        command: stringSchema("Installed Ciclo command."),
        install: { type: "object" }
      }),
      pid: { type: "number", description: "Process id when launched." },
      evidence: arrayOfStrings("Launch evidence.")
    }),
    permission: permission("send_prompt", "work.update"),
    sideEffects: ["worker_session_update", "harness_dispatch"],
    audit: audit("mcp.worker_session_launched", ["principal_id", "loop_id", "bead_id", "harness_id"], ["prompt", "extra_args", "mcp_command"])
  },
  {
    name: "ciclo_heartbeat_worker_session",
    description: "Record worker liveness, optional waiting/running state, and token/cost usage for a Ciclo-managed worker session.",
    inputSchema: objectSchema("Worker heartbeat request.", {
      worker_session_id: stringSchema("Ciclo worker session id."),
      state: { type: "string", enum: ["running", "waiting_on_operator"] },
      input_tokens: { type: "number", description: "Input token delta since the previous heartbeat." },
      output_tokens: { type: "number", description: "Output token delta since the previous heartbeat." },
      cost_usd: { type: "number", description: "Cost delta in USD since the previous heartbeat." },
      evidence: arrayOfStrings("Heartbeat evidence.")
    }, ["worker_session_id"]),
    outputSchema: objectSchema("Worker heartbeat result.", {
      session_id: stringSchema("Ciclo worker session id."),
      state: stringSchema("Worker lifecycle state."),
      last_heartbeat_at: stringSchema("Last heartbeat timestamp."),
      state_entered_at: stringSchema("Current state entry timestamp."),
      usage: { type: "object" },
      evidence: arrayOfStrings("Heartbeat evidence.")
    }),
    permission: permission("send_prompt", "work.update"),
    sideEffects: ["worker_session_update"],
    audit: audit("mcp.worker_session_heartbeat", ["principal_id", "worker_session_id", "state"], ["evidence"])
  },
  {
    name: "ciclo_list_worker_sessions",
    description: "List Ciclo-managed Claude Code and Codex worker sessions.",
    inputSchema: objectSchema("Worker session list request.", {
      stale_after_ms: { type: "number", description: "Mark running workers stalled after this many milliseconds without heartbeat." }
    }),
    outputSchema: objectSchema("Worker sessions.", {
      worker_sessions: { type: "array", items: { type: "object" } }
    }),
    permission: permission("read_status", "status.read", true),
    sideEffects: ["none"],
    audit: audit("mcp.worker_sessions_read", ["principal_id", "session_id"])
  },
  {
    name: "ciclo_stop_worker_session",
    description: "Stop and clean up a Ciclo-managed worker session.",
    inputSchema: objectSchema("Worker session stop request.", {
      worker_session_id: stringSchema("Ciclo worker session id."),
      reason: stringSchema("Cleanup reason."),
      signal: stringSchema("Process signal, default SIGTERM.")
    }, ["worker_session_id", "reason"]),
    outputSchema: objectSchema("Worker session stop result.", {
      session_id: stringSchema("Ciclo worker session id."),
      state: stringSchema("Worker lifecycle state."),
      cleanup_reason: stringSchema("Cleanup reason."),
      evidence: arrayOfStrings("Cleanup evidence.")
    }),
    permission: permission("send_prompt", "work.update"),
    sideEffects: ["worker_session_update"],
    audit: audit("mcp.worker_session_stopped", ["principal_id", "worker_session_id"], ["reason"])
  },
  {
    name: "ciclo_auth_device_start",
    description: "Start OAuth-style device login for a CLI, MCP HTTP client, or remote worker.",
    inputSchema: objectSchema("Device authorization request.", {
      client_id: stringSchema("Client id."),
      client_kind: { type: "string", enum: ["cli", "mcp_http", "remote_worker"] },
      requested_scopes: arrayOfStrings("Requested scopes.")
    }, ["client_id", "client_kind"]),
    outputSchema: objectSchema("Device authorization response.", {
      device_code: stringSchema("Opaque device code."),
      user_code: stringSchema("Short user code."),
      verification_uri: stringSchema("User verification URI."),
      interval_seconds: { type: "number" }
    }),
    permission: permission("read_status", "status.read", true, "none_in_single_mode"),
    sideEffects: ["auth_token_issue"],
    audit: audit("mcp.auth_device_started", ["client_id", "client_kind"], ["device_code", "user_code"])
  },
  {
    name: "ciclo_auth_device_poll",
    description: "Poll device authorization status and receive token material only after approval.",
    inputSchema: objectSchema("Device poll request.", {
      device_code: stringSchema("Opaque device code.")
    }, ["device_code"]),
    outputSchema: objectSchema("Device poll response.", {
      status: { type: "string", enum: ["authorization_pending", "slow_down", "approved", "denied", "expired"] },
      token_set: { type: "object" }
    }),
    permission: permission("read_status", "status.read", true, "none_in_single_mode"),
    sideEffects: ["auth_token_issue"],
    audit: audit("mcp.auth_device_polled", ["client_id"], ["device_code", "token_set"])
  },
  {
    name: "ciclo_whoami",
    description: "Return current principal, session mode, token expiry, and effective capabilities.",
    inputSchema: objectSchema("Whoami request.", {}),
    outputSchema: objectSchema("Principal status.", {
      principal_id: stringSchema("Current principal id."),
      session_mode: stringSchema("single or multiuser."),
      capabilities: arrayOfStrings("Effective capabilities."),
      expires_at: stringSchema("Token expiry.")
    }),
    permission: permission("read_status", "status.read", true),
    sideEffects: ["none"],
    audit: audit("mcp.whoami_read", ["principal_id", "session_id"])
  },
  {
    name: "ciclo_grant_access",
    description: "Grant scoped access to a user or service principal.",
    inputSchema: objectSchema("Grant request.", {
      principal_id: stringSchema("Principal receiving access."),
      role: { type: "string", enum: ["owner", "operator", "agent", "viewer"] },
      capabilities: arrayOfStrings("Additional capabilities."),
      scope: { type: "object" },
      expires_at: stringSchema("Grant expiry.")
    }, ["principal_id", "role", "scope"]),
    outputSchema: objectSchema("Grant result.", {
      granted: { type: "boolean" },
      grant_id: stringSchema("Grant id."),
      evidence: arrayOfStrings("Grant evidence.")
    }),
    permission: permission("grant_access", "access.admin"),
    sideEffects: ["access_grant_update"],
    audit: audit("mcp.access_granted", ["actor_principal_id", "principal_id", "role", "scope"])
  },
  {
    name: "ciclo_revoke_access",
    description: "Revoke an access grant or device token.",
    inputSchema: objectSchema("Revoke request.", {
      principal_id: stringSchema("Principal id."),
      grant_id: stringSchema("Grant id."),
      token_id: stringSchema("Token id.")
    }),
    outputSchema: objectSchema("Revoke result.", {
      revoked: { type: "boolean" },
      evidence: arrayOfStrings("Revocation evidence.")
    }),
    permission: permission("revoke_access", "access.admin"),
    sideEffects: ["access_grant_update"],
    audit: audit("mcp.access_revoked", ["actor_principal_id", "principal_id", "grant_id", "token_id"])
  }
];

export const cicloMcpResources: readonly McpResourceContract[] = [
  {
    uriTemplate: "ciclo://status",
    description: "Overall system status with loops, Beads, Herdr, remotes, and sync.",
    outputSchema: objectSchema("Overall status.", { status: { type: "object" } }),
    permission: permission("read_status", "status.read", true),
    cachePolicy: "short_poll",
    audit: audit("mcp.resource.status", ["principal_id"])
  },
  {
    uriTemplate: "ciclo://loops",
    description: "Loop summary list.",
    outputSchema: objectSchema("Loop summaries.", { loops: { type: "array", items: { type: "object" } } }),
    permission: permission("read_loop", "status.read", true),
    cachePolicy: "short_poll",
    audit: audit("mcp.resource.loops", ["principal_id"])
  },
  {
    uriTemplate: "ciclo://loops/{loop_id}",
    description: "Detailed loop state, current goal, policy, and evidence.",
    outputSchema: objectSchema("Loop detail.", { loop: { type: "object" }, evidence: arrayOfStrings("Evidence.") }),
    permission: permission("read_loop", "status.read", true),
    cachePolicy: "short_poll",
    audit: audit("mcp.resource.loop", ["principal_id", "loop_id"])
  },
  {
    uriTemplate: "ciclo://events",
    description: "Pollable Ciclo runtime event stream snapshot.",
    outputSchema: objectSchema("Event stream snapshot.", {
      cursor: { type: "number" },
      next_cursor: { type: "number" },
      events: { type: "array", items: { type: "object" } }
    }),
    permission: permission("read_status", "status.read", true),
    cachePolicy: "short_poll",
    audit: audit("mcp.resource.events", ["principal_id"])
  },
  {
    uriTemplate: "ciclo://board",
    description: "Joined Beads worker branch PR validation board.",
    outputSchema: objectSchema("Ciclo board.", {
      rows: { type: "array", items: { type: "object" } },
      rollup: { type: "object" },
      evidence: arrayOfStrings("Board evidence.")
    }),
    permission: permission("read_status", "status.read", true),
    cachePolicy: "short_poll",
    audit: audit("mcp.resource.board", ["principal_id"])
  },
  {
    uriTemplate: "ciclo://work/ready",
    description: "Ready Beads work view.",
    outputSchema: objectSchema("Ready work.", { work: { type: "array", items: { type: "object" } } }),
    permission: permission("read_ready_work", "status.read", true),
    cachePolicy: "short_poll",
    audit: audit("mcp.resource.ready_work", ["principal_id"])
  },
  {
    uriTemplate: "ciclo://work/{bead_id}",
    description: "Bead-derived work context and Ciclo audit state.",
    outputSchema: objectSchema("Work context.", { bead: { type: "object" }, audit: { type: "array", items: { type: "object" } } }),
    permission: permission("read_ready_work", "status.read", true),
    cachePolicy: "event_driven",
    audit: audit("mcp.resource.work", ["principal_id", "bead_id"])
  },
  {
    uriTemplate: "ciclo://questions",
    description: "Pending questions awaiting operator or agent response.",
    outputSchema: objectSchema("Question queue.", { questions: { type: "array", items: { type: "object" } } }),
    permission: permission("read_status", "status.read", true),
    cachePolicy: "event_driven",
    audit: audit("mcp.resource.questions", ["principal_id"])
  },
  {
    uriTemplate: "ciclo://feedback",
    description: "Feedback queue for the operator session.",
    outputSchema: objectSchema("Feedback queue.", { feedback: { type: "array", items: { type: "object" } } }),
    permission: permission("read_status", "status.read", true),
    cachePolicy: "event_driven",
    audit: audit("mcp.resource.feedback", ["principal_id"])
  },
  {
    uriTemplate: "ciclo://remote-sessions",
    description: "Registered remote sessions and liveness state.",
    outputSchema: objectSchema("Remote sessions.", { remote_sessions: { type: "array", items: { type: "object" } } }),
    permission: permission("read_status", "status.read", true),
    cachePolicy: "short_poll",
    audit: audit("mcp.resource.remote_sessions", ["principal_id"])
  },
  {
    uriTemplate: "ciclo://remote-runners",
    description: "Remote runner launch plans with WireGuard and Herdr attach details.",
    outputSchema: objectSchema("Remote runners.", { remote_runners: { type: "array", items: { type: "object" } } }),
    permission: permission("read_status", "status.read", true),
    cachePolicy: "short_poll",
    audit: audit("mcp.resource.remote_runners", ["principal_id"])
  },
  {
    uriTemplate: "ciclo://secret-providers",
    description: "Configured secret providers and supported field behavior without secret material.",
    outputSchema: objectSchema("Secret providers.", { secret_providers: { type: "array", items: { type: "object" } } }),
    permission: permission("read_status", "status.read", true),
    cachePolicy: "no_store",
    audit: audit("mcp.resource.secret_providers", ["principal_id"])
  },
  {
    uriTemplate: "ciclo://worker-sessions",
    description: "Ciclo-managed Claude Code and Codex worker sessions.",
    outputSchema: objectSchema("Worker sessions.", { worker_sessions: { type: "array", items: { type: "object" } } }),
    permission: permission("read_status", "status.read", true),
    cachePolicy: "short_poll",
    audit: audit("mcp.resource.worker_sessions", ["principal_id"])
  },
  {
    uriTemplate: "ciclo://session/access",
    description: "Effective access mode, current principal, and caller-visible grants.",
    outputSchema: objectSchema("Access status.", { access: { type: "object" } }),
    permission: permission("read_status", "status.read", true),
    cachePolicy: "no_store",
    audit: audit("mcp.resource.session_access", ["principal_id"])
  },
  {
    uriTemplate: "ciclo://users/me",
    description: "Current principal and token expiry.",
    outputSchema: objectSchema("Current user.", { principal: { type: "object" } }),
    permission: permission("read_status", "status.read", true),
    cachePolicy: "no_store",
    audit: audit("mcp.resource.users_me", ["principal_id"])
  },
  {
    uriTemplate: "ciclo://benchmarks/latest",
    description: "Latest benchmark results and regressions.",
    outputSchema: objectSchema("Latest benchmark summary.", { benchmarks: { type: "object" } }),
    permission: permission("read_status", "status.read", true),
    cachePolicy: "short_poll",
    audit: audit("mcp.resource.benchmarks_latest", ["principal_id"])
  }
];

export const cicloMcpPrompts: readonly McpPromptContract[] = [
  {
    name: "ciclo_continue_work",
    description: "Continue a claimed Beads task with bounded context, validation commands, and stop conditions.",
    argumentsSchema: objectSchema("Continue work prompt args.", { bead_id: beadId, harness_id: harnessId }, ["bead_id", "harness_id"]),
    outputPurpose: "Harness implementation prompt.",
    permission: permission("read_ready_work", "status.read", true),
    audit: audit("mcp.prompt.continue_work", ["principal_id", "bead_id", "harness_id"])
  },
  {
    name: "ciclo_review_loop",
    description: "Review loop prompt with repo state, Beads context, policy, and feedback format.",
    argumentsSchema: objectSchema("Review loop args.", { loop_id: loopId, bead_id: beadId }, ["loop_id"]),
    outputPurpose: "Harness review prompt.",
    permission: permission("read_loop", "status.read", true),
    audit: audit("mcp.prompt.review_loop", ["principal_id", "loop_id", "bead_id"])
  },
  {
    name: "ciclo_deploy_gate",
    description: "Deploy gate prompt requiring validation, policy, rollback, and operator approval evidence.",
    argumentsSchema: objectSchema("Deploy gate args.", { loop_id: loopId, bead_id: beadId }, ["loop_id"]),
    outputPurpose: "Deploy readiness prompt.",
    permission: permission("read_loop", "status.read", true),
    audit: audit("mcp.prompt.deploy_gate", ["principal_id", "loop_id", "bead_id"])
  },
  {
    name: "ciclo_answer_operator_question",
    description: "Prompt for answering a pending question with evidence and uncertainty boundaries.",
    argumentsSchema: objectSchema("Question answer args.", { question_id: stringSchema("Question id.") }, ["question_id"]),
    outputPurpose: "Question answer prompt.",
    permission: permission("read_status", "status.read", true),
    audit: audit("mcp.prompt.answer_operator_question", ["principal_id", "question_id"])
  },
  {
    name: "ciclo_report_feedback",
    description: "Prompt for reporting structured findings, benchmark results, or review notes to the operator.",
    argumentsSchema: objectSchema("Feedback prompt args.", { loop_id: loopId, bead_id: beadId }, ["loop_id"]),
    outputPurpose: "Structured feedback prompt.",
    permission: permission("read_loop", "status.read", true),
    audit: audit("mcp.prompt.report_feedback", ["principal_id", "loop_id", "bead_id"])
  }
];
