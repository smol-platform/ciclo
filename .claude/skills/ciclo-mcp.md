---
name: ciclo-mcp
description: "Use Ciclo MCP as the control plane for Claude-driven repository work: status, Beads work, worker launches with MCP config, Herdr panes, worktrees, remote runners, secret providers, event/board monitoring, tracker sync, and closeout evidence."
---

# Ciclo MCP

Use Ciclo MCP whenever this project asks Claude to drive work through Ciclo.

## Workflow

1. Read `ciclo_status` or `ciclo://status`.
2. Read `ciclo_whoami` or `ciclo://users/me` when identity or access matters.
3. Select work with `ciclo_list_ready_work`.
4. Claim with `ciclo_claim_work` before implementation.
5. Record progress, blockers, validation, and final summaries with `ciclo_update_work`.
6. Launch Claude/Codex workers through `ciclo_launch_worker_session`; dry-run first and use `configure_mcp: true` unless MCP is already installed in the worker cwd.
7. Monitor with `ciclo_poll_events`, `ciclo_board`, `ciclo_list_worker_sessions`, or `ciclo://worker-sessions`.
8. Heartbeat active workers with `ciclo_heartbeat_worker_session` when operating as the worker.
9. Ask blocked questions with `ciclo_ask_operator`; answer only through `ciclo_answer_question` when authorized.
10. Request configured secrets through `ciclo_request_secret`, never by pasting values into chat.
11. For PR-producing fan-out loops, call `ciclo_board` with `expected_pr_after_ms` and treat `expected_pr_missing` as a blocker.
12. Close with `ciclo_close_work` only after acceptance and validation evidence; successful closes launch a bounded review worker by default.
13. Monitor the post-close review worker and surface its `ciclo_report_feedback`, validation updates, or blockers to the operator.

## Install Or Refresh

```bash
ciclo mcp install --client all --project "$(pwd)"
ciclo skill install --client all --project "$(pwd)"
```

Dry-run first when you are not sure what files will change:

```bash
ciclo mcp install --client all --project "$(pwd)" --dry-run --compact
ciclo skill install --client all --project "$(pwd)" --dry-run --compact
```

MCP install writes project config for Claude and/or Codex. Use `--client claude`, `--client codex`, or `--client all`; use `--server-name` and `--command` only when the project needs a non-default Ciclo binary or server id. Restart the client if tools or skills do not hot-reload.

## Plugins

Use the CLI for third-party plugins:

```bash
ciclo plugin list --compact
ciclo plugin install <package> --trust
ciclo plugin install <package> --path <local-package-dir> --trust
ciclo plugin enable <package>
ciclo plugin disable <package>
```

Only trust plugins after the operator accepts the package source and behavior. External plugins must include `ciclo.plugin.json` and export `activate(api)`. Plugins can register remote runner kinds and secret provider kinds; after enabling a plugin, re-check `ciclo_status`, `ciclo_list_remote_runners`, or `ciclo_list_secret_providers` before using it. Project config can alias plugin-backed secret providers with `secrets.providers[].pluginProviderId`; use the configured `id` in `ciclo_request_secret`.

## Feature Map

- Status and identity: `ciclo_status`, `ciclo_whoami`, `ciclo://status`, `ciclo://users/me`.
- Work control: `ciclo_list_ready_work`, `ciclo_claim_work`, `ciclo_update_work`, `ciclo_close_work`; use `review_dry_run`, `review_harness_id`, or `launch_review: false` to control post-close review.
- Brain decisions: `ciclo_decide` routes remote monitoring, context insertion, answerable questions, and user-session interface decisions through the OpenAI/Pi brain.
- Worker sessions: `ciclo_launch_worker_session`, `ciclo_heartbeat_worker_session`, `ciclo_list_worker_sessions`, `ciclo_stop_worker_session`.
- Worker launch options: `configure_mcp: true`, `mcp_clients`, `mcp_server_name`, `mcp_command`, `mcp_env`, `mcp_secret_env`, `mcp_claude_channel`, `extra_args`, `isolation: "worktree"`, model/effort/sandbox/approval settings.
- Claude Code model aliases: `fable 5`, `Fable 5`, and `claude fable 5` normalize to `claude-fable-5`.
- Monitoring: `ciclo_poll_events`, `ciclo_board`, `ciclo://events`, `ciclo://board`; tell terminal operators to use `ciclo events --follow`.
- Operator routing: `ciclo_ask_operator`, `ciclo_answer_question`, `ciclo_report_feedback`.
- Secrets: `ciclo_list_secret_providers`, `ciclo_request_secret`, `ciclo://secret-providers`.
- Remote runners: `ciclo_launch_remote_runner`, `ciclo_list_remote_runners`, `ciclo_attach_plan`, `ciclo://remote-runners`.
- Tracker sync: `ciclo_sync_remote_trackers` only when Beads-native Jira/Linear sync is configured and authorized.

## Rules

- Keep the current Claude session operator-facing; ask Ciclo to launch bounded workers for implementation.
- Dry-run worker launches first; include `configure_mcp: true` unless the worker already has project MCP config, include `extra_args` for harness-specific flags, and prefer `isolation: "worktree"` when the worker should run in an isolated git worktree.
- Use `.ciclo/config.json` for shared secret-provider, MCP, and remote-runner defaults. Inspect it with `ciclo config show --compact`; create a starter file with `ciclo config init`. Explicit MCP tool arguments override config defaults.
- Use `ciclo launch codex` or `ciclo launch claude` when the operator wants a ready-to-go local Herdr session with Ciclo MCP and configured additional MCP servers installed before the harness starts. The default session and first pane are named for the project; use `--session`, `--pane-name`, `--no-attach`, or `--terminal` only when the operator needs a different shape. Dry-run with `ciclo launch codex --dry-run --compact` to inspect the redacted install plan, Herdr command, and harness command.
- Configure spawned worker MCP tools through `ciclo_launch_worker_session`: use `mcp_clients` for Claude/Codex config targets, `mcp_server_name` for a non-default Ciclo server id, `mcp_command` for a non-default Ciclo binary or wrapper, `mcp_env` for non-secret MCP server env, `mcp_secret_env` for secret-backed Ciclo MCP server env, `worker_secret_env` for credentials needed by the launched agent shell, and `mcp_claude_channel` for Claude channel integration.
- Configure additional third-party MCP servers for launched worktrees or remote sessions with project `mcp.additionalServers` or per-launch `mcp_additional_servers`. Each server is keyed by name and accepts `command`, `args`, and an environment map; raw values must be non-secret, but values may include `${secret://provider-id/ref}` placeholders that Ciclo converts into runtime wrappers in generated `.mcp.json` and/or `.codex/config.toml` for the new session.
- Use `mcp.secretBindings` in `.ciclo/config.json` when the generated Ciclo MCP server config needs secret-backed environment variables; use `mcp.workerSecretBindings` for credentials needed by the launched worker shell. Provider ids can point at built-in providers or plugin-backed aliases from `secrets.providers[].pluginProviderId`; optional `format` can wrap a resolved value and must contain exactly one `${secret}` placeholder. Ciclo writes runtime wrappers, not resolved values, into generated config.
- Treat `mcp_secret_env` and `mcp.secretBindings` as secret injection for the generated `ciclo` MCP server subprocess only. Use `mcp.workerSecretBindings` or `worker_secret_env` when `gh`, `git`, `curl`, or other worker shell tools need credentials. For third-party MCP server credentials, use `${secret://provider-id/ref}` env placeholders, provider-native references, wrapper commands, or task-scoped `ciclo_request_secret`; do not place raw values in additional server environment maps.
- The generated MCP config gives workers Ciclo tools, resources, prompts, enabled plugin capabilities, and any configured additional MCP servers. Prefer config or launch payloads over manual generated-config edits so worktree and remote sessions stay reproducible.
- When Ciclo MCP is running inside Herdr, local Claude/Codex workers launch as visible Herdr agent panes by default. With `isolation: "worktree"`, Ciclo uses fresh `herdr worktree create` workspaces and starts the pane with the returned Herdr workspace id; existing Herdr worktree paths fail instead of reopening stale workspace state. Ciclo MCP runs an internal heartbeat for sessions it owns; use `ciclo_decide` when a monitoring, context, question-answering, or operator-interface decision needs OpenAI judgment. Set `CICLO_REUSE_HERDR_SESSION=false` before starting MCP only when direct process launches are required.
- Use Beads IDs in mutating calls.
- Do not edit `.beads/issues.jsonl` or bypass Ciclo for claims/closeout.
- Use `ciclo_report_feedback` for findings and warnings.
- Use `ciclo_sync_remote_trackers` only when Beads-native tracker sync is configured and authorized.
- Use `ciclo_list_secret_providers` and `ciclo_request_secret` for configured secret references; ask the operator only when the provider, reference, or authorization is missing.
- Prefer provider references such as OpenBao paths/fields or 1Password `op://` references; never paste secret values into Beads, tracker sync, feedback, progress notes, or transcripts.
- Use `mcp_secret_env` on `ciclo_launch_worker_session` when the generated Ciclo MCP server needs a secret environment variable; use `worker_secret_env` when the launched agent shell needs credentials; use optional `format` such as `Bearer ${secret}` only when the target variable needs a wrapper string; do not put secret values in `mcp_env`, prompts, or notes.
- For remote work, use `ciclo_attach_plan`, `ciclo_launch_remote_runner`, and remote session registration/heartbeat/detach tools; remote observation must go through Herdr remote attach over SSH. Keep remote MCP setup enabled unless the remote image already installs Ciclo MCP; `mcp_config` includes generated `.mcp.json` and/or `.codex/config.toml` artifacts for the remote repo, including configured additional MCP servers.
- Ask the operator before destructive commands, deploys, permission prompts, or scope expansion.
