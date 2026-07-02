"""Version metadata for Ciclo."""

from __future__ import annotations

import tomllib
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import cast


def _version_from_pyproject() -> str:
    for parent in Path(__file__).resolve().parents:
        pyproject = parent / "pyproject.toml"
        if pyproject.exists():
            data = cast("dict[str, object]", tomllib.loads(pyproject.read_text()))
            project = data.get("project")
            if isinstance(project, dict):
                project_data = cast("dict[str, object]", project)
                version_value = project_data.get("version")
                if isinstance(version_value, str):
                    return version_value
    raise RuntimeError("could not resolve Ciclo version from package metadata")


def _load_version() -> str:
    try:
        return version("ciclo")
    except PackageNotFoundError:
        return _version_from_pyproject()


__version__ = _load_version()
