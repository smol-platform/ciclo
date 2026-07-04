import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("GitHub Actions builds and publishes the Ciclo runner image", () => {
  const workflow = readFileSync(".github/workflows/images.yml", "utf8");

  assert.match(workflow, /name: images/);
  assert.match(workflow, /REGISTRY: ghcr\.io/);
  assert.match(workflow, /IMAGE_NAME: \$\{\{ github\.repository \}\}/);
  assert.match(workflow, /docker\/metadata-action@v5/);
  assert.match(workflow, /docker\/build-push-action@v6/);
  assert.match(workflow, /cachix\/install-nix-action@v27/);
  assert.match(workflow, /nix-instantiate --parse nix\/runner-images\.nix/);
  assert.match(workflow, /base\n\s+- codex\n\s+- claude\n\s+- full/);
  assert.match(workflow, /RUNNER_VARIANT=\$\{\{ matrix\.variant \}\}/);
  assert.match(workflow, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(workflow, /push: \$\{\{ github\.event_name != 'pull_request' \}\}/);
  assert.match(workflow, /type=raw,value=\$\{\{ matrix\.variant \}\}-latest/);
  assert.match(workflow, /type=semver,pattern=\$\{\{ matrix\.variant \}\}-\{\{version\}\}/);
});

test("Nix dockerTools runner variants package Ciclo and harness dependencies", () => {
  const runnerImages = readFileSync("nix/runner-images.nix", "utf8");

  assert.match(runnerImages, /pkgs\.dockerTools\.buildLayeredImage/);
  assert.match(runnerImages, /ghcr\.io\/smol-platform\/ciclo/);
  assert.match(runnerImages, /tag = "\$\{variant\}-latest"/);
  assert.match(runnerImages, /devenv/);
  assert.match(runnerImages, /claude-code/);
  assert.match(runnerImages, /codex/);
  assert.match(runnerImages, /wireguard-tools/);
});

test("Dockerfile packages Ciclo, Herdr, and remote runner tools", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");

  assert.match(dockerfile, /FROM node:\$\{NODE_VERSION\} AS build/);
  assert.match(dockerfile, /ARG RUNNER_VARIANT=base/);
  assert.match(dockerfile, /npm run build/);
  assert.match(dockerfile, /https:\/\/herdr\.dev\/install\.sh/);
  assert.match(dockerfile, /@anthropic-ai\/claude-code/);
  assert.match(dockerfile, /@openai\/codex/);
  assert.match(dockerfile, /wireguard-tools/);
  assert.match(dockerfile, /openssh-client/);
  assert.match(dockerfile, /ln -s \/app\/dist\/src\/cli\.js \/usr\/local\/bin\/ciclo/);
  assert.match(dockerfile, /ENTRYPOINT \["ciclo"\]/);
});

test("Docker build context excludes generated files and secret-shaped inputs", () => {
  const dockerignore = readFileSync(".dockerignore", "utf8");

  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^dist$/m);
  assert.match(dockerignore, /^\.\[e\]nv\*$/m);
  assert.match(dockerignore, /^\*\.pem$/m);
  assert.match(dockerignore, /^\*\.key$/m);
});
