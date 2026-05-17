/**
 * Live smoke tests — run against real Cloudflare API.
 *
 * Requires CLOUDFLARE_API_TOKEN and SMOKE_TEST_ZONE env vars.
 * Run with: SMOKE_TEST_ZONE=matthew.systems npx vitest run tests/smoke/
 */
import { describe, it, expect, beforeAll } from "vitest";
import { setApiToken } from "../../src/utils/cf-client.js";
import { clearZoneCache } from "../../src/utils/zone-resolver.js";
import { zoneTools } from "../../src/zones.js";
import { dnsTools } from "../../src/dns.js";
import { firewallTools } from "../../src/firewall.js";

const ZONE = process.env.SMOKE_TEST_ZONE;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const skip = !TOKEN || !ZONE;

beforeAll(() => {
  if (skip) return;
  setApiToken(TOKEN!);
  clearZoneCache();
});

describe.skipIf(skip)("smoke: zones", () => {
  it("list_zones returns real zones", async () => {
    const list = zoneTools.find((t) => t.name === "list_zones")!;
    const result = await list.handler({});
    const data = parseResult(result);
    expect(data.count).toBeGreaterThan(0);
    expect(data.zones.some((z: { name: string }) => z.name === ZONE)).toBe(true);
  });

  it("get_zone resolves by name", async () => {
    const get = zoneTools.find((t) => t.name === "get_zone")!;
    const result = await get.handler({ zone: ZONE! });
    const data = parseResult(result);
    expect(data.name).toBe(ZONE);
    expect(data.id).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe.skipIf(skip)("smoke: DNS", () => {
  it("list_dns_records returns records", async () => {
    const list = dnsTools.find((t) => t.name === "list_dns_records")!;
    const result = await list.handler({ zone: ZONE! });
    const data = parseResult(result);
    expect(data.count).toBeGreaterThan(0);
  });

  it("upsert_dns_record dry_run on TXT record", async () => {
    const upsert = dnsTools.find((t) => t.name === "upsert_dns_record")!;
    const result = await upsert.handler({
      zone: ZONE!,
      type: "TXT",
      name: `_smoke-test.${ZONE}`,
      content: "cloudflare-infra-mcp-smoke-test",
      dry_run: true,
    });
    const data = parseResult(result);
    expect(data.dry_run).toBe(true);
  });

  it("export_dns_records returns BIND content", async () => {
    const exp = dnsTools.find((t) => t.name === "export_dns_records")!;
    const result = await exp.handler({ zone: ZONE! });
    const data = parseResult(result);
    expect(data.format).toBe("BIND");
    expect(data.content).toContain(ZONE);
  });
});

describe.skipIf(skip)("smoke: WAF", () => {
  it("list_waf_custom_rules returns without error", async () => {
    const list = firewallTools.find((t) => t.name === "list_waf_custom_rules")!;
    const result = await list.handler({ zone: ZONE! });
    const data = parseResult(result);
    expect(data).toHaveProperty("rules");
    expect(data).toHaveProperty("count");
  });

  it("create_waf_custom_rule dry_run returns preview", async () => {
    const create = firewallTools.find((t) => t.name === "create_waf_custom_rule")!;
    const result = await create.handler({
      zone: ZONE!,
      expression: 'http.request.uri.path contains "/smoke-test-never-match"',
      action: "log",
      description: "Smoke test — dry run only",
      dry_run: true,
    });
    const data = parseResult(result);
    expect(data.dry_run).toBe(true);
    expect(data.would_create.action).toBe("log");
  });
});
