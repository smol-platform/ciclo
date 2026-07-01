from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from ciclo.config import load_project_loop_config
from ciclo.schemas import CicloEvent, EventKind, LoopState, LoopStatus

ROOT = Path(__file__).resolve().parents[1]


def python_env() -> dict[str, str]:
    return {**os.environ, "PYTHONPATH": str(ROOT / "src")}


def test_review_and_deploy_yaml_configs_validate() -> None:
    review = load_project_loop_config(ROOT / "tests/fixtures/review_loop.yaml")
    deploy = load_project_loop_config(ROOT / "tests/fixtures/deploy_loop.yaml")

    assert review.loop.kind.value == "review"
    assert review.policy.mode == "dry_run"
    assert "task_close" in review.policy.require_approval_for
    assert deploy.loop.kind.value == "deploy"
    assert deploy.policy.mode == "supervised"
    assert "deploy" in deploy.policy.require_approval_for


def test_cli_validates_yaml_loop_config() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "ciclo.cli",
            "config",
            "validate",
            "tests/fixtures/review_loop.yaml",
        ],
        cwd=ROOT,
        env=python_env(),
        text=True,
        capture_output=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    assert payload["ok"] is True
    assert payload["config"]["loop"]["id"] == "review-demo"


def test_required_event_fixtures_validate() -> None:
    expected = {
        "agent_state_changed.json": EventKind.AGENT_STATE_CHANGED,
        "agent_blocked.json": EventKind.AGENT_BLOCKED,
        "repo_changed.json": EventKind.REPO_CHANGED,
        "loop_goal_updated.json": EventKind.LOOP_GOAL_UPDATED,
        "benchmark_scenario_completed.json": EventKind.BENCHMARK_SCENARIO_COMPLETED,
    }
    for filename, kind in expected.items():
        payload = json.loads((ROOT / "tests/fixtures/events" / filename).read_text())
        event = CicloEvent.from_mapping(payload)
        assert event.kind is kind
        assert event.evidence


def test_loop_state_fixture_validates() -> None:
    payload = json.loads((ROOT / "tests/fixtures/loop_state_review.json").read_text())
    loop_state = LoopState.from_mapping(payload)
    assert loop_state.status is LoopStatus.READY_FOR_REVIEW
    assert loop_state.last_event_kind is EventKind.AGENT_STATE_CHANGED


def test_cli_validates_ciclo_event_fixture() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "ciclo.cli",
            "validate",
            "ciclo-event",
            "tests/fixtures/events/repo_changed.json",
        ],
        cwd=ROOT,
        env=python_env(),
        text=True,
        capture_output=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    assert payload["normalized"]["kind"] == "repo.changed"
