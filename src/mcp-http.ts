import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { CicloMcpAuditEntry, CicloMcpReadService, CicloMcpRuntimeContext, JsonRpcRequest } from "./mcp-stdio.js";
import { createLocalMcpReadService, createLocalMcpRuntimeContext, handleMcpRequest } from "./mcp-stdio.js";
import { cicloMcpTools } from "./mcp-contract.js";
import type { SessionAccessAction } from "./session-access.js";

export interface McpHttpConfig {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly allowedOrigins: readonly string[];
  readonly requireAuthForNonLocal: boolean;
  readonly maxBodyBytes: number;
}

export interface McpHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
}

export interface McpHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export function defaultMcpHttpConfig(input: Partial<McpHttpConfig> = {}): McpHttpConfig {
  return {
    host: input.host ?? "127.0.0.1",
    port: input.port ?? 0,
    path: input.path ?? "/mcp",
    allowedOrigins: input.allowedOrigins ?? ["http://127.0.0.1", "http://localhost"],
    requireAuthForNonLocal: input.requireAuthForNonLocal ?? true,
    maxBodyBytes: input.maxBodyBytes ?? 1_048_576
  };
}

function header(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  return headers[name] ?? headers[name.toLowerCase()];
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isLocalOrigin(origin: string): boolean {
  try {
    return isLocalHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function originAllowed(origin: string | undefined, config: McpHttpConfig): boolean {
  if (origin === undefined || origin.trim().length === 0) return true;
  if (config.allowedOrigins.includes(origin)) return true;
  return isLocalHost(config.host) && isLocalOrigin(origin);
}

function jsonResponse(status: number, payload: unknown, origin: string | undefined, config: McpHttpConfig): McpHttpResponse {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    vary: "Origin"
  };
  if (origin !== undefined && originAllowed(origin, config)) {
    headers["access-control-allow-origin"] = origin;
  }
  return {
    status,
    headers,
    body: JSON.stringify(payload)
  };
}

function preBodyResponse(
  request: Pick<McpHttpRequest, "method" | "url" | "headers">,
  runtime: CicloMcpRuntimeContext,
  config: McpHttpConfig
): McpHttpResponse | undefined {
  const origin = header(request.headers, "origin");
  if (!originAllowed(origin, config)) {
    return jsonResponse(403, { error: "origin not allowed" }, origin, config);
  }

  if (request.method === "OPTIONS") {
    return {
      status: 204,
      headers: {
        "access-control-allow-origin": origin ?? "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        vary: "Origin"
      },
      body: ""
    };
  }

  if (request.method !== "POST" || new URL(request.url, "http://ciclo.local").pathname !== config.path) {
    return jsonResponse(404, { error: "not found" }, origin, config);
  }

  if (config.requireAuthForNonLocal && !isLocalHost(config.host) && runtime.auth.session.mode !== "multiuser") {
    return jsonResponse(403, { error: "non-local MCP HTTP requires multiuser authentication" }, origin, config);
  }

  return undefined;
}

function runtimeForHttp(runtime: CicloMcpRuntimeContext, request: McpHttpRequest): CicloMcpRuntimeContext {
  return {
    ...runtime,
    auth: {
      ...runtime.auth,
      origin: "mcp_http",
      authorizationHeader: header(request.headers, "authorization")
    }
  };
}

function toolAction(name: string): SessionAccessAction {
  return cicloMcpTools.find((tool) => tool.name === name)?.permission.action ?? "read_status";
}

function toolName(request: JsonRpcRequest): string | undefined {
  if (request.method !== "tools/call") return undefined;
  const params = request.params !== null && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  return typeof params.name === "string" ? params.name : undefined;
}

function recordHttpToolCall(runtime: CicloMcpRuntimeContext, request: JsonRpcRequest, response: unknown): void {
  const name = toolName(request);
  if (name === undefined) return;
  const failed = response !== null && typeof response === "object" && "error" in response;
  const entry: CicloMcpAuditEntry = {
    event: "mcp.http.tool_call",
    tool: name,
    action: toolAction(name),
    decision: failed ? "deny" : "allow",
    reason: failed ? "HTTP MCP tool call returned an error" : "HTTP MCP tool call completed",
    evidence: ["mcp.http.tool_call", `mcp.http.tool:${name}`]
  };
  runtime.auditLog?.push(entry);
}

export async function handleMcpHttpRequest(
  request: McpHttpRequest,
  service: CicloMcpReadService = createLocalMcpReadService(),
  runtime: CicloMcpRuntimeContext = createLocalMcpRuntimeContext(),
  configInput: Partial<McpHttpConfig> = {}
): Promise<McpHttpResponse> {
  const config = defaultMcpHttpConfig(configInput);
  const origin = header(request.headers, "origin");
  const early = preBodyResponse(request, runtime, config);
  if (early !== undefined) return early;

  if (Buffer.byteLength(request.body ?? "", "utf8") > config.maxBodyBytes) {
    return jsonResponse(413, { error: "request body too large", max_body_bytes: config.maxBodyBytes }, origin, config);
  }

  let payload: JsonRpcRequest;
  try {
    payload = JSON.parse(request.body ?? "") as JsonRpcRequest;
  } catch {
    return jsonResponse(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, origin, config);
  }

  const httpRuntime = runtimeForHttp(runtime, request);
  const response = await handleMcpRequest(payload, service, httpRuntime);
  if (response === undefined) return jsonResponse(202, {}, origin, config);
  recordHttpToolCall(httpRuntime, payload, response);
  return jsonResponse(200, response, origin, config);
}

function headersFromIncoming(request: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBodyBytes: number) {
    super(`request body exceeded ${maxBodyBytes} bytes`);
  }
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  request.setEncoding("utf8");
  let body = "";
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > maxBodyBytes) {
      throw new RequestBodyTooLargeError(maxBodyBytes);
    }
    body += chunk;
  }
  return body;
}

export function runMcpHttpServer(
  configInput: Partial<McpHttpConfig> = {},
  service: CicloMcpReadService = createLocalMcpReadService(),
  runtime: CicloMcpRuntimeContext = createLocalMcpRuntimeContext()
): Promise<Server> {
  const config = defaultMcpHttpConfig(configInput);
  const server = http.createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const requestEnvelope = {
      method: request.method ?? "GET",
      url: request.url ?? config.path,
      headers: headersFromIncoming(request)
    };
    const early = preBodyResponse(requestEnvelope, runtime, config);
    if (early !== undefined) {
      response.writeHead(early.status, early.headers);
      response.end(early.body);
      return;
    }

    let body: string;
    try {
      body = await readBody(request, config.maxBodyBytes);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        const origin = header(requestEnvelope.headers, "origin");
        const handled = jsonResponse(
          413,
          { error: "request body too large", max_body_bytes: error.maxBodyBytes },
          origin,
          config
        );
        response.writeHead(handled.status, handled.headers);
        response.end(handled.body);
        return;
      }
      throw error;
    }

    const handled = await handleMcpHttpRequest(
      {
        ...requestEnvelope,
        body
      },
      service,
      runtime,
      config
    );
    response.writeHead(handled.status, handled.headers);
    response.end(handled.body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      runtime.internalHeartbeat?.start();
      server.once("close", () => runtime.internalHeartbeat?.stop());
      resolve(server);
    });
  });
}
