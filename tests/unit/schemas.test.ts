import { describe, it, expect } from "vitest";
import { z } from "zod";

// Re-create the schemas here to test them in isolation (avoiding CF API imports)
const CreateWafInput = z.object({
  zone: z.string(),
  expression: z.string(),
  action: z.enum(["block", "challenge", "js_challenge", "managed_challenge", "skip", "log"]),
  description: z.string().optional().default(""),
  enabled: z.boolean().optional().default(true),
  action_parameters: z.record(z.unknown()).optional(),
  dry_run: z.boolean().optional().default(false),
});

const UpsertDnsInput = z.object({
  zone: z.string(),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "SRV"]),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean().optional().default(false),
  ttl: z.number().optional().default(1),
  priority: z.number().optional(),
  dry_run: z.boolean().optional().default(false),
});

describe("WAF schema", () => {
  it("accepts valid block rule", () => {
    const result = CreateWafInput.safeParse({
      zone: "example.com",
      expression: "ip.src == 1.2.3.4",
      action: "block",
    });
    expect(result.success).toBe(true);
  });

  it("defaults dry_run to false", () => {
    const result = CreateWafInput.parse({
      zone: "example.com",
      expression: "ip.src == 1.2.3.4",
      action: "block",
    });
    expect(result.dry_run).toBe(false);
    expect(result.enabled).toBe(true);
  });

  it("rejects invalid action", () => {
    const result = CreateWafInput.safeParse({
      zone: "example.com",
      expression: "ip.src == 1.2.3.4",
      action: "nuke",
    });
    expect(result.success).toBe(false);
  });

  it("accepts skip with action_parameters", () => {
    const result = CreateWafInput.safeParse({
      zone: "example.com",
      expression: "ip.src == 10.0.0.0/8",
      action: "skip",
      action_parameters: {
        ruleset: "current",
        phases: ["http_request_firewall_managed"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action_parameters).toEqual({
        ruleset: "current",
        phases: ["http_request_firewall_managed"],
      });
    }
  });

  it("accepts skip without action_parameters (schema allows it, CF API will reject)", () => {
    const result = CreateWafInput.safeParse({
      zone: "example.com",
      expression: "ip.src == 10.0.0.0/8",
      action: "skip",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(CreateWafInput.safeParse({ zone: "example.com" }).success).toBe(false);
    expect(CreateWafInput.safeParse({ expression: "true" }).success).toBe(false);
    expect(CreateWafInput.safeParse({}).success).toBe(false);
  });
});

describe("DNS upsert schema", () => {
  it("accepts valid A record", () => {
    const result = UpsertDnsInput.safeParse({
      zone: "example.com",
      type: "A",
      name: "www",
      content: "1.2.3.4",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.proxied).toBe(false);
      expect(result.data.ttl).toBe(1);
    }
  });

  it("accepts MX with priority", () => {
    const result = UpsertDnsInput.safeParse({
      zone: "example.com",
      type: "MX",
      name: "example.com",
      content: "mail.example.com",
      priority: 10,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unsupported record type", () => {
    const result = UpsertDnsInput.safeParse({
      zone: "example.com",
      type: "LOC",
      name: "www",
      content: "something",
    });
    expect(result.success).toBe(false);
  });
});
