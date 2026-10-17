#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initAuth } from "./auth.js";
import { httpConfigFromEnv, startHttpServer } from "./http.js";
import { createServer } from "./server.js";
import type { ToolDef } from "./server.js";
import { firewallTools } from "./firewall.js";
import { zoneTools } from "./zones.js";
import { dnsTools } from "./dns.js";
import { tunnelTools } from "./tunnels.js";
import { accessTools } from "./access.js";
import { composableTools } from "./composable.js";

initAuth();

const allTools: ToolDef[] = [
  ...firewallTools,
  ...zoneTools,
  ...dnsTools,
  ...tunnelTools,
  ...accessTools,
  ...composableTools,
];

const mode = process.env.MCP_TRANSPORT ?? "stdio";

if (mode === "http") {
  // Loopback by default, bearer token required: this server can edit DNS, tunnels and Access.
  const server = startHttpServer(httpConfigFromEnv(process.env), () => createServer(allTools));
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  const server = createServer(allTools);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
