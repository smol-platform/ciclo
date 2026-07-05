import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildStandaloneStatus } from "../src/app.js";
import {
  createLocalMcpRuntimeContextWithPlugins,
  handleMcpRequest,
  type CicloMcpReadService
} from "../src/mcp-stdio.js";
import {
  openAiBrainIntelligence,
  openAiBrainModelFamily,
  openAiBrainPolicy,
  type OpenAiBrain,
  type OpenAiBrainDecision,
  type OpenAiBrainDecisionInput,
  type OpenAiBrainStatus
} from "../src/openai-brain.js";

class IntegrationBrain implements OpenAiBrain {
  status(): OpenAiBrainStatus {
    return openAiBrainPolicy;
  }

  async decide(input: OpenAiBrainDecisionInput): Promise<OpenAiBrainDecision> {
    return {
      provider: "openai",
      adapter: "pi-sdk",
      intelligence: openAiBrainIntelligence,
      modelFamily: openAiBrainModelFamily,
      model: openAiBrainPolicy.model,
      thinking: openAiBrainPolicy.thinking,
      purpose: input.purpose,
      text: "Keep monitoring and surface the next needed operator action.",
      evidence: ["brain.provider:openai", `brain.purpose:${input.purpose}`, "integration.fixture:brain"]
    };
  }
}

const service: CicloMcpReadService = {
  async status() {
    return buildStandaloneStatus();
  },
  async loopStatus(loopId) {
    return {
      loop: {
        id: loopId,
        kind: "review",
        state: "monitor",
        harnesses: ["codex"],
        dryRun: true
      },
      goal: "Monitor integration events.",
      policy: {
        mutations: "disabled_in_test",
        networkListener: false,
        access: "single_user"
      },
      currentWork: null,
      evidence: ["integration.service:loop"]
    };
  },
  async readyWork() {
    return {
      selected: null,
      work: [],
      skipped: [],
      evidence: ["integration.service:ready"]
    };
  },
  async questions() {
    return [];
  },
  async feedback() {
    return [];
  }
};

test("MCP brain decisions are visible through ciclo events CLI", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ciclo-events-integration-"));
  try {
    const runtime = {
      ...(await createLocalMcpRuntimeContextWithPlugins(tempDir)),
      openAiBrain: new IntegrationBrain()
    };

    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: {
          name: "ciclo_decide",
          arguments: {
            purpose: "remote_session_monitoring",
            loop_id: "integration-loop",
            worker_session_id: "worker-integration",
            prompt: "Worker has been quiet; decide whether to wait or ask the operator.",
            context: ["worker state: running", "last heartbeat: 2m ago"],
            evidence: ["integration.worker:silent"]
          }
        }
      },
      service,
      runtime
    );
    assert.ok(response !== undefined && "result" in response, JSON.stringify(response));

    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const cli = spawnSync(process.execPath, [
      cliPath,
      "events",
      "--project",
      tempDir,
      "--follow",
      "--once",
      "--compact"
    ], {
      cwd: tempDir,
      encoding: "utf8"
    });

    assert.equal(cli.status, 0, cli.stderr);
    const payload = JSON.parse(cli.stdout) as {
      next_cursor?: number;
      events?: readonly {
        type?: string;
        loopId?: string;
        workerSessionId?: string;
        data?: { purpose?: string; provider?: string; intelligence?: string };
        evidence?: readonly string[];
      }[];
    };
    assert.ok((payload.next_cursor ?? 0) >= 1);
    const event = payload.events?.find((candidate) => candidate.type === "brain.decision");
    assert.ok(event, JSON.stringify(payload.events));
    assert.equal(event?.type, "brain.decision");
    assert.equal(event?.loopId, "integration-loop");
    assert.equal(event?.workerSessionId, "worker-integration");
    assert.equal(event?.data?.purpose, "remote_session_monitoring");
    assert.equal(event?.data?.provider, "openai");
    assert.equal(event?.data?.intelligence, "model_backed");
    assert.ok(event?.evidence?.includes("integration.fixture:brain"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
