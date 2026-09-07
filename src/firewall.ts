import { z } from "zod";
import { cfGet, cfPost, cfPatch, cfDelete, isRateLimited, paginate } from "./utils/cf-client.js";
import { resolveZone } from "./utils/zone-resolver.js";
import { resolveAccount } from "./utils/account-resolver.js";
import type { ToolDef } from "./server.js";
import { textResult, errorResult } from "./server.js";

interface WafRule {
  id: string;
  action: string;
  expression: string;
  description: string;
  enabled: boolean;
  last_updated: string;
}

interface Ruleset {
  id: string;
  name: string;
  kind: string;
  phase: string;
  rules?: WafRule[];
}

async function getCustomRuleset(zoneId: string): Promise<Ruleset | null> {
  const res = await cfGet<Ruleset[]>(`/zones/${zoneId}/rulesets`);
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return (
    res.result.find((rs) => rs.phase === "http_request_firewall_custom") ?? null
  );
}

async function getCustomRulesetWithRules(
  zoneId: string,
): Promise<{ ruleset: Ruleset; rules: WafRule[] }> {
  const listing = await getCustomRuleset(zoneId);
  if (!listing) {
    return { ruleset: { id: "", name: "", kind: "", phase: "" }, rules: [] };
  }

  const res = await cfGet<Ruleset>(`/zones/${zoneId}/rulesets/${listing.id}`);
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return { ruleset: res.result, rules: res.result.rules ?? [] };
}

// --- Tool: list_waf_custom_rules ---

const ListWafInput = z.object({
  zone: z.string().describe("Domain name (e.g. example.com) or zone ID"),
});

async function listWafCustomRules(input: Record<string, unknown>) {
  const { zone } = ListWafInput.parse(input);
  const zoneId = await resolveZone(zone);
  const { rules } = await getCustomRulesetWithRules(zoneId);
  return textResult({ zone, zone_id: zoneId, rules, count: rules.length });
}

// --- Tool: create_waf_custom_rule ---

const CreateWafInput = z.object({
  zone: z.string().describe("Domain name or zone ID"),
  expression: z
    .string()
    .describe('Cloudflare WAF expression (e.g. \'ip.src in {1.2.3.4 5.6.7.8}\')'),
  action: z.enum([
    "block",
    "challenge",
    "js_challenge",
    "managed_challenge",
    "skip",
    "log",
  ]),
  description: z.string().optional().default(""),
  enabled: z.boolean().optional().default(true),
  action_parameters: z
    .record(z.unknown())
    .optional()
    .describe(
      'Parameters for the action. Required for "skip" (e.g. {"ruleset":"current","phases":["http_request_firewall_managed"]})',
    ),
  dry_run: z
    .boolean()
    .optional()
    .default(false)
    .describe("Preview the rule without creating it"),
});

async function createWafCustomRule(input: Record<string, unknown>) {
  const { zone, expression, action, description, enabled, action_parameters, dry_run } =
    CreateWafInput.parse(input);
  const zoneId = await resolveZone(zone);
  const { ruleset, rules } = await getCustomRulesetWithRules(zoneId);

  const newRule: Record<string, unknown> = { action, expression, description, enabled };
  if (action_parameters) {
    newRule.action_parameters = action_parameters;
  }

  if (dry_run) {
    return textResult({
      dry_run: true,
      would_create: newRule,
      current_rules_count: rules.length,
      zone,
      zone_id: zoneId,
    });
  }

  if (!ruleset.id) {
    // Zone has no custom ruleset yet — create one with this rule
    const res = await cfPost<Ruleset>(`/zones/${zoneId}/rulesets`, {
      name: "Custom WAF rules",
      kind: "zone",
      phase: "http_request_firewall_custom",
      rules: [newRule],
    });
    if (isRateLimited(res)) {
      throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
    }
    const created = res.result.rules?.[0];
    return textResult({ created: true, rule: created, zone, zone_id: zoneId });
  }

  const res = await cfPost<WafRule[]>(
    `/zones/${zoneId}/rulesets/${ruleset.id}/rules`,
    [newRule],
  );
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({ created: true, rule: res.result, zone, zone_id: zoneId });
}

// --- Tool: update_waf_custom_rule ---

const UpdateWafInput = z.object({
  zone: z.string().describe("Domain name or zone ID"),
  rule_id: z.string().describe("ID of the rule to update"),
  expression: z.string().optional(),
  action: z
    .enum(["block", "challenge", "js_challenge", "managed_challenge", "skip", "log"])
    .optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  action_parameters: z.record(z.unknown()).optional(),
  dry_run: z.boolean().optional().default(false),
});

async function updateWafCustomRule(input: Record<string, unknown>) {
  const { zone, rule_id, dry_run, ...updates } = UpdateWafInput.parse(input);
  const zoneId = await resolveZone(zone);
  const { ruleset, rules } = await getCustomRulesetWithRules(zoneId);

  if (!ruleset.id) {
    return errorResult("No custom WAF ruleset found for this zone.");
  }

  const existing = rules.find((r) => r.id === rule_id);
  if (!existing) {
    return errorResult(`Rule ${rule_id} not found in zone ${zone}.`);
  }

  const patch = Object.fromEntries(
    Object.entries(updates).filter(([, v]) => v !== undefined),
  );

  if (dry_run) {
    return textResult({
      dry_run: true,
      rule_id,
      current_state: existing,
      would_update: patch,
    });
  }

  const res = await cfPatch<WafRule>(
    `/zones/${zoneId}/rulesets/${ruleset.id}/rules/${rule_id}`,
    patch,
  );
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({
    updated: true,
    previous_state: existing,
    new_state: res.result,
  });
}

// --- Tool: delete_waf_custom_rule ---

const DeleteWafInput = z.object({
  zone: z.string().describe("Domain name or zone ID"),
  rule_id: z.string().describe("ID of the rule to delete"),
});

async function deleteWafCustomRule(input: Record<string, unknown>) {
  const { zone, rule_id } = DeleteWafInput.parse(input);
  const zoneId = await resolveZone(zone);
  const { ruleset, rules } = await getCustomRulesetWithRules(zoneId);

  if (!ruleset.id) {
    return errorResult("No custom WAF ruleset found for this zone.");
  }

  const existing = rules.find((r) => r.id === rule_id);
  if (!existing) {
    return errorResult(`Rule ${rule_id} not found in zone ${zone}.`);
  }

  const res = await cfDelete(
    `/zones/${zoneId}/rulesets/${ruleset.id}/rules/${rule_id}`,
  );
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({ deleted: true, rule_id, previous_state: existing });
}

// --- Tool: list_waf_managed_rulesets ---

const ListManagedInput = z.object({
  zone: z.string().describe("Domain name or zone ID"),
});

async function listWafManagedRulesets(input: Record<string, unknown>) {
  const { zone } = ListManagedInput.parse(input);
  const zoneId = await resolveZone(zone);

  const res = await cfGet<Ruleset[]>(`/zones/${zoneId}/rulesets`);
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }

  const managed = res.result.filter((rs) => rs.kind === "managed");
  return textResult({ zone, zone_id: zoneId, managed_rulesets: managed });
}

// --- Tool: list_ip_list_items ---

interface IpList {
  id: string;
  name: string;
  kind: string;
  num_items: number;
}

interface IpListItem {
  id: string;
  ip: string;
  comment: string;
  created_on: string;
  modified_on: string;
}

const ListIpListItemsInput = z.object({
  list_id: z.string().optional().describe("IP List ID (provide this or list_name)"),
  list_name: z
    .string()
    .optional()
    .describe("IP List name (alternative to list_id — resolved by lookup)"),
});

async function listIpListItems(input: Record<string, unknown>) {
  const { list_id, list_name } = ListIpListItemsInput.parse(input);
  if (!list_id && !list_name) {
    return errorResult("Provide list_id or list_name (at least one is required).");
  }
  const accountId = await resolveAccount();

  let resolvedId = list_id;
  let resolvedName = list_name;

  if (!resolvedId) {
    const lists = await paginate<IpList>(`/accounts/${accountId}/rules/lists`);
    const match = lists.find((l) => l.name === list_name && l.kind === "ip");
    if (!match) {
      return errorResult(`IP list "${list_name}" not found.`);
    }
    resolvedId = match.id;
    resolvedName = match.name;
  }

  const items = await paginate<IpListItem>(
    `/accounts/${accountId}/rules/lists/${resolvedId}/items`,
  );
  return textResult({
    list_id: resolvedId,
    list_name: resolvedName ?? null,
    items,
    count: items.length,
  });
}

// --- Export all tools ---

export const firewallTools: ToolDef[] = [
  {
    name: "list_waf_custom_rules",
    description:
      "List all custom WAF rules for a Cloudflare zone. Returns rule IDs, expressions, actions, and enabled status.",
    inputSchema: ListWafInput,
    annotations: { readOnlyHint: true },
    handler: listWafCustomRules,
  },
  {
    name: "create_waf_custom_rule",
    description:
      "Create a custom WAF rule to block, challenge, or log traffic matching a Cloudflare expression. Supports dry_run to preview without applying.",
    inputSchema: CreateWafInput,
    handler: createWafCustomRule,
  },
  {
    name: "update_waf_custom_rule",
    description:
      "Update an existing custom WAF rule (expression, action, description, or enabled state). Supports dry_run.",
    inputSchema: UpdateWafInput,
    handler: updateWafCustomRule,
  },
  {
    name: "delete_waf_custom_rule",
    description: "Delete a custom WAF rule by ID. This action is irreversible.",
    inputSchema: DeleteWafInput,
    annotations: { destructiveHint: true },
    handler: deleteWafCustomRule,
  },
  {
    name: "list_waf_managed_rulesets",
    description:
      "List managed WAF rulesets (OWASP, Cloudflare Managed, etc.) and their status for a zone.",
    inputSchema: ListManagedInput,
    annotations: { readOnlyHint: true },
    handler: listWafManagedRulesets,
  },
  {
    name: "list_ip_list_items",
    description:
      "List items in a Cloudflare IP List. Look up by list_id or list_name.",
    inputSchema: ListIpListItemsInput,
    annotations: { readOnlyHint: true },
    handler: listIpListItems,
  },
];
