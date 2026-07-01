# Ciclo EGG

EGG means Executable Golden Guide: the shortest path that proves a local Ciclo checkout can build, answer status, run benchmarks, and expose MCP.

Run these commands from the repository root.

## 1. Enter The Dev Shell

```bash
devenv shell
```

If you do not want an interactive shell, prefix the commands with `devenv shell`, or use the matching `just` recipes.

## 2. Prove The Toolchain

```bash
ciclo-doctor
npm ci --ignore-scripts
npm run build
```

`ciclo-doctor` checks the external runtime tools Ciclo depends on: Beads (`bd`), Herdr, Dolt, Quint, Node, Python, SSH, and supporting CLIs.

## 3. Ask Ciclo For Help And Status

Use the built CLI directly:

```bash
node dist/src/cli.js --help
node dist/src/cli.js status --compact
node dist/src/cli.js runtime
npm run demo
```

After `npm link`, the same commands are available as `ciclo --help`, `ciclo status`, and `ciclo runtime`.

Expected shape:

- `--help` prints command and option help.
- `status` returns the standalone Ciclo status document.
- `runtime` says Ciclo is the standalone orchestrator and Pi is an internal brain provider.
- `demo` emits the current demo status JSON.

## 4. Run A Benchmark Pass

```bash
node dist/src/cli.js benchmark --scenario-dir tests/fixtures/benchmarks
```

This runs the deterministic fixture suite used to score Ciclo's response behavior across review, deploy, Beads, MCP, auth, context, and remote-session scenarios.

## 5. Start MCP

For stdio clients such as Claude Code or Codex MCP configuration:

```bash
node dist/src/cli.js mcp stdio
```

For local HTTP MCP experiments:

```bash
node dist/src/cli.js mcp http --host 127.0.0.1 --port 7331 --path /mcp
```

The HTTP server listens on:

```text
http://127.0.0.1:7331/mcp
```

## 6. Run The Full Gate

```bash
just check
```

That runs the agent gate self-test, Python transitional checks, TypeScript build and tests, demo smoke test, and Quint model checks.
