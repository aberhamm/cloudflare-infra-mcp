import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApp, httpConfigFromEnv, readBearerToken, startHttpServer } from "../../src/http.js";
import { createServer } from "../../src/server.js";

const TOKEN = "a".repeat(64);
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

function tokenFile(content = TOKEN, mode = 0o600): string {
  const path = join(mkdtempSync(join(tmpdir(), "cf-mcp-")), "bearer.token");
  writeFileSync(path, content + "\n");
  chmodSync(path, mode);
  return path;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

async function listen(app: { listen: (port: number, host: string, cb: () => void) => Server }) {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

function initialize(url: string, auth?: string) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(INIT),
  });
}

describe("readBearerToken", () => {
  it("refuses a missing setting", () => {
    expect(() => readBearerToken(undefined)).toThrow(/CLOUDFLARE_MCP_BEARER_TOKEN_FILE/);
  });
  it("refuses a file other users can read", () => {
    expect(() => readBearerToken(tokenFile(TOKEN, 0o644))).toThrow(/chmod 600/);
  });
  it("refuses content that is not a 64-character hex token", () => {
    expect(() => readBearerToken(tokenFile("short"))).toThrow(/64-character hex/);
  });
  it("reads a valid token", () => {
    expect(readBearerToken(tokenFile())).toBe(TOKEN);
  });
});

describe("httpConfigFromEnv", () => {
  it("defaults to loopback", () => {
    const config = httpConfigFromEnv({ CLOUDFLARE_MCP_BEARER_TOKEN_FILE: tokenFile() });
    expect(config.host).toBe("127.0.0.1");
    expect(config.idleMs).toBe(30 * 60_000);
  });
  it("refuses to start without a token file", () => {
    expect(() => httpConfigFromEnv({ MCP_PORT: "3110" })).toThrow(/CLOUDFLARE_MCP_BEARER_TOKEN_FILE/);
  });
});

describe("bearer check", () => {
  const config = { host: "127.0.0.1", bearerToken: TOKEN, idleMs: 60_000 };

  it("rejects a request without a token", async () => {
    const url = await listen(createHttpApp(config, () => createServer([])).app);
    const res = await initialize(url);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("rejects a wrong token", async () => {
    const url = await listen(createHttpApp(config, () => createServer([])).app);
    expect((await initialize(url, `Bearer ${"b".repeat(64)}`)).status).toBe(401);
  });

  it("accepts the right token and opens a session", async () => {
    const url = await listen(createHttpApp(config, () => createServer([])).app);
    const res = await initialize(url, `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });
});

describe("idle sessions", () => {
  it("closes a session that has been idle longer than idleMs", async () => {
    let clock = 1_000;
    const http = createHttpApp({ host: "127.0.0.1", bearerToken: TOKEN, idleMs: 60_000 }, () => createServer([]), () => clock);
    const url = await listen(http.app);
    expect((await initialize(url, `Bearer ${TOKEN}`)).status).toBe(200);
    expect(http.sessionCount()).toBe(1);

    clock += 30_000;
    expect(await http.sweepIdle()).toBe(0);
    clock += 60_000;
    expect(await http.sweepIdle()).toBe(1);
    expect(http.sessionCount()).toBe(0);
  });
});

describe("startHttpServer", () => {
  it("listens on the configured loopback host only", async () => {
    const server = startHttpServer({ host: "127.0.0.1", port: 0, bearerToken: TOKEN, idleMs: 60_000 }, () => createServer([]));
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });
});
