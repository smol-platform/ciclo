from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

import pytest

from ciclo.adapters.herdr import (
    CommandResult,
    HerdrClient,
    HerdrCommandError,
    HerdrParseError,
    HerdrUnavailable,
    event_from_fixture,
    harness_from_label,
    normalize_state,
    parse_explain_json,
    parse_explain_text,
)
from ciclo.schemas import AgentState, HarnessId

ROOT = Path(__file__).resolve().parents[1]
OBSERVATION_FIXTURE_CASES = (
    ("working.json", AgentState.WORKING, HarnessId.CLAUDE_CODE, "pane-working"),
    ("blocked.json", AgentState.BLOCKED, HarnessId.CODEX, "pane-blocked"),
    ("done.json", AgentState.DONE, HarnessId.CODEX, "pane-done"),
    ("idle.json", AgentState.IDLE, HarnessId.CLAUDE_CODE, "pane-idle"),
    ("unknown.json", AgentState.UNKNOWN, HarnessId.UNKNOWN, "pane-unknown"),
)


def python_env() -> dict[str, str]:
    return {**os.environ, "PYTHONPATH": str(ROOT / "src")}


def test_state_and_harness_normalization() -> None:
    assert normalize_state("busy") is AgentState.WORKING
    assert normalize_state("needs-input") is AgentState.BLOCKED
    assert normalize_state("finished") is AgentState.DONE
    assert normalize_state("ready") is AgentState.IDLE
    assert normalize_state("nonsense") is AgentState.UNKNOWN
    assert harness_from_label("Claude Code") is HarnessId.CLAUDE_CODE
    assert harness_from_label("openai codex") is HarnessId.CODEX


def test_parse_explain_json_fixture() -> None:
    raw = (ROOT / "tests/fixtures/herdr_explain_codex_done.json").read_text()
    event = parse_explain_json(raw)
    assert event.source == "herdr"
    assert event.state is AgentState.DONE
    assert event.harness is HarnessId.CODEX
    assert event.target == "pane-1"
    assert any("Codex reports" in item for item in event.evidence)


def test_parse_explain_text_fixture() -> None:
    raw = (ROOT / "tests/fixtures/herdr_explain_claude_working.txt").read_text()
    event = parse_explain_text(raw, target="pane-2")
    assert event.state is AgentState.WORKING
    assert event.harness is HarnessId.CLAUDE_CODE
    assert event.target == "pane-2"


@pytest.mark.parametrize(
    ("filename", "expected_state", "expected_harness", "expected_target"),
    OBSERVATION_FIXTURE_CASES,
)
def test_herdr_observation_fixture_suite(
    filename: str,
    expected_state: AgentState,
    expected_harness: HarnessId,
    expected_target: str,
) -> None:
    path = ROOT / "tests/fixtures/herdr/observations" / filename
    event = event_from_fixture(path)
    assert event.source == "herdr"
    assert event.state is expected_state
    assert event.harness is expected_harness
    assert event.target == expected_target
    assert all(item.startswith("herdr:") for item in event.evidence)


def test_fixture_loader_accepts_ciclo_event_fixture() -> None:
    event = event_from_fixture(ROOT / "tests/fixtures/event_codex_done.json")
    assert event.state is AgentState.DONE
    assert event.harness is HarnessId.CODEX


def test_parse_explain_json_rejects_invalid_json() -> None:
    with pytest.raises(HerdrParseError):
        parse_explain_json("not json")


def test_client_raises_on_command_failure() -> None:
    def runner(args: object, timeout: float) -> CommandResult:
        return CommandResult(
            args=("herdr", "agent", "explain"),
            returncode=1,
            stdout=json.dumps({"error": "no target"}),
            stderr="agent target not found",
        )

    client = HerdrClient(runner=runner)
    with pytest.raises(HerdrCommandError):
        client.explain("missing")


def test_client_replays_observation_fixtures_without_live_herdr() -> None:
    fixture_by_target = {
        expected_target: (ROOT / "tests/fixtures/herdr/observations" / filename).read_text()
        for filename, _state, _harness, expected_target in OBSERVATION_FIXTURE_CASES
    }

    def runner(args: Sequence[str], timeout: float) -> CommandResult:
        command = tuple(args)
        return CommandResult(
            args=command,
            returncode=0,
            stdout=fixture_by_target[command[3]],
            stderr="",
        )

    client = HerdrClient(runner=runner)
    for _filename, expected_state, expected_harness, expected_target in OBSERVATION_FIXTURE_CASES:
        event = client.explain(expected_target)
        assert event.state is expected_state
        assert event.harness is expected_harness
        assert event.target == expected_target


def test_client_replays_unavailable_fixture_as_structured_error() -> None:
    payload = json.loads((ROOT / "tests/fixtures/herdr/unavailable_command.json").read_text())

    def runner(args: Sequence[str], timeout: float) -> CommandResult:
        raise HerdrUnavailable(payload["stderr"])

    client = HerdrClient(runner=runner)
    with pytest.raises(HerdrUnavailable, match="herdr binary not found"):
        client.explain("pane-missing")


def test_cli_herdr_fixture_command() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "ciclo.cli",
            "herdr",
            "fixture",
            "tests/fixtures/herdr_explain_codex_done.json",
        ],
        cwd=ROOT,
        env=python_env(),
        text=True,
        capture_output=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    assert payload["state"] == "done"
    assert payload["harness"] == "codex"
