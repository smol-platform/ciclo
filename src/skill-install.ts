import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type CicloSkillInstallClient = "claude" | "codex";

export interface CicloSkillInstallOptions {
  readonly projectRoot?: string;
  readonly clients?: readonly CicloSkillInstallClient[];
  readonly dryRun?: boolean;
}

export interface CicloSkillInstallTargetResult {
  readonly client: CicloSkillInstallClient;
  readonly paths: readonly string[];
  readonly changed: boolean;
  readonly dryRun: boolean;
}

export interface CicloSkillInstallResult {
  readonly installed: boolean;
  readonly projectRoot: string;
  readonly targets: readonly CicloSkillInstallTargetResult[];
  readonly nextSteps: readonly string[];
}

const CODEX_SKILL = `---
name: ciclo-mcp
description: "Use when Claude, Codex, or another coding agent is working in a Ciclo-enabled project and should coordinate through Ciclo MCP: status, Beads claims, worker launches with MCP config, Herdr pane monitoring, worktrees, remote runners, secret providers, event/board monitoring, tracker sync, feedback, and closeout evidence."
---

# Ciclo MCP

Use Ciclo MCP as the control plane. Do not bypass Ciclo for claims, worker lifecycle, operator questions, remote runner planning, or task closeout when Ciclo MCP is available.

## First Moves

1. Read \`ciclo_status\` or \`ciclo://status\`.
2. Read \`ciclo_whoami\` or \`ciclo://users/me\` when access or identity affects the action.
3. For work selection, call \`ciclo_list_ready_work\`; do not infer ready work only from local files.
4. Claim work with \`ciclo_claim_work\` before implementation.
5. Record progress, blockers, validation, and final summaries with \`ciclo_update_work\`.

If MCP tools are not visible, check project MCP and skill installation:

\`\`\`bash
ciclo mcp install --client all --project "$(pwd)"
ciclo skill install --client all --project "$(pwd)"
\`\`\`

## Install Or Refresh

Use these from a repository root to install or refresh Ciclo integration:

\`\`\`bash
ciclo mcp install --client all --project "$(pwd)"
ciclo skill install --client all --project "$(pwd)"
\`\`\`

Dry-run first when you are not sure what files will change:

\`\`\`bash
ciclo mcp install --client all --project "$(pwd)" --dry-run --compact
ciclo skill install --client all --project "$(pwd)" --dry-run --compact
\`\`\`

MCP install writes project client config for Claude and/or Codex. Use \`--client claude\`, \`--client codex\`, or \`--client all\`; use \`--server-name\` and \`--command\` only when the project needs a non-default Ciclo binary or server id. After install, restart the client if tools or skills do not hot-reload.

## Plugin Guidance

Third-party plugins extend Ciclo outside this repository. Use the CLI, not manual config edits:

\`\`\`bash
ciclo plugin list --compact
ciclo plugin install <package> --trust
ciclo plugin install <package> --path <local-package-dir> --trust
ciclo plugin enable <package>
ciclo plugin disable <package>
\`\`\`

Only trust plugins after the operator accepts the package source and behavior. External plugins must include \`ciclo.plugin.json\` and export \`activate(api)\`. Plugins can register remote runner kinds and secret provider kinds; after enabling a plugin, re-check \`ciclo_status\`, \`ciclo_list_remote_runners\`, or \`ciclo_list_secret_providers\` before using it.

Plugin-backed secret providers can be named in \`.ciclo/config.json\`:

\`\`\`json
{
  "secrets": {
    "providers": [
      {
        "id": "team-keychain",
        "kind": "keychain",
        "pluginProviderId": "keychain-test"
      }
    ]
  }
}
\`\`\`

Use \`id\` in \`ciclo_request_secret\`; \`pluginProviderId\` is the provider id registered by the installed plugin. Do not put secret values in config.

## Operating Rules

- Use Beads IDs in every mutating Ciclo MCP call when work is tied to a task.
- Use \`dry_run: true\` before launching workers, remote runners, or any plan with unclear policy impact.
- Use \`ciclo_list_secret_providers\` and \`ciclo_request_secret\` when a task needs a configured secret reference. Ask through \`ciclo_ask_operator\` only when the provider, reference, or authorization is missing.
- Never paste secret values into Beads, tracker sync, feedback, progress notes, or chat transcripts.
- Ask through \`ciclo_ask_operator\` for destructive commands, deploys, scope changes, unclear product intent, or blocked agent decisions.
- Report findings or warnings with \`ciclo_report_feedback\` instead of burying them in chat.
- Close work only through \`ciclo_close_work\`, with acceptance evidence and validation evidence; successful closes launch a bounded review worker by default.
- Do not write \`.beads/issues.jsonl\` or treat it as live coordination state.
- Do not push Jira/Linear directly; use \`ciclo_sync_remote_trackers\` only when Beads-native sync is configured and authorized.

## Feature Map

- Status and identity: \`ciclo_status\`, \`ciclo_whoami\`, \`ciclo://status\`, \`ciclo://users/me\`.
- Brain decisions: \`ciclo_decide\` routes remote monitoring, context insertion, answerable questions, and user-session interface decisions through Ciclo's model-backed OpenAI brain via Pi.
- Work control: \`ciclo_list_ready_work\`, \`ciclo_claim_work\`, \`ciclo_update_work\`, \`ciclo_close_work\`; use \`launch_review: false\` only when the operator explicitly does not want post-close review.
- Worker sessions: \`ciclo_launch_worker_session\`, \`ciclo_heartbeat_worker_session\`, \`ciclo_list_worker_sessions\`, \`ciclo_stop_worker_session\`.
- Worker launch options: use \`configure_mcp: true\`, \`mcp_clients\`, \`extra_args\`, \`isolation: "worktree"\`, model/effort/sandbox/approval settings, and dry-run first.
- Claude Code model aliases: \`fable 5\`, \`Fable 5\`, and \`claude fable 5\` normalize to \`claude-fable-5\`.
- Monitoring: \`ciclo_poll_events\`, \`ciclo_board\`, \`ciclo://events\`, \`ciclo://board\`; tell terminal operators to use \`ciclo events --follow\`; use \`expected_pr_after_ms\` for PR-producing work.
- Cron and memory: \`ciclo_remember\`, \`ciclo_list_memories\`, \`ciclo_compact_memories\`, \`ciclo_list_cron_jobs\`, \`ciclo_run_due_cron\`, \`ciclo://memory\`, and \`ciclo://cron\`. Use memory for durable project learnings, model fit, PR review needs, blockers, and cross-session handoff context; do not store secrets or raw transcripts.
- Operator routing: \`ciclo_ask_operator\`, \`ciclo_answer_question\`, \`ciclo_report_feedback\`.
- Secrets: \`ciclo_list_secret_providers\`, \`ciclo_request_secret\`, \`ciclo://secret-providers\`.
- Remote runners: \`ciclo_launch_remote_runner\`, \`ciclo_list_remote_runners\`, \`ciclo_attach_plan\`, \`ciclo://remote-runners\`.
- Tracker sync: \`ciclo_sync_remote_trackers\` only when Beads-native Jira/Linear sync is configured and authorized.

## Worker Pattern

When the user wants Claude to drive work through Ciclo, keep the current session as the operator-facing session. Launch implementation or review workers through Ciclo:

1. Call \`ciclo_launch_worker_session\` with \`dry_run: true\` and \`configure_mcp: true\` unless the worker already has project MCP config.
2. Show the command, cwd, model, session name, prompt scope, extra args, worktree plan, and MCP config plan.
3. After approval, call \`ciclo_launch_worker_session\` without dry run.
4. Prefer \`isolation: "worktree"\` for bead fan-out so workers do not collide in the main checkout.
5. Monitor with \`ciclo_poll_events\`, \`ciclo_board\`, \`ciclo_list_worker_sessions\`, or \`ciclo://worker-sessions\`.
6. Have workers heartbeat with \`ciclo_heartbeat_worker_session\`; include token and cost deltas when available.
7. For PR-producing loops, call \`ciclo_board\` with \`expected_pr_after_ms\`; treat \`expected_pr_missing\` as a blocker requiring transcript inspection, stop, or relaunch.
8. Stop stale or superseded workers with \`ciclo_stop_worker_session\`.

## Spawned Session MCP Tools

Use \`ciclo_launch_worker_session\` to decide which MCP tools a spawned Claude or Codex worker receives:

- Prefer repository defaults in \`.ciclo/config.json\` when the project has shared MCP, secret-provider, or remote-runner settings. Use \`ciclo config show --compact\` to inspect redacted defaults and \`ciclo config init\` to create a starter file.
- Use \`examples/ciclo-config.json\` in the Ciclo repository as the reference shape for provider aliases, MCP secret bindings, prompt guidance, cron jobs, memory compaction policy, remote runner defaults, WireGuard settings, and provider-specific runner blocks.
- Use \`ciclo launch codex\` or \`ciclo launch claude\` when the operator wants a ready-to-go local Herdr session with Ciclo MCP and all configured additional MCP servers installed before the harness starts. The default session and first pane are named for the project, and the launched harness starts in bypass permission mode unless explicitly narrowed. Use \`--session\`, \`--pane-name\`, \`--no-attach\`, or \`--terminal\` only when the operator needs a different shape. Dry-run with \`ciclo launch codex --dry-run --compact\` to inspect the MCP install plan, Herdr command, and harness command without writing files or starting a session.
- Set \`configure_mcp: true\` to install the Ciclo MCP server into the worker cwd or generated worktree before launch.
- Set \`mcp_clients\` to the clients that should receive the config: \`["claude"]\`, \`["codex"]\`, or \`["claude", "codex"]\`. If omitted, Ciclo configures both Claude and Codex with the same Ciclo MCP server so either harness sees the same control plane.
- Set \`mcp_server_name\` only when the project needs a non-default server id. Default is \`ciclo\`.
- Set \`mcp_command\` only when workers must run a non-default Ciclo binary or wrapper. Default is \`ciclo\`.
- Set \`mcp_claude_channel: true\` when a spawned Claude worker should expose Ciclo through Claude channel integration.
- Put only non-secret MCP server environment in \`mcp_env\`; use it for flags such as \`CICLO_REUSE_HERDR_SESSION\` or provider mode switches.
- Put secret-backed Ciclo MCP server environment in \`mcp_secret_env\`; Ciclo writes a runtime wrapper and resolves the values only for the generated Ciclo MCP subprocess.
- Put worker shell non-secret values in \`worker_env\`; project \`mcp.vars\` are inherited by worker shells automatically. Put credentials in \`worker_secret_env\` when Claude/Codex tools such as \`gh\`, \`git\`, or \`curl\` need them. Ciclo wraps the launched harness command so only the worker process tree receives secret variables.
- Put additional third-party MCP servers in \`mcp_additional_servers\` when the launched worker should receive more than Ciclo MCP. The object is keyed by server name; each value accepts \`command\`, \`args\`, and an environment map. Raw env values must be non-secret; values may include \`\${secret://provider-id/ref}\` placeholders that Ciclo converts into runtime wrappers for the target MCP server. Ciclo writes those servers into the generated \`.mcp.json\` and/or \`.codex/config.toml\` in the worker cwd or worktree without resolved secret values.

The generated config gives the worker Ciclo MCP tools, resources, prompts, enabled plugin capabilities, and configured additional MCP servers. Prefer \`.ciclo/config.json\` or launch payloads over manual generated-config edits so worktree and remote sessions stay reproducible.

Config file mapping: \`.ciclo/config.json\` uses \`mcp.clients\`, \`mcp.serverName\`, \`mcp.command\`, \`mcp.vars\`, \`mcp.additionalServers\`, \`mcp.secretBindings\`, \`mcp.workerSecretBindings\`, and \`mcp.claudeChannel\`; it uses \`secrets.providers\` for built-in and plugin-backed provider ids; it uses \`heartbeat.preemptiveWork.maxConcurrent\` for the maximum active preemptive worker sessions, defaulting to 10 when omitted; it uses \`remote\` for remote runner defaults; it uses \`prompts.systemInjections\` for non-secret goals and helper guidance appended to matching Ciclo prompts; it uses \`cron.jobs\` for scheduled heartbeat tasks; it uses \`memory\` for compaction, aging, archive, and compounding policy. Inline MCP tool arguments override config defaults for one launch. \`vars\`, prompt guidance, and raw additional server environment values are non-secret strings; additional server env values may include \`\${secret://provider-id/ref}\` placeholders; \`secretBindings\` and \`workerSecretBindings\` are provider references that Ciclo stores as runtime wrappers rather than resolved values.

Prompt guidance scopes are \`all\`, \`brain\`, \`worker\`, \`review\`, and \`beads\`. Use \`all\` for durable project goals, \`brain\` for control-plane decision preferences, \`worker\` for launched Claude/Codex execution hints, \`review\` for post-close verification expectations, and \`beads\` for Beads-derived task prompts. Ciclo appends these entries after its own ground rules and rejects secret references or secret-like values in prompt text.

Use \`mcp.secretBindings\` when the generated Ciclo MCP server config needs a secret-backed environment variable. The binding \`name\` becomes an env var resolved by the generated \`ciclo secret exec\` wrapper, and \`providerId\`/\`ref\` identify the configured provider reference to resolve. Add \`format\` when the env var needs a wrapper string such as \`Bearer \${secret}\`; formats must contain exactly one \`\${secret}\` placeholder. Provider ids can point at built-in providers or plugin-backed aliases from \`secrets.providers[].pluginProviderId\`. For additional MCP servers, keep raw env values non-secret or use \`\${secret://provider-id/ref}\` placeholders.

MCP server secret support has a strict boundary:

- Use \`mcp.secretBindings\` or launch-time \`mcp_secret_env\` only for secrets that should be injected into the generated \`ciclo\` MCP server subprocess.
- Use project \`mcp.vars\` or launch-time \`worker_env\` for non-secret values the worker shell itself needs. Use project \`mcp.workerSecretBindings\` or launch-time \`worker_secret_env\` for credentials.
- Keep raw additional MCP server environment values non-secret. Ciclo turns \`\${secret://provider-id/ref}\` placeholders into runtime wrappers for new sessions.
- For third-party MCP server credentials, prefer Ciclo placeholders, provider-native references, a wrapper command that fetches the secret at runtime, or task-scoped \`ciclo_request_secret\` calls from the worker.
- Never put raw secret values in \`mcp.vars\`, additional server environment maps, prompts, Beads notes, feedback, tracker sync, board output, or progress updates.

When operating as a worker, request secrets by reference:

1. Call \`ciclo_list_secret_providers\`.
2. Call \`ciclo_request_secret\` with \`provider_id\`, \`secret_ref\`, \`reason\`, and task scope (\`loop_id\`, \`bead_id\`, \`worker_session_id\`).
3. Prefer provider references such as OpenBao paths/fields, 1Password CLI \`op://\` references, or 1Password Connect \`op-connect://vault-uuid/item-uuid/field\` references; do not ask the operator to paste values.
4. Use the returned value only for the command that needs it, then avoid echoing it in validation output, Beads notes, feedback, tracker sync, or transcripts.

When the generated Ciclo MCP server needs a secret as an environment variable, use \`mcp_secret_env\` on \`ciclo_launch_worker_session\` instead of \`mcp_env\` or prompt text. When the worker shell needs the credential, use \`worker_secret_env\` instead. Each binding should include \`env_name\`, \`provider_id\`, \`secret_ref\`, optional \`field\`, optional \`format\`, and \`reason\`. Ciclo resolves the secret through the configured provider only inside the runtime wrapper for the intended process and redacts it from launch responses, worker-session listings, audit records, and events. The caller must be authorized for \`secret.read\`.

Ciclo reuses the active Herdr session when detected. Local Claude/Codex workers launched through Ciclo then run as visible Herdr agents, so the operator can attach to the overall Ciclo session and watch them. With \`isolation: "worktree"\`, local launches use fresh \`herdr worktree create\` workspaces and then start the agent inside the returned Herdr workspace id; Ciclo never passes the old \`cli:worktree:create\` placement sentinel to \`herdr agent start\`. Existing Herdr worktree paths fail instead of reopening stale workspace state. Direct launches outside Herdr use \`git worktree add\`. Ciclo starts launched harnesses in bypass mode by default: Claude Code gets \`permission_mode: "bypassPermissions"\` and Codex gets \`approval_policy: "never"\` with \`sandbox: "danger-full-access"\` unless the launch payload explicitly narrows them. Ciclo MCP also runs an internal heartbeat for sessions it owns; on startup, the first wake records that Ciclo should analyze repo, Beads, Herdr, PR/CI, remote, context, memory, cron, and worker state before choosing what to start first. The heartbeat evaluates due \`cron.jobs\`, runs memory compaction tasks, and records monologue/events while preserving project memory in \`.ciclo/memory.jsonl\`. Read \`ciclo://heartbeat\`, \`ciclo://events\`, \`ciclo://memory\`, \`ciclo://cron\`, or \`ciclo_status\` for its monologue, stalled-worker checks, scheduled runs, memory status, brain decisions, and Claude-channel communication status. Use \`ciclo_decide\` when a monitoring, context, question-answering, or operator-interface decision needs model-backed OpenAI judgment. If Herdr pane reuse is not wanted, start the MCP server with \`CICLO_REUSE_HERDR_SESSION=false\` to use direct process launches and repo-name fallback.

## Remote Pattern

- Use \`ciclo_attach_plan\` to show how the operator can attach to the overall Herdr session or a specific agent pane.
- Use \`ciclo_launch_remote_runner\` for Kubernetes, AWS Lambda MicroVM, Cloudflare, or plugin-provided runner kinds; dry-run first and review image resolution, repo bootstrap, WireGuard, Herdr target, repo path, generated remote MCP config, preflight report path, and provider commands.
- Prefer \`image_resolver.strategy: "variant"\` for official Nix dockerTools images (\`base-latest\`, \`codex-latest\`, \`claude-latest\`, \`full-latest\`) and \`image_resolver.strategy: "nixery"\` only when a private Nixery registry should compose package-path images dynamically.
- Use \`repo_bootstrap.use_devenv: true\` so Kubernetes runners clone/fetch the repository and run \`devenv shell -- true\` as the final project dependency check before preflight.
- Treat remote preflight failures as launch blockers when required checks fail. The default preflight checks Claude Code access with a tiny non-interactive prompt and checks Ciclo-like build tools such as Git, Node.js, npm, Ciclo, Herdr, SSH, WireGuard, Beads, \`just\`, and \`devenv\`; only set \`preflight.claude: false\` when the operator explicitly wants to skip Claude access validation.
- Use \`preflight_only: true\` when validating image/devenv/Claude readiness without starting WireGuard or Herdr. For live Kubernetes launches, use \`wireguard.existing_config_secret_name\` or resolved key material; do not accept unresolved \`\${secret:...}\` placeholders in \`runner.conf\`.
- Keep remote MCP setup enabled unless the remote image already installs Ciclo MCP. The response \`mcp_config\` includes \`.mcp.json\` and/or \`.codex/config.toml\` artifacts for the remote repo plus a remote \`ciclo mcp install\` command for merge-based setup. Project \`mcp.additionalServers\` and per-launch \`mcp_additional_servers\` are rendered into those remote artifacts so the spawned Claude/Codex session sees the same extra MCP servers as a local worktree worker.
- Use \`ciclo_register_remote_session\`, \`ciclo_heartbeat_remote_session\`, and \`ciclo_detach_remote_session\` for already-running remote Ciclo/Herdr/harness sessions.
- Remote observation must go through Herdr remote attach over SSH. Do not supervise remote work by inventing direct SSH process polling.
- Treat remote attach failure, missing Herdr, stale heartbeat, or project path mismatch as a blocker to surface through \`ciclo_report_feedback\` or \`ciclo_ask_operator\`.

## Closeout Pattern

Before closeout:

1. Record validation with \`ciclo_update_work\` using \`kind: "validation"\`.
2. Record any remaining blocker or follow-up with \`ciclo_update_work\`, or create follow-up Beads work when needed.
3. Call \`ciclo_close_work\` with final summary, acceptance evidence, and validation evidence. Ciclo launches a review worker by default; use \`review_dry_run: true\` to inspect the plan or \`launch_review: false\` only when approved.
4. Monitor the review worker with \`ciclo_poll_events\`, \`ciclo_board\`, or \`ciclo_list_worker_sessions\`; review workers should leave comments with \`ciclo_report_feedback\` and validation updates with \`ciclo_update_work\`.
5. If tracker sync is configured and approved, call \`ciclo_sync_remote_trackers\`.

## Detailed Reference

Read \`references/mcp-workflows.md\` when you need tool payload examples, resource names, remote runner flow, device auth, or the recommended first prompt for a Claude/Codex session.
`;

const CODEX_WORKFLOWS = `# Ciclo MCP Workflows

## Operator Session Prompt

Use this when starting Claude or Codex in a project that has Ciclo MCP installed:

\`\`\`text
Use Ciclo MCP as the control plane for this repository. Start by reading Ciclo status and ready work. Claim Beads work through Ciclo, ask operator questions through Ciclo, launch worker sessions through Ciclo when useful, and use \`ciclo_decide\` for model-backed OpenAI decisions about remote monitoring, context insertion, answerable questions, and controlling-session feedback. Report progress and validation evidence through Ciclo, and close work only through Ciclo after acceptance evidence is present. After close, monitor the Ciclo-launched review worker and surface its feedback to the operator.
\`\`\`

## Common Tool Order

1. \`ciclo_status\` or \`ciclo://status\`
2. \`ciclo_whoami\` or \`ciclo://users/me\`
3. \`ciclo_list_ready_work\`
4. \`ciclo_claim_work\`
5. \`ciclo_update_work\`
6. \`ciclo_launch_worker_session\` when another Claude/Codex process should do bounded work
7. \`ciclo_heartbeat_worker_session\` from active workers with liveness, token, and cost deltas
8. \`ciclo_poll_events\` and \`ciclo_board\` while monitoring active work
9. \`ciclo_decide\` when monitoring, context, answerable-question, or operator-interface judgment is needed
10. \`ciclo_board\` with \`expected_pr_after_ms\` for PR-producing fan-out loops
11. \`ciclo_list_secret_providers\` and \`ciclo_request_secret\` when a task has an approved secret reference
12. \`ciclo_ask_operator\` when blocked
13. \`ciclo_report_feedback\` for review findings and warnings
14. \`ciclo_close_work\`; successful closes launch a bounded review worker by default
15. \`ciclo_poll_events\`, \`ciclo_board\`, or \`ciclo_list_worker_sessions\` to monitor the post-close review worker
16. \`ciclo_sync_remote_trackers\` only when configured and approved

## Status And Context Resources

- \`ciclo://status\`: overall loops, Beads, Herdr, remotes, sync, and access state.
- \`ciclo://loops\`: loop summaries.
- \`ciclo://loops/{loop_id}\`: detailed loop state.
- \`ciclo://work/ready\`: ready Beads work.
- \`ciclo://work/{bead_id}\`: work context and Ciclo audit state.
- \`ciclo://questions\`: pending operator or agent questions.
- \`ciclo://feedback\`: queued feedback.
- \`ciclo://worker-sessions\`: Ciclo-managed worker lifecycle state.
- \`ciclo://remote-sessions\`: registered remote sessions.
- \`ciclo://remote-runners\`: remote runner plans.
- \`ciclo://secret-providers\`: configured secret providers without secret material.
- \`ciclo://session/access\`: access mode and grants.
- \`ciclo://users/me\`: current principal.

## MCP And Skill Install

Use the installer instead of hand-editing client config:

\`\`\`bash
ciclo mcp install --client all --project "$(pwd)" --dry-run --compact
ciclo skill install --client all --project "$(pwd)" --dry-run --compact
ciclo mcp install --client all --project "$(pwd)"
ciclo skill install --client all --project "$(pwd)"
\`\`\`

Use \`--client claude\` or \`--client codex\` for a single client. Use \`--server-name\`, \`--command\`, and Claude channel options only when the operator requests a non-default MCP server id, binary path, or channel integration. Restart the client session when tools, resources, prompts, or skills do not hot-reload.

## Plugin Management

Use the CLI for third-party plugin lifecycle:

\`\`\`bash
ciclo plugin list --compact
ciclo plugin install <package> --trust
ciclo plugin install <package> --path <local-package-dir> --trust
ciclo plugin enable <package>
ciclo plugin disable <package>
\`\`\`

Only install or trust a plugin after the operator approves the package source and behavior. External plugins must include \`ciclo.plugin.json\` and export \`activate(api)\`. Plugins can add remote runner kinds and secret provider kinds; after enabling one, re-read \`ciclo_status\`, \`ciclo_list_remote_runners\`, or \`ciclo_list_secret_providers\`.

Plugin-backed secret providers can be aliased from project config:

\`\`\`json
{
  "secrets": {
    "providers": [
      {
        "id": "team-keychain",
        "kind": "keychain",
        "name": "Team Keychain",
        "pluginProviderId": "keychain-test"
      }
    ]
  }
}
\`\`\`

The configured \`id\` is what workers and operators pass to \`ciclo_request_secret\`; \`pluginProviderId\` is the provider id registered by the trusted installed plugin. Ciclo delegates the read to the plugin provider, returns the value only to the authorized caller, and keeps audit/events limited to provider ids, kinds, field names, and secret reference hashes.

## Worker Launch Example

Always dry-run first:

\`\`\`json
{
  "harness_id": "codex",
  "loop_id": "review-loop",
  "bead_id": "project-123",
  "model": "gpt-5.5",
  "extra_args": ["--profile", "review"],
  "isolation": "worktree",
  "configure_mcp": true,
  "mcp_clients": ["codex"],
  "mcp_secret_env": [
    {
      "env_name": "API_TOKEN",
      "provider_id": "onepassword",
      "secret_ref": "op://Ciclo/API/token",
      "reason": "worker MCP server needs the API token"
    }
  ],
  "prompt": "Use Ciclo MCP as the control plane. Work only on project-123. Report progress, blockers, validation, and final summary through Ciclo.",
  "dry_run": true
}
\`\`\`

After operator approval, send the same payload with \`dry_run: false\`. Use \`extra_args\` for harness-specific CLI flags, \`configure_mcp: true\` to install Ciclo MCP config into the worker cwd or worktree before launch, and \`isolation: "worktree"\` when the worker should run in an isolated git worktree. Ciclo resolves a default sibling worktree path unless \`worktree_path\` is provided and defaults bead branches to \`ciclo/<bead-id>\`. When Ciclo is inside Herdr, worktree-isolated local launches use fresh \`herdr worktree create\` workspaces and start the agent inside the returned Herdr workspace id; existing Herdr worktree paths fail instead of reopening stale workspace state.

For Claude Code workers, \`model\` may be \`claude-fable-5\`, \`fable 5\`, \`Fable 5\`, or \`claude fable 5\`; Ciclo normalizes those aliases to \`claude-fable-5\` before launching Claude. Other model ids pass through unchanged.

## Spawned Session MCP Configuration

Use worker launch fields to control the MCP surface available inside spawned Claude and Codex sessions:

Repository defaults can be stored in \`.ciclo/config.json\`. Use:

\`\`\`bash
ciclo config init --project "$(pwd)"
ciclo config show --project "$(pwd)" --compact
\`\`\`

The file can define \`secrets.providers\`, \`mcp.clients\`, \`mcp.serverName\`, \`mcp.command\`, \`mcp.vars\`, \`mcp.additionalServers\`, \`mcp.secretBindings\`, \`mcp.workerSecretBindings\`, \`mcp.claudeChannel\`, \`prompts.systemInjections\`, \`cron.jobs\`, \`memory\`, and \`remote\` defaults. \`ciclo mcp install\`, MCP startup, spawned workers, prompt builders, cron scheduling, memory compaction, and remote runner planning read it. Explicit tool payload fields override config defaults. Use \`examples/ciclo-config.json\` in the Ciclo repository as the reference shape. It includes OpenBao, 1Password CLI, 1Password Connect, and plugin-backed providers, additional third-party MCP servers, worker MCP secret bindings, prompt guidance, cron jobs, memory policy, WireGuard tunnel fields, and Kubernetes/AWS Lambda MicroVM/Cloudflare runner blocks.

Project-level additional MCP servers are configured under \`mcp.additionalServers\`:

\`\`\`json
{
  "mcp": {
    "clients": ["claude", "codex"],
    "additionalServers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
        "env": {
          "MCP_FS_MODE": "workspace"
        }
      }
    }
  }
}
\`\`\`

These entries are not Ciclo plugins and do not add tools to the Ciclo control plane. They are copied into the launched worker's Claude/Codex MCP config so that worker session can call those third-party MCP servers directly. Keep raw environment values non-secret. When a third-party server needs a Ciclo-managed secret, use a placeholder such as \`Bearer \${secret://team-1password/Ciclo/API/token}\` in the env value; Ciclo converts it into a \`ciclo secret exec\` runtime wrapper so only that server subprocess receives the resolved value. The placeholder host is the provider id, the path is the provider secret reference, and \`?field=token\` or \`#token\` selects a field.

### MCP Server Secret Support

Ciclo supports secret-backed environment variables for the generated \`ciclo\` MCP server entry, supports worker process secret variables, and supports \`\${secret://provider-id/ref}\` replacements inside additional MCP server environment values. Generated config stores runtime wrappers and provider references, not resolved values.

Use this path when the Ciclo MCP server itself needs credentials or when a worker should receive a secret through Ciclo's controlled MCP surface:

- Project defaults: \`mcp.secretBindings[]\` in \`.ciclo/config.json\`.
- One-off Ciclo MCP server overrides: \`mcp_secret_env[]\` in \`ciclo_launch_worker_session\`.
- Project worker shell defaults: \`mcp.workerSecretBindings[]\` in \`.ciclo/config.json\`.
- One-off worker shell overrides: \`worker_secret_env[]\` in \`ciclo_launch_worker_session\`.
- Required fields: \`name\` or \`env_name\`, \`providerId\` or \`provider_id\`, and \`ref\` or \`secret_ref\`.
- Optional fields: \`field\`, \`format\`, and \`reason\`.
- \`format\` must contain exactly one \`\${secret}\` placeholder and is applied only after the provider returns the value.
- Dry runs do not resolve the provider value. Non-dry-run installs and launches require \`secret.read\` authorization before writing runtime wrappers.

Use \`mcp.secretBindings\` when the generated Ciclo MCP server entry itself needs secret-backed environment variables. The binding name becomes an env var resolved by the generated \`ciclo secret exec\` wrapper; the secret value is only visible to the Ciclo MCP server subprocess. Add \`format\` when the target variable needs a wrapper string, such as \`Bearer \${secret}\`; the format must contain exactly one \`\${secret}\` placeholder.

\`\`\`json
{
  "secrets": {
    "providers": [
      {
        "id": "team-keychain",
        "kind": "keychain",
        "name": "Team Keychain",
        "pluginProviderId": "keychain-test"
      }
    ]
  },
  "mcp": {
    "clients": ["claude", "codex"],
    "secretBindings": [
      {
        "name": "PLUGIN_BACKED_API_TOKEN",
        "providerId": "team-keychain",
        "ref": "keychain://ciclo/example-api-token",
        "format": "Bearer \${secret}",
        "reason": "provide task-scoped API access to the Ciclo MCP server"
      }
    ]
  }
}
\`\`\`

The generated Claude config shape is equivalent to:

\`\`\`json
{
  "mcpServers": {
    "ciclo": {
      "command": "ciclo",
      "args": ["mcp", "stdio"],
      "env": {
        "CICLO_PROJECT_ROOT": "/path/to/project",
        "PLUGIN_BACKED_API_TOKEN": "Bearer <resolved by Ciclo at install or launch>"
      }
    }
  }
}
\`\`\`

Do not put the secret value into \`mcp.vars\`, additional MCP server environment maps, prompt text, Beads notes, or tracker sync. Treat \`format\` as a template, not a place for another secret. If a third-party MCP server needs a token directly, prefer that server's native secret-reference support or a wrapper command that obtains the token without writing it into project config. Another valid pattern is for the spawned worker to call \`ciclo_request_secret\` for task-scoped use and avoid injecting that credential into the third-party server.

\`\`\`json
{
  "harness_id": "claude-code",
  "loop_id": "review-loop",
  "bead_id": "project-789",
  "prompt": "Use Ciclo MCP. Inspect project-789 and report validation.",
  "configure_mcp": true,
  "mcp_clients": ["claude"],
  "mcp_server_name": "ciclo",
  "mcp_command": "ciclo",
  "mcp_claude_channel": true,
  "mcp_env": {
    "CICLO_REUSE_HERDR_SESSION": "true"
  },
  "mcp_additional_servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": {
        "MCP_FS_MODE": "worker"
      }
    }
  },
  "mcp_secret_env": [
    {
      "env_name": "OPENBAO_TOKEN",
      "provider_id": "openbao",
      "secret_ref": "secret/data/ciclo/mcp",
      "field": "token",
      "format": "Bearer \${secret}",
      "reason": "spawned worker MCP tools need OpenBao-backed task credentials"
    }
  ],
  "dry_run": true
}
\`\`\`

Field behavior:

- \`configure_mcp: true\` installs the Ciclo MCP server into the worker cwd or generated worktree before the harness starts.
- \`mcp_clients\` chooses which client config files to write. Use \`["claude"]\`, \`["codex"]\`, or both. When omitted, Ciclo uses the launched \`harness_id\`.
- \`mcp_server_name\` changes the server id written into Claude or Codex config; leave it as \`ciclo\` unless the operator needs multiple Ciclo servers.
- \`mcp_command\` changes the command the spawned client runs for Ciclo MCP; use it for wrappers or non-standard installs.
- \`mcp_claude_channel\` enables Claude channel integration for spawned Claude sessions.
- \`mcp_env\` writes non-secret environment variables into the generated Ciclo MCP server config.
- \`mcp_additional_servers\` writes extra third-party MCP server entries into the launched worker config. The object is keyed by server name; values accept \`command\`, \`args\`, and \`env\`. Raw env values must be non-secret; values may include \`\${secret://provider-id/ref}\` placeholders that Ciclo turns into runtime wrappers. Per-launch entries override project config entries with the same name.
- \`mcp_secret_env\` writes runtime-wrapped secret-backed environment variables for the generated Ciclo MCP server. Ciclo resolves each binding through \`provider_id\`, \`secret_ref\`, and optional \`field\` only when that server subprocess starts; optional \`format\` wraps the resolved value and must contain exactly one \`\${secret}\` placeholder; the response and audit trail stay redacted.
- \`worker_secret_env\` wraps the launched Claude/Codex harness process when shell tools need credentials. Use this for \`gh\`, \`git\`, \`curl\`, deploy CLIs, or other commands run by the agent shell.

The installer-generated MCP config exposes Ciclo's MCP tools, resources, prompts, and enabled plugin capabilities to the spawned worker. If the worker needs unrelated third-party MCP servers, install those servers into the target project through their own installer before launching, or expose the capability through a Ciclo plugin that the worker can reach via Ciclo MCP. Avoid manual edits to generated worker config; they are hard to reproduce across worktrees and remote runners.

Use \`mcp_env\` only for non-secret variables needed by the generated Ciclo MCP server. Use \`worker_env\` for non-secret variables needed by the launched worker shell; project \`mcp.vars\` are delivered to both by default. Use \`mcp_secret_env\` when the generated Ciclo MCP server needs a secret; use \`worker_secret_env\` when the launched worker shell needs a secret. The caller needs \`secret.read\`. Do not use \`mcp_secret_env\` to target additional MCP servers; put \`\${secret://provider-id/ref}\` placeholders in those server env values when Ciclo should provide the secret at server startup.

Heartbeat while working:

\`\`\`json
{
  "worker_session_id": "worker-123",
  "state": "running",
  "input_tokens": 1200,
  "output_tokens": 450,
  "cost_usd": 0.06,
  "evidence": ["validation:unit-tests-pending"]
}
\`\`\`

## Secret Request Example

Use this when a task has an approved secret reference. Do not ask the operator to paste the secret value. Prefer provider references such as OpenBao paths/fields, 1Password CLI \`op://\` references, or 1Password Connect \`op-connect://vault-uuid/item-uuid/field\` references.

\`\`\`json
{
  "provider_id": "onepassword",
  "secret_ref": "op://Ciclo/API/token",
  "loop_id": "deploy-loop",
  "bead_id": "project-456",
  "worker_session_id": "worker-123",
  "reason": "deployment smoke test needs the API token",
  "dry_run": false
}
\`\`\`

Call \`ciclo_list_secret_providers\` first if the provider id is unknown. Use the returned value only for the command that needs it, and do not echo it in notes, validation output, feedback, transcripts, or tracker sync.

## Remote Runner Example

Use \`ciclo_launch_remote_runner\` for planning remote runnable environments. Provider execution remains policy-gated, and remote observation must go through Herdr remote attach over SSH.

\`\`\`json
{
  "runner_kind": "kubernetes",
  "runner_id": "runner-k8s-1",
  "loop_id": "review-loop",
  "bead_id": "project-remote-1",
  "harness_id": "codex",
  "image_resolver": {
    "strategy": "variant",
    "repository": "smol-platform/ciclo",
    "tag": "latest"
  },
  "repo_url": "https://github.com/smol-platform/project.git",
  "repo_path": "/workspace/project",
  "prompt": "Use Ciclo MCP and report progress.",
  "dry_run": true
}
\`\`\`

Review the returned provider commands, image resolution, repo bootstrap, WireGuard config, Herdr target, remote \`mcp_config\`, \`preflight\`, and \`attach\` plan before proceeding. \`mcp_config\` contains generated \`.mcp.json\` and/or \`.codex/config.toml\` artifacts for the remote \`repo_path\`; use its install command inside the runner when the remote checkout needs to merge with existing MCP client config. Project \`mcp.additionalServers\` and per-launch \`mcp_additional_servers\` are included in those remote artifacts, so the remote worker receives the same extra third-party MCP servers as a local launched worktree. Kubernetes runners clone/fetch the repo, run project \`devenv\` when present, and mount/run the preflight script before WireGuard setup, so pod logs show missing Claude access or build-tool gaps early.

## Remote Session Example

For an already-running remote Ciclo, Herdr, or harness session, register and heartbeat the session instead of claiming the same Beads work locally:

\`\`\`json
{
  "remote_session_id": "remote-build-1",
  "herdr_target": "builder-1",
  "repo_path": "/workspace/project",
  "harness_id": "codex",
  "loop_id": "review-loop",
  "bead_id": "project-remote-1"
}
\`\`\`

Use \`ciclo_heartbeat_remote_session\` for liveness and \`ciclo_detach_remote_session\` when the remote worker is paused, lost, or retired. Treat remote attach failure, missing Herdr, stale heartbeat, or project path mismatch as operator-visible feedback or a blocking question.

## Close Work Example

\`\`\`json
{
  "bead_id": "project-123",
  "final_summary": "Implemented the requested change and updated focused tests.",
  "acceptance_evidence": ["Requested behavior is implemented."],
  "validation_evidence": [
    {
      "command": "npm run check",
      "passed": true
    }
  ]
}
\`\`\`

## Fallback When MCP Is Missing

If Ciclo MCP tools are unavailable:

1. Verify Ciclo is installed: \`ciclo --version\`.
2. Dry-run project installs: \`ciclo mcp install --client all --project "$(pwd)" --dry-run --compact\` and \`ciclo skill install --client all --project "$(pwd)" --dry-run --compact\`.
3. Install for the active clients with \`ciclo mcp install --client all --project "$(pwd)"\` and \`ciclo skill install --client all --project "$(pwd)"\`.
4. Restart the client session if it does not hot-reload MCP config or project skills.

Do not emulate Ciclo MCP by editing Ciclo state files directly.
`;

const CODEX_OPENAI_AGENT = `interface:
  display_name: "Ciclo MCP"
  short_description: "Use Ciclo MCP as the control plane for Claude and Codex work."
  default_prompt: "Use Ciclo MCP to inspect status, claim work, ask questions, launch workers, and close work with validation evidence."
`;

const RELEASE_SKILL = [
  "---",
  "name: release",
  "description: \"Use when the user invokes /release or asks Claude or Codex to cut a repository release: update local state from remote, run release gates, create a new git tag, publish the branch and tag to the remote, and create a GitHub release with gh.\"",
  "---",
  "",
  "# Release",
  "",
  "Use this skill to publish a GitHub-backed repository release. A direct `/release` request grants authority to fetch, fast-forward the local branch, create a tag, publish the current release branch and tag, and create a GitHub release when the target version and branch are unambiguous. Do not force-publish, rewrite tags, bypass gates, or publish from a dirty worktree.",
  "",
  "## Workflow",
  "",
  "1. Establish the release target.",
  "   - Prefer an explicit tag from the user, such as `/release v0.2.0`.",
  "   - If no tag is supplied, derive it from the repository canonical version file only when obvious, such as `package.json`, `pyproject.toml`, or an existing project version module.",
  "   - Normalize release tags to the repository convention. If the repo has existing `v*` tags, use `v<version>`.",
  "   - Stop and ask when the tag, release branch, prerelease status, or notes source is unclear.",
  "",
  "2. Verify local and remote state before changing anything.",
  "   ```bash",
  "   git status --short",
  "   git remote -v",
  "   git branch --show-current",
  "   git fetch --tags --prune origin",
  "   git pull --ff-only origin \"$(git branch --show-current)\"",
  "   git status --short",
  "   ```",
  "   Stop if the worktree is dirty, the branch cannot fast-forward, the remote is missing, or the user is not on the intended release branch.",
  "",
  "3. Check that the tag is new.",
  "   ```bash",
  "   git rev-parse -q --verify \"refs/tags/<tag>\"",
  "   git ls-remote --tags origin \"<tag>\"",
  "   ```",
  "   Stop if either command finds the tag. Never delete or move an existing release tag unless the user explicitly asks for repair and approves the exact risk.",
  "",
  "4. Run the repository release gate.",
  "   - Use the repo documented full gate first, such as `just check`, `devenv shell ciclo-check`, `npm test`, or the release instructions in project docs.",
  "   - If no gate is documented, run the narrowest build/test commands that prove the package can be released.",
  "   - Stop on any failure and report the failing command.",
  "",
  "5. Create and publish the release.",
  "   ```bash",
  "   git tag -a \"<tag>\" -m \"Release <tag>\"",
  "   git \\",
  "     push origin \"$(git branch --show-current)\"",
  "   git \\",
  "     push origin \"<tag>\"",
  "   gh release create \"<tag>\" --target \"$(git branch --show-current)\" --title \"Release <tag>\" --generate-notes",
  "   gh release view \"<tag>\" --json url,tagName,isDraft,isPrerelease",
  "   ```",
  "   Use `--prerelease` only when the tag or user request clearly indicates a prerelease. Use `--draft` only when requested.",
  "",
  "6. Report the result.",
  "   - Include the tag, branch, validation command and result, published remote, and GitHub release URL.",
  "   - Include any local changes still present after release. There should normally be none.",
  "",
  "## Safety Rules",
  "",
  "- Do not release from a dirty worktree.",
  "- Do not create a release from unpublished or unvalidated changes unless the user explicitly confirms that this is the release branch state.",
  "- Do not use forced publishing, `git tag -f`, `gh release delete`, or tag deletion in normal release flow.",
  "- Do not paste tokens or credentials into commands. If `gh` is not authenticated, stop and ask the user to authenticate.",
  "- If this repo uses Beads, close only release-specific work that was actually completed and include release validation evidence."
].join("\n");

const RELEASE_OPENAI_AGENT = `interface:
  display_name: "Release"
  short_description: "Cut tags and publish GitHub releases"
  default_prompt: "Use $release to cut a repository tag, publish it, and create a GitHub release."
`;

const CLAUDE_RELEASE_COMMAND = [
  "Use the release skill to cut and publish a GitHub release.",
  "",
  "If the user supplied arguments after `/release`, treat them as the requested tag, prerelease/draft flags, or release-note instructions. Follow the release skill exactly: update local state from remote, require a clean worktree, run the release gate, create a new annotated tag, publish the branch and tag to origin, create the GitHub release with `gh release create`, verify it with `gh release view`, and report the release URL."
].join("\n");

const CLAUDE_SKILL = `---
name: ciclo-mcp
description: "Use Ciclo MCP as the control plane for Claude-driven repository work: status, Beads work, worker launches with MCP config, Herdr panes, worktrees, remote runners, secret providers, event/board monitoring, tracker sync, and closeout evidence."
---

# Ciclo MCP

Use Ciclo MCP whenever this project asks Claude to drive work through Ciclo.

## Workflow

1. Read \`ciclo_status\` or \`ciclo://status\`.
2. Read \`ciclo_whoami\` or \`ciclo://users/me\` when identity or access matters.
3. Select work with \`ciclo_list_ready_work\`.
4. Claim with \`ciclo_claim_work\` before implementation.
5. Record progress, blockers, validation, and final summaries with \`ciclo_update_work\`.
6. Launch Claude/Codex workers through \`ciclo_launch_worker_session\`; dry-run first and use \`configure_mcp: true\` unless MCP is already installed in the worker cwd.
7. Monitor with \`ciclo_poll_events\`, \`ciclo_board\`, \`ciclo_list_worker_sessions\`, or \`ciclo://worker-sessions\`.
8. Heartbeat active workers with \`ciclo_heartbeat_worker_session\` when operating as the worker.
9. Ask blocked questions with \`ciclo_ask_operator\`; answer only through \`ciclo_answer_question\` when authorized.
10. Request configured secrets through \`ciclo_request_secret\`, never by pasting values into chat.
11. For PR-producing fan-out loops, call \`ciclo_board\` with \`expected_pr_after_ms\` and treat \`expected_pr_missing\` as a blocker.
12. Close with \`ciclo_close_work\` only after acceptance and validation evidence; successful closes launch a bounded review worker by default.
13. Monitor the post-close review worker and surface its \`ciclo_report_feedback\`, validation updates, or blockers to the operator.

## Install Or Refresh

\`\`\`bash
ciclo mcp install --client all --project "$(pwd)"
ciclo skill install --client all --project "$(pwd)"
\`\`\`

Dry-run first when you are not sure what files will change:

\`\`\`bash
ciclo mcp install --client all --project "$(pwd)" --dry-run --compact
ciclo skill install --client all --project "$(pwd)" --dry-run --compact
\`\`\`

MCP install writes project config for Claude and/or Codex. Use \`--client claude\`, \`--client codex\`, or \`--client all\`; use \`--server-name\` and \`--command\` only when the project needs a non-default Ciclo binary or server id. Restart the client if tools or skills do not hot-reload.

## Plugins

Use the CLI for third-party plugins:

\`\`\`bash
ciclo plugin list --compact
ciclo plugin install <package> --trust
ciclo plugin install <package> --path <local-package-dir> --trust
ciclo plugin enable <package>
ciclo plugin disable <package>
\`\`\`

Only trust plugins after the operator accepts the package source and behavior. External plugins must include \`ciclo.plugin.json\` and export \`activate(api)\`. Plugins can register remote runner kinds and secret provider kinds; after enabling a plugin, re-check \`ciclo_status\`, \`ciclo_list_remote_runners\`, or \`ciclo_list_secret_providers\` before using it. Project config can alias plugin-backed secret providers with \`secrets.providers[].pluginProviderId\`; use the configured \`id\` in \`ciclo_request_secret\`.

## Feature Map

- Status and identity: \`ciclo_status\`, \`ciclo_whoami\`, \`ciclo://status\`, \`ciclo://users/me\`.
- Work control: \`ciclo_list_ready_work\`, \`ciclo_claim_work\`, \`ciclo_update_work\`, \`ciclo_close_work\`; use \`review_dry_run\`, \`review_harness_id\`, or \`launch_review: false\` to control post-close review.
- Brain decisions: \`ciclo_decide\` routes remote monitoring, context insertion, answerable questions, and user-session interface decisions through Ciclo's model-backed OpenAI brain via Pi.
- Worker sessions: \`ciclo_launch_worker_session\`, \`ciclo_heartbeat_worker_session\`, \`ciclo_list_worker_sessions\`, \`ciclo_stop_worker_session\`.
- Worker launch options: \`configure_mcp: true\`, \`mcp_clients\`, \`mcp_server_name\`, \`mcp_command\`, \`mcp_env\`, \`mcp_secret_env\`, \`mcp_claude_channel\`, \`extra_args\`, \`isolation: "worktree"\`, model/effort/sandbox/approval settings.
- Claude Code model aliases: \`fable 5\`, \`Fable 5\`, and \`claude fable 5\` normalize to \`claude-fable-5\`.
- Monitoring: \`ciclo_poll_events\`, \`ciclo_board\`, \`ciclo://events\`, \`ciclo://board\`; tell terminal operators to use \`ciclo events --follow\`.
- Cron and memory: \`ciclo_remember\`, \`ciclo_list_memories\`, \`ciclo_compact_memories\`, \`ciclo_list_cron_jobs\`, \`ciclo_run_due_cron\`, \`ciclo://memory\`, and \`ciclo://cron\`.
- Operator routing: \`ciclo_ask_operator\`, \`ciclo_answer_question\`, \`ciclo_report_feedback\`.
- Secrets: \`ciclo_list_secret_providers\`, \`ciclo_request_secret\`, \`ciclo://secret-providers\`.
- Remote runners: \`ciclo_launch_remote_runner\`, \`ciclo_list_remote_runners\`, \`ciclo_attach_plan\`, \`ciclo://remote-runners\`.
- Tracker sync: \`ciclo_sync_remote_trackers\` only when Beads-native Jira/Linear sync is configured and authorized.

## Rules

- Keep the current Claude session operator-facing; ask Ciclo to launch bounded workers for implementation.
- Dry-run worker launches first; include \`configure_mcp: true\` unless the worker already has project MCP config, include \`extra_args\` for harness-specific flags, and prefer \`isolation: "worktree"\` when the worker should run in an isolated git worktree.
- Use \`.ciclo/config.json\` for shared secret-provider, MCP, prompt-guidance, and remote-runner defaults. Inspect it with \`ciclo config show --compact\`; create a starter file with \`ciclo config init\`. Explicit MCP tool arguments override config defaults.
- Put non-secret project goals or helper information in \`prompts.systemInjections\` with scope \`all\`, \`brain\`, \`worker\`, \`review\`, or \`beads\`. Ciclo appends matching entries after its own ground rules for OpenAI brain decisions, worker launches, review sessions, remote prompts, and Beads-derived harness prompts; secret references and secret-like values are rejected.
- Use \`ciclo launch codex\` or \`ciclo launch claude\` when the operator wants a ready-to-go local Herdr session with Ciclo MCP and configured additional MCP servers installed before the harness starts. The default session and first pane are named for the project, and the launched harness starts in bypass permission mode unless explicitly narrowed. Use \`--session\`, \`--pane-name\`, \`--no-attach\`, or \`--terminal\` only when the operator needs a different shape. Dry-run with \`ciclo launch codex --dry-run --compact\` to inspect the redacted install plan, Herdr command, and harness command.
- Configure spawned worker MCP tools through \`ciclo_launch_worker_session\`: use \`mcp_clients\` only when narrowing or expanding the default Claude+Codex shared Ciclo MCP config, \`mcp_server_name\` for a non-default Ciclo server id, \`mcp_command\` for a non-default Ciclo binary or wrapper, \`mcp_env\` for non-secret MCP server env, \`worker_env\` for non-secret launched-agent shell env, \`mcp_secret_env\` for secret-backed Ciclo MCP server env, \`worker_secret_env\` for credentials needed by the launched agent shell, and \`mcp_claude_channel\` for Claude channel integration.
- Configure additional third-party MCP servers for launched worktrees or remote sessions with project \`mcp.additionalServers\` or per-launch \`mcp_additional_servers\`. Each server is keyed by name and accepts \`command\`, \`args\`, and an environment map; raw values must be non-secret, but values may include \`\${secret://provider-id/ref}\` placeholders that Ciclo converts into runtime wrappers in generated \`.mcp.json\` and/or \`.codex/config.toml\` for the new session.
- Use \`mcp.secretBindings\` in \`.ciclo/config.json\` when the generated Ciclo MCP server config needs secret-backed environment variables; use \`mcp.workerSecretBindings\` for credentials needed by the launched worker shell. Provider ids can point at built-in providers or plugin-backed aliases from \`secrets.providers[].pluginProviderId\`; optional \`format\` can wrap a resolved value and must contain exactly one \`\${secret}\` placeholder. Ciclo writes runtime wrappers, not resolved values, into generated config.
- Treat \`mcp_secret_env\` and \`mcp.secretBindings\` as secret injection for the generated \`ciclo\` MCP server subprocess only. Use \`mcp.vars\` or \`worker_env\` for non-secret worker shell values, and use \`mcp.workerSecretBindings\` or \`worker_secret_env\` when \`gh\`, \`git\`, \`curl\`, or other worker shell tools need credentials. For third-party MCP server credentials, use \`\${secret://provider-id/ref}\` env placeholders, provider-native references, wrapper commands, or task-scoped \`ciclo_request_secret\`; do not place raw values in additional server environment maps.
- The generated MCP config gives workers Ciclo tools, resources, prompts, enabled plugin capabilities, and any configured additional MCP servers. Prefer config or launch payloads over manual generated-config edits so worktree and remote sessions stay reproducible.
- When Ciclo MCP is running inside Herdr, local Claude/Codex workers launch as visible Herdr agents by default. With \`isolation: "worktree"\`, Ciclo uses fresh \`herdr worktree create\` workspaces and starts the agent inside the returned Herdr workspace id; existing Herdr worktree paths fail instead of reopening stale workspace state. Launched harnesses default to bypass permission mode: Claude Code receives \`bypassPermissions\`, and Codex receives \`approval_policy: "never"\` with \`sandbox: "danger-full-access"\`; explicitly pass narrower values when a worker should be constrained. Ciclo MCP runs an internal heartbeat for sessions it owns; on startup, the first wake records repo/Beads/Herdr/PR/CI/context analysis before choosing first work. Read \`ciclo://heartbeat\`, \`ciclo://events\`, or \`ciclo_status\` for its monologue, stalled-worker checks, brain decisions, and Claude-channel communication status. Use \`ciclo_decide\` when a monitoring, context, question-answering, or operator-interface decision needs model-backed OpenAI judgment. Set \`CICLO_REUSE_HERDR_SESSION=false\` before starting MCP only when direct process launches are required.
- Use Beads IDs in mutating calls.
- Do not edit \`.beads/issues.jsonl\` or bypass Ciclo for claims/closeout.
- Use \`ciclo_report_feedback\` for findings and warnings.
- Use \`ciclo_sync_remote_trackers\` only when Beads-native tracker sync is configured and authorized.
- Use \`ciclo_list_secret_providers\` and \`ciclo_request_secret\` for configured secret references; ask the operator only when the provider, reference, or authorization is missing.
- Prefer provider references such as OpenBao paths/fields, 1Password CLI \`op://\` references, or 1Password Connect \`op-connect://vault-uuid/item-uuid/field\` references; never paste secret values into Beads, tracker sync, feedback, progress notes, or transcripts.
- Use \`mcp_secret_env\` on \`ciclo_launch_worker_session\` when the generated Ciclo MCP server needs a secret environment variable; use \`worker_secret_env\` when the launched agent shell needs credentials; use optional \`format\` such as \`Bearer \${secret}\` only when the target variable needs a wrapper string; do not put secret values in \`mcp_env\`, prompts, or notes.
- For remote work, use \`ciclo_attach_plan\`, \`ciclo_launch_remote_runner\`, and remote session registration/heartbeat/detach tools; remote observation must go through Herdr remote attach over SSH. Review \`image_resolution\`, \`repo_bootstrap\`, \`preflight\`, and WireGuard evidence before launch. Keep remote MCP setup enabled unless the remote image already installs Ciclo MCP; \`mcp_config\` includes generated \`.mcp.json\` and/or \`.codex/config.toml\` artifacts for the remote repo, including configured additional MCP servers.
- Ask the operator before destructive commands, deploys, permission prompts, or scope expansion.
`;

function uniqueClients(clients: readonly CicloSkillInstallClient[]): readonly CicloSkillInstallClient[] {
  return [...new Set(clients)];
}

function writeIfChanged(path: string, content: string, dryRun: boolean): boolean {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const changed = previous !== content;
  if (changed && !dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return changed;
}

function installCodexSkill(projectRoot: string, dryRun: boolean): CicloSkillInstallTargetResult {
  const files = [
    { path: join(projectRoot, ".agents", "skills", "ciclo-mcp", "SKILL.md"), content: CODEX_SKILL },
    { path: join(projectRoot, ".agents", "skills", "ciclo-mcp", "references", "mcp-workflows.md"), content: CODEX_WORKFLOWS },
    { path: join(projectRoot, ".agents", "skills", "ciclo-mcp", "agents", "openai.yaml"), content: CODEX_OPENAI_AGENT },
    { path: join(projectRoot, ".agents", "skills", "release", "SKILL.md"), content: RELEASE_SKILL },
    { path: join(projectRoot, ".agents", "skills", "release", "agents", "openai.yaml"), content: RELEASE_OPENAI_AGENT }
  ];
  const changed = files.map((file) => writeIfChanged(file.path, file.content, dryRun)).some(Boolean);
  return { client: "codex", paths: files.map((file) => file.path), changed, dryRun };
}

function installClaudeSkill(projectRoot: string, dryRun: boolean): CicloSkillInstallTargetResult {
  const files = [
    { path: join(projectRoot, ".claude", "skills", "ciclo-mcp.md"), content: CLAUDE_SKILL },
    { path: join(projectRoot, ".claude", "skills", "release.md"), content: RELEASE_SKILL },
    { path: join(projectRoot, ".claude", "commands", "release.md"), content: CLAUDE_RELEASE_COMMAND }
  ];
  const changed = files.map((file) => writeIfChanged(file.path, file.content, dryRun)).some(Boolean);
  return { client: "claude", paths: files.map((file) => file.path), changed, dryRun };
}

export function installCicloSkills(options: CicloSkillInstallOptions = {}): CicloSkillInstallResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const clients = uniqueClients(options.clients ?? ["claude", "codex"]);
  const dryRun = options.dryRun ?? false;
  const targets = clients.map((client) => {
    if (client === "claude") return installClaudeSkill(projectRoot, dryRun);
    return installCodexSkill(projectRoot, dryRun);
  });

  return {
    installed: targets.some((target) => target.changed) && !dryRun,
    projectRoot,
    targets,
    nextSteps: [
      "Run ciclo mcp install --client all --project <repo> if the project does not already expose Ciclo MCP.",
      "Restart Claude or Codex if it does not hot-reload project skills.",
      "Ask the session to use the ciclo-mcp skill and Ciclo MCP for work claims, worker launches, and closeout evidence.",
      "Use /release or the release skill when a repository release should tag, publish, and create a GitHub release."
    ]
  };
}
