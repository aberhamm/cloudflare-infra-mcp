import { describe, it, expect } from "vitest";
import "./setup.js";
import { firewallTools } from "../../src/firewall.js";

const listRules = firewallTools.find((t) => t.name === "list_waf_custom_rules")!;
const createRule = firewallTools.find((t) => t.name === "create_waf_custom_rule")!;
const deleteRule = firewallTools.find((t) => t.name === "delete_waf_custom_rule")!;
const listManaged = firewallTools.find((t) => t.name === "list_waf_managed_rulesets")!;

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("WAF tools (integration)", () => {
  it("list_waf_custom_rules returns existing rules", async () => {
    const result = await listRules.handler({ zone: "example.com" });
    const data = parseResult(result);
    expect(data.count).toBe(1);
    expect(data.rules[0].action).toBe("block");
    expect(data.rules[0].expression).toBe("ip.src == 10.0.0.1");
  });

  it("create_waf_custom_rule dry_run returns preview", async () => {
    const result = await createRule.handler({
      zone: "example.com",
      expression: "ip.src in {192.168.1.0/24}",
      action: "block",
      dry_run: true,
    });
    const data = parseResult(result);
    expect(data.dry_run).toBe(true);
    expect(data.would_create.action).toBe("block");
    expect(data.current_rules_count).toBe(1);
  });

  it("create_waf_custom_rule actually creates rule", async () => {
    const result = await createRule.handler({
      zone: "example.com",
      expression: "ip.src == 99.99.99.99",
      action: "block",
      description: "Test block",
    });
    const data = parseResult(result);
    expect(data.created).toBe(true);
  });

  it("create_waf_custom_rule with skip and action_parameters", async () => {
    const result = await createRule.handler({
      zone: "example.com",
      expression: "ip.src in {10.0.0.0/8}",
      action: "skip",
      action_parameters: { ruleset: "current" },
    });
    const data = parseResult(result);
    expect(data.created).toBe(true);
  });

  it("delete_waf_custom_rule removes rule", async () => {
    const result = await deleteRule.handler({
      zone: "example.com",
      rule_id: "rule_001",
    });
    const data = parseResult(result);
    expect(data.deleted).toBe(true);
    expect(data.previous_state.expression).toBe("ip.src == 10.0.0.1");
  });

  it("delete_waf_custom_rule errors on unknown rule", async () => {
    const result = await deleteRule.handler({
      zone: "example.com",
      rule_id: "nonexistent",
    });
    expect(result.isError).toBe(true);
  });

  it("list_waf_managed_rulesets returns managed rulesets", async () => {
    const result = await listManaged.handler({ zone: "example.com" });
    const data = parseResult(result);
    expect(data.managed_rulesets.length).toBe(1);
    expect(data.managed_rulesets[0].kind).toBe("managed");
  });
});
