#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

export PATH="${HOME}/.local/bin:${HOME}/.nix-profile/bin:/nix/var/nix/profiles/default/bin:${PATH}"

if command -v bd >/dev/null 2>&1; then
  bd prime >/dev/null || true
fi

devenv shell ciclo-doctor
