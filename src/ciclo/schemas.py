"""Typed Ciclo data structures for the MVP foundation.

These dataclasses mirror the core structures in SPEC-CICLO-001 while staying
dependency-free for a portable first demo. Runtime validation lives in
``from_mapping`` constructors so adapters can safely normalize CLI/fixture data.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal, Self, TypeVar, cast

SPEC_ID = "SPEC-CICLO-001"


class SchemaError(ValueError):
    """Raised when external data cannot be normalized into a Ciclo schema."""


class HarnessId(StrEnum):
    CLAUDE_CODE = "claude-code"
    CODEX = "codex"
    UNKNOWN = "unknown"


class AgentState(StrEnum):
    WORKING = "working"
    BLOCKED = "blocked"
    DONE = "done"
    IDLE = "idle"
    UNKNOWN = "unknown"


class LoopKind(StrEnum):
    REVIEW = "review"
    DEPLOY = "deploy"
    TRIAGE = "triage"
    BENCHMARK = "benchmark"
    BEADS_WORK = "beads_work"


class LoopStatus(StrEnum):
    CREATED = "created"
    OBSERVING = "observing"
    ACTIVE = "active"
    BLOCKED = "blocked"
    READY_FOR_REVIEW = "ready_for_review"
    COMPLETE = "complete"
    PAUSED = "paused"
    FAILED = "failed"


class PolicyDecision(StrEnum):
    ALLOW = "allow"
    DENY = "deny"
    ASK_OPERATOR = "ask_operator"
    DRY_RUN_ONLY = "dry_run_only"


class ResponseKind(StrEnum):
    WAIT = "wait"
    NUDGE_AGENT = "nudge_agent"
    CLAIM_TASK = "claim_task"
    UPDATE_TASK = "update_task"
    ASK_OPERATOR = "ask_operator"
    REPORT_FEEDBACK = "report_feedback"
    BUILD_CONTEXT_PACK = "build_context_pack"
    REGISTER_REMOTE_SESSION = "register_remote_session"


class EventKind(StrEnum):
    AGENT_STATE_CHANGED = "agent.state_changed"
    AGENT_BLOCKED = "agent.blocked"
    REPO_CHANGED = "repo.changed"
    LOOP_GOAL_UPDATED = "loop.goal_updated"
    BENCHMARK_SCENARIO_COMPLETED = "benchmark.scenario_completed"


def expect_str(data: dict[str, Any], key: str, *, default: str | None = None) -> str:
    value = data.get(key, default)
    if not isinstance(value, str) or not value:
        raise SchemaError(f"{key} must be a non-empty string")
    return value


EnumT = TypeVar("EnumT", bound=StrEnum)
Source = Literal["herdr", "beads", "mcp", "repo", "remote", "fixture"]
RemoteStatus = Literal["registered", "attached", "stale", "lost", "blocked"]


def expect_list(data: dict[str, Any], key: str) -> list[str]:
    value = data.get(key, [])
    if not isinstance(value, list):
        raise SchemaError(f"{key} must be a list of strings")
    raw_items = cast(list[object], value)
    items: list[str] = []
    for item in raw_items:
        if not isinstance(item, str):
            raise SchemaError(f"{key} must be a list of strings")
        items.append(item)
    return items


def _expect_mapping(value: Any, key: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise SchemaError(f"{key} must be an object")
    return dict(cast(Mapping[str, Any], value))


_expect_str = expect_str
_expect_list = expect_list


def enum_value(enum_type: type[EnumT], value: Any, key: str) -> EnumT:
    if not isinstance(value, str):
        raise SchemaError(f"{key} must be a string")
    try:
        return enum_type(value)
    except ValueError as exc:
        allowed = ", ".join(member.value for member in enum_type)
        raise SchemaError(f"{key} must be one of: {allowed}") from exc


@dataclass(frozen=True)
class LoopConfig:
    id: str
    kind: LoopKind
    goal: str
    harnesses: tuple[HarnessId, ...] = (HarnessId.CLAUDE_CODE, HarnessId.CODEX)
    dry_run: bool = True

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        harness_values = _expect_list(data, "harnesses") or [
            HarnessId.CLAUDE_CODE.value,
            HarnessId.CODEX.value,
        ]
        harnesses = tuple(
            enum_value(HarnessId, value, "harnesses").value for value in harness_values
        )
        return cls(
            id=_expect_str(data, "id"),
            kind=enum_value(LoopKind, data.get("kind"), "kind"),
            goal=_expect_str(data, "goal"),
            harnesses=tuple(HarnessId(value) for value in harnesses),
            dry_run=bool(data.get("dry_run", True)),
        )


@dataclass(frozen=True)
class NormalizedEvent:
    source: Source
    state: AgentState
    harness: HarnessId
    target: str
    evidence: tuple[str, ...] = ()

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        source = _expect_str(data, "source")
        allowed_sources = {"herdr", "beads", "mcp", "repo", "remote", "fixture"}
        if source not in allowed_sources:
            raise SchemaError(f"source must be one of: {', '.join(sorted(allowed_sources))}")
        return cls(
            source=cast(Source, source),
            state=enum_value(AgentState, data.get("state"), "state"),
            harness=enum_value(HarnessId, data.get("harness", HarnessId.UNKNOWN.value), "harness"),
            target=_expect_str(data, "target"),
            evidence=tuple(_expect_list(data, "evidence")),
        )


@dataclass(frozen=True)
class BeadsWorkSnapshot:
    id: str
    title: str
    status: str
    priority: int
    acceptance: str | None = None
    labels: tuple[str, ...] = ()

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        priority = data.get("priority", 2)
        if not isinstance(priority, int):
            raise SchemaError("priority must be an integer")
        acceptance = data.get("acceptance_criteria") or data.get("acceptance")
        if acceptance is not None and not isinstance(acceptance, str):
            raise SchemaError("acceptance must be a string when present")
        return cls(
            id=_expect_str(data, "id"),
            title=_expect_str(data, "title"),
            status=_expect_str(data, "status"),
            priority=priority,
            acceptance=acceptance,
            labels=tuple(_expect_list(data, "labels")),
        )


@dataclass(frozen=True)
class RemoteSessionState:
    id: str
    transport: Literal["herdr_remote_ssh"]
    herdr_remote: str
    status: RemoteStatus
    herdr_session: str | None = None

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        transport = _expect_str(data, "transport", default="herdr_remote_ssh")
        if transport != "herdr_remote_ssh":
            raise SchemaError("transport must be herdr_remote_ssh")
        status = _expect_str(data, "status", default="registered")
        allowed = {"registered", "attached", "stale", "lost", "blocked"}
        if status not in allowed:
            raise SchemaError(f"status must be one of: {', '.join(sorted(allowed))}")
        herdr_session = data.get("herdr_session")
        if herdr_session is not None and not isinstance(herdr_session, str):
            raise SchemaError("herdr_session must be a string when present")
        return cls(
            id=_expect_str(data, "id"),
            transport="herdr_remote_ssh",
            herdr_remote=_expect_str(data, "herdr_remote"),
            status=cast(RemoteStatus, status),
            herdr_session=herdr_session,
        )


@dataclass(frozen=True)
class AuthGrant:
    principal: str
    role: str
    scopes: tuple[str, ...] = ()

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        return cls(
            principal=_expect_str(data, "principal"),
            role=_expect_str(data, "role"),
            scopes=tuple(_expect_list(data, "scopes")),
        )


@dataclass(frozen=True)
class PolicyOutcome:
    decision: PolicyDecision
    reason: str
    evidence: tuple[str, ...] = ()

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        return cls(
            decision=enum_value(PolicyDecision, data.get("decision"), "decision"),
            reason=_expect_str(data, "reason"),
            evidence=tuple(_expect_list(data, "evidence")),
        )


@dataclass(frozen=True)
class PlannedResponse:
    kind: ResponseKind
    policy: PolicyOutcome
    summary: str
    evidence: tuple[str, ...] = ()
    work_id: str | None = None

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        work_id = data.get("work_id")
        if work_id is not None and not isinstance(work_id, str):
            raise SchemaError("work_id must be a string when present")
        return cls(
            kind=enum_value(ResponseKind, data.get("kind"), "kind"),
            policy=PolicyOutcome.from_mapping(_expect_mapping(data.get("policy"), "policy")),
            summary=_expect_str(data, "summary"),
            evidence=tuple(_expect_list(data, "evidence")),
            work_id=work_id,
        )


@dataclass(frozen=True)
class AuditRecord:
    event: str
    spec_id: str = SPEC_ID
    bead_id: str | None = None
    evidence: tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        bead_id = data.get("bead_id")
        if bead_id is not None and not isinstance(bead_id, str):
            raise SchemaError("bead_id must be a string when present")
        spec_id = _expect_str(data, "spec_id", default=SPEC_ID)
        return cls(
            event=_expect_str(data, "event"),
            spec_id=spec_id,
            bead_id=bead_id,
            evidence=tuple(_expect_list(data, "evidence")),
        )


@dataclass(frozen=True)
class CicloEvent:
    kind: EventKind
    source: Source
    evidence: tuple[str, ...] = ()
    normalized_event: NormalizedEvent | None = None
    payload: dict[str, Any] = field(default_factory=lambda: {})

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        normalized_raw = data.get("normalized_event")
        normalized_event = None
        if normalized_raw is not None:
            normalized_event = NormalizedEvent.from_mapping(
                _expect_mapping(normalized_raw, "normalized_event")
            )
        source = _expect_str(data, "source")
        allowed_sources = {"herdr", "beads", "mcp", "repo", "remote", "fixture"}
        if source not in allowed_sources:
            raise SchemaError(f"source must be one of: {', '.join(sorted(allowed_sources))}")
        payload_raw = data.get("payload", {})
        return cls(
            kind=enum_value(EventKind, data.get("kind"), "kind"),
            source=cast(Source, source),
            evidence=tuple(_expect_list(data, "evidence")),
            normalized_event=normalized_event,
            payload=_expect_mapping(payload_raw, "payload"),
        )


@dataclass(frozen=True)
class GoalUpdate:
    loop_id: str
    previous_goal: str
    new_goal: str
    reason: str
    evidence: tuple[str, ...] = ()

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        return cls(
            loop_id=_expect_str(data, "loop_id"),
            previous_goal=_expect_str(data, "previous_goal"),
            new_goal=_expect_str(data, "new_goal"),
            reason=_expect_str(data, "reason"),
            evidence=tuple(_expect_list(data, "evidence")),
        )


@dataclass(frozen=True)
class LoopState:
    id: str
    config_id: str
    status: LoopStatus
    goal: str
    active_harness: HarnessId | None = None
    active_work_id: str | None = None
    last_event_kind: EventKind | None = None
    evidence: tuple[str, ...] = ()

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        active_harness_raw = data.get("active_harness")
        active_harness = None
        if active_harness_raw is not None:
            active_harness = enum_value(HarnessId, active_harness_raw, "active_harness")
        active_work_id = data.get("active_work_id")
        if active_work_id is not None and not isinstance(active_work_id, str):
            raise SchemaError("active_work_id must be a string when present")
        last_event_raw = data.get("last_event_kind")
        last_event_kind = None
        if last_event_raw is not None:
            last_event_kind = enum_value(EventKind, last_event_raw, "last_event_kind")
        return cls(
            id=_expect_str(data, "id"),
            config_id=_expect_str(data, "config_id"),
            status=enum_value(LoopStatus, data.get("status"), "status"),
            goal=_expect_str(data, "goal"),
            active_harness=active_harness,
            active_work_id=active_work_id,
            last_event_kind=last_event_kind,
            evidence=tuple(_expect_list(data, "evidence")),
        )
