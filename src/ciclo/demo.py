"""Small demo entrypoint for the current foundation slice."""

from __future__ import annotations

import json
from dataclasses import asdict

from ciclo.runtime import DECISION
from ciclo.schemas import (
    AgentState,
    HarnessId,
    NormalizedEvent,
    PlannedResponse,
    PolicyDecision,
    PolicyOutcome,
    ResponseKind,
)


def demo_payload() -> dict[str, object]:
    event = NormalizedEvent(
        source="fixture",
        state=AgentState.DONE,
        harness=HarnessId.CODEX,
        target="local-demo",
        evidence=("fixture:codex done", "repo:dirty"),
    )
    response = PlannedResponse(
        kind=ResponseKind.REPORT_FEEDBACK,
        policy=PolicyOutcome(
            decision=PolicyDecision.DRY_RUN_ONLY,
            reason="foundation demo does not execute mutating actions",
            evidence=("SPEC-CICLO-001",),
        ),
        summary="Codex is done with local changes; Ciclo would summarize and ask for review.",
        evidence=event.evidence,
    )
    return {
        "runtime": asdict(DECISION),
        "event": asdict(event),
        "response": asdict(response),
    }


def main() -> int:
    print(json.dumps(demo_payload(), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
