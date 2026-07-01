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
description: "Use when Claude, Codex, or another coding agent is working in a Ciclo-enabled project and should coordinate through Ciclo MCP: reading Ciclo status, selecting and claiming Beads work, asking or answering operator questions, launching Ciclo-managed Claude/Codex workers, monitoring Herdr/remote sessions, reporting feedback, syncing Beads-native trackers, or closing work with validation evidence."
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

## Operating Rules

- Use Beads IDs in every mutating Ciclo MCP call when work is tied to a task.
- Use \`dry_run: true\` before launching workers, remote runners, or any plan with unclear policy impact.
- Ask through \`ciclo_ask_operator\` for secrets, credentials, destructive commands, deploys, scope changes, unclear product intent, or blocked agent decisions.
- Report findings or warnings with \`ciclo_report_feedback\` instead of burying them in chat.
- Close work only through \`ciclo_close_work\`, with acceptance evidence and validation evidence.
- Do not write \`.beads/issues.jsonl\` or treat it as live coordination state.
- Do not push Jira/Linear directly; use \`ciclo_sync_remote_trackers\` only when Beads-native sync is configured and authorized.

## Worker Pattern

When the user wants Claude to drive work through Ciclo, keep the current session as the operator-facing session. Launch implementation or review workers through Ciclo:

1. Call \`ciclo_launch_worker_session\` with \`dry_run: true\`.
2. Show the command, cwd, model, session name, prompt scope, extra args, and worktree plan.
3. After approval, call \`ciclo_launch_worker_session\` without dry run.
4. Prefer \`isolation: "worktree"\` for bead fan-out so workers do not collide in the main checkout.
5. Monitor with \`ciclo_poll_events\`, \`ciclo_board\`, \`ciclo_list_worker_sessions\`, or \`ciclo://worker-sessions\`.
6. Have workers heartbeat with \`ciclo_heartbeat_worker_session\`; include token and cost deltas when available.
7. For PR-producing loops, call \`ciclo_board\` with \`expected_pr_after_ms\`; treat \`expected_pr_missing\` as a blocker requiring transcript inspection, stop, or relaunch.
8. Stop stale or superseded workers with \`ciclo_stop_worker_session\`.

Ciclo reuses the active Herdr session when detected. Local Claude/Codex workers launched through Ciclo then run as visible Herdr agent panes, so the operator can attach to the overall Ciclo session and watch them. If that is not wanted, start the MCP server with \`CICLO_REUSE_HERDR_SESSION=false\` to use direct process launches and repo-name fallback.

## Closeout Pattern

Before closeout:

1. Record validation with \`ciclo_update_work\` using \`kind: "validation"\`.
2. Record any remaining blocker or follow-up with \`ciclo_update_work\`, or create follow-up Beads work when needed.
3. Call \`ciclo_close_work\` with final summary, acceptance evidence, and validation evidence.
4. If tracker sync is configured and approved, call \`ciclo_sync_remote_trackers\`.

## Detailed Reference

Read \`references/mcp-workflows.md\` when you need tool payload examples, resource names, remote runner flow, device auth, or the recommended first prompt for a Claude/Codex session.
`;

const CODEX_WORKFLOWS = `# Ciclo MCP Workflows

## Operator Session Prompt

Use this when starting Claude or Codex in a project that has Ciclo MCP installed:

\`\`\`text
Use Ciclo MCP as the control plane for this repository. Start by reading Ciclo status and ready work. Claim Beads work through Ciclo, ask operator questions through Ciclo, launch worker sessions through Ciclo when useful, report progress and validation evidence through Ciclo, and close work only through Ciclo after acceptance evidence is present.
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
9. \`ciclo_board\` with \`expected_pr_after_ms\` for PR-producing fan-out loops
10. \`ciclo_ask_operator\` when blocked
11. \`ciclo_report_feedback\` for review findings and warnings
12. \`ciclo_close_work\`
13. \`ciclo_sync_remote_trackers\` only when configured and approved

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
  "prompt": "Use Ciclo MCP as the control plane. Work only on project-123. Report progress, blockers, validation, and final summary through Ciclo.",
  "dry_run": true
}
\`\`\`

After operator approval, send the same payload with \`dry_run: false\`. Use \`extra_args\` for harness-specific CLI flags and \`isolation: "worktree"\` when the worker should run in an isolated git worktree. Ciclo resolves a default sibling worktree path unless \`worktree_path\` is provided and defaults bead branches to \`ciclo/<bead-id>\`.

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

const CLAUDE_SKILL = `---
name: ciclo-mcp
description: "Use Ciclo MCP as the control plane for Claude-driven repository work: status, ready Beads work, claims, progress notes, operator questions, worker launches, Herdr/remote monitoring, tracker sync, and closeout with validation evidence."
---

# Ciclo MCP

Use Ciclo MCP whenever this project asks Claude to drive work through Ciclo.

## Workflow

1. Read \`ciclo_status\` or \`ciclo://status\`.
2. Read \`ciclo_whoami\` or \`ciclo://users/me\` when identity or access matters.
3. Select work with \`ciclo_list_ready_work\`.
4. Claim with \`ciclo_claim_work\` before implementation.
5. Record progress, blockers, validation, and final summaries with \`ciclo_update_work\`.
6. Ask blocked questions with \`ciclo_ask_operator\`.
7. Launch Claude/Codex workers through \`ciclo_launch_worker_session\`; dry-run first.
8. Monitor with \`ciclo_list_worker_sessions\` or \`ciclo://worker-sessions\`.
9. Close with \`ciclo_close_work\` only after acceptance and validation evidence.

## Rules

- Keep the current Claude session operator-facing; ask Ciclo to launch bounded workers for implementation.
- Dry-run worker launches first; include \`extra_args\` for harness-specific flags and \`create_worktree\` when the worker should run in an isolated git worktree.
- When Ciclo MCP is running inside Herdr, local Claude/Codex workers launch as visible Herdr agent panes by default. Set \`CICLO_REUSE_HERDR_SESSION=false\` before starting MCP only when direct process launches are required.
- Use Beads IDs in mutating calls.
- Do not edit \`.beads/issues.jsonl\` or bypass Ciclo for claims/closeout.
- Use \`ciclo_report_feedback\` for findings and warnings.
- Use \`ciclo_sync_remote_trackers\` only when Beads-native tracker sync is configured and authorized.
- Ask the operator before secrets, destructive commands, deploys, permission prompts, or scope expansion.
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
    { path: join(projectRoot, ".agents", "skills", "ciclo-mcp", "agents", "openai.yaml"), content: CODEX_OPENAI_AGENT }
  ];
  const changed = files.map((file) => writeIfChanged(file.path, file.content, dryRun)).some(Boolean);
  return { client: "codex", paths: files.map((file) => file.path), changed, dryRun };
}

function installClaudeSkill(projectRoot: string, dryRun: boolean): CicloSkillInstallTargetResult {
  const path = join(projectRoot, ".claude", "skills", "ciclo-mcp.md");
  const changed = writeIfChanged(path, CLAUDE_SKILL, dryRun);
  return { client: "claude", paths: [path], changed, dryRun };
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
      "Ask the session to use the ciclo-mcp skill and Ciclo MCP for work claims, worker launches, and closeout evidence."
    ]
  };
}
