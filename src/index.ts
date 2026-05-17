#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initAuth } from "./auth.js";
import { createServer } from "./server.js";
import { firewallTools } from "./firewall.js";
import { zoneTools } from "./zones.js";
import { dnsTools } from "./dns.js";
import { tunnelTools } from "./tunnels.js";
import { accessTools } from "./access.js";
import { composableTools } from "./composable.js";

initAuth();

const allTools = [
  ...firewallTools,
  ...zoneTools,
  ...dnsTools,
  ...tunnelTools,
  ...accessTools,
  ...composableTools,
];

const server = createServer(allTools);
const transport = new StdioServerTransport();
await server.connect(transport);
