# Ciclo Codex Remote Environment

Codex cloud environments run a setup script before the agent phase and an optional maintenance script when a cached container resumes. Ciclo keeps those scripts in the repository so the remote setup is reviewable and versioned.

Use these in the Codex environment settings:

```bash
scripts/codex-remote-setup.sh
```

Maintenance script:

```bash
scripts/codex-remote-maintenance.sh
```

The setup installs or verifies:

- Nix and `devenv`.
- Beads CLI (`bd`) for durable task tracking.
- Herdr for local/remote agent observation.
- Ciclo's devenv quality gate through `ciclo-doctor`.

Remote operating rules:

- Use `bd` as the task source of truth. Do not read or import `.beads/issues.jsonl`.
- Use `bd dolt pull/push` only when the user or Ciclo policy explicitly enables remote Beads sync for the current loop.
- Use Herdr remote attach for remote supervision; do not create raw SSH polling loops.
- Run `just check` before handing back changes that affect hooks, specs, formal models, or build setup.
