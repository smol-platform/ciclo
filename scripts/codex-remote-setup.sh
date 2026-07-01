#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf '\n==> %s\n' "$*"
}

append_path_once() {
  local line="$1"
  local bashrc="${HOME}/.bashrc"
  touch "${bashrc}"
  if ! grep -Fqx "${line}" "${bashrc}"; then
    printf '%s\n' "${line}" >> "${bashrc}"
  fi
}

log "Preparing Ciclo Codex remote environment"

mkdir -p "${HOME}/.local/bin"
# shellcheck disable=SC2016
append_path_once 'export PATH="$HOME/.local/bin:$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"'
export PATH="${HOME}/.local/bin:${HOME}/.nix-profile/bin:/nix/var/nix/profiles/default/bin:${PATH}"

if ! command -v nix >/dev/null 2>&1; then
  log "Installing Nix"
  curl -fsSL https://install.determinate.systems/nix | sh -s -- install --no-confirm
  # shellcheck disable=SC1091
  [[ -f /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]] && . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
fi

if ! command -v devenv >/dev/null 2>&1; then
  log "Installing devenv"
  nix profile install --accept-flake-config github:cachix/devenv/v2.1.2
fi

if ! command -v bd >/dev/null 2>&1; then
  log "Installing Beads CLI"
  curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash
fi

if ! command -v herdr >/dev/null 2>&1; then
  log "Installing Herdr"
  curl -fsSL https://herdr.dev/install.sh | sh
fi

log "Priming Beads and building devenv cache"
if command -v bd >/dev/null 2>&1; then
  bd prime >/dev/null || true
fi

devenv shell ciclo-doctor

cat > "${repo_root}/.codex/remote/.last-setup" <<EOF
setup_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
repo=${repo_root}
EOF

log "Ciclo Codex remote environment ready"
