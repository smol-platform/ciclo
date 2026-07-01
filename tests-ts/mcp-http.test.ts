import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AccessGrant } from "../src/access-grants.js";
import { buildStandaloneStatus } from "../src/app.js";
import { DeviceAuthorizationFlow, type DeviceTokenSet } from "../src/auth-device-flow.js";
import type { BeadsTaskSnapshot } from "../src/beads-adapter.js";
import type { LoopConfig } from "../src/ciclo-core.js";
import type { PolicyConfig } from "../src/loop-config.js";
import {
  defaultMcpHttpConfig,
  handleMcpHttpRequest,
  runMcpHttpServer,
  type McpHttpResponse
} from "../src/mcp-http.js";
import type { CicloMcpRuntimeContext, CicloMcpReadService, JsonRpcResponse } from "../src/mcp-stdio.js";
import { createSingleUserSession, type CicloSession } from "../src/session-access.js";
import { TokenRegistry } from "../src/token-store.js";

const readyTask: BeadsTaskSnapshot = {
  id: "ciclo-http.1",
  title: "HTTP ready work",
  status: "open",
  priority: 1,
  issueType: "task",
  description: "",
  acceptanceCriteria: "",
  labels: ["mcp"],
  dependencies: [],
  externalRefs: []
};

const loop: LoopConfig = {
  id: "http-loop",
  kind: "beads_work",
  goal: "Exercise HTTP MCP.",
  harnesses: ["codex"],
  dryRun: true
};

const policy: PolicyConfig = {
  mode: "supervised",
  requireApprovalFor: [],
  allowCommands: []
};

const service: CicloMcpReadService = {
  async status() {
    return buildStandaloneStatus();
  },
  async loopStatus(loopId) {
    return {
      loop: { id: loopId, kind: "beads_work", state: "wait", harnesses: ["codex"], dryRun: true },
      goal: "fixture",
      policy: { mutations: "disabled_in_local_status_mode", networkListener: false, access: "single_user" },
      currentWork: null,
      evidence: ["fixture:http"]
    };
  },
  async readyWork() {
    return { selected: readyTask, work: [readyTask], skipped: [], evidence: ["fixture:ready"] };
  },
  async questions() {
    return [];
  },
  async feedback() {
    return [];
  }
};

function fakeClient(task: BeadsTaskSnapshot) {
  const claims: string[] = [];
  const notes: string[] = [];
  return {
    claims,
    notes,
    async ready() {
      return [task];
    },
    async show(id: string) {
      return { ...task, id };
    },
    async claim(id: string) {
      claims.push(id);
      return { ...task, id, status: "in_progress" };
    },
    async note(id: string, message: string) {
      notes.push(`${id}:${message}`);
    },
    async close(id: string) {
      return { ...task, id, status: "closed" };
    }
  };
}

function responsePayload(response: McpHttpResponse): JsonRpcResponse {
  return JSON.parse(response.body) as JsonRpcResponse;
}

function structuredContent(response: McpHttpResponse): Record<string, unknown> {
  const payload = responsePayload(response);
  assert.ok("result" in payload, JSON.stringify(payload));
  const result = payload.result as Record<string, unknown>;
  return result.structuredContent as Record<string, unknown>;
}

function closeServer(server: Awaited<ReturnType<typeof runMcpHttpServer>>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function runtime(input: Partial<CicloMcpRuntimeContext> = {}): CicloMcpRuntimeContext {
  return {
    auth: {
      session: createSingleUserSession({
        id: "session-local",
        ownerPrincipalId: "owner:zach",
        projectRoot: "/repo"
      }),
      origin: "mcp_stdio",
      grants: []
    },
    ...input
  };
}

test("HTTP MCP defaults bind to localhost and use /mcp", () => {
  const config = defaultMcpHttpConfig();
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.path, "/mcp");
  assert.equal(config.requireAuthForNonLocal, true);
  assert.equal(config.maxBodyBytes, 1_048_576);
});

test("HTTP MCP rejects disallowed Origin before JSON-RPC handling", async () => {
  const response = await handleMcpHttpRequest(
    {
      method: "POST",
      url: "/mcp",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    },
    service,
    runtime(),
    { allowedOrigins: ["https://ciclo.example"] }
  );

  assert.equal(response.status, 403);
  assert.match(response.body, /origin not allowed/);
});

test("HTTP MCP multiuser mode requires bearer tokens and accepts active bearer read requests", async () => {
  const tokenSet: DeviceTokenSet = {
    tokenType: "Bearer",
    accessToken: "ciclo_at_http",
    refreshToken: "ciclo_rt_http",
    expiresAt: "1970-01-01T00:01:00.000Z",
    principalId: "operator:ada",
    sessionId: "session-shared",
    clientId: "mcp-http",
    scopes: ["status.read"]
  };
  const registry = new TokenRegistry({ nowMs: () => 0 });
  registry.store(tokenSet);
  const session: CicloSession = {
    id: "session-shared",
    mode: "multiuser",
    ownerPrincipalId: "owner:zach",
    projectRoot: "/repo"
  };
  const baseRuntime = runtime({
    auth: { session, origin: "mcp_stdio", grants: [], tokenRegistry: registry }
  });
  const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  const missing = responsePayload(
    await handleMcpHttpRequest({ method: "POST", url: "/mcp", headers: {}, body }, service, baseRuntime)
  );
  assert.ok("error" in missing);
  assert.equal(missing.error.code, -32001);

  const accepted = responsePayload(
    await handleMcpHttpRequest(
      { method: "POST", url: "/mcp", headers: { authorization: `Bearer ${tokenSet.accessToken}` }, body },
      service,
      baseRuntime
    )
  );
  assert.ok("result" in accepted);
});

test("HTTP MCP multiuser mode allows device auth bootstrap without an existing bearer token", async () => {
  const registry = new TokenRegistry({ nowMs: () => 0 });
  const flow = new DeviceAuthorizationFlow({
    verificationUri: "https://ciclo.local/device",
    nowMs: () => 0,
    codeBytes: () => Buffer.alloc(24, 7)
  });
  const session: CicloSession = {
    id: "session-shared",
    mode: "multiuser",
    ownerPrincipalId: "owner:zach",
    projectRoot: "/repo"
  };
  const baseRuntime = runtime({
    auth: { session, origin: "mcp_stdio", grants: [], tokenRegistry: registry },
    deviceFlow: flow
  });

  const start = structuredContent(
    await handleMcpHttpRequest(
      {
        method: "POST",
        url: "/mcp",
        headers: {},
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: {
            name: "ciclo_auth_device_start",
            arguments: { client_id: "http-client", client_kind: "mcp_http", requested_scopes: ["status.read"] }
          }
        })
      },
      service,
      baseRuntime
    )
  );
  const deviceCode = start.device_code as string;
  assert.equal(flow.approve(deviceCode, "operator:ada"), true);

  const poll = structuredContent(
    await handleMcpHttpRequest(
      {
        method: "POST",
        url: "/mcp",
        headers: {},
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 22,
          method: "tools/call",
          params: {
            name: "ciclo_auth_device_poll",
            arguments: { device_code: deviceCode }
          }
        })
      },
      service,
      baseRuntime
    )
  );
  const tokenSet = poll.token_set as { accessToken?: string };
  assert.equal(poll.status, "approved");
  assert.equal(registry.introspect(tokenSet.accessToken ?? "").active, true);
});

test("HTTP MCP non-local bind requires multiuser auth mode", async () => {
  const response = await handleMcpHttpRequest(
    {
      method: "POST",
      url: "/mcp",
      headers: {},
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    },
    service,
    runtime(),
    { host: "0.0.0.0" }
  );

  assert.equal(response.status, 403);
  assert.match(response.body, /non-local MCP HTTP requires multiuser authentication/);
});

test("HTTP MCP rejects oversized request bodies", async () => {
  const response = await handleMcpHttpRequest(
    {
      method: "POST",
      url: "/mcp",
      headers: {},
      body: "x".repeat(17)
    },
    service,
    runtime(),
    { maxBodyBytes: 16 }
  );

  assert.equal(response.status, 413);
  assert.match(response.body, /request body too large/);
});

test("HTTP MCP server enforces the body limit while reading incoming requests", async () => {
  const server = await runMcpHttpServer({ maxBodyBytes: 16 }, service, runtime());
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      body: "x".repeat(17)
    });

    assert.equal(response.status, 413);
    assert.match(await response.text(), /request body too large/);
  } finally {
    await closeServer(server);
  }
});

test("HTTP MCP supports dry-run work mutations and records tool calls", async () => {
  const client = fakeClient(readyTask);
  const auditLog: NonNullable<CicloMcpRuntimeContext["auditLog"]> = [];
  const grants: readonly AccessGrant[] = [];
  const httpRuntime = runtime({
    auth: {
      session: createSingleUserSession({
        id: "session-local",
        ownerPrincipalId: "owner:zach",
        projectRoot: "/repo"
      }),
      origin: "mcp_stdio",
      grants
    },
    beadsClient: client,
    loop,
    policy,
    auditLog
  });

  const response = responsePayload(
    await handleMcpHttpRequest(
      {
        method: "POST",
        url: "/mcp",
        headers: { origin: "http://127.0.0.1" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "ciclo_claim_work",
            arguments: { loop_id: "http-loop", bead_id: readyTask.id, harness_id: "codex" }
          }
        })
      },
      service,
      httpRuntime
    )
  );

  assert.ok("result" in response);
  const result = response.result as { structuredContent?: { claimed?: boolean; reason?: string } };
  assert.equal(result.structuredContent?.claimed, false);
  assert.match(result.structuredContent?.reason ?? "", /dry-run/);
  assert.deepEqual(client.claims, []);
  assert.ok(auditLog.some((entry) => entry.event === "mcp.http.tool_call" && entry.tool === "ciclo_claim_work"));
});
