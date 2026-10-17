import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { Express, NextFunction, Request, Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export interface HttpConfig {
  host: string;
  port: number;
  bearerToken: string;
  idleMs: number;
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Read the bearer token from a file. HTTP mode refuses to start without one:
 * the server holds a Cloudflare token that can edit DNS, tunnels and Access.
 */
export function readBearerToken(path: string | undefined): string {
  if (!path) {
    throw new Error(
      "HTTP mode needs CLOUDFLARE_MCP_BEARER_TOKEN_FILE: a file with a 64-character hex token " +
        "(openssl rand -hex 32), mode 0600.",
    );
  }
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Bearer token file is not a regular file: ${path}`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Bearer token file must not be readable by group or others (chmod 600): ${path}`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`Bearer token file must hold a 64-character hex token: ${path}`);
  }
  return token;
}

export function httpConfigFromEnv(env: NodeJS.ProcessEnv): HttpConfig {
  const port = parseInt(env.MCP_PORT ?? "3100", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid MCP_PORT: ${env.MCP_PORT}`);
  const idleMinutes = parseInt(env.MCP_IDLE_SESSION_MINUTES ?? "30", 10);
  if (!Number.isInteger(idleMinutes) || idleMinutes <= 0) {
    throw new Error(`Invalid MCP_IDLE_SESSION_MINUTES: ${env.MCP_IDLE_SESSION_MINUTES}`);
  }
  return {
    host: env.MCP_HOST ?? "127.0.0.1",
    port,
    bearerToken: readBearerToken(env.CLOUDFLARE_MCP_BEARER_TOKEN_FILE),
    idleMs: idleMinutes * 60_000,
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function requireBearer(token: string) {
  const expected = digest(token);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (presented && timingSafeEqual(digest(presented), expected)) {
      next();
      return;
    }
    res.setHeader("WWW-Authenticate", 'Bearer realm="cloudflare-infra-mcp"');
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  };
}

function badRequest(res: Response, message: string) {
  res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

export interface HttpApp {
  app: Express;
  /** Close sessions with no request for longer than idleMs. Returns how many were closed. */
  sweepIdle(): Promise<number>;
  sessionCount(): number;
}

export function createHttpApp(
  config: Pick<HttpConfig, "host" | "bearerToken" | "idleMs">,
  newServer: () => McpServer,
  now: () => number = Date.now,
): HttpApp {
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const lastSeen: Record<string, number> = {};
  const app = createMcpExpressApp({ host: config.host });
  app.use("/mcp", requireBearer(config.bearerToken));

  const touch = (sid: string) => {
    lastSeen[sid] = now();
  };
  const forget = (sid: string) => {
    delete transports[sid];
    delete lastSeen[sid];
  };

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    try {
      if (sessionId && transports[sessionId]) {
        touch(sessionId);
        await transports[sessionId].handleRequest(req, res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid: string) => {
            transports[sid] = transport;
            touch(sid);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) forget(sid);
        };
        const server = newServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } else {
        badRequest(res, "Bad request: send initialize first or include mcp-session-id header");
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null });
      }
    }
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports[sessionId]) {
      touch(sessionId);
      await transports[sessionId].handleRequest(req, res);
    } else {
      badRequest(res, "Invalid or missing session ID");
    }
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res);
      forget(sessionId);
    } else {
      badRequest(res, "Invalid or missing session ID");
    }
  });

  return {
    app,
    async sweepIdle() {
      const cutoff = now() - config.idleMs;
      const idle = Object.keys(transports).filter((sid) => (lastSeen[sid] ?? 0) < cutoff);
      for (const sid of idle) {
        const transport = transports[sid];
        forget(sid);
        await transport?.close().catch(() => undefined);
      }
      return idle.length;
    },
    sessionCount: () => Object.keys(transports).length,
  };
}

/** Start listening on config.host only, and sweep idle sessions once a minute. */
export function startHttpServer(config: HttpConfig, newServer: () => McpServer): Server {
  const { app, sweepIdle } = createHttpApp(config, newServer);
  const timer = setInterval(() => void sweepIdle(), 60_000);
  timer.unref();
  return app.listen(config.port, config.host, () => {
    console.log(`cloudflare-infra-mcp listening on http://${config.host}:${config.port}/mcp`);
  });
}
