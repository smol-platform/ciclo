# Ciclo Quint Models

This directory contains executable Quint models for high-risk Ciclo coordination rules.

## Model

- `ciclo_core.qnt`: finite model of Beads work ownership, Beads remote DB health, multi-user authorization, command approval, remote session loss, and context compaction safety.

## Verified Invariants

- `invClaimOwnerMatchesStatus`: claimed work has exactly one non-empty claim owner.
- `invClosedWorkUnclaimed`: closed work is not left claimed.
- `invNoIntruderOwnsWork`: unauthenticated/under-scoped principal cannot own work.
- `invNoUnderScopedCommandApproval`: commands are approved only by principals with approval grants.
- `invRemoteLostDoesNotReleaseClaimedWork`: remote loss does not silently release claimed work.
- `invTokenNeverLeaked`: modeled token material is never exposed.
- `invTranscriptDroppedOnlyAfterMemoryPersisted`: transcript context is dropped only after durable Beads work memory exists.
- `invSensitiveContextMemoryPersistedRedacted`: sensitive context is persisted only after redaction.
- `invDroppedSensitiveTranscriptHadRedactedMemory`: sensitive transcript context is dropped only when its durable memory is redacted.

## Commands

```bash
quint parse formal/quint/ciclo_core.qnt
quint typecheck formal/quint/ciclo_core.qnt
quint test formal/quint/ciclo_core.qnt --verbosity=1
quint run formal/quint/ciclo_core.qnt --max-samples=1000 --max-steps=20 \
  --invariants invClaimOwnerMatchesStatus invClosedWorkUnclaimed invNoIntruderOwnsWork \
  invNoUnderScopedCommandApproval invRemoteLostDoesNotReleaseClaimedWork invTokenNeverLeaked \
  invTranscriptDroppedOnlyAfterMemoryPersisted invSensitiveContextMemoryPersistedRedacted \
  invDroppedSensitiveTranscriptHadRedactedMemory \
  --verbosity=1
quint verify formal/quint/ciclo_core.qnt --max-steps=6 \
  --invariants invClaimOwnerMatchesStatus invClosedWorkUnclaimed invNoIntruderOwnsWork \
  invNoUnderScopedCommandApproval invRemoteLostDoesNotReleaseClaimedWork invTokenNeverLeaked \
  invTranscriptDroppedOnlyAfterMemoryPersisted invSensitiveContextMemoryPersistedRedacted \
  invDroppedSensitiveTranscriptHadRedactedMemory \
  --verbosity=1
```

Update the model whenever implementation changes affect Beads claims, authorization, command approval, remote session ownership, token handling, or context compaction.
