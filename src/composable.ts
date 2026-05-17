import { z } from "zod";
import { cfGet, cfPost, cfPut, cfDelete, isRateLimited, paginate } from "./utils/cf-client.js";
import { resolveZone } from "./utils/zone-resolver.js";
import { resolveAccount } from "./utils/account-resolver.js";
import type { ToolDef } from "./server.js";
import { textResult } from "./server.js";

interface CompletedStep {
  action: string;
  result: unknown;
}

interface FailedStep {
  action: string;
  error: string;
  cleanup_hint: string;
}

// --- setup_tunnel_with_dns ---

const SetupTunnelDnsInput = z.object({
  tunnel_name: z.string().describe("Name for the new tunnel"),
  hostname: z.string().describe("Public hostname (e.g. app.example.com)"),
  service: z
    .string()
    .describe("Origin service URL (e.g. http://localhost:8080)"),
  zone: z
    .string()
    .optional()
    .describe("Zone for DNS record (auto-detected from hostname if omitted)"),
  dry_run: z.boolean().optional().default(false),
});

async function setupTunnelWithDns(input: Record<string, unknown>) {
  const { tunnel_name, hostname, service, zone, dry_run } =
    SetupTunnelDnsInput.parse(input);

  const accountId = await resolveAccount();
  // Detect zone from hostname if not provided
  const zoneName = zone ?? hostname.split(".").slice(-2).join(".");
  const zoneId = await resolveZone(zoneName);

  if (dry_run) {
    return textResult({
      dry_run: true,
      steps: [
        { action: "create_tunnel", params: { name: tunnel_name } },
        {
          action: "update_tunnel_config",
          params: { ingress: [{ hostname, service }, { service: "http_status:404" }] },
        },
        {
          action: "create_cname",
          params: { type: "CNAME", name: hostname, content: `<tunnel_id>.cfargotunnel.com` },
        },
      ],
    });
  }

  const completed: CompletedStep[] = [];

  // Step 1: Create tunnel
  let tunnelId: string;
  let token: string;
  try {
    const tunnelRes = await cfPost<{ id: string; token?: string }>(
      `/accounts/${accountId}/cfd_tunnel`,
      { name: tunnel_name, config_src: "cloudflare", tunnel_secret: "" },
    );
    if (isRateLimited(tunnelRes)) throw new Error("Rate limited");
    tunnelId = tunnelRes.result.id;

    const tokenRes = await cfGet<string>(
      `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
    );
    token = isRateLimited(tokenRes) ? "(fetch token separately)" : tokenRes.result;

    completed.push({ action: "create_tunnel", result: { id: tunnelId, name: tunnel_name, token } });
  } catch (err) {
    const failed: FailedStep = {
      action: "create_tunnel",
      error: err instanceof Error ? err.message : String(err),
      cleanup_hint: "No cleanup needed — tunnel was not created.",
    };
    return textResult({ completed_steps: completed, failed_step: failed });
  }

  // Step 2: Configure ingress
  try {
    const ingress = [
      { hostname, service },
      { service: "http_status:404" },
    ];
    const configRes = await cfPut<unknown>(
      `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
      { config: { ingress } },
    );
    if (isRateLimited(configRes)) throw new Error("Rate limited");
    completed.push({ action: "update_tunnel_config", result: { ingress } });
  } catch (err) {
    const failed: FailedStep = {
      action: "update_tunnel_config",
      error: err instanceof Error ? err.message : String(err),
      cleanup_hint: `Tunnel ${tunnelId} was created but not configured. Delete it or configure manually.`,
    };
    return textResult({ completed_steps: completed, failed_step: failed });
  }

  // Step 3: Create CNAME DNS record
  try {
    const cnameContent = `${tunnelId}.cfargotunnel.com`;
    const dnsRes = await cfPost<unknown>(`/zones/${zoneId}/dns_records`, {
      type: "CNAME",
      name: hostname,
      content: cnameContent,
      proxied: true,
      ttl: 1,
    });
    if (isRateLimited(dnsRes)) throw new Error("Rate limited");
    completed.push({ action: "create_cname", result: { name: hostname, content: cnameContent } });
  } catch (err) {
    const failed: FailedStep = {
      action: "create_cname",
      error: err instanceof Error ? err.message : String(err),
      cleanup_hint: `Tunnel ${tunnelId} created and configured, but DNS record failed. Create CNAME manually: ${hostname} → ${tunnelId}.cfargotunnel.com`,
    };
    return textResult({ completed_steps: completed, failed_step: failed });
  }

  return textResult({
    completed_steps: completed,
    final_state: {
      tunnel_id: tunnelId,
      hostname,
      service,
      run_command: `cloudflared tunnel run --token ${token}`,
    },
  });
}

// --- block_ips ---

const BlockIpsInput = z.object({
  zone: z.string().describe("Domain name or zone ID (for the WAF rule)"),
  ips: z
    .array(z.string())
    .describe("IP addresses or CIDR ranges to block"),
  list_name: z
    .string()
    .optional()
    .default("cloudflare_infra_blocked")
    .describe("Name for the IP List"),
  dry_run: z.boolean().optional().default(false),
});

interface IpList {
  id: string;
  name: string;
  kind: string;
  num_items: number;
}

async function blockIps(input: Record<string, unknown>) {
  const { zone, ips, list_name, dry_run } = BlockIpsInput.parse(input);
  const accountId = await resolveAccount();
  const zoneId = await resolveZone(zone);

  if (dry_run) {
    return textResult({
      dry_run: true,
      steps: [
        { action: "find_or_create_ip_list", params: { name: list_name } },
        { action: "add_ips_to_list", params: { ips } },
        { action: "ensure_waf_rule_references_list" },
      ],
    });
  }

  const completed: CompletedStep[] = [];

  // Step 1: Find or create IP list
  let listId: string;
  try {
    const lists = await paginate<IpList>(`/accounts/${accountId}/rules/lists`);
    const existing = lists.find((l) => l.name === list_name && l.kind === "ip");

    if (existing) {
      listId = existing.id;
      completed.push({ action: "found_ip_list", result: { id: listId, name: list_name } });
    } else {
      const createRes = await cfPost<IpList>(`/accounts/${accountId}/rules/lists`, {
        name: list_name,
        kind: "ip",
        description: "Blocked IPs managed by cloudflare-infra-mcp",
      });
      if (isRateLimited(createRes)) throw new Error("Rate limited");
      listId = createRes.result.id;
      completed.push({ action: "created_ip_list", result: { id: listId, name: list_name } });
    }
  } catch (err) {
    return textResult({
      completed_steps: completed,
      failed_step: {
        action: "find_or_create_ip_list",
        error: err instanceof Error ? err.message : String(err),
        cleanup_hint: "No cleanup needed.",
      },
    });
  }

  // Step 2: Add IPs to the list
  try {
    const items = ips.map((ip) => ({ ip, comment: `Added by cloudflare-infra-mcp` }));
    const addRes = await cfPost<unknown>(
      `/accounts/${accountId}/rules/lists/${listId}/items`,
      items,
    );
    if (isRateLimited(addRes)) throw new Error("Rate limited");
    completed.push({ action: "added_ips", result: { count: ips.length, ips } });
  } catch (err) {
    return textResult({
      completed_steps: completed,
      failed_step: {
        action: "add_ips_to_list",
        error: err instanceof Error ? err.message : String(err),
        cleanup_hint: `IP list ${listId} exists but IPs were not added.`,
      },
    });
  }

  // Step 3: Ensure WAF rule references the list
  try {
    // Check if a rule already references this list
    const rulesetsRes = await cfGet<Array<{ id: string; phase: string }>>(
      `/zones/${zoneId}/rulesets`,
    );
    if (isRateLimited(rulesetsRes)) throw new Error("Rate limited");

    const customRuleset = rulesetsRes.result.find(
      (rs) => rs.phase === "http_request_firewall_custom",
    );

    const expression = `ip.src in $${list_name}`;

    if (customRuleset) {
      // Check if rule already exists
      const rulesetDetail = await cfGet<{ rules?: Array<{ expression: string }> }>(
        `/zones/${zoneId}/rulesets/${customRuleset.id}`,
      );
      if (!isRateLimited(rulesetDetail)) {
        const hasRule = rulesetDetail.result.rules?.some(
          (r) => r.expression === expression,
        );
        if (hasRule) {
          completed.push({ action: "waf_rule_exists", result: { expression } });
          return textResult({ completed_steps: completed, final_state: { list_id: listId, ips_added: ips.length } });
        }
      }

      // Create rule in existing ruleset
      await cfPost<unknown>(`/zones/${zoneId}/rulesets/${customRuleset.id}/rules`, [
        { action: "block", expression, description: `Block IPs in ${list_name}`, enabled: true },
      ]);
    } else {
      // Create ruleset with the rule
      await cfPost<unknown>(`/zones/${zoneId}/rulesets`, {
        name: "Custom WAF rules",
        kind: "zone",
        phase: "http_request_firewall_custom",
        rules: [{ action: "block", expression, description: `Block IPs in ${list_name}`, enabled: true }],
      });
    }
    completed.push({ action: "ensured_waf_rule", result: { expression } });
  } catch (err) {
    return textResult({
      completed_steps: completed,
      failed_step: {
        action: "ensure_waf_rule",
        error: err instanceof Error ? err.message : String(err),
        cleanup_hint: `IPs added to list ${listId}, but WAF rule not created. Add rule manually with expression: ip.src in $${list_name}`,
      },
    });
  }

  return textResult({
    completed_steps: completed,
    final_state: { list_id: listId, ips_added: ips.length, zone },
  });
}

// --- setup_access_for_tunnel ---

const SetupAccessInput = z.object({
  hostname: z.string().describe("Hostname to protect (must already have a tunnel route)"),
  app_name: z.string().describe("Access application name"),
  allowed_emails: z
    .array(z.string())
    .optional()
    .describe("Email addresses allowed access"),
  allowed_domains: z
    .array(z.string())
    .optional()
    .describe("Email domains allowed access (e.g. company.com)"),
  dry_run: z.boolean().optional().default(false),
});

async function setupAccessForTunnel(input: Record<string, unknown>) {
  const { hostname, app_name, allowed_emails, allowed_domains, dry_run } =
    SetupAccessInput.parse(input);
  const accountId = await resolveAccount();

  const includeRules: Array<Record<string, unknown>> = [];
  if (allowed_emails) {
    for (const email of allowed_emails) {
      includeRules.push({ email: { email } });
    }
  }
  if (allowed_domains) {
    for (const domain of allowed_domains) {
      includeRules.push({ email_domain: { domain } });
    }
  }

  if (dry_run) {
    return textResult({
      dry_run: true,
      steps: [
        { action: "create_access_app", params: { name: app_name, domain: hostname } },
        { action: "create_access_policy", params: { include: includeRules } },
      ],
    });
  }

  const completed: CompletedStep[] = [];

  // Step 1: Create Access application
  let appId: string;
  try {
    const appRes = await cfPost<{ id: string }>(
      `/accounts/${accountId}/access/apps`,
      { name: app_name, domain: hostname, type: "self_hosted", session_duration: "24h" },
    );
    if (isRateLimited(appRes)) throw new Error("Rate limited");
    appId = appRes.result.id;
    completed.push({ action: "created_access_app", result: { id: appId, domain: hostname } });
  } catch (err) {
    return textResult({
      completed_steps: completed,
      failed_step: {
        action: "create_access_app",
        error: err instanceof Error ? err.message : String(err),
        cleanup_hint: "No cleanup needed.",
      },
    });
  }

  // Step 2: Create policy
  try {
    if (includeRules.length === 0) {
      completed.push({ action: "skipped_policy", result: "No include rules specified" });
    } else {
      const policyRes = await cfPost<unknown>(
        `/accounts/${accountId}/access/apps/${appId}/policies`,
        { name: `${app_name} policy`, decision: "allow", include: includeRules, precedence: 1 },
      );
      if (isRateLimited(policyRes)) throw new Error("Rate limited");
      completed.push({ action: "created_policy", result: { include: includeRules } });
    }
  } catch (err) {
    return textResult({
      completed_steps: completed,
      failed_step: {
        action: "create_access_policy",
        error: err instanceof Error ? err.message : String(err),
        cleanup_hint: `Access app ${appId} created for ${hostname} but has no policy. Add one manually.`,
      },
    });
  }

  return textResult({
    completed_steps: completed,
    final_state: { app_id: appId, hostname, protected: true },
  });
}

export const composableTools: ToolDef[] = [
  {
    name: "setup_tunnel_with_dns",
    description:
      "Create a Cloudflare Tunnel, configure ingress, and create a CNAME DNS record — all in one step. Reports partial progress on failure.",
    inputSchema: SetupTunnelDnsInput,
    handler: setupTunnelWithDns,
  },
  {
    name: "block_ips",
    description:
      "Block IP addresses using Cloudflare IP Lists and a single WAF rule. Scalable — designed for Fail2Ban integration. Reports partial progress on failure.",
    inputSchema: BlockIpsInput,
    handler: blockIps,
  },
  {
    name: "setup_access_for_tunnel",
    description:
      "Create a Zero Trust Access application and policy for a tunneled hostname. Reports partial progress on failure.",
    inputSchema: SetupAccessInput,
    handler: setupAccessForTunnel,
  },
];
