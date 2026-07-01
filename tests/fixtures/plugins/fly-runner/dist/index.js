export function activate(api) {
  api.remoteRunners.register({
    kind: "fly",
    name: "fly-machines",
    executionModel: "fly_machine",
    plan(input, wireGuard) {
      const runnerId = input.runnerId ?? "ciclo-fly-runner";
      return {
        providerName: "fly-machines",
        executionModel: "fly_machine",
        commands: [
          `fly machines run ${input.image} --name ${runnerId}`
        ],
        artifacts: [
          {
            name: `${runnerId}.bootstrap.sh`,
            format: "shell",
            content: [
              "set -euo pipefail",
              `export CICLO_REPO_PATH=${input.repoPath}`,
              `export CICLO_HERDR_SESSION=${input.herdrSession ?? "ciclo"}`,
              `export WG_CONFIG='${wireGuard.runnerConfig}'`,
              "ciclo-wg-up \"$WG_CONFIG\"",
              "herdr session start \"$CICLO_HERDR_SESSION\" --cwd \"$CICLO_REPO_PATH\""
            ].join("\n")
          }
        ],
        warnings: [],
        evidence: [
          "remote.runner.plugin:fly-machines",
          "remote.runner.execution_model:fly_machine"
        ]
      };
    }
  });
}
