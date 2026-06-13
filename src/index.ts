#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { initAuth } from "./auth.js";
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
  const port = parseInt(process.env.MCP_PORT ?? "3100", 10);
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const app = createMcpExpressApp();

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    try {
      if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid: string) => { transports[sid] = transport; },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) delete transports[sid];
        };
        const server = createServer(allTools);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad request: send initialize first or include mcp-session-id header" },
          id: null,
        });
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: String(err) },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing session ID" },
        id: null,
      });
    }
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res);
      delete transports[sessionId];
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing session ID" },
        id: null,
      });
    }
  });

  app.all("/register", (_req: Request, res: Response) => {
    res.status(404).json({ error: "not_supported", error_description: "OAuth not supported" });
  });

  app.listen(port, () => {
    console.log(`cloudflare-infra-mcp listening on http://0.0.0.0:${port}/mcp`);
  });

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
} else {
  const server = createServer(allTools);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
