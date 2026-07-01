{ pkgs, ... }:

let
  quintInvariants = ''
    invClaimOwnerMatchesStatus invClosedWorkUnclaimed invNoIntruderOwnsWork \
    invNoUnderScopedCommandApproval invRemoteLostDoesNotReleaseClaimedWork invTokenNeverLeaked \
    invTranscriptDroppedOnlyAfterMemoryPersisted invSensitiveContextMemoryPersistedRedacted \
    invDroppedSensitiveTranscriptHadRedactedMemory
  '';
in
{
  packages = with pkgs; [
    actionlint
    coreutils
    curl
    dolt
    fd
    gawk
    gh
    git
    git-lfs
    gnused
    go_1_25
    golangci-lint
    httpie
    jq
    just
    nodejs_22
    openssh
    pkg-config
    pnpm
    prettier
    pyright
    python313
    python313Packages.build
    python313Packages.hatchling
    python313Packages.pytest
    quint
    ripgrep
    rsync
    ruff
    rustup
    shellcheck
    sqlite
    taplo
    tmux
    tree
    typescript
    uv
    watch
    wget
    yq-go
  ];

  env.CICLO_DEVENV = "1";
  env.CICLO_QUINT_MODEL = "formal/quint/ciclo_core.qnt";

  scripts.ciclo-doctor.exec = ''
    set -euo pipefail

    required_tools=(
      bd
      dolt
      git
      go
      jq
      node
      npm
      pnpm
      python
      quint
      rg
      rustup
      ssh
      tsserver
      uv
    )

    missing=()
    for tool in "''${required_tools[@]}"; do
      if ! command -v "$tool" >/dev/null 2>&1; then
        missing+=("$tool")
      fi
    done

    if (( ''${#missing[@]} > 0 )); then
      printf 'Missing required tools: %s\n' "''${missing[*]}" >&2
      exit 1
    fi

    if ! command -v herdr >/dev/null 2>&1; then
      cat >&2 <<'EOF'
Herdr is required for Ciclo runtime development, but it is not packaged in nixpkgs.
Install it on the host, then re-run ciclo-doctor.
EOF
      exit 1
    fi

    bd --version
    bd dep cycles
    herdr --version
    quint --version
  '';

  scripts.ciclo-quint.exec = ''
    set -euo pipefail

    model="''${CICLO_QUINT_MODEL:-formal/quint/ciclo_core.qnt}"
    invariants="${quintInvariants}"

    quint parse "$model"
    quint typecheck "$model"
    quint test "$model" --verbosity=1
    quint run "$model" --max-samples=1000 --max-steps=20 --invariants $invariants --verbosity=1
    quint verify "$model" --max-steps=6 --invariants $invariants --verbosity=1
  '';

  scripts.ciclo-hooks-check.exec = ''
    set -euo pipefail

    python3 scripts/agent-gate.py --self-test
    python3 -m json.tool .claude/settings.json >/dev/null
    python3 -m json.tool .codex/hooks.json >/dev/null

    grep -q 'scripts/agent-gate.py' .claude/settings.json
    grep -q 'scripts/agent-gate.py' .codex/hooks.json
    test -f .codex/remote/README.md
    test -x scripts/codex-remote-setup.sh
    test -x scripts/codex-remote-maintenance.sh
  '';

  scripts.ciclo-python-check.exec = ''
    set -euo pipefail

    export PYTHONPATH="$PWD/src''${PYTHONPATH:+:$PYTHONPATH}"
    pytest
    ruff check src tests
    pyright src tests
    python -m build --wheel --no-isolation
  '';

  scripts.ciclo-typescript-check.exec = ''
    set -euo pipefail

    npm ci --ignore-scripts
    npm run check
    npm run demo >/dev/null
  '';

  scripts.ciclo-check.exec = ''
    set -euo pipefail

    ciclo-doctor
    ciclo-hooks-check
    ciclo-python-check
    ciclo-typescript-check
    ciclo-quint
  '';

  enterShell = ''
    echo "Ciclo devenv ready. Run: ciclo-check"
  '';
}
