"""Ciclo operator CLI entrypoint."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

from ciclo.adapters.herdr import HerdrClient, HerdrError, event_from_fixture
from ciclo.runtime import DECISION
from ciclo.schemas import (
    CicloEvent,
    LoopConfig,
    LoopState,
    NormalizedEvent,
    PlannedResponse,
    SchemaError,
)
from ciclo.version import __version__


def _print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


def runtime_command(_args: argparse.Namespace) -> int:
    _print_json(asdict(DECISION))
    return 0


def validate_command(args: argparse.Namespace) -> int:
    payload = json.loads(args.file.read_text())
    kind = args.kind
    try:
        if kind == "loop-config":
            value = LoopConfig.from_mapping(payload)
        elif kind == "event":
            value = NormalizedEvent.from_mapping(payload)
        elif kind == "response":
            value = PlannedResponse.from_mapping(payload)
        elif kind == "ciclo-event":
            value = CicloEvent.from_mapping(payload)
        elif kind == "loop-state":
            value = LoopState.from_mapping(payload)
        else:
            raise SchemaError(f"unsupported schema kind: {kind}")
    except (json.JSONDecodeError, SchemaError) as exc:
        print(f"schema validation failed: {exc}", file=sys.stderr)
        return 1

    _print_json({"ok": True, "kind": kind, "normalized": asdict(value)})
    return 0


def config_validate_command(args: argparse.Namespace) -> int:
    from ciclo.config import load_project_loop_config

    try:
        config = load_project_loop_config(args.file)
    except SchemaError as exc:
        print(f"config validation failed: {exc}", file=sys.stderr)
        return 1
    _print_json({"ok": True, "config": asdict(config)})
    return 0


def herdr_fixture_command(args: argparse.Namespace) -> int:
    try:
        event = event_from_fixture(args.file)
    except HerdrError as exc:
        print(f"herdr fixture normalization failed: {exc}", file=sys.stderr)
        return 1
    _print_json(asdict(event))
    return 0


def herdr_status_command(args: argparse.Namespace) -> int:
    client = HerdrClient(timeout_seconds=args.timeout)
    try:
        event = client.status_event(args.target)
    except HerdrError as exc:
        _print_json(
            {
                "ok": False,
                "target": args.target,
                "error": type(exc).__name__,
                "message": str(exc),
            }
        )
        return 2
    _print_json({"ok": True, "event": asdict(event)})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ciclo",
        description="Spec-driven Herdr supervisor foundation CLI.",
    )
    parser.add_argument("--version", action="version", version=f"ciclo {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    runtime = sub.add_parser("runtime", help="print the implementation runtime decision")
    runtime.set_defaults(func=runtime_command)

    validate = sub.add_parser("validate", help="validate a Ciclo JSON fixture")
    validate.add_argument(
        "kind", choices=("loop-config", "event", "response", "ciclo-event", "loop-state")
    )
    validate.add_argument("file", type=Path)
    validate.set_defaults(func=validate_command)

    herdr = sub.add_parser("herdr", help="Herdr adapter utilities")
    herdr_sub = herdr.add_subparsers(dest="herdr_command", required=True)

    fixture = herdr_sub.add_parser("fixture", help="normalize a Herdr/Ciclo event fixture")
    fixture.add_argument("file", type=Path)
    fixture.set_defaults(func=herdr_fixture_command)

    status = herdr_sub.add_parser("status", help="try local Herdr explain and normalize output")
    status.add_argument("target", nargs="?", default="local")
    status.add_argument("--timeout", type=float, default=3.0)
    status.set_defaults(func=herdr_status_command)

    config = sub.add_parser("config", help="Ciclo loop config utilities")
    config_sub = config.add_subparsers(dest="config_command", required=True)
    config_validate = config_sub.add_parser("validate", help="validate a YAML loop config")
    config_validate.add_argument("file", type=Path)
    config_validate.set_defaults(func=config_validate_command)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
