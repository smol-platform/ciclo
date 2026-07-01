#!/usr/bin/env node
import type { AddressInfo } from "node:net";

import { parseMcpHttpOptions } from "./cli.js";
import { runMcpHttpServer } from "./mcp-http.js";

const options = parseMcpHttpOptions(process.argv.slice(2));
const server = await runMcpHttpServer({
  host: options.host,
  port: options.port,
  ...(options.path === undefined ? {} : { path: options.path }),
  ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes })
});
const address = server.address();
if (address !== null && typeof address === "object") {
  const endpoint = formatAddress(address);
  console.error(`ciclo MCP HTTP listening on http://${endpoint}${options.path ?? "/mcp"}`);
}

function formatAddress(address: AddressInfo): string {
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  return `${host}:${address.port}`;
}
