from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ciclo.runtime import DECISION
from ciclo.schemas import AgentState, LoopConfig, NormalizedEvent, SchemaError

ROOT = Path(__file__).resolve().parents[1]


def python_env() -> dict[str, str]:
    return {**os.environ, "PYTHONPATH": str(ROOT / "src")}


def test_runtime_decision_records_package_shape() -> None:
    assert DECISION.runtime == "Standalone TypeScript Ciclo orchestrator agent"
    assert "standalone CLI: ./src/cli.ts" in DECISION.entrypoints
    assert "Pi brain adapter: ./src/pi-extension.ts" in DECISION.entrypoints
    assert "src/app.ts" in DECISION.package_roots
    assert "src/pi-extension.ts" in DECISION.package_roots
    assert any("Herdr" in reason or "Beads" in reason for reason in DECISION.rationale)


def test_loop_config_fixture_validates() -> None:
    payload = json.loads((ROOT / "tests/fixtures/loop_config.json").read_text())
    config = LoopConfig.from_mapping(payload)
    assert config.id == "review-demo"
    assert config.kind.value == "review"
    assert config.dry_run is True


def test_event_fixture_validates() -> None:
    payload = json.loads((ROOT / "tests/fixtures/event_codex_done.json").read_text())
    event = NormalizedEvent.from_mapping(payload)
    assert event.state is AgentState.DONE
    assert event.harness.value == "codex"


def test_invalid_event_rejected() -> None:
    with pytest.raises(SchemaError):
        NormalizedEvent.from_mapping(
            {"source": "fixture", "state": "confused", "harness": "codex", "target": "x"}
        )


def test_cli_runtime_command() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "ciclo.cli", "runtime"],
        cwd=ROOT,
        env=python_env(),
        text=True,
        capture_output=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    assert payload["runtime"] == "Standalone TypeScript Ciclo orchestrator agent"


def test_cli_validate_fixture() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "ciclo.cli",
            "validate",
            "loop-config",
            "tests/fixtures/loop_config.json",
        ],
        cwd=ROOT,
        env=python_env(),
        text=True,
        capture_output=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    assert payload["ok"] is True
