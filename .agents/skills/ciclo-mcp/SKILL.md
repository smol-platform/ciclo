---
name: ciclo-mcp
description: "Use when Claude, Codex, or another coding agent is working in a Ciclo-enabled project and should coordinate through Ciclo MCP: status, Beads claims, worker launches with MCP config, Herdr pane monitoring, worktrees, remote runners, secret providers, event/board monitoring, tracker sync, feedback, and closeout evidence."
---

# Ciclo MCP

Use Ciclo MCP as the control plane. Do not bypass Ciclo for claims, worker lifecycle, operator questions, remote runner planning, or task closeout when Ciclo MCP is available.

## First Moves

1. Read `ciclo_status` or `ciclo://status`.
2. Read `ciclo_whoami` or `ciclo://users/me` when access or identity affects the action.
3. For work selection, call `ciclo_list_ready_work`; do not infer ready work only from local files.
4. Claim work with `ciclo_claim_work` before implementation.
5. Record progress, blockers, validation, and final summaries with `ciclo_update_work`.

If MCP tools are not visible, check project MCP and skill installation:

```bash
ciclo mcp install --client all --project "$(pwd)"
ciclo skill install --client all --project "$(pwd)"
```

## Install Or Refresh

Use these from a repository root to install or refresh Ciclo integration:

```bash
ciclo mcp install --client all --project "$(pwd)"
ciclo skill install --client all --project "$(pwd)"
```

Dry-run first when you are not sure what files will change:

```bash
ciclo mcp install --client all --project "$(pwd)" --dry-run --compact
ciclo skill install --client all --project "$(pwd)" --dry-run --compact
```

MCP install writes project client config for Claude and/or Codex. Use `--client claude`, `--client codex`, or `--client all`; use `--server-name` and `--command` only when the project needs a non-default Ciclo binary or server id. After install, restart the client if tools or skills do not hot-reload.

## Plugin Guidance

Third-party plugins extend Ciclo outside this repository. Use the CLI, not manual config edits:

```bash
ciclo plugin list --compact
ciclo plugin install <package> --trust
ciclo plugin install <package> --path <local-package-dir> --trust
ciclo plugin enable <package>
ciclo plugin disable <package>
```

Only trust plugins after the operator accepts the package source and behavior. External plugins must include `ciclo.plugin.json` and export `activate(api)`. Plugins can register remote runner kinds and secret provider kinds; after enabling a plugin, re-check `ciclo_status`, `ciclo_list_remote_runners`, or `ciclo_list_secret_providers` before using it.

Plugin-backed secret providers can be named in `.ciclo/config.json`:

```json
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
```

Use `id` in `ciclo_request_secret`; `pluginProviderId` is the provider id registered by the installed plugin. Do not put secret values in config.

## Operating Rules

- Use Beads IDs in every mutating Ciclo MCP call when work is tied to a task.
- Use `dry_run: true` before launching workers, remote runners, or any plan with unclear policy impact.
- Use `ciclo_list_secret_providers` and `ciclo_request_secret` when a task needs a configured secret reference. Ask through `ciclo_ask_operator` only when the provider, reference, or authorization is missing.
- Never paste secret values into Beads, tracker sync, feedback, progress notes, or chat transcripts.
- Ask through `ciclo_ask_operator` for destructive commands, deploys, scope changes, unclear product intent, or blocked agent decisions.
- Report findings or warnings with `ciclo_report_feedback` instead of burying them in chat.
- Close work only through `ciclo_close_work`, with acceptance evidence and validation evidence; successful closes launch a bounded review worker by default.
- Do not write `.beads/issues.jsonl` or treat it as live coordination state.
- Do not push Jira/Linear directly; use `ciclo_sync_remote_trackers` only when Beads-native sync is configured and authorized.

## Feature Map

- Status and identity: `ciclo_status`, `ciclo_whoami`, `ciclo://status`, `ciclo://users/me`.
- Brain decisions: `ciclo_decide` routes remote monitoring, context insertion, answerable questions, and user-session interface decisions through the OpenAI/Pi brain.
- Work control: `ciclo_list_ready_work`, `ciclo_claim_work`, `ciclo_update_work`, `ciclo_close_work`; use `launch_review: false` only when the operator explicitly does not want post-close review.
- Worker sessions: `ciclo_launch_worker_session`, `ciclo_heartbeat_worker_session`, `ciclo_list_worker_sessions`, `ciclo_stop_worker_session`.
- Worker launch options: use `configure_mcp: true`, `mcp_clients`, `extra_args`, `isolation: "worktree"`, model/effort/sandbox/approval settings, and dry-run first.
- Claude Code model aliases: `fable 5`, `Fable 5`, and `claude fable 5` normalize to `claude-fable-5`.
- Monitoring: `ciclo_poll_events`, `ciclo_board`, `ciclo://events`, `ciclo://board`; use `expected_pr_after_ms` for PR-producing work.
- Operator routing: `ciclo_ask_operator`, `ciclo_answer_question`, `ciclo_report_feedback`.
- Secrets: `ciclo_list_secret_providers`, `ciclo_request_secret`, `ciclo://secret-providers`.
- Remote runners: `ciclo_launch_remote_runner`, `ciclo_list_remote_runners`, `ciclo_attach_plan`, `ciclo://remote-runners`.
- Tracker sync: `ciclo_sync_remote_trackers` only when Beads-native Jira/Linear sync is configured and authorized.

## Worker Pattern

When the user wants Claude to drive work through Ciclo, keep the current session as the operator-facing session. Launch implementation or review workers through Ciclo:

1. Call `ciclo_launch_worker_session` with `dry_run: true` and `configure_mcp: true` unless the worker already has project MCP config.
2. Show the command, cwd, model, session name, prompt scope, extra args, worktree plan, and MCP config plan.
3. After approval, call `ciclo_launch_worker_session` without dry run.
4. Prefer `isolation: "worktree"` for bead fan-out so workers do not collide in the main checkout.
5. Monitor with `ciclo_poll_events`, `ciclo_board`, `ciclo_list_worker_sessions`, or `ciclo://worker-sessions`.
6. Have workers heartbeat with `ciclo_heartbeat_worker_session`; include token and cost deltas when available.
7. For PR-producing loops, call `ciclo_board` with `expected_pr_after_ms`; treat `expected_pr_missing` as a blocker requiring transcript inspection, stop, or relaunch.
8. Stop stale or superseded workers with `ciclo_stop_worker_session`.

## Spawned Session MCP Tools

Use `ciclo_launch_worker_session` to decide which MCP tools a spawned Claude or Codex worker receives:

- Prefer repository defaults in `.ciclo/config.json` when the project has shared MCP, secret-provider, or remote-runner settings. Use `ciclo config show --compact` to inspect redacted defaults and `ciclo config init` to create a starter file.
- Use `examples/ciclo-config.json` in the Ciclo repository as the reference shape for provider aliases, MCP secret bindings, remote runner defaults, WireGuard settings, and provider-specific runner blocks.
- Use `ciclo launch codex` or `ciclo launch claude` when the operator wants a ready-to-go local Herdr session with Ciclo MCP and all configured additional MCP servers installed before the harness starts. The default session and first pane are named for the project; use `--session`, `--pane-name`, `--no-attach`, or `--terminal` only when the operator needs a different shape. Dry-run with `ciclo launch codex --dry-run --compact` to inspect the MCP install plan, Herdr command, and harness command without writing files or starting a session.
- Set `configure_mcp: true` to install the Ciclo MCP server into the worker cwd or generated worktree before launch.
- Set `mcp_clients` to the clients that should receive the config: `["claude"]`, `["codex"]`, or `["claude", "codex"]`. If omitted, Ciclo configures the client matching `harness_id`.
- Set `mcp_server_name` only when the project needs a non-default server id. Default is `ciclo`.
- Set `mcp_command` only when workers must run a non-default Ciclo binary or wrapper. Default is `ciclo`.
- Set `mcp_claude_channel: true` when a spawned Claude worker should expose Ciclo through Claude channel integration.
- Put only non-secret MCP server environment in `mcp_env`; use it for flags such as `CICLO_REUSE_HERDR_SESSION` or provider mode switches.
- Put secret-backed Ciclo MCP server environment in `mcp_secret_env`; Ciclo writes a runtime wrapper and resolves the values only for the generated Ciclo MCP subprocess.
- Put worker shell credentials in `worker_secret_env` when Claude/Codex tools such as `gh`, `git`, or `curl` need them. Ciclo wraps the launched harness command so only the worker process tree receives those variables.
- Put additional third-party MCP servers in `mcp_additional_servers` when the launched worker should receive more than Ciclo MCP. The object is keyed by server name; each value accepts `command`, `args`, and an environment map. Raw env values must be non-secret; values may include `${secret://provider-id/ref}` placeholders that Ciclo converts into runtime wrappers for the target MCP server. Ciclo writes those servers into the generated `.mcp.json` and/or `.codex/config.toml` in the worker cwd or worktree without resolved secret values.

The generated config gives the worker Ciclo MCP tools, resources, prompts, enabled plugin capabilities, and configured additional MCP servers. Prefer `.ciclo/config.json` or launch payloads over manual generated-config edits so worktree and remote sessions stay reproducible.

Config file mapping: `.ciclo/config.json` uses `mcp.clients`, `mcp.serverName`, `mcp.command`, `mcp.vars`, `mcp.additionalServers`, `mcp.secretBindings`, `mcp.workerSecretBindings`, and `mcp.claudeChannel`; it uses `secrets.providers` for built-in and plugin-backed provider ids; it uses `remote` for remote runner defaults. Inline MCP tool arguments override config defaults for one launch. `vars` and raw additional server environment values are non-secret strings; additional server env values may include `${secret://provider-id/ref}` placeholders; `secretBindings` and `workerSecretBindings` are provider references that Ciclo stores as runtime wrappers rather than resolved values.

Use `mcp.secretBindings` when the generated Ciclo MCP server config needs a secret-backed environment variable. The binding `name` becomes an env var resolved by the generated `ciclo secret exec` wrapper, and `providerId`/`ref` identify the configured provider reference to resolve. Add `format` when the env var needs a wrapper string such as `Bearer ${secret}`; formats must contain exactly one `${secret}` placeholder. Provider ids can point at built-in providers or plugin-backed aliases from `secrets.providers[].pluginProviderId`. For additional MCP servers, keep raw env values non-secret or use `${secret://provider-id/ref}` placeholders.

MCP server secret support has a strict boundary:

- Use `mcp.secretBindings` or launch-time `mcp_secret_env` only for secrets that should be injected into the generated `ciclo` MCP server subprocess.
- Use project `mcp.workerSecretBindings` or launch-time `worker_secret_env` for credentials the worker shell itself needs.
- Keep raw additional MCP server environment values non-secret. Ciclo turns `${secret://provider-id/ref}` placeholders into runtime wrappers for new sessions.
- For third-party MCP server credentials, prefer Ciclo placeholders, provider-native references, a wrapper command that fetches the secret at runtime, or task-scoped `ciclo_request_secret` calls from the worker.
- Never put raw secret values in `mcp.vars`, additional server environment maps, prompts, Beads notes, feedback, tracker sync, board output, or progress updates.

When operating as a worker, request secrets by reference:

1. Call `ciclo_list_secret_providers`.
2. Call `ciclo_request_secret` with `provider_id`, `secret_ref`, `reason`, and task scope (`loop_id`, `bead_id`, `worker_session_id`).
3. Prefer provider references such as OpenBao paths/fields or 1Password `op://` references; do not ask the operator to paste values.
4. Use the returned value only for the command that needs it, then avoid echoing it in validation output, Beads notes, feedback, tracker sync, or transcripts.

When the generated Ciclo MCP server needs a secret as an environment variable, use `mcp_secret_env` on `ciclo_launch_worker_session` instead of `mcp_env` or prompt text. When the worker shell needs the credential, use `worker_secret_env` instead. Each binding should include `env_name`, `provider_id`, `secret_ref`, optional `field`, optional `format`, and `reason`. Ciclo resolves the secret through the configured provider only inside the runtime wrapper for the intended process and redacts it from launch responses, worker-session listings, audit records, and events. The caller must be authorized for `secret.read`.

Ciclo reuses the active Herdr session when detected. Local Claude/Codex workers launched through Ciclo then run as visible Herdr agent panes, so the operator can attach to the overall Ciclo session and watch them. With `isolation: "worktree"`, local pane launches use fresh `herdr worktree create` workspaces and then start the agent with the returned Herdr workspace id; existing Herdr worktree paths fail instead of reopening stale workspace state. Direct launches outside Herdr use `git worktree add`. Ciclo MCP also runs an internal heartbeat for sessions it owns; use `ciclo_decide` when a monitoring, context, question-answering, or operator-interface decision needs OpenAI judgment. If Herdr pane reuse is not wanted, start the MCP server with `CICLO_REUSE_HERDR_SESSION=false` to use direct process launches and repo-name fallback.

## Remote Pattern

- Use `ciclo_attach_plan` to show how the operator can attach to the overall Herdr session or a specific agent pane.
- Use `ciclo_launch_remote_runner` for Kubernetes, AWS Lambda MicroVM, Cloudflare, or plugin-provided runner kinds; dry-run first and review image resolution, repo bootstrap, WireGuard, Herdr target, repo path, generated remote MCP config, preflight report path, and provider commands.
- Prefer `image_resolver.strategy: "variant"` for official Nix dockerTools images (`base-latest`, `codex-latest`, `claude-latest`, `full-latest`) and `image_resolver.strategy: "nixery"` only when a private Nixery registry should compose package-path images dynamically.
- Use `repo_bootstrap.use_devenv: true` so Kubernetes runners clone/fetch the repository and run `devenv shell -- true` as the final project dependency check before preflight.
- Treat remote preflight failures as launch blockers when required checks fail. The default preflight checks Claude Code access with a tiny non-interactive prompt and checks Ciclo-like build tools such as Git, Node.js, npm, Ciclo, Herdr, SSH, WireGuard, Beads, `just`, and `devenv`; only set `preflight.claude: false` when the operator explicitly wants to skip Claude access validation.
- Use `preflight_only: true` when validating image/devenv/Claude readiness without starting WireGuard or Herdr. For live Kubernetes launches, use `wireguard.existing_config_secret_name` or resolved key material; do not accept unresolved `${secret:...}` placeholders in `runner.conf`.
- Keep remote MCP setup enabled unless the remote image already installs Ciclo MCP. The response `mcp_config` includes `.mcp.json` and/or `.codex/config.toml` artifacts for the remote repo plus a remote `ciclo mcp install` command for merge-based setup. Project `mcp.additionalServers` and per-launch `mcp_additional_servers` are rendered into those remote artifacts so the spawned Claude/Codex session sees the same extra MCP servers as a local worktree worker.
- Use `ciclo_register_remote_session`, `ciclo_heartbeat_remote_session`, and `ciclo_detach_remote_session` for already-running remote Ciclo/Herdr/harness sessions.
- Remote observation must go through Herdr remote attach over SSH. Do not supervise remote work by inventing direct SSH process polling.
- Treat remote attach failure, missing Herdr, stale heartbeat, or project path mismatch as a blocker to surface through `ciclo_report_feedback` or `ciclo_ask_operator`.

## Closeout Pattern

Before closeout:

1. Record validation with `ciclo_update_work` using `kind: "validation"`.
2. Record any remaining blocker or follow-up with `ciclo_update_work`, or create follow-up Beads work when needed.
3. Call `ciclo_close_work` with final summary, acceptance evidence, and validation evidence. Ciclo launches a review worker by default; use `review_dry_run: true` to inspect the plan or `launch_review: false` only when approved.
4. Monitor the review worker with `ciclo_poll_events`, `ciclo_board`, or `ciclo_list_worker_sessions`; review workers should leave comments with `ciclo_report_feedback` and validation updates with `ciclo_update_work`.
5. If tracker sync is configured and approved, call `ciclo_sync_remote_trackers`.

## Detailed Reference

Read `references/mcp-workflows.md` when you need tool payload examples, resource names, remote runner flow, device auth, or the recommended first prompt for a Claude/Codex session.
