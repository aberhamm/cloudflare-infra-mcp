import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { setApiToken } from "../../src/utils/cf-client.js";
import { clearAccountCache } from "../../src/utils/account-resolver.js";
import { tunnelTools } from "../../src/tunnels.js";

const BASE = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = "test-account-123";
const TUNNEL_ID = "tunnel-new-001";

const createTunnel = tunnelTools.find((t) => t.name === "create_tunnel")!;

/** Captured request bodies from tunnel creation calls */
const capturedBodies: Array<Record<string, unknown>> = [];

const server = setupServer(
  // Account resolver
  http.get(`${BASE}/accounts`, () => {
    return HttpResponse.json({
      success: true,
      errors: [],
      messages: [],
      result: [{ id: ACCOUNT_ID, name: "Test Account" }],
      result_info: { page: 1, per_page: 5, total_pages: 1, count: 1, total_count: 1 },
    });
  }),

  // Tunnel creation — captures the request body
  http.post(`${BASE}/accounts/${ACCOUNT_ID}/cfd_tunnel`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    capturedBodies.push(body);
    return HttpResponse.json({
      success: true,
      errors: [],
      messages: [],
      result: {
        id: TUNNEL_ID,
        name: body.name,
        status: "inactive",
        created_at: "2025-06-01T00:00:00Z",
        remote_config: true,
        connections: [],
      },
    });
  }),

  // Tunnel token fetch
  http.get(`${BASE}/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/token`, () => {
    return HttpResponse.json({
      success: true,
      errors: [],
      messages: [],
      result: "mock-token-value",
    });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  setApiToken("test-token");
});

afterEach(() => {
  server.resetHandlers();
  clearAccountCache();
  capturedBodies.length = 0;
});

afterAll(() => {
  server.close();
});

describe("createTunnel tunnel_secret", () => {
  it("sends a non-empty tunnel_secret in the API request", async () => {
    await createTunnel.handler({ name: "test-tunnel" });

    expect(capturedBodies).toHaveLength(1);
    const secret = capturedBodies[0].tunnel_secret as string;
    expect(secret).toBeTruthy();
    expect(secret.length).toBeGreaterThan(0);
  });

  it("sends a valid base64-encoded string", async () => {
    await createTunnel.handler({ name: "test-tunnel-b64" });

    const secret = capturedBodies[0].tunnel_secret as string;
    // Base64 regex: only valid base64 characters + padding
    expect(secret).toMatch(/^[A-Za-z0-9+/]+=*$/);

    // Should not throw when decoded
    const decoded = Buffer.from(secret, "base64");
    // Re-encode to verify round-trip
    expect(decoded.toString("base64")).toBe(secret);
  });

  it("sends a secret that is exactly 32 bytes when decoded", async () => {
    await createTunnel.handler({ name: "test-tunnel-32" });

    const secret = capturedBodies[0].tunnel_secret as string;
    const decoded = Buffer.from(secret, "base64");
    expect(decoded.length).toBe(32);
  });

  it("generates a different secret on each call", async () => {
    await createTunnel.handler({ name: "tunnel-a" });
    await createTunnel.handler({ name: "tunnel-b" });

    expect(capturedBodies).toHaveLength(2);
    const secretA = capturedBodies[0].tunnel_secret as string;
    const secretB = capturedBodies[1].tunnel_secret as string;
    expect(secretA).not.toBe(secretB);
  });
});
