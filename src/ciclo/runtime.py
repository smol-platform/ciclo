"""Runtime decision and package-shape metadata."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RuntimeDecision:
    runtime: str
    entrypoints: tuple[str, ...]
    package_roots: tuple[str, ...]
    rationale: tuple[str, ...]


DECISION = RuntimeDecision(
    runtime="Standalone TypeScript Ciclo orchestrator agent",
    entrypoints=(
        "standalone CLI: ./src/cli.ts",
        "npm script: ciclo-demo",
        "Pi brain adapter: ./src/pi-extension.ts",
        "transitional ciclo.cli:main",
        "future ciclo.mcp_stdio:main",
        "future ciclo.bench:main",
    ),
    package_roots=(
        "src/app.ts",
        "src/cli.ts",
        "src/pi-extension.ts",
        "src/ciclo-core.ts",
        "future src/adapters",
        "future src/harnesses",
        "future src/mcp",
        "future src/bench",
        "transitional src/ciclo",
    ),
    rationale=(
        "Ciclo is a standalone orchestrator agent for loops, sessions, MCP, Beads, "
        "Herdr, safety policy, and agent clouds.",
        "Pi is used under the covers as one brain provider that helps Ciclo choose "
        "high-quality next actions.",
        "The Pi adapter remains an internal brain/integration surface, but it does not "
        "define Ciclo's product boundary.",
        "Herdr and Beads remain external adapters behind the Ciclo planner boundary.",
        "Quint continues to model high-risk coordination invariants outside the runtime language.",
    ),
)
