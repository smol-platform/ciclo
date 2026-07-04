{ pkgs ? import <nixpkgs> { } }:

let
  nodejs = pkgs.nodejs_24;

  cicloApp = pkgs.stdenvNoCC.mkDerivation {
    pname = "ciclo-app";
    version = "0.1.7";
    src = ../.;

    nativeBuildInputs = [
      nodejs
      pkgs.rsync
    ];

    buildPhase = ''
      runHook preBuild
      export HOME="$TMPDIR/home"
      mkdir -p "$HOME"
      npm ci --ignore-scripts
      npm run build
      npm ci --omit=dev --ignore-scripts
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      install -d "$out/app" "$out/bin"
      rsync -a dist package.json package-lock.json node_modules "$out/app/"
      install -m 0755 dist/src/cli.js "$out/bin/ciclo"
      install -m 0755 dist/src/demo.js "$out/bin/ciclo-demo"
      install -m 0755 dist/src/mcp-http-cli.js "$out/bin/ciclo-mcp-http"
      install -m 0755 dist/src/mcp-stdio-cli.js "$out/bin/ciclo-mcp-stdio"
      runHook postInstall
    '';
  };

  maybe = name:
    if builtins.hasAttr name pkgs
    then [ (builtins.getAttr name pkgs) ]
    else [ ];

  commonTools = with pkgs; [
    bashInteractive
    cacert
    coreutils
    curl
    git
    gnused
    iproute2
    jq
    nodejs
    openssh
    wireguard-tools
  ];

  buildTooling = with pkgs; [
    gh
    just
    python313
  ] ++ maybe "devenv" ++ maybe "bd";

  codexTools = maybe "codex";
  claudeTools = maybe "claude-code";
  herdrTools = maybe "herdr";

  image = variant: extraTools:
    pkgs.dockerTools.buildLayeredImage {
      name = "ghcr.io/smol-platform/ciclo";
      tag = "${variant}-latest";
      contents = commonTools ++ [ cicloApp ] ++ extraTools;
      config = {
        Entrypoint = [ "${cicloApp}/bin/ciclo" ];
        Cmd = [ "--help" ];
        Env = [
          "NODE_ENV=production"
          "PATH=${cicloApp}/bin:${nodejs}/bin:/bin"
        ];
        WorkingDir = "/workspace";
        Labels = {
          "org.opencontainers.image.title" = "ciclo-${variant}";
          "org.opencontainers.image.description" = "Ciclo remote runner ${variant} image built with Nix dockerTools";
          "org.opencontainers.image.source" = "https://github.com/smol-platform/ciclo";
          "dev.ciclo.runner.variant" = variant;
        };
      };
    };
in
{
  base = image "base" [ ];
  codex = image "codex" (buildTooling ++ herdrTools ++ codexTools);
  claude = image "claude" (buildTooling ++ herdrTools ++ claudeTools);
  full = image "full" (buildTooling ++ herdrTools ++ codexTools ++ claudeTools);
}
