import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import type { AccessGrant } from "../src/access-grants.js";
import { buildStandaloneStatus } from "../src/app.js";
import { DeviceAuthorizationFlow } from "../src/auth-device-flow.js";
import type { BeadsTaskSnapshot } from "../src/beads-adapter.js";
import { BeadsRemoteTrackerSync } from "../src/beads-tracker-sync.js";
import { CicloEventStore } from "../src/ciclo-events.js";
import type { LoopConfig } from "../src/ciclo-core.js";
import type { PolicyConfig } from "../src/loop-config.js";
import { OperatorRoutingStore } from "../src/operator-routing.js";
import { defaultPluginPaths, installPlugin } from "../src/plugin-manager.js";
import type {
  OpenAiBrain,
  OpenAiBrainDecision,
  OpenAiBrainDecisionInput,
  OpenAiBrainStatus
} from "../src/openai-brain.js";
import { openAiBrainPolicy } from "../src/openai-brain.js";
import { RemoteRunnerRegistry } from "../src/remote-runner.js";
import { SecretProviderRegistry, secretRefHash } from "../src/secret-provider.js";
import type { RepoBoardProvider, RepoBoardStatus } from "../src/repo-board.js";
import { createSingleUserSession, type CicloSession } from "../src/session-access.js";
import { TokenRegistry } from "../src/token-store.js";
import {
  WorkerSessionSupervisor,
  type WorkerProcessHandle,
  type WorkerProcessLauncher
} from "../src/worker-session-supervisor.js";
import {
  createLocalMcpRuntimeContextWithPlugins,
  handleMcpRequest,
  runMcpStdioServer,
  type CicloMcpRuntimeContext,
  type CicloMcpReadService,
  type JsonRpcResponse,
  type LoopStatus
} from "../src/mcp-stdio.js";
import { CICLO_VERSION } from "../src/version.js";

const fixtureSecretPluginPath = resolve("tests/fixtures/plugins/keychain-secrets");

const readyTask: BeadsTaskSnapshot = {
  id: "ciclo-demo.1",
  title: "Demo ready work",
  status: "open",
  priority: 1,
  issueType: "task",
  description: "Ready task fixture.",
  acceptanceCriteria: "Visible through MCP.",
  specId: "SPEC-CICLO-001",
  labels: ["mcp"],
  dependencies: [],
  externalRefs: []
};

function loopStatus(loopId: string): LoopStatus {
  return {
    loop: {
      id: loopId,
      kind: "review",
      state: "build_context_pack",
      harnesses: ["codex", "claude-code"],
      dryRun: true
    },
    goal: "Review completed work.",
    policy: {
      mutations: "disabled_in_local_status_mode",
      networkListener: false,
      access: "single_user"
    },
    currentWork: null,
    evidence: ["fixture:loop"]
  };
}

const service: CicloMcpReadService = {
  async status() {
    return buildStandaloneStatus();
  },
  async loopStatus(loopId) {
    return loopStatus(loopId);
  },
  async readyWork(limit = 20) {
    return {
      selected: readyTask,
      work: [readyTask].slice(0, limit),
      skipped: [],
      evidence: ["fixture:ready"]
    };
  },
  async questions() {
    return [
      {
        questionId: "q-1",
        loopId: "review-demo",
        question: "Should Ciclo continue?",
        urgency: "normal"
      }
    ];
  },
  async feedback() {
    return [
      {
        feedbackId: "f-1",
        loopId: "review-demo",
        severity: "warning",
        message: "Validation is still pending.",
        evidence: ["fixture:feedback"]
      }
    ];
  }
};

const singleRuntime: CicloMcpRuntimeContext = {
  auth: {
    session: createSingleUserSession({
      id: "session-local",
      ownerPrincipalId: "owner:zach",
      projectRoot: "/repo"
    }),
    origin: "mcp_stdio",
    grants: [],
    tokenRegistry: new TokenRegistry({ nowMs: () => 0 })
  },
  deviceFlow: new DeviceAuthorizationFlow({
    verificationUri: "https://ciclo.local/device",
    nowMs: () => 0,
    codeBytes: () => Buffer.from("0123456789abcdef0123456789abcdef", "hex")
  })
};

class FakeWorkerHandle implements WorkerProcessHandle {
  readonly pid = 8686;
  onExit(): void {}
  stop(): boolean {
    return true;
  }
}

class FakeWorkerLauncher implements WorkerProcessLauncher {
  launch(): WorkerProcessHandle {
    return new FakeWorkerHandle();
  }
}

class FakeRepoBoardProvider implements RepoBoardProvider {
  constructor(private readonly prState = "OPEN", private readonly conclusion = "SUCCESS") {}

  statusForBranch(branch: string | undefined): RepoBoardStatus {
    return {
      pullRequests: branch === undefined || this.prState === "NONE" ? [] : [{ number: 42, state: this.prState, head_ref: branch, url: "https://example.test/pr/42" }],
      ci: branch === undefined || this.conclusion === "NONE" ? [] : [{ name: "check", status: "COMPLETED", conclusion: this.conclusion }],
      mergeState: branch === undefined ? undefined : this.prState === "MERGED" ? "MERGED" : "CLEAN",
      evidence: branch === undefined ? ["fake.repo_board.branch:missing"] : [`fake.repo_board.branch:${branch}`]
    };
  }
}

class FakeOpenAiBrain implements OpenAiBrain {
  readonly inputs: OpenAiBrainDecisionInput[] = [];

  status(): OpenAiBrainStatus {
    return openAiBrainPolicy;
  }

  async decide(input: OpenAiBrainDecisionInput): Promise<OpenAiBrainDecision> {
    this.inputs.push(input);
    return {
      provider: "openai",
      adapter: "pi-sdk",
      model: openAiBrainPolicy.model,
      thinking: openAiBrainPolicy.thinking,
      purpose: input.purpose,
      text: "Insert a small context pack, then ask the worker to continue.",
      evidence: ["brain.provider:openai", `brain.purpose:${input.purpose}`]
    };
  }
}

function resultOf(response: JsonRpcResponse | undefined): unknown {
  assert.ok(response);
  assert.ok("result" in response, JSON.stringify(response));
  return response.result;
}

function structuredContent(response: JsonRpcResponse | undefined): Record<string, unknown> {
  const result = resultOf(response) as Record<string, unknown>;
  return result.structuredContent as Record<string, unknown>;
}

function resourcePayload(response: JsonRpcResponse | undefined): Record<string, unknown> {
  const result = resultOf(response) as Record<string, unknown>;
  const contents = result.contents as readonly Record<string, unknown>[];
  assert.equal(contents.length, 1);
  return JSON.parse(contents[0]?.text as string) as Record<string, unknown>;
}

function fakeMutationClient(initial: BeadsTaskSnapshot) {
  const tasks = new Map<string, BeadsTaskSnapshot>([[initial.id, initial]]);
  const notes: string[] = [];
  const claims: string[] = [];
  const closes: string[] = [];
  return {
    notes,
    claims,
    closes,
    async ready() {
      return [...tasks.values()].filter((task) => task.status === "open");
    },
    async show(id: string) {
      const task = tasks.get(id);
      if (task === undefined) throw new Error(`missing task ${id}`);
      return task;
    },
    async claim(id: string) {
      const before = await this.show(id);
      const after = { ...before, status: "in_progress" };
      tasks.set(id, after);
      claims.push(id);
      return after;
    },
    async note(id: string, message: string) {
      await this.show(id);
      notes.push(`${id}:${message}`);
    },
    async close(id: string, reason: string) {
      const before = await this.show(id);
      const after = { ...before, status: "closed" };
      tasks.set(id, after);
      closes.push(`${id}:${reason}`);
      return after;
    }
  };
}

const activeLoop: LoopConfig = {
  id: "review-demo",
  kind: "beads_work",
  goal: "Work through Beads.",
  harnesses: ["codex", "claude-code"],
  dryRun: false
};

const supervisedPolicy: PolicyConfig = {
  mode: "supervised",
  requireApprovalFor: [],
  allowCommands: []
};

test("local MCP stdio handler exposes catalog capabilities", async () => {
  const initialize = resultOf(
    await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, service, singleRuntime)
  ) as Record<string, unknown>;
  assert.deepEqual(initialize.serverInfo, { name: "ciclo", version: CICLO_VERSION });

  const tools = resultOf(
    await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, service, singleRuntime)
  ) as Record<string, unknown>;
  assert.ok((tools.tools as readonly unknown[]).some((tool) => (tool as { name?: string }).name === "ciclo_status"));

  const resources = resultOf(
    await handleMcpRequest({ jsonrpc: "2.0", id: 3, method: "resources/list" }, service, singleRuntime)
  ) as Record<string, unknown>;
  assert.ok((resources.resources as readonly unknown[]).some((resource) => (resource as { uri?: string }).uri === "ciclo://questions"));
  assert.ok((resources.resourceTemplates as readonly unknown[]).some((resource) => (resource as { uriTemplate?: string }).uriTemplate === "ciclo://loops/{loop_id}"));
});

test("local MCP stdio handler can expose Claude channel capability", async () => {
  const initialize = resultOf(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 31, method: "initialize" },
      service,
      {
        ...singleRuntime,
        claudeChannel: { enabled: true }
      }
    )
  ) as { capabilities?: { experimental?: Record<string, unknown> } };

  assert.deepEqual(initialize.capabilities?.experimental?.["claude/channel"], {});
});

test("local MCP tools answer status loop status and ready work without mutations", async () => {
  const status = structuredContent(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ciclo_status", arguments: {} } },
      service,
      singleRuntime
    )
  );
  assert.equal(status.app, "ciclo");
  assert.equal(status.live, true);
  assert.equal((status.brain as { provider?: string }).provider, "openai");

  const loop = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "ciclo_loop_status", arguments: { loop_id: "review-demo" } }
      },
      service,
      singleRuntime
    )
  );
  assert.deepEqual(loop.policy, {
    mutations: "disabled_in_local_status_mode",
    networkListener: false,
    access: "single_user"
  });

  const ready = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "ciclo_list_ready_work", arguments: { limit: 1 } }
      },
      service,
      singleRuntime
    )
  );
  assert.equal((ready.selected as { id?: string }).id, "ciclo-demo.1");
  assert.deepEqual(ready.evidence, ["fixture:ready"]);
});

test("MCP brain decision tool routes control-plane decisions through OpenAI brain", async () => {
  const eventStore = new CicloEventStore();
  const brain = new FakeOpenAiBrain();
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    eventStore,
    openAiBrain: brain
  };

  const decision = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 61,
        method: "tools/call",
        params: {
          name: "ciclo_decide",
          arguments: {
            purpose: "context_insertion",
            loop_id: "review-loop",
            bead_id: "ciclo-1",
            worker_session_id: "worker-1",
            prompt: "Worker is missing repository context.",
            context: ["diff touched authz.ts"],
            evidence: ["worker.question:needs-context"]
          }
        }
      },
      service,
      runtime
    )
  );

  assert.equal(decision.provider, "openai");
  assert.equal(decision.decision, "Insert a small context pack, then ask the worker to continue.");
  assert.equal(brain.inputs[0]?.purpose, "context_insertion");
  assert.equal(brain.inputs[0]?.prompt, "Worker is missing repository context.");
  const events = eventStore.poll(0);
  assert.ok(events.events.some((event) => event.type === "brain.decision"));
});

test("MCP secret tools resolve through registry while redacting audit and events", async () => {
  const eventStore = new CicloEventStore();
  const auditLog: NonNullable<CicloMcpRuntimeContext["auditLog"]> = [];
  const secretProviderRegistry = new SecretProviderRegistry([
    {
      id: "fixture-secrets",
      kind: "fixture",
      name: "Fixture Secrets",
      supportsFields: true,
      resolve(input) {
        return {
          resolved: true,
          providerId: "fixture-secrets",
          providerKind: "fixture",
          secretRefHash: secretRefHash(input.secretRef),
          field: input.field,
          value: "super-secret-value",
          reason: "fixture provider resolved the secret",
          evidence: [
            "secret.provider:fixture-secrets",
            "secret.kind:fixture",
            `secret.ref_hash:${secretRefHash(input.secretRef)}`,
            "secret.resolved:true"
          ]
        };
      }
    }
  ]);
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    eventStore,
    auditLog,
    secretProviderRegistry
  };

  const listed = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 611,
        method: "tools/call",
        params: { name: "ciclo_list_secret_providers", arguments: {} }
      },
      service,
      runtime
    )
  );
  assert.equal((listed.secret_providers as readonly { id?: string }[])[0]?.id, "fixture-secrets");

  const resolved = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 612,
        method: "tools/call",
        params: {
          name: "ciclo_request_secret",
          arguments: {
            provider_id: "fixture-secrets",
            secret_ref: "op://Ciclo/API/token",
            field: "token",
            loop_id: "deploy-loop",
            bead_id: "ciclo-1",
            worker_session_id: "worker-1",
            reason: "deploy validation"
          }
        }
      },
      service,
      runtime
    )
  );

  assert.equal(resolved.resolved, true);
  assert.equal(resolved.value, "super-secret-value");
  assert.equal(resolved.secret_ref_hash, secretRefHash("op://Ciclo/API/token"));
  const serializedAudit = JSON.stringify(auditLog);
  const serializedEvents = JSON.stringify(eventStore.poll(0));
  assert.ok(!serializedAudit.includes("super-secret-value"));
  assert.ok(!serializedAudit.includes("op://Ciclo/API/token"));
  assert.ok(!serializedEvents.includes("super-secret-value"));
  assert.ok(!serializedEvents.includes("op://Ciclo/API/token"));
  assert.ok(serializedEvents.includes("secret.requested"));

  const resource = resourcePayload(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 613, method: "resources/read", params: { uri: "ciclo://secret-providers" } },
      service,
      runtime
    )
  );
  assert.equal((resource.secret_providers as readonly { kind?: string }[])[0]?.kind, "fixture");
});

test("MCP runtime reads secrets through installed secret provider plugins", async () => {
  const root = mkdtempSync(join(tmpdir(), "ciclo-mcp-secret-plugin-"));
  try {
    mkdirSync(join(root, ".ciclo"), { recursive: true });
    writeFileSync(join(root, ".ciclo", "config.json"), `${JSON.stringify({
      secrets: {
        providers: [{
          id: "team-keychain",
          kind: "keychain",
          name: "Team Keychain",
          pluginProviderId: "keychain-test"
        }]
      }
    }, null, 2)}\n`);
    installPlugin({
      packageName: "@example/ciclo-secrets-keychain",
      path: fixtureSecretPluginPath,
      trust: true,
      enable: true,
      now: "2026-07-02T00:00:00.000Z"
    }, defaultPluginPaths(root));

    const runtime = await createLocalMcpRuntimeContextWithPlugins(root);
    const auditLog: NonNullable<CicloMcpRuntimeContext["auditLog"]> = [];
    const eventStore = new CicloEventStore();
    const pluginRuntime: CicloMcpRuntimeContext = {
      ...runtime,
      auditLog,
      eventStore
    };

    const listed = structuredContent(
      await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 616,
          method: "tools/call",
          params: { name: "ciclo_list_secret_providers", arguments: {} }
        },
        service,
        pluginRuntime
      )
    );
    const providers = listed.secret_providers as readonly { id?: string; kind?: string }[];
    assert.ok(providers.some((provider) => provider.id === "team-keychain" && provider.kind === "keychain"));
    assert.ok(providers.some((provider) => provider.id === "keychain-test" && provider.kind === "keychain"));

    const resolved = structuredContent(
      await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 617,
          method: "tools/call",
          params: {
            name: "ciclo_request_secret",
            arguments: {
              provider_id: "team-keychain",
              secret_ref: "keychain://ciclo/demo",
              field: "token",
              loop_id: "deploy-loop",
              bead_id: "ciclo-plugin-secret",
              reason: "resolve through installed secret provider plugin"
            }
          }
        },
        service,
        pluginRuntime
      )
    );

    assert.equal(resolved.resolved, true);
    assert.equal(resolved.provider_id, "team-keychain");
    assert.equal(resolved.provider_kind, "keychain");
    assert.equal(resolved.value, "fixture-secret");
    assert.equal(resolved.secret_ref_hash, "fixture-hash");
    const serializedAudit = JSON.stringify(auditLog);
    const serializedEvents = JSON.stringify(eventStore.poll(0));
    assert.ok(!serializedAudit.includes("fixture-secret"));
    assert.ok(!serializedAudit.includes("keychain://ciclo/demo"));
    assert.ok(!serializedEvents.includes("fixture-secret"));
    assert.ok(!serializedEvents.includes("keychain://ciclo/demo"));
    assert.ok(serializedEvents.includes("secret.requested"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP worker launch resolves plugin secrets into generated MCP config without leaking responses", async () => {
  const root = mkdtempSync(join(tmpdir(), "ciclo-mcp-secret-worker-"));
  try {
    const eventStore = new CicloEventStore();
    const auditLog: NonNullable<CicloMcpRuntimeContext["auditLog"]> = [];
    const secretProviderRegistry = new SecretProviderRegistry([
      {
        id: "fixture-secrets",
        kind: "fixture",
        name: "Fixture Secrets",
        supportsFields: true,
        resolve(input) {
          return {
            resolved: true,
            providerId: "fixture-secrets",
            providerKind: "fixture",
            secretRefHash: secretRefHash(input.secretRef),
            field: input.field,
            value: "super-secret-value",
            reason: "fixture provider resolved the secret",
            evidence: [
              "secret.provider:fixture-secrets",
              "secret.kind:fixture",
              `secret.ref_hash:${secretRefHash(input.secretRef)}`,
              "secret.resolved:true"
            ]
          };
        }
      }
    ]);
    const supervisor = new WorkerSessionSupervisor(root, new FakeWorkerLauncher(), undefined, eventStore);
    const runtime: CicloMcpRuntimeContext = {
      ...singleRuntime,
      eventStore,
      auditLog,
      secretProviderRegistry,
      workerSupervisor: supervisor
    };

    const launched = structuredContent(
      await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 614,
          method: "tools/call",
          params: {
            name: "ciclo_launch_worker_session",
            arguments: {
              harness_id: "codex",
              loop_id: "deploy-loop",
              bead_id: "ciclo-secret",
              prompt: "Use Ciclo MCP.",
              cwd: root,
              configure_mcp: true,
              mcp_clients: ["codex"],
              mcp_secret_env: [
                {
                  env_name: "API_TOKEN",
                  provider_id: "fixture-secrets",
                  secret_ref: "op://Ciclo/API/token",
                  format: "Bearer ${secret}",
                  reason: "provide API token to worker MCP"
                }
              ]
            }
          }
        },
        service,
        runtime
      )
    );

    assert.equal(launched.state, "running");
    assert.doesNotMatch(JSON.stringify(launched), /super-secret-value/);
    const mcpConfig = launched.mcp_config as Record<string, unknown>;
    assert.equal((mcpConfig.secretEnv as readonly { name?: string; formatApplied?: boolean }[])[0]?.name, "API_TOKEN");
    assert.equal((mcpConfig.secretEnv as readonly { name?: string; formatApplied?: boolean }[])[0]?.formatApplied, true);
    assert.equal(mcpConfig.secretEnvBindings, undefined);

    const config = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    assert.match(config, /API_TOKEN = "Bearer super-secret-value"/);

    const listed = structuredContent(
      await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 615,
          method: "tools/call",
          params: { name: "ciclo_list_worker_sessions", arguments: {} }
        },
        service,
        runtime
      )
    );
    assert.doesNotMatch(JSON.stringify(listed), /super-secret-value/);
    assert.doesNotMatch(JSON.stringify(auditLog), /super-secret-value|op:\/\/Ciclo\/API\/token/);
    assert.doesNotMatch(JSON.stringify(eventStore.poll(0)), /super-secret-value|op:\/\/Ciclo\/API\/token/);
    assert.ok(JSON.stringify(eventStore.poll(0)).includes("mcp.secret_env.format:applied"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP worker session tools let Ciclo plan and list managed workers", async () => {
  const eventStore = new CicloEventStore();
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    eventStore,
    workerSupervisor: new WorkerSessionSupervisor("/repo", undefined, undefined, eventStore),
    repoBoardProvider: new FakeRepoBoardProvider(),
    repoBoardEventKeys: new Set<string>()
  };

  const launched = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 61,
        method: "tools/call",
        params: {
          name: "ciclo_launch_worker_session",
          arguments: {
            harness_id: "codex",
            loop_id: "loop-1",
            bead_id: "ciclo-774",
            model: "gpt-5.5",
            prompt: "Use Ciclo MCP to complete the work.",
            extra_args: ["--profile", "bench"],
            create_worktree: true,
            worktree_path: "../ciclo-mcp-worker",
            worktree_branch: "ciclo-mcp-worker",
            configure_mcp: true,
            mcp_clients: ["codex", "claude"],
            mcp_server_name: "ciclo_worker",
            mcp_command: "ciclo-dev",
            mcp_additional_servers: {
              filesystem: {
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
                env: { MCP_FS_MODE: "stdio" }
              }
            },
            dry_run: true
          }
        }
      },
      service,
      runtime
    )
  );

  assert.equal(launched.harness_id, "codex");
  assert.equal(launched.state, "planned");
  assert.equal(launched.command, "codex");
  assert.ok((launched.args as readonly string[]).includes("gpt-5.5"));
  assert.deepEqual(launched.extra_args, ["--profile", "bench"]);
  assert.ok((launched.args as readonly string[]).includes("--profile"));
  assert.equal((launched.worktree as { branch?: string }).branch, "ciclo-mcp-worker");
  assert.equal(launched.cwd, (launched.worktree as { path?: string }).path);
  assert.deepEqual((launched.mcp_config as { clients?: readonly string[] }).clients, ["codex", "claude"]);
  assert.equal((launched.mcp_config as { serverName?: string }).serverName, "ciclo_worker");
  assert.deepEqual((launched.mcp_config as { additionalServerNames?: readonly string[] }).additionalServerNames, ["filesystem"]);
  assert.equal(((launched.mcp_config as { install?: { targets?: readonly unknown[] } }).install?.targets ?? []).length, 2);

  const listed = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 62,
        method: "tools/call",
        params: { name: "ciclo_list_worker_sessions", arguments: {} }
      },
      service,
      runtime
    )
  );
  assert.equal((listed.worker_sessions as readonly unknown[]).length, 1);

  const loop = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 621,
        method: "tools/call",
        params: { name: "ciclo_loop_status", arguments: { loop_id: "loop-1" } }
      },
      service,
      runtime
    )
  );
  assert.equal((loop.loop as { id?: string }).id, "loop-1");
  assert.equal((loop.loop as { state?: string }).state, "planned");

  const status = structuredContent(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 622, method: "tools/call", params: { name: "ciclo_status", arguments: {} } },
      service,
      runtime
    )
  );
  assert.equal((status.workers as { total?: number }).total, 1);

  const board = structuredContent(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 623, method: "tools/call", params: { name: "ciclo_board", arguments: {} } },
      service,
      runtime
    )
  );
  const workerRow = (board.rows as readonly { worker_session_id?: string; pull_requests?: readonly unknown[]; ci?: readonly unknown[]; validation?: readonly unknown[]; merge_state?: string }[])
    .find((row) => row.worker_session_id === launched.session_id);
  assert.ok(workerRow);
  assert.equal(workerRow.pull_requests?.length, 1);
  assert.equal(workerRow.ci?.length, 1);
  assert.equal(workerRow.validation?.length, 1);
  assert.equal(workerRow.merge_state, "CLEAN");

  const events = structuredContent(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 624, method: "tools/call", params: { name: "ciclo_poll_events", arguments: { cursor: 0 } } },
      service,
      runtime
    )
  );
  assert.ok((events.events as readonly { type?: string }[]).some((event) => event.type === "worker.state_change"));
  assert.ok((events.events as readonly { type?: string }[]).some((event) => event.type === "pull_request.opened"));
  assert.ok((events.events as readonly { type?: string }[]).some((event) => event.type === "validation.passed"));

  const resource = resourcePayload(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 63, method: "resources/read", params: { uri: "ciclo://worker-sessions" } },
      service,
      runtime
    )
  );
  assert.equal((resource.worker_sessions as readonly unknown[]).length, 1);
});

test("MCP board emits merged PR and failed validation events once", async () => {
  const eventStore = new CicloEventStore();
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    eventStore,
    workerSupervisor: new WorkerSessionSupervisor("/repo", undefined, undefined, eventStore),
    repoBoardProvider: new FakeRepoBoardProvider("MERGED", "FAILURE"),
    repoBoardEventKeys: new Set<string>()
  };

  const launched = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 631,
        method: "tools/call",
        params: {
          name: "ciclo_launch_worker_session",
          arguments: {
            harness_id: "codex",
            loop_id: "loop-merged",
            bead_id: "ciclo-merged",
            prompt: "Use Ciclo MCP to complete the work.",
            create_worktree: true,
            worktree_branch: "ciclo-merged",
            dry_run: true
          }
        }
      },
      service,
      runtime
    )
  );

  await handleMcpRequest(
    { jsonrpc: "2.0", id: 632, method: "tools/call", params: { name: "ciclo_board", arguments: {} } },
    service,
    runtime
  );
  await handleMcpRequest(
    { jsonrpc: "2.0", id: 633, method: "tools/call", params: { name: "ciclo_board", arguments: {} } },
    service,
    runtime
  );

  const events = structuredContent(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 634, method: "tools/call", params: { name: "ciclo_poll_events", arguments: { cursor: 0 } } },
      service,
      runtime
    )
  );
  const matchingEvents = (events.events as readonly { type?: string; workerSessionId?: string }[])
    .filter((event) => event.workerSessionId === launched.session_id);
  assert.equal(matchingEvents.filter((event) => event.type === "pull_request.merged").length, 1);
  assert.equal(matchingEvents.filter((event) => event.type === "validation.failed").length, 1);
});

test("MCP board flags workers that miss the expected PR artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "ciclo-mcp-pr-missing-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" });
  spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "init"], {
    cwd: root,
    encoding: "utf8"
  });
  const eventStore = new CicloEventStore();
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    auth: {
      ...singleRuntime.auth,
      session: createSingleUserSession({
        id: "session-local",
        ownerPrincipalId: "owner:zach",
        projectRoot: root
      })
    },
    eventStore,
    workerSupervisor: new WorkerSessionSupervisor(root, new FakeWorkerLauncher(), {
      now: () => "2026-06-30T00:00:00.000Z"
    }, eventStore),
    repoBoardProvider: new FakeRepoBoardProvider("NONE", "NONE"),
    repoBoardEventKeys: new Set<string>()
  };

  const launched = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 635,
        method: "tools/call",
        params: {
          name: "ciclo_launch_worker_session",
          arguments: {
            harness_id: "codex",
            loop_id: "loop-missing-pr",
            bead_id: "ciclo-missing-pr",
            prompt: "Open a PR when done.",
            create_worktree: true,
            worktree_branch: "ciclo-missing-pr"
          }
        }
      },
      service,
      runtime
    )
  );

  const board = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 636,
        method: "tools/call",
        params: { name: "ciclo_board", arguments: { expected_pr_after_ms: 1 } }
      },
      service,
      runtime
    )
  );
  const row = (board.rows as readonly { worker_session_id?: string; artifact_status?: string; recovery_actions?: readonly string[] }[])
    .find((entry) => entry.worker_session_id === launched.session_id);
  assert.equal(row?.artifact_status, "expected_pr_missing");
  assert.ok(row?.recovery_actions?.some((action) => action.includes("relaunch")));

  const events = structuredContent(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 637, method: "tools/call", params: { name: "ciclo_poll_events", arguments: { cursor: 0 } } },
      service,
      runtime
    )
  );
  assert.ok((events.events as readonly { type?: string; data?: { kind?: string } }[])
    .some((event) => event.type === "blocker.raised" && event.data?.kind === "expected_pr_missing"));
});

test("MCP worker sessions expose waiting heartbeat stalled and usage rollups", async () => {
  let now = "2026-06-30T00:00:00.000Z";
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    operatorRouting: new OperatorRoutingStore(),
    workerSupervisor: new WorkerSessionSupervisor("/repo", new FakeWorkerLauncher(), {
      now: () => now
    })
  };

  const launched = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 641,
        method: "tools/call",
        params: {
          name: "ciclo_launch_worker_session",
          arguments: {
            harness_id: "codex",
            loop_id: "loop-live",
            bead_id: "ciclo-live",
            prompt: "Use Ciclo MCP to complete the work."
          }
        }
      },
      service,
      runtime
    )
  );
  const sessionId = launched.session_id as string;
  assert.equal(launched.state, "running");

  now = "2026-06-30T00:01:00.000Z";
  const question = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 642,
        method: "tools/call",
        params: {
          name: "ciclo_ask_operator",
          arguments: {
            loop_id: "loop-live",
            bead_id: "ciclo-live",
            worker_session_id: sessionId,
            question: "Merge this risky change?",
            urgency: "blocking"
          }
        }
      },
      service,
      runtime
    )
  );
  assert.equal(((question.waiting_workers as readonly { state?: string }[])[0])?.state, "waiting_on_operator");

  const waitingStatus = structuredContent(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 643, method: "tools/call", params: { name: "ciclo_status", arguments: {} } },
      service,
      runtime
    )
  );
  assert.equal(((waitingStatus.workers as { by_state?: Record<string, number> }).by_state ?? {}).waiting_on_operator, 1);

  now = "2026-06-30T00:02:00.000Z";
  const answer = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 644,
        method: "tools/call",
        params: {
          name: "ciclo_answer_question",
          arguments: {
            question_id: question.question_id,
            answer: "Proceed after validation passes."
          }
        }
      },
      service,
      runtime
    )
  );
  assert.equal(((answer.resumed_workers as readonly { state?: string }[])[0])?.state, "running");

  now = "2026-06-30T00:03:00.000Z";
  const heartbeat = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 645,
        method: "tools/call",
        params: {
          name: "ciclo_heartbeat_worker_session",
          arguments: {
            worker_session_id: sessionId,
            input_tokens: 12,
            output_tokens: 7,
            cost_usd: 0.03,
            evidence: ["progress"]
          }
        }
      },
      service,
      runtime
    )
  );
  assert.deepEqual(heartbeat.usage, { inputTokens: 12, outputTokens: 7, costUsd: 0.03 });

  now = "2026-06-30T00:20:00.000Z";
  const board = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 646,
        method: "tools/call",
        params: { name: "ciclo_board", arguments: { stale_after_ms: 5 * 60 * 1000 } }
      },
      service,
      runtime
    )
  );
  const rollup = board.rollup as { workers?: { by_state?: Record<string, number>; usage?: Record<string, number> } };
  assert.equal(rollup.workers?.by_state?.stalled, 1);
  assert.equal(rollup.workers?.usage?.input_tokens, 12);

  const events = structuredContent(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 647, method: "tools/call", params: { name: "ciclo_poll_events", arguments: { cursor: 0 } } },
      service,
      runtime
    )
  );
  assert.ok((events.events as readonly { type?: string }[]).some((event) => event.type === "worker.stalled"));
});

test("MCP remote runner tools plan WireGuard Herdr runner environments", async () => {
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    remoteRunnerRegistry: new RemoteRunnerRegistry(),
    projectConfig: {
      mcp: {
        clients: ["claude", "codex"],
        serverName: "ciclo_remote",
        command: "ciclo",
        vars: { CICLO_REUSE_HERDR_SESSION: "true" }
      }
    }
  };

  const launched = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 64,
        method: "tools/call",
        params: {
          name: "ciclo_launch_remote_runner",
          arguments: {
            runner_kind: "kubernetes",
            runner_id: "runner-k8s-1",
            loop_id: "loop-remote",
            bead_id: "ciclo-remote.1",
            harness_id: "codex",
            image: "ghcr.io/acme/ciclo-runner:latest",
            repo_path: "/workspace/project",
            prompt: "Use Ciclo MCP and report progress.",
            herdr_session: "ciclo",
            ssh_user: "ciclo",
            wireguard: {
              runner_address: "10.66.0.8/24",
              ciclo_endpoint: "198.51.100.10:51820"
            },
            kubernetes: {
              namespace: "ciclo-runners",
              job_name: "runner-k8s-1"
            },
            dry_run: true
          }
        }
      },
      service,
      runtime
    )
  );

  assert.equal(launched.accepted, true);
  assert.equal(launched.runner_kind, "kubernetes");
  assert.equal(launched.provider_name, "kubernetes-job");
  assert.equal(launched.execution_model, "kubernetes_job");
  assert.equal(launched.herdr_remote_target, "ciclo@10.66.0.8:/workspace/project");
  assert.deepEqual((launched.mcp_config as { clients?: readonly string[] }).clients, ["claude", "codex"]);
  assert.equal((launched.mcp_config as { serverName?: string }).serverName, "ciclo_remote");
  assert.ok(((launched.mcp_config as { artifacts?: readonly { name?: string }[] }).artifacts ?? []).some((artifact) => artifact.name === ".mcp.json"));
  assert.ok((launched.commands as readonly string[]).some((command) => command.includes("kubectl")));

  const attach = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 65,
        method: "tools/call",
        params: {
          name: "ciclo_attach_plan",
          arguments: {
            herdr_target: "ciclo@10.66.0.8:/workspace/project",
            herdr_session: "ciclo",
            agent_target: "pane-1"
          }
        }
      },
      service,
      runtime
    )
  );
  assert.deepEqual(attach.args, [
    "--remote",
    "ciclo@10.66.0.8:/workspace/project",
    "--session",
    "ciclo",
    "agent",
    "attach",
    "pane-1"
  ]);

  const listed = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 66,
        method: "tools/call",
        params: { name: "ciclo_list_remote_runners", arguments: {} }
      },
      service,
      runtime
    )
  );
  assert.equal((listed.remote_runners as readonly unknown[]).length, 1);

  const resource = resourcePayload(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 67, method: "resources/read", params: { uri: "ciclo://remote-runners" } },
      service,
      runtime
    )
  );
  assert.equal((resource.remote_runners as readonly unknown[]).length, 1);
});

test("local MCP resources expose pending questions and feedback queues", async () => {
  const questions = resourcePayload(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "ciclo://questions" } },
      service,
      singleRuntime
    )
  );
  assert.equal(((questions.questions as readonly { questionId: string }[])[0])?.questionId, "q-1");

  const feedback = resourcePayload(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 8, method: "resources/read", params: { uri: "ciclo://feedback" } },
      service,
      singleRuntime
    )
  );
  assert.equal(((feedback.feedback as readonly { feedbackId: string }[])[0])?.feedbackId, "f-1");
});

test("local MCP stdio server processes newline JSON-RPC on stdio", async () => {
  const input = Readable.from([
    `${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })}\n`,
    `${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "resources/read", params: { uri: "ciclo://work/ready" } })}\n`
  ]);
  let output = "";
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    }
  });

  await runMcpStdioServer(input, writable, service, singleRuntime);

  const responses = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as JsonRpcResponse);
  assert.equal(responses.length, 2);
  assert.equal(responses[0]?.id, 9);
  assert.equal(responses[1]?.id, 10);
  assert.ok("result" in responses[0]!);
  assert.ok("result" in responses[1]!);
});

test("local MCP stdio handler returns JSON-RPC errors for unknown methods and resources", async () => {
  const unknownMethod = await handleMcpRequest({ jsonrpc: "2.0", id: 11, method: "missing" }, service, singleRuntime);
  assert.ok(unknownMethod);
  assert.ok("error" in unknownMethod);
  assert.equal(unknownMethod.error.code, -32601);

  const unknownResource = await handleMcpRequest(
    { jsonrpc: "2.0", id: 12, method: "resources/read", params: { uri: "ciclo://missing" } },
    service,
    singleRuntime
  );
  assert.ok(unknownResource);
  assert.ok("error" in unknownResource);
  assert.equal(unknownResource.error.code, -32000);
});

test("local MCP whoami and access resources report stdio single owner identity", async () => {
  const whoami = structuredContent(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "ciclo_whoami", arguments: {} } },
      service,
      singleRuntime
    )
  );
  assert.equal(whoami.principal_id, "owner:zach");
  assert.ok((whoami.capabilities as readonly string[]).includes("access.admin"));

  const access = resourcePayload(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 14, method: "resources/read", params: { uri: "ciclo://session/access" } },
      service,
      singleRuntime
    )
  );
  assert.equal((access.access as { principal_id?: string }).principal_id, "owner:zach");
});

test("local MCP stdio multiuser launcher principal reports effective grants", async () => {
  const grants: readonly AccessGrant[] = [
    {
      principalId: "maintainer:lin",
      role: "maintainer",
      scope: { sessionId: "session-shared", loopId: "review-demo" }
    }
  ];
  const multiuser: CicloSession = {
    id: "session-shared",
    mode: "multiuser",
    ownerPrincipalId: "owner:zach",
    projectRoot: "/repo"
  };
  const runtime: CicloMcpRuntimeContext = {
    auth: {
      session: multiuser,
      origin: "mcp_stdio",
      grants,
      principalId: "maintainer:lin"
    }
  };

  const access = resourcePayload(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 15, method: "resources/read", params: { uri: "ciclo://session/access" } },
      service,
      runtime
    )
  );
  const accessView = access.access as { principal_id?: string; capabilities?: readonly string[] };
  assert.equal(accessView.principal_id, "maintainer:lin");
  assert.ok(accessView.capabilities?.includes("work.claim"));
});

test("MCP HTTP multiuser requests fail closed without bearer tokens", async () => {
  const runtime: CicloMcpRuntimeContext = {
    auth: {
      session: {
        id: "session-shared",
        mode: "multiuser",
        ownerPrincipalId: "owner:zach",
        projectRoot: "/repo"
      },
      origin: "mcp_http",
      grants: []
    }
  };

  const response = await handleMcpRequest({ jsonrpc: "2.0", id: 16, method: "tools/list" }, service, runtime);

  assert.ok(response);
  assert.ok("error" in response);
  assert.equal(response.error.code, -32001);
  assert.match(response.error.message, /access denied/);
});

test("MCP auth device tools issue and store approved bearer tokens", async () => {
  const registry = new TokenRegistry({ nowMs: () => 0 });
  const flow = new DeviceAuthorizationFlow({
    verificationUri: "https://ciclo.local/device",
    nowMs: () => 0,
    codeBytes: () => Buffer.from("0123456789abcdef0123456789abcdef", "hex")
  });
  const runtime: CicloMcpRuntimeContext = {
    auth: {
      session: createSingleUserSession({
        id: "session-local",
        ownerPrincipalId: "owner:zach",
        projectRoot: "/repo"
      }),
      origin: "mcp_stdio",
      grants: [],
      tokenRegistry: registry
    },
    deviceFlow: flow
  };

  const start = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: {
          name: "ciclo_auth_device_start",
          arguments: { client_id: "codex-local", client_kind: "cli", requested_scopes: ["status.read"] }
        }
      },
      service,
      runtime
    )
  );
  const deviceCode = start.device_code as string;
  assert.equal(flow.approve(deviceCode, "operator:ada"), true);

  const poll = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 18,
        method: "tools/call",
        params: {
          name: "ciclo_auth_device_poll",
          arguments: { device_code: deviceCode }
        }
      },
      service,
      runtime
    )
  );
  const tokenSet = poll.token_set as { accessToken?: string };
  assert.equal(poll.status, "approved");
  assert.equal(registry.introspect(tokenSet.accessToken ?? "").active, true);
});

test("MCP work mutation tools claim update close audit and record idempotency", async () => {
  const client = fakeMutationClient(readyTask);
  const auditLog: NonNullable<CicloMcpRuntimeContext["auditLog"]> = [];
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    beadsClient: client,
    loop: activeLoop,
    policy: supervisedPolicy,
    mutationIdempotencyStore: new Set<string>(),
    auditLog
  };

  const claim = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 19,
        method: "tools/call",
        params: {
          name: "ciclo_claim_work",
          arguments: { loop_id: "review-demo", bead_id: readyTask.id, harness_id: "codex" }
        }
      },
      service,
      runtime
    )
  );
  assert.equal(claim.claimed, true);
  assert.deepEqual(client.claims, [readyTask.id]);
  assert.match(client.notes[0] ?? "", /Ciclo claim metadata/);

  const update = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "ciclo_update_work",
          arguments: {
            loop_id: "review-demo",
            bead_id: readyTask.id,
            harness_id: "codex",
            kind: "progress",
            message: "Implemented the MCP mutation path."
          }
        }
      },
      service,
      runtime
    )
  );
  assert.equal(update.mutated, true);
  const noteCountAfterUpdate = client.notes.length;

  const duplicate = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "ciclo_update_work",
          arguments: {
            loop_id: "review-demo",
            bead_id: readyTask.id,
            harness_id: "codex",
            kind: "progress",
            message: "Implemented the MCP mutation path."
          }
        }
      },
      service,
      runtime
    )
  );
  assert.equal(duplicate.idempotent, true);
  assert.equal(client.notes.length, noteCountAfterUpdate);

  const close = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: {
          name: "ciclo_close_work",
          arguments: {
            loop_id: "review-demo",
            bead_id: readyTask.id,
            harness_id: "codex",
            final_summary: "MCP mutation path is complete.",
            acceptance_evidence: ["claim update close flow covered"],
            validation_evidence: [{ command: "just check", passed: true, summary: "passed" }]
          }
        }
      },
      service,
      runtime
    )
  );
  assert.equal(close.mutated, true);
  assert.deepEqual(client.closes, [`${readyTask.id}:MCP mutation path is complete.`]);
  assert.ok(auditLog.some((entry) => entry.tool === "ciclo_claim_work"));
  assert.ok(auditLog.some((entry) => entry.tool === "ciclo_update_work"));
  assert.ok(auditLog.some((entry) => entry.tool === "ciclo_close_work"));
});

test("MCP close work launches a bounded review worker after successful task close", async () => {
  const client = fakeMutationClient(readyTask);
  const supervisor = new WorkerSessionSupervisor("/repo", new FakeWorkerLauncher());
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    beadsClient: client,
    loop: activeLoop,
    policy: supervisedPolicy,
    workerSupervisor: supervisor
  };

  const close = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 221,
        method: "tools/call",
        params: {
          name: "ciclo_close_work",
          arguments: {
            loop_id: "review-demo",
            bead_id: readyTask.id,
            harness_id: "claude-code",
            final_summary: "MCP mutation path is complete.",
            acceptance_evidence: ["claim update close flow covered"],
            validation_evidence: [{ command: "just check", passed: true, summary: "passed" }],
            review_harness_id: "codex",
            review_dry_run: true
          }
        }
      },
      service,
      runtime
    )
  );

  assert.equal(close.mutated, true);
  const reviewSession = close.review_session as Record<string, unknown>;
  assert.equal(reviewSession.launched, true);
  assert.equal(reviewSession.harnessId, "codex");
  assert.equal(reviewSession.state, "planned");
  assert.equal(reviewSession.dryRun, true);
  const workers = supervisor.list();
  assert.equal(workers.length, 1);
  assert.equal(workers[0]?.beadId, readyTask.id);
  assert.equal(workers[0]?.loopId, "review-demo");
  assert.equal(workers[0]?.state, "planned");
  assert.ok(workers[0]?.evidence.some((item) => item === "worker.session.launch:planned"));
});

test("MCP work mutations enforce loop dry-run policy before Beads ownership changes", async () => {
  const client = fakeMutationClient(readyTask);
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    beadsClient: client,
    loop: { ...activeLoop, dryRun: true },
    policy: supervisedPolicy
  };

  const claim = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 23,
        method: "tools/call",
        params: {
          name: "ciclo_claim_work",
          arguments: { loop_id: "review-demo", bead_id: readyTask.id, harness_id: "codex" }
        }
      },
      service,
      runtime
    )
  );

  assert.equal(claim.claimed, false);
  assert.match(claim.reason as string, /dry-run/);
  assert.deepEqual(client.claims, []);
});

test("MCP remote tracker sync requires configured Beads integration", async () => {
  const auditLog: NonNullable<CicloMcpRuntimeContext["auditLog"]> = [];
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    loop: activeLoop,
    policy: supervisedPolicy,
    auditLog
  };

  const result = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2401,
        method: "tools/call",
        params: {
          name: "ciclo_sync_remote_trackers",
          arguments: { loop_id: "review-demo", bead_id: readyTask.id, dry_run: false }
        }
      },
      service,
      runtime
    )
  );

  assert.equal(result.synced, false);
  assert.match((result.policy as { reason?: string }).reason ?? "", /disabled until Beads integration is configured/);
  assert.ok((result.evidence as readonly string[]).includes("beads.tracker_sync:not_configured"));
  assert.equal(auditLog[0]?.tool, "ciclo_sync_remote_trackers");
});

test("MCP remote tracker sync calls configured Beads-native trigger and deduplicates", async () => {
  const auditLog: NonNullable<CicloMcpRuntimeContext["auditLog"]> = [];
  const calls: string[][] = [];
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    loop: activeLoop,
    policy: supervisedPolicy,
    mutationIdempotencyStore: new Set<string>(),
    auditLog,
    remoteTrackerSync: new BeadsRemoteTrackerSync(
      {
        root: process.cwd(),
        targets: [
          {
            id: "linear-team",
            kind: "linear",
            required: true,
            syncArgs: ["trackers", "sync", "--target", "linear-team"],
            statusArgs: ["trackers", "status", "--target", "linear-team"]
          }
        ]
      },
      async (_cwd, args) => {
        calls.push([...args]);
        return {
          args,
          code: 0,
          stdout: JSON.stringify({ cursor: "mcp-cursor" }),
          stderr: ""
        };
      }
    )
  };

  const params = {
    name: "ciclo_sync_remote_trackers",
    arguments: {
      loop_id: "review-demo",
      bead_id: readyTask.id,
      dry_run: false,
      idempotency_key: "mcp-sync-1"
    }
  };
  const first = structuredContent(
    await handleMcpRequest({ jsonrpc: "2.0", id: 2402, method: "tools/call", params }, service, runtime)
  );
  const second = structuredContent(
    await handleMcpRequest({ jsonrpc: "2.0", id: 2403, method: "tools/call", params }, service, runtime)
  );

  assert.equal(first.synced, true);
  assert.equal((first.policy as { decision?: string }).decision, "allow");
  assert.deepEqual(calls[0], ["bd", "trackers", "sync", "--target", "linear-team"]);
  assert.equal(calls.length, 1);
  assert.equal(second.idempotent, true);
  assert.ok(auditLog.some((entry) => entry.tool === "ciclo_sync_remote_trackers"));
});

test("MCP work mutations enforce scoped multiuser grants", async () => {
  const client = fakeMutationClient(readyTask);
  const runtime: CicloMcpRuntimeContext = {
    auth: {
      session: {
        id: "session-shared",
        mode: "multiuser",
        ownerPrincipalId: "owner:zach",
        projectRoot: "/repo"
      },
      origin: "mcp_stdio",
      principalId: "maintainer:lin",
      grants: [
        {
          principalId: "maintainer:lin",
          role: "maintainer",
          scope: { sessionId: "session-shared", loopId: "other-loop", beadId: readyTask.id }
        }
      ]
    },
    beadsClient: client,
    loop: activeLoop,
    policy: supervisedPolicy
  };

  const response = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: {
        name: "ciclo_claim_work",
        arguments: { loop_id: "review-demo", bead_id: readyTask.id, harness_id: "codex" }
      }
    },
    service,
    runtime
  );

  assert.ok(response);
  assert.ok("error" in response);
  assert.equal(response.error.code, -32001);
  assert.deepEqual(client.claims, []);
});

test("MCP handler records access audit entries for accepted and denied requests", async () => {
  const accessAuditLog: NonNullable<CicloMcpRuntimeContext["accessAuditLog"]> = [];
  const runtime: CicloMcpRuntimeContext = {
    auth: {
      session: {
        id: "session-shared",
        mode: "multiuser",
        ownerPrincipalId: "owner:zach",
        projectRoot: "/repo"
      },
      origin: "mcp_stdio",
      principalId: "maintainer:lin",
      grants: [
        {
          principalId: "maintainer:lin",
          role: "maintainer",
          scope: { sessionId: "session-shared", loopId: "review-demo", beadId: readyTask.id }
        }
      ]
    },
    beadsClient: fakeMutationClient(readyTask),
    loop: activeLoop,
    policy: supervisedPolicy,
    accessAuditLog
  };

  await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 25,
      method: "tools/call",
      params: {
        name: "ciclo_claim_work",
        arguments: { loop_id: "review-demo", bead_id: readyTask.id, harness_id: "codex" }
      }
    },
    service,
    runtime
  );
  await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 26,
      method: "tools/call",
      params: {
        name: "ciclo_close_work",
        arguments: { loop_id: "review-demo", bead_id: "other-task", harness_id: "codex", final_summary: "no" }
      }
    },
    service,
    runtime
  );

  assert.equal(accessAuditLog[0]?.decision, "accepted");
  assert.equal(accessAuditLog[0]?.principalId, "maintainer:lin");
  assert.equal(accessAuditLog[1]?.decision, "denied");
  assert.match(accessAuditLog[1]?.reason ?? "", /lacks an unexpired grant/);
});

test("MCP operator question tools queue dedupe expose and answer questions", async () => {
  const operatorRouting = new OperatorRoutingStore();
  const auditLog: NonNullable<CicloMcpRuntimeContext["auditLog"]> = [];
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    operatorRouting,
    auditLog
  };

  const asked = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 27,
        method: "tools/call",
        params: {
          name: "ciclo_ask_operator",
          arguments: {
            loop_id: "review-demo",
            bead_id: readyTask.id,
            harness_id: "codex",
            question: "Should I continue with the review?",
            urgency: "blocking",
            evidence: ["herdr:blocked"]
          }
        }
      },
      service,
      runtime
    )
  );
  const duplicate = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 28,
        method: "tools/call",
        params: {
          name: "ciclo_ask_operator",
          arguments: {
            loop_id: "review-demo",
            bead_id: readyTask.id,
            harness_id: "codex",
            question: "Should I continue with the review?",
            urgency: "blocking"
          }
        }
      },
      service,
      runtime
    )
  );
  const questions = resourcePayload(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 29, method: "resources/read", params: { uri: "ciclo://questions" } },
      service,
      runtime
    )
  );
  const questionId = asked.question_id as string;
  const answer = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: {
          name: "ciclo_answer_question",
          arguments: {
            question_id: questionId,
            answer: "Continue, but keep the change scoped.",
            evidence: ["operator:confirmed"]
          }
        }
      },
      service,
      runtime
    )
  );
  const remaining = resourcePayload(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 31, method: "resources/read", params: { uri: "ciclo://questions" } },
      service,
      runtime
    )
  );

  assert.equal(asked.queued, true);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.question_id, questionId);
  assert.equal((questions.questions as readonly unknown[]).length, 1);
  assert.equal(answer.answered, true);
  assert.deepEqual(answer.routed_to, {
    loopId: "review-demo",
    beadId: readyTask.id,
    harnessId: "codex"
  });
  assert.equal((remaining.questions as readonly unknown[]).length, 0);
  assert.ok(auditLog.some((entry) => entry.tool === "ciclo_ask_operator"));
  assert.ok(auditLog.some((entry) => entry.tool === "ciclo_answer_question"));
});

test("MCP operator feedback tool queues deduplicated feedback and exposes it as a resource", async () => {
  const runtime: CicloMcpRuntimeContext = {
    ...singleRuntime,
    operatorRouting: new OperatorRoutingStore()
  };

  const first = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: {
          name: "ciclo_report_feedback",
          arguments: {
            loop_id: "review-demo",
            bead_id: readyTask.id,
            severity: "warning",
            message: "Review found a missing validation step.",
            evidence: ["review:missing-test"]
          }
        }
      },
      service,
      runtime
    )
  );
  const second = structuredContent(
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 33,
        method: "tools/call",
        params: {
          name: "ciclo_report_feedback",
          arguments: {
            loop_id: "review-demo",
            bead_id: readyTask.id,
            severity: "warning",
            message: "Review found a missing validation step.",
            evidence: ["review:repeat"]
          }
        }
      },
      service,
      runtime
    )
  );
  const feedback = resourcePayload(
    await handleMcpRequest(
      { jsonrpc: "2.0", id: 34, method: "resources/read", params: { uri: "ciclo://feedback" } },
      service,
      runtime
    )
  );

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.feedback_id, first.feedback_id);
  const records = feedback.feedback as readonly { feedbackId: string; duplicateCount: number }[];
  assert.equal(records.length, 1);
  assert.equal(records[0]?.duplicateCount, 1);
});
