#!/usr/bin/env python3
"""Project guard hook for Claude Code and Codex.

The hook reads lifecycle JSON on stdin and emits Claude/Codex-compatible JSON
only when it needs to block or add context. Keep this dependency-free: hooks run
before the project devenv may be active.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]

CONTEXT = """Ciclo project guardrails:
- Use Beads (`bd`) for durable task tracking; do not use markdown TODO files as the source of truth.
- Claim concrete Beads tasks before implementation and close them only with validation evidence.
- Run `just check` or `devenv shell ciclo-check` before handoff when behavior, hooks, specs, or formal models change.
- Do not commit, push, or run Beads remote sync unless the user explicitly asked for that operation in the current turn.
- Use Herdr remote attach for remote sessions; do not invent raw SSH supervision paths.
- Do not read secrets or write `.env*`, `.git/`, generated caches, or Beads internals directly.
"""


PROTECTED_PATH_PREFIXES = (
    ".git/",
    ".devenv/",
    ".direnv/",
    "_apalache-out/",
    ".beads/backup/",
    ".beads/dolt/",
    ".beads/proxieddb/",
)

PROTECTED_EXACT_PATHS = {
    ".beads/issues.jsonl",
    ".beads-credential-key",
}

SECRET_PATH_RE = re.compile(r"(^|/)\.env(\..*)?$")

DESTRUCTIVE_COMMANDS = (
    (r"\bgit\s+reset\s+--hard\b", "git reset --hard is prohibited."),
    (r"\bgit\s+checkout\s+--\b", "git checkout -- can discard user work."),
    (r"\bgit\s+clean\s+-[^;&|]*[fdx]", "git clean can delete untracked work."),
    (r"\brm\s+-[^;&|]*r[^;&|]*f\b\s+(/|\$HOME|~|\.|\*)", "destructive rm -rf target is prohibited."),
    (r"\bbd\s+edit\b", "bd edit opens an interactive editor; use bd update flags."),
    (r"\bbd\s+import\b", "bd import is not part of normal Beads coordination."),
    (r"\b(?:cp|mv|rm)\s+(?!-[^\n;&|]*f\b)", "cp, mv, and rm must use non-interactive flags such as -f or -rf."),
)

SHELL_WRITE_TRICKS = (
    r"\bcat\s+>+",
    r"\btee\s+(-a\s+)?[^|;&]+",
    r"python[0-9.]*\s+-c\s+['\"].*(write_text|open\(.*[\"']w)",
)


def load_input() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {"_raw": raw}
    return value if isinstance(value, dict) else {"value": value}


def event_name(payload: dict[str, Any], fallback: str | None) -> str:
    return (
        fallback
        or payload.get("hook_event_name")
        or payload.get("hookEventName")
        or payload.get("event")
        or ""
    )


def tool_name(payload: dict[str, Any]) -> str:
    return str(payload.get("tool_name") or payload.get("toolName") or "")


def tool_input(payload: dict[str, Any]) -> dict[str, Any]:
    value = payload.get("tool_input") or payload.get("toolInput") or {}
    return value if isinstance(value, dict) else {}


def command_text(payload: dict[str, Any]) -> str:
    value = tool_input(payload).get("command")
    return value if isinstance(value, str) else ""


def candidate_paths(payload: dict[str, Any]) -> list[str]:
    values: list[str] = []
    inp = tool_input(payload)

    for key in ("file_path", "path", "notebook_path"):
        value = inp.get(key)
        if isinstance(value, str):
            values.append(value)

    command = command_text(payload)
    if command:
        for match in re.finditer(r"(?<![\w./-])(?:\.?/)?(?:\.env(?:\.\w+)?|\.beads/issues\.jsonl|\.git/[\w./-]+|_apalache-out/[\w./-]+|\.devenv/[\w./-]+)", command):
            values.append(match.group(0))

    return values


def normalize_path(path: str) -> str:
    text = path.strip()
    if not text:
        return ""
    try:
        parts = shlex.split(text)
        if len(parts) == 1:
            text = parts[0]
    except ValueError:
        pass
    candidate = Path(text)
    if candidate.is_absolute():
        try:
            return candidate.resolve().relative_to(ROOT).as_posix()
        except ValueError:
            return candidate.as_posix().lstrip("/")
    normalized = candidate.as_posix()
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def protected_path_reason(path: str) -> str | None:
    rel = normalize_path(path)
    if not rel:
        return None
    if rel in PROTECTED_EXACT_PATHS:
        return f"{rel} is a protected Beads/project state file."
    if SECRET_PATH_RE.search(rel):
        return f"{rel} may contain secrets and is protected."
    for prefix in PROTECTED_PATH_PREFIXES:
        if rel.startswith(prefix):
            return f"{rel} is under protected generated/internal state."
    return None


def command_reason(command: str) -> str | None:
    if not command:
        return None

    if re.search(r"\bgit\s+commit\b", command) and os.environ.get("CICLO_ALLOW_GIT_COMMIT") != "1":
        return "git commit requires explicit user approval; set CICLO_ALLOW_GIT_COMMIT=1 for the approved command."
    if re.search(r"\bgit\s+push\b", command) and os.environ.get("CICLO_ALLOW_GIT_PUSH") != "1":
        return "git push requires explicit user approval; set CICLO_ALLOW_GIT_PUSH=1 for the approved command."
    if re.search(r"\bbd\s+dolt\s+(push|pull)\b", command) and os.environ.get("CICLO_ALLOW_BEADS_REMOTE_SYNC") != "1":
        return "Beads remote sync requires explicit user approval; set CICLO_ALLOW_BEADS_REMOTE_SYNC=1 for the approved command."
    if re.search(r"\bgit\s+commit\b.*\s--no-verify\b", command):
        return "git commit --no-verify bypasses project gates."
    if re.search(r"\bbd\s+close\b", command) and "--reason" not in command:
        return "bd close must include --reason with completion evidence."

    for pattern, reason in DESTRUCTIVE_COMMANDS:
        if re.search(pattern, command):
            return reason

    if os.environ.get("CICLO_ALLOW_SHELL_WRITES") != "1":
        for pattern in SHELL_WRITE_TRICKS:
            if re.search(pattern, command, flags=re.DOTALL):
                return "write files with apply_patch or project tooling, not shell redirection/write tricks."

    for path in candidate_paths({"tool_input": {"command": command}}):
        reason = protected_path_reason(path)
        if reason:
            return reason

    return None


def pre_tool_reason(payload: dict[str, Any]) -> str | None:
    for path in candidate_paths(payload):
        reason = protected_path_reason(path)
        if reason:
            return reason
    return command_reason(command_text(payload))


def deny(event: str, reason: str) -> None:
    hook_event = event or "PreToolUse"
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": hook_event,
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                },
                "decision": "block",
                "reason": reason,
            }
        )
    )


def context(event: str) -> None:
    hook_event = event or "SessionStart"
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": hook_event,
                    "additionalContext": CONTEXT,
                }
            }
        )
    )


def run(payload: dict[str, Any], event_arg: str | None = None) -> int:
    event = event_name(payload, event_arg)
    if event in {"SessionStart", "UserPromptSubmit", "SubagentStart"}:
        context(event)
        return 0

    if event in {"PreToolUse", "PermissionRequest"} or tool_name(payload):
        reason = pre_tool_reason(payload)
        if reason:
            deny(event or "PreToolUse", reason)
        return 0

    return 0


def self_test() -> int:
    cases = [
        ({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git status"}}, False),
        ({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git commit -m x"}}, True),
        ({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "bd close ciclo-1"}}, True),
        ({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "bd close ciclo-1 --reason done"}}, False),
        ({"hook_event_name": "PreToolUse", "tool_name": "Write", "tool_input": {"file_path": ".env"}}, True),
        ({"hook_event_name": "PreToolUse", "tool_name": "apply_patch", "tool_input": {"command": "*** Update File: .beads/issues.jsonl"}}, True),
    ]
    for payload, should_block in cases:
        blocked = pre_tool_reason(payload) is not None
        if blocked != should_block:
            print(f"self-test failed: {payload!r} blocked={blocked}", file=sys.stderr)
            return 1
    print("agent gate self-test passed")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()

    event_arg = None
    for arg in argv[1:]:
        if not arg.startswith("-"):
            event_arg = arg
            break
    return run(load_input(), event_arg)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
