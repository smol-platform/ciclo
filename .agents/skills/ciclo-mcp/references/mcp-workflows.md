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

## Work Claim Example

```json
{
  "loop_id": "review-loop",
  "bead_id": "project-123",
  "harness_id": "claude-code"
}
```

After claiming, use `ciclo_update_work` for progress:

```json
{
  "bead_id": "project-123",
  "kind": "progress",
  "message": "Inspected the failing tests and narrowed the issue to the scheduler retry path."
}
```

Validation update:

```json
{
  "bead_id": "project-123",
  "kind": "validation",
  "message": "Full TypeScript gate passed.",
  "validation_command": "npm run check",
  "validation_passed": true
}
```

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

After operator approval, send the same payload with `dry_run: false`. Use `extra_args` for harness-specific CLI flags, `configure_mcp: true` to install Ciclo MCP config into the worker cwd or worktree before launch, and `isolation: "worktree"` when the worker should run in an isolated git worktree. Ciclo resolves a default sibling worktree path unless `worktree_path` is provided and defaults bead branches to `ciclo/<bead-id>`. When Ciclo is inside Herdr, worktree-isolated local pane launches use `herdr worktree create/open` and start the agent with the returned Herdr workspace id.

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

These entries are not Ciclo plugins and do not add tools to the Ciclo control plane. They are copied into the launched worker's Claude/Codex MCP config so that worker session can call those third-party MCP servers directly. Keep the environment map non-secret; use command wrappers, provider-native secret references, or Ciclo secret request flow when a server needs sensitive values.

Use `mcp.secretBindings` when the generated Ciclo MCP server entry itself needs secret-backed environment variables. The binding name becomes an env var on the generated `ciclo` server entry in `.mcp.json` or `.codex/config.toml`; the secret value is resolved only for authorized non-dry-run installs or launches and is redacted from responses, audit records, and events. Add `format` when the target variable needs a wrapper string, such as `Bearer ${secret}`; the format must contain exactly one `${secret}` placeholder.

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

Do not put the secret value into `mcp.vars`, additional MCP server environment maps, prompt text, Beads notes, or tracker sync. Treat `format` as a template, not a place for another secret. If a third-party MCP server needs a token directly, prefer that server's native secret-reference support or a wrapper command that obtains the token without writing it into project config.

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
- `mcp_additional_servers` writes extra third-party MCP server entries into the launched worker config. The object is keyed by server name; values accept `command`, `args`, and non-secret `env`. Per-launch entries override project config entries with the same name.
- `mcp_secret_env` writes secret-backed environment variables into the generated config only on non-dry-run launches. Ciclo resolves each binding through `provider_id`, `secret_ref`, and optional `field`; optional `format` wraps the resolved value and must contain exactly one `${secret}` placeholder; the response and audit trail stay redacted.

The installer-generated MCP config exposes Ciclo's MCP tools, resources, prompts, and enabled plugin capabilities to the spawned worker. If the worker needs unrelated third-party MCP servers, install those servers into the target project through their own installer before launching, or expose the capability through a Ciclo plugin that the worker can reach via Ciclo MCP. Avoid manual edits to generated worker config; they are hard to reproduce across worktrees and remote runners.

Use `mcp_env` only for non-secret environment variables. Use `mcp_secret_env` when a configured MCP server needs a secret; Ciclo resolves each binding through `provider_id` and `secret_ref`, applies optional `format`, writes the resulting value into the generated MCP client config only for non-dry-run launches, and redacts the value from responses, worker-session listings, audit records, and events. The caller needs `secret.read`.

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

## Operator Question Example

```json
{
  "loop_id": "deploy-loop",
  "bead_id": "project-456",
  "urgency": "blocking",
  "question": "Deployment needs a production token. Which secret reference should this loop use?"
}
```

Use `ciclo_answer_question` only when answering a pending question as the operator or with explicit authorization.

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
  "final_summary": "Implemented retry backoff fix and updated scheduler tests.",
  "acceptance_evidence": [
    "Retry backoff now caps at the configured maximum.",
    "Scheduler resumes after transient failure."
  ],
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
2. Dry-run project config and skill installs: `ciclo mcp install --client all --project "$(pwd)" --dry-run --compact` and `ciclo skill install --client all --project "$(pwd)" --dry-run --compact`.
3. Install for the active client:
   - Claude: `ciclo mcp install --client claude --project "$(pwd)" && ciclo skill install --client claude --project "$(pwd)"`
   - Codex: `ciclo mcp install --client codex --project "$(pwd)" && ciclo skill install --client codex --project "$(pwd)"`
4. Restart the client session if it does not hot-reload MCP config or project skills.

Do not emulate Ciclo MCP by editing Ciclo state files directly.
