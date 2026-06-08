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

const AccessIncludeRuleInput = z
  .object({
    email: z.object({ email: z.string() }).optional(),
    email_domain: z.object({ domain: z.string() }).optional(),
    ip: z.object({ ip: z.string() }).optional(),
    service_token: z.object({ token_id: z.string().min(1) }).optional(),
    any_valid_service_token: z.object({}).optional(),
  })
  .refine(
    (rule) =>
      [
        rule.email,
        rule.email_domain,
        rule.ip,
        rule.service_token,
        rule.any_valid_service_token,
      ].filter(Boolean).length === 1,
  );

const CreateAccessPolicyInput = z.object({
  app_id: z.string(),
  name: z.string(),
  decision: z.enum(["allow", "deny", "non_identity", "bypass"]).default("allow"),
  include: z.array(AccessIncludeRuleInput).min(1),
  precedence: z.number().optional().default(1),
  dry_run: z.boolean().optional().default(false),
});

const CreateAccessServiceTokenInput = z.object({
  name: z.string(),
  duration: z.string().optional().default("8760h"),
  dry_run: z.boolean().optional().default(false),
});

const DiagnoseCloudflarePermissionsInput = z.object({
  zone_id: z.string().optional(),
  app_id: z.string().optional(),
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

describe("Access schemas", () => {
  it("accepts a Service Auth policy for a specific service token", () => {
    const result = CreateAccessPolicyInput.safeParse({
      app_id: "416eafd8-bc1d-4996-a3fa-749174db5889",
      name: "Obsidian LiveSync service token",
      decision: "non_identity",
      include: [{ service_token: { token_id: "3537a672-e4d8-4d89-aab9-26cb622918a1" } }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decision).toBe("non_identity");
      expect(result.data.precedence).toBe(1);
    }
  });

  it("rejects a service token rule without token_id", () => {
    const result = CreateAccessPolicyInput.safeParse({
      app_id: "app-id",
      name: "invalid",
      decision: "non_identity",
      include: [{ service_token: {} }],
    });
    expect(result.success).toBe(false);
  });

  it("defaults service token duration to one year", () => {
    const result = CreateAccessServiceTokenInput.parse({
      name: "Obsidian LiveSync",
    });
    expect(result.duration).toBe("8760h");
    expect(result.dry_run).toBe(false);
  });

  it("accepts optional diagnostic context", () => {
    const result = DiagnoseCloudflarePermissionsInput.safeParse({
      zone_id: "8066ef16cb9c768b3fe2134f14913611",
      app_id: "416eafd8-bc1d-4996-a3fa-749174db5889",
    });
    expect(result.success).toBe(true);
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
