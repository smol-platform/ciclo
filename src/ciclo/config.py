"""Loop configuration loading and validation."""

from __future__ import annotations

import importlib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Self, cast

from ciclo.schemas import HarnessId, LoopConfig, SchemaError, enum_value, expect_list, expect_str


@dataclass(frozen=True)
class TriggerConfig:
    event: str
    when: str = "always"

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        return cls(
            event=expect_str(data, "event"),
            when=expect_str(data, "when", default="always"),
        )


@dataclass(frozen=True)
class PolicyConfig:
    mode: str = "dry_run"
    require_approval_for: tuple[str, ...] = ()
    allow_commands: tuple[str, ...] = ()

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        mode = expect_str(data, "mode", default="dry_run")
        if mode not in {"dry_run", "supervised", "autonomous"}:
            raise SchemaError("policy.mode must be dry_run, supervised, or autonomous")
        return cls(
            mode=mode,
            require_approval_for=tuple(expect_list(data, "require_approval_for")),
            allow_commands=tuple(expect_list(data, "allow_commands")),
        )


@dataclass(frozen=True)
class ExitCriteria:
    success: tuple[str, ...]
    failure: tuple[str, ...] = ()

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        success = tuple(expect_list(data, "success"))
        if not success:
            raise SchemaError("exit_criteria.success must include at least one condition")
        return cls(
            success=success,
            failure=tuple(expect_list(data, "failure")),
        )


@dataclass(frozen=True)
class ProjectLoopConfig:
    loop: LoopConfig
    triggers: tuple[TriggerConfig, ...]
    policy: PolicyConfig
    exit_criteria: ExitCriteria

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> Self:
        loop = LoopConfig.from_mapping(data)
        trigger_raw = data.get("triggers", [])
        if not isinstance(trigger_raw, list):
            raise SchemaError("triggers must be a list")
        trigger_values = cast(list[object], trigger_raw)
        parsed_triggers: list[TriggerConfig] = []
        for item in trigger_values:
            if not isinstance(item, dict):
                raise SchemaError("each trigger must be an object")
            parsed_triggers.append(TriggerConfig.from_mapping(cast(dict[str, Any], item)))
        triggers = tuple(parsed_triggers)

        policy_raw = data.get("policy", {})
        if not isinstance(policy_raw, dict):
            raise SchemaError("policy must be an object")
        exit_raw = data.get("exit_criteria")
        if not isinstance(exit_raw, dict):
            raise SchemaError("exit_criteria must be an object")

        # Validate harness values through LoopConfig and keep a precise error here for config users.
        for harness in data.get("harnesses", []):
            enum_value(HarnessId, harness, "harnesses")

        return cls(
            loop=loop,
            triggers=triggers,
            policy=PolicyConfig.from_mapping(cast(dict[str, Any], policy_raw)),
            exit_criteria=ExitCriteria.from_mapping(cast(dict[str, Any], exit_raw)),
        )


def _parse_scalar(value: str) -> object:
    stripped = value.strip()
    if stripped == "true":
        return True
    if stripped == "false":
        return False
    if stripped == "null":
        return None
    if (stripped.startswith('"') and stripped.endswith('"')) or (
        stripped.startswith("'") and stripped.endswith("'")
    ):
        return stripped[1:-1]
    return stripped


def _split_key_value(line: str) -> tuple[str, str]:
    key, separator, value = line.partition(":")
    if not separator or not key.strip():
        raise SchemaError(f"invalid loop config line: {line}")
    return key.strip(), value.strip()


def _append_scalar_list_item(container: dict[str, Any], key: str, value: str) -> None:
    items = container.get(key)
    if not isinstance(items, list):
        raise SchemaError(f"{key} must be a list")
    scalar_items = cast(list[object], items)
    scalar_items.append(_parse_scalar(value))


def _load_simple_yaml(text: str) -> dict[str, Any]:
    """Parse the conservative YAML subset Ciclo uses for loop config fixtures.

    Ciclo accepts full YAML when PyYAML is installed. This fallback keeps the CLI
    demoable in remote/dev shells where the optional module is not available.
    """

    root: dict[str, Any] = {}
    current_section: str | None = None
    current_nested_list: str | None = None
    current_trigger: dict[str, Any] | None = None

    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue

        indent = len(raw_line) - len(raw_line.lstrip(" "))
        line = raw_line.strip()

        if indent == 0:
            key, value = _split_key_value(line)
            current_section = None
            current_nested_list = None
            current_trigger = None

            if value:
                root[key] = _parse_scalar(value)
                continue

            if key in {"harnesses", "triggers"}:
                root[key] = []
            elif key in {"policy", "exit_criteria"}:
                root[key] = {}
            else:
                root[key] = {}
            current_section = key
            continue

        if current_section is None:
            raise SchemaError(f"nested value without section: {line}")

        if current_section == "harnesses":
            if indent != 2 or not line.startswith("- "):
                raise SchemaError("harnesses must be a scalar list")
            _append_scalar_list_item(root, "harnesses", line[2:].strip())
            continue

        if current_section == "triggers":
            triggers = cast(list[object], root["triggers"])
            if indent == 2 and line.startswith("- "):
                current_trigger = {}
                triggers.append(current_trigger)
                item_line = line[2:].strip()
                if item_line:
                    key, value = _split_key_value(item_line)
                    current_trigger[key] = _parse_scalar(value)
                continue
            if indent == 4 and current_trigger is not None:
                key, value = _split_key_value(line)
                current_trigger[key] = _parse_scalar(value)
                continue
            raise SchemaError("triggers must be a list of objects")

        if current_section in {"policy", "exit_criteria"}:
            section = cast(dict[str, Any], root[current_section])
            if indent == 2:
                key, value = _split_key_value(line)
                if value:
                    section[key] = _parse_scalar(value)
                    current_nested_list = None
                else:
                    section[key] = []
                    current_nested_list = key
                continue
            if indent == 4 and line.startswith("- ") and current_nested_list is not None:
                _append_scalar_list_item(section, current_nested_list, line[2:].strip())
                continue
            raise SchemaError(f"{current_section} contains unsupported YAML")

        raise SchemaError(f"unsupported loop config section: {current_section}")

    return root


def _load_yaml_mapping(text: str) -> dict[str, Any]:
    try:
        yaml_module = importlib.import_module("yaml")
    except ModuleNotFoundError:
        return _load_simple_yaml(text)

    safe_load_raw = getattr(yaml_module, "safe_load", None)
    if not callable(safe_load_raw):
        raise SchemaError("yaml.safe_load is unavailable")
    safe_load = cast(Callable[[str], object], safe_load_raw)
    raw = safe_load(text)
    if not isinstance(raw, dict):
        raise SchemaError("loop config YAML must contain an object")
    return cast(dict[str, Any], raw)


def load_project_loop_config(path: Path) -> ProjectLoopConfig:
    return ProjectLoopConfig.from_mapping(_load_yaml_mapping(path.read_text()))
