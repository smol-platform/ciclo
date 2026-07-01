"""Herdr CLI observation adapter.

This module keeps the first integration deliberately conservative: Herdr remains
the authoritative sensor, while Ciclo treats CLI output as external data that
must be parsed, normalized, and failure-wrapped before the planner sees it.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from ciclo.schemas import AgentState, HarnessId, NormalizedEvent, SchemaError


class HerdrError(RuntimeError):
    """Base class for Herdr adapter errors."""


class HerdrUnavailable(HerdrError):
    """Raised when the Herdr binary is missing or cannot be executed."""


class HerdrCommandError(HerdrError):
    """Raised when a Herdr command exits unsuccessfully."""


class HerdrParseError(HerdrError):
    """Raised when Herdr output cannot be parsed."""


@dataclass(frozen=True)
class CommandResult:
    args: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str


Runner = Callable[[Sequence[str], float], CommandResult]


def default_runner(args: Sequence[str], timeout_seconds: float) -> CommandResult:
    try:
        completed = subprocess.run(
            list(args),
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except FileNotFoundError as exc:
        raise HerdrUnavailable("herdr binary not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise HerdrCommandError(f"herdr command timed out after {timeout_seconds}s") from exc

    return CommandResult(
        args=tuple(args),
        returncode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )


def ensure_herdr_available(binary: str = "herdr") -> None:
    if shutil.which(binary) is None:
        raise HerdrUnavailable(f"{binary} binary not found")


def harness_from_label(label: str | None) -> HarnessId:
    text = (label or "").lower()
    if "claude" in text:
        return HarnessId.CLAUDE_CODE
    if "codex" in text:
        return HarnessId.CODEX
    return HarnessId.UNKNOWN


def normalize_state(value: str | None) -> AgentState:
    text = (value or "").strip().lower()
    if text in {"working", "busy", "running", "thinking", "executing"}:
        return AgentState.WORKING
    if text in {"blocked", "needs_input", "needs-input", "error", "failed"}:
        return AgentState.BLOCKED
    if text in {"done", "complete", "completed", "finished", "success"}:
        return AgentState.DONE
    if text in {"idle", "waiting", "ready", "stopped"}:
        return AgentState.IDLE
    return AgentState.UNKNOWN


def _string_value(data: dict[str, object], *keys: str) -> str | None:
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _evidence_from_payload(payload: dict[str, object]) -> tuple[str, ...]:
    evidence: list[str] = []
    for key in ("evidence", "reasons", "reason", "explanation", "summary", "status", "state"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            evidence.append(f"herdr:{value.strip()}")
        elif isinstance(value, list):
            for item in cast(list[object], value):
                if isinstance(item, str) and item.strip():
                    evidence.append(f"herdr:{item.strip()}")
    return tuple(dict.fromkeys(evidence))


def parse_explain_json(raw: str, *, target: str = "unknown") -> NormalizedEvent:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HerdrParseError("Herdr explain output is not valid JSON") from exc

    if not isinstance(parsed, dict):
        raise HerdrParseError("Herdr explain JSON must be an object")

    payload = cast(dict[str, object], parsed)
    agent = payload.get("agent")
    if isinstance(agent, dict):
        payload = {**payload, **cast(dict[str, object], agent)}

    label = _string_value(payload, "harness", "agent", "label", "detected_agent", "name")
    state_value = _string_value(payload, "state", "status", "agent_state")
    normalized_target = _string_value(payload, "target", "terminal", "pane", "id") or target

    return NormalizedEvent(
        source="herdr",
        state=normalize_state(state_value),
        harness=harness_from_label(label),
        target=normalized_target,
        evidence=_evidence_from_payload(payload) or (f"herdr:target={normalized_target}",),
    )


def parse_explain_text(raw: str, *, target: str = "unknown") -> NormalizedEvent:
    lowered = raw.lower()
    harness = harness_from_label(raw)
    state = AgentState.UNKNOWN
    for candidate in AgentState:
        if candidate.value in lowered:
            state = candidate
            break
    if state is AgentState.UNKNOWN:
        state = normalize_state(lowered)
    evidence = tuple(line.strip() for line in raw.splitlines() if line.strip())[:5]
    return NormalizedEvent(
        source="herdr",
        state=state,
        harness=harness,
        target=target,
        evidence=tuple(f"herdr:{line}" for line in evidence) or (f"herdr:target={target}",),
    )


@dataclass(frozen=True)
class HerdrClient:
    binary: str = "herdr"
    timeout_seconds: float = 3.0
    runner: Runner = default_runner

    def _run(self, args: Sequence[str]) -> CommandResult:
        command = (self.binary, *args)
        result = self.runner(command, self.timeout_seconds)
        if result.returncode != 0:
            message = result.stderr.strip() or result.stdout.strip() or "unknown Herdr error"
            raise HerdrCommandError(message)
        return result

    def list_targets(self) -> tuple[str, ...]:
        result = self._run(("agent", "list"))
        targets: list[str] = []
        for line in result.stdout.splitlines():
            text = line.strip()
            if text:
                targets.append(text.split()[0])
        return tuple(targets)

    def explain(self, target: str) -> NormalizedEvent:
        result = self._run(("agent", "explain", target, "--json"))
        try:
            return parse_explain_json(result.stdout, target=target)
        except HerdrParseError:
            return parse_explain_text(result.stdout, target=target)

    def explain_file(self, path: Path, agent: str) -> NormalizedEvent:
        result = self._run(("agent", "explain", "--file", str(path), "--agent", agent, "--json"))
        try:
            return parse_explain_json(result.stdout, target=str(path))
        except HerdrParseError:
            return parse_explain_text(result.stdout, target=str(path))

    def status_event(self, target: str = "local") -> NormalizedEvent:
        ensure_herdr_available(self.binary)
        return self.explain(target)


def event_from_fixture(path: Path) -> NormalizedEvent:
    raw = path.read_text()
    try:
        return parse_explain_json(raw, target=str(path))
    except HerdrParseError:
        try:
            return NormalizedEvent.from_mapping(json.loads(raw))
        except (json.JSONDecodeError, SchemaError) as exc:
            raise HerdrParseError(f"{path} is not a Herdr or Ciclo event fixture") from exc
