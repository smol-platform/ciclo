# Ciclo MCP Workflows

## Operator Session Prompt

Use this when starting Claude or Codex in a project that has Ciclo MCP installed:

```text
Use Ciclo MCP as the control plane for this repository. Start by reading Ciclo status and ready work. Claim Beads work through Ciclo, ask operator questions through Ciclo, launch worker sessions through Ciclo when useful, and use `ciclo_decide` for OpenAI-backed decisions about remote monitoring, context insertion, answerable questions, and controlling-session feedback. Report progress and validation evidence through Ciclo, and close work only through Ciclo after acceptance evidence is present. After close, monitor the Ciclo-launched review worker and surface its feedback to the operator.
```

## Common Tool Order

1. `ciclo_status` or `ciclo://status`
2. `ciclo_whoami` or `ciclo://users/me`
3. `ciclo_list_ready_work`
4. `ciclo_claim_work`
5. `ciclo_update_work`
6. `ciclo_launch_worker_session` when another Claude/Codex process should do bounded work
7. `ciclo_heartbeat_worker_session` from active workers with liveness, token, and cost deltas
8. `ciclo_poll_events` and `ciclo_board` while monitoring active work
9. `ciclo_decide` when monitoring, context, answerable-question, or operator-interface judgment is needed
10. `ciclo_board` with `expected_pr_after_ms` for PR-producing fan-out loops
11. `ciclo_list_secret_providers` and `ciclo_request_secret` when a task has an approved secret reference
12. `ciclo_ask_operator` when blocked
13. `ciclo_report_feedback` for review findings and warnings
14. `ciclo_close_work`; successful closes launch a bounded review worker by default
15. `ciclo_poll_events`, `ciclo_board`, or `ciclo_list_worker_sessions` to monitor the post-close review worker
16. `ciclo_sync_remote_trackers` only when configured and approved

## Status And Context Resources

- `ciclo://status`: overall loops, Beads, Herdr, remotes, sync, and access state.
- `ciclo://loops`: loop summaries.
- `ciclo://loops/{loop_id}`: detailed loop state.
- `ciclo://work/ready`: ready Beads work.
- `ciclo://work/{bead_id}`: work context and Ciclo audit state.
- `ciclo://questions`: pending operator or agent questions.
- `ciclo://feedback`: queued feedback.
- `ciclo://worker-sessions`: Ciclo-managed worker lifecycle state.
- `ciclo://remote-sessions`: registered remote sessions.
- `ciclo://remote-runners`: remote runner plans.
- `ciclo://secret-providers`: configured secret providers without secret material.
- `ciclo://session/access`: access mode and grants.
- `ciclo://users/me`: current principal.

## MCP And Skill Install

Use the installer instead of hand-editing client config:

```bash
ciclo mcp install --client all --project "$(pwd)" --dry-run --compact
ciclo skill install --client all --project "$(pwd)" --dry-run --compact
ciclo mcp install --client all --project "$(pwd)"
ciclo skill install --client all --project "$(pwd)"
```

Use `--client claude` or `--client codex` for a single client. Use `--server-name`, `--command`, and Claude channel options only when the operator requests a non-default MCP server id, binary path, or channel integration. Restart the client session when tools, resources, prompts, or skills do not hot-reload.

## Plugin Management

Use the CLI for third-party plugin lifecycle:

```bash
ciclo plugin list --compact
ciclo plugin install <package> --trust
ciclo plugin install <package> --path <local-package-dir> --trust
ciclo plugin enable <package>
ciclo plugin disable <package>
```

Only install or trust a plugin after the operator approves the package source and behavior. External plugins must include `ciclo.plugin.json` and export `activate(api)`. Plugins can add remote runner kinds and secret provider kinds; after enabling one, re-read `ciclo_status`, `ciclo_list_remote_runners`, or `ciclo_list_secret_providers`.

Plugin-backed secret providers can be aliased from project config:

```json
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
```

The configured `id` is what workers and operators pass to `ciclo_request_secret`; `pluginProviderId` is the provider id registered by the trusted installed plugin. Ciclo delegates the read to the plugin provider, returns the value only to the authorized caller, and keeps audit/events limited to provider ids, kinds, field names, and secret reference hashes.

## Worker Launch Example

Always dry-run first:

```json
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
```

After operator approval, send the same payload with `dry_run: false`. Use `extra_args` for harness-specific CLI flags, `configure_mcp: true` to install Ciclo MCP config into the worker cwd or worktree before launch, and `isolation: "worktree"` when the worker should run in an isolated git worktree. Ciclo resolves a default sibling worktree path unless `worktree_path` is provided and defaults bead branches to `ciclo/<bead-id>`. When Ciclo is inside Herdr, worktree-isolated local pane launches use fresh `herdr worktree create` workspaces and start the agent with the returned Herdr workspace id; existing Herdr worktree paths fail instead of reopening stale workspace state.

For Claude Code workers, `model` may be `claude-fable-5`, `fable 5`, `Fable 5`, or `claude fable 5`; Ciclo normalizes those aliases to `claude-fable-5` before launching Claude. Other model ids pass through unchanged.

## Spawned Session MCP Configuration

Use worker launch fields to control the MCP surface available inside spawned Claude and Codex sessions:

Repository defaults can be stored in `.ciclo/config.json`. Use:

```bash
ciclo config init --project "$(pwd)"
ciclo config show --project "$(pwd)" --compact
```

The file can define `secrets.providers`, `mcp.clients`, `mcp.serverName`, `mcp.command`, `mcp.vars`, `mcp.additionalServers`, `mcp.secretBindings`, `mcp.claudeChannel`, and `remote` defaults. `ciclo mcp install`, MCP startup, spawned workers, and remote runner planning read it. Explicit tool payload fields override config defaults. Use `examples/ciclo-config.json` in the Ciclo repository as the reference shape. It includes OpenBao, 1Password, and plugin-backed providers, additional third-party MCP servers, worker MCP secret bindings, WireGuard tunnel fields, and Kubernetes/AWS Lambda MicroVM/Cloudflare runner blocks.

Project-level additional MCP servers are configured under `mcp.additionalServers`:

```json
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
```

These entries are not Ciclo plugins and do not add tools to the Ciclo control plane. They are copied into the launched worker's Claude/Codex MCP config so that worker session can call those third-party MCP servers directly. Keep raw environment values non-secret. When a third-party server needs a Ciclo-managed secret, use a placeholder such as `Bearer ${secret://team-1password/Ciclo/API/token}` in the env value; Ciclo converts it into a `ciclo secret exec` runtime wrapper so only that server subprocess receives the resolved value. The placeholder host is the provider id, the path is the provider secret reference, and `?field=token` or `#token` selects a field.

### MCP Server Secret Support

Ciclo supports secret-backed environment variables for the generated `ciclo` MCP server entry, supports worker process secret variables, and supports `${secret://provider-id/ref}` replacements inside additional MCP server environment values. Generated config stores runtime wrappers and provider references, not resolved values.

Use this path when the Ciclo MCP server itself needs credentials or when a worker should receive a secret through Ciclo's controlled MCP surface:

- Project defaults: `mcp.secretBindings[]` in `.ciclo/config.json`.
- One-off Ciclo MCP server overrides: `mcp_secret_env[]` in `ciclo_launch_worker_session`.
- Project worker shell defaults: `mcp.workerSecretBindings[]` in `.ciclo/config.json`.
- One-off worker shell overrides: `worker_secret_env[]` in `ciclo_launch_worker_session`.
- Required fields: `name` or `env_name`, `providerId` or `provider_id`, and `ref` or `secret_ref`.
- Optional fields: `field`, `format`, and `reason`.
- `format` must contain exactly one `${secret}` placeholder and is applied only after the provider returns the value.
- Dry runs do not resolve the provider value. Non-dry-run installs and launches require `secret.read` authorization before writing runtime wrappers.

Use `mcp.secretBindings` when the generated Ciclo MCP server entry itself needs secret-backed environment variables. The binding name becomes an env var resolved by the generated `ciclo secret exec` wrapper; the secret value is only visible to the Ciclo MCP server subprocess. Add `format` when the target variable needs a wrapper string, such as `Bearer ${secret}`; the format must contain exactly one `${secret}` placeholder.

```json
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
        "format": "Bearer ${secret}",
        "reason": "provide task-scoped API access to the Ciclo MCP server"
      }
    ]
  }
}
```

The generated Claude config shape is equivalent to:

```json
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
```

Do not put the secret value into `mcp.vars`, additional MCP server environment maps, prompt text, Beads notes, or tracker sync. Treat `format` as a template, not a place for another secret. If a third-party MCP server needs a token directly, prefer that server's native secret-reference support or a wrapper command that obtains the token without writing it into project config. Another valid pattern is for the spawned worker to call `ciclo_request_secret` for task-scoped use and avoid injecting that credential into the third-party server.

```json
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
      "format": "Bearer ${secret}",
      "reason": "spawned worker MCP tools need OpenBao-backed task credentials"
    }
  ],
  "dry_run": true
}
```

Field behavior:

- `configure_mcp: true` installs the Ciclo MCP server into the worker cwd or generated worktree before the harness starts.
- `mcp_clients` chooses which client config files to write. Use `["claude"]`, `["codex"]`, or both. When omitted, Ciclo uses the launched `harness_id`.
- `mcp_server_name` changes the server id written into Claude or Codex config; leave it as `ciclo` unless the operator needs multiple Ciclo servers.
- `mcp_command` changes the command the spawned client runs for Ciclo MCP; use it for wrappers or non-standard installs.
- `mcp_claude_channel` enables Claude channel integration for spawned Claude sessions.
- `mcp_env` writes non-secret environment variables into the generated Ciclo MCP server config.
- `mcp_additional_servers` writes extra third-party MCP server entries into the launched worker config. The object is keyed by server name; values accept `command`, `args`, and `env`. Raw env values must be non-secret; values may include `${secret://provider-id/ref}` placeholders that Ciclo turns into runtime wrappers. Per-launch entries override project config entries with the same name.
- `mcp_secret_env` writes runtime-wrapped secret-backed environment variables for the generated Ciclo MCP server. Ciclo resolves each binding through `provider_id`, `secret_ref`, and optional `field` only when that server subprocess starts; optional `format` wraps the resolved value and must contain exactly one `${secret}` placeholder; the response and audit trail stay redacted.
- `worker_secret_env` wraps the launched Claude/Codex harness process when shell tools need credentials. Use this for `gh`, `git`, `curl`, deploy CLIs, or other commands run by the agent shell.

The installer-generated MCP config exposes Ciclo's MCP tools, resources, prompts, and enabled plugin capabilities to the spawned worker. If the worker needs unrelated third-party MCP servers, install those servers into the target project through their own installer before launching, or expose the capability through a Ciclo plugin that the worker can reach via Ciclo MCP. Avoid manual edits to generated worker config; they are hard to reproduce across worktrees and remote runners.

Use `mcp_env` only for non-secret environment variables. Use `mcp_secret_env` when the generated Ciclo MCP server needs a secret; use `worker_secret_env` when the launched worker shell needs a secret. The caller needs `secret.read`. Do not use `mcp_secret_env` to target additional MCP servers; put `${secret://provider-id/ref}` placeholders in those server env values when Ciclo should provide the secret at server startup.

Heartbeat while working:

```json
{
  "worker_session_id": "worker-123",
  "state": "running",
  "input_tokens": 1200,
  "output_tokens": 450,
  "cost_usd": 0.06,
  "evidence": ["validation:unit-tests-pending"]
}
```

## Secret Request Example

Use this when a task has an approved secret reference. Do not ask the operator to paste the secret value. Prefer provider references such as OpenBao paths/fields or 1Password `op://` references.

```json
{
  "provider_id": "onepassword",
  "secret_ref": "op://Ciclo/API/token",
  "loop_id": "deploy-loop",
  "bead_id": "project-456",
  "worker_session_id": "worker-123",
  "reason": "deployment smoke test needs the API token",
  "dry_run": false
}
```

Call `ciclo_list_secret_providers` first if the provider id is unknown. Use the returned value only for the command that needs it, and do not echo it in notes, validation output, feedback, transcripts, or tracker sync.

## Remote Runner Example

Use `ciclo_launch_remote_runner` for planning remote runnable environments. Provider execution remains policy-gated, and remote observation must go through Herdr remote attach over SSH.

```json
{
  "runner_kind": "kubernetes",
  "runner_id": "runner-k8s-1",
  "loop_id": "review-loop",
  "bead_id": "project-remote-1",
  "harness_id": "codex",
  "image": "ghcr.io/example/ciclo-runner:latest",
  "repo_path": "/workspace/project",
  "prompt": "Use Ciclo MCP and report progress.",
  "dry_run": true
}
```

Review the returned provider commands, WireGuard config, Herdr target, remote `mcp_config`, and `attach` plan before proceeding. `mcp_config` contains generated `.mcp.json` and/or `.codex/config.toml` artifacts for the remote `repo_path`; use its install command inside the runner when the remote checkout needs to merge with existing MCP client config. Project `mcp.additionalServers` and per-launch `mcp_additional_servers` are included in those remote artifacts, so the remote worker receives the same extra third-party MCP servers as a local launched worktree.

## Remote Session Example

For an already-running remote Ciclo, Herdr, or harness session, register and heartbeat the session instead of claiming the same Beads work locally:

```json
{
  "remote_session_id": "remote-build-1",
  "herdr_target": "builder-1",
  "repo_path": "/workspace/project",
  "harness_id": "codex",
  "loop_id": "review-loop",
  "bead_id": "project-remote-1"
}
```

Use `ciclo_heartbeat_remote_session` for liveness and `ciclo_detach_remote_session` when the remote worker is paused, lost, or retired. Treat remote attach failure, missing Herdr, stale heartbeat, or project path mismatch as operator-visible feedback or a blocking question.

## Close Work Example

```json
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
```

## Fallback When MCP Is Missing

If Ciclo MCP tools are unavailable:

1. Verify Ciclo is installed: `ciclo --version`.
2. Dry-run project installs: `ciclo mcp install --client all --project "$(pwd)" --dry-run --compact` and `ciclo skill install --client all --project "$(pwd)" --dry-run --compact`.
3. Install for the active clients with `ciclo mcp install --client all --project "$(pwd)"` and `ciclo skill install --client all --project "$(pwd)"`.
4. Restart the client session if it does not hot-reload MCP config or project skills.

Do not emulate Ciclo MCP by editing Ciclo state files directly.
