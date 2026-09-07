import { z } from "zod";
import { cfGet, cfPost, cfPatch, cfDelete, isRateLimited, paginate } from "./utils/cf-client.js";
import { resolveZone } from "./utils/zone-resolver.js";
import { resolveAccount } from "./utils/account-resolver.js";
import type { ToolDef } from "./server.js";
import { textResult } from "./server.js";

interface Zone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
  name_servers: string[];
  created_on: string;
  modified_on: string;
}

// --- list_zones ---

const ListZonesInput = z.object({
  name: z
    .string()
    .optional()
    .describe("Filter by domain name (exact match)"),
  status: z
    .enum(["active", "pending", "initializing", "moved", "deleted", "deactivated"])
    .optional(),
});

async function listZones(input: Record<string, unknown>) {
  const { name, status } = ListZonesInput.parse(input);
  const zones = await paginate<Zone>("/zones", { name, status });
  return textResult({ zones, count: zones.length });
}

// --- get_zone ---

const GetZoneInput = z.object({
  zone: z.string().describe("Domain name or zone ID"),
});

async function getZone(input: Record<string, unknown>) {
  const { zone } = GetZoneInput.parse(input);
  const zoneId = await resolveZone(zone);
  const res = await cfGet<Zone>(`/zones/${zoneId}`);
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult(res.result);
}

// --- purge_cache ---

const PurgeCacheInput = z.object({
  zone: z.string().describe("Domain name or zone ID"),
  purge_everything: z
    .boolean()
    .optional()
    .default(false)
    .describe("Purge all cached content"),
  files: z
    .array(z.string())
    .optional()
    .describe("Specific URLs to purge"),
  dry_run: z.boolean().optional().default(false),
});

async function purgeCache(input: Record<string, unknown>) {
  const { zone, purge_everything, files, dry_run } = PurgeCacheInput.parse(input);
  const zoneId = await resolveZone(zone);

  const body: Record<string, unknown> = {};
  if (purge_everything) {
    body.purge_everything = true;
  } else if (files && files.length > 0) {
    body.files = files;
  } else {
    body.purge_everything = true;
  }

  if (dry_run) {
    return textResult({ dry_run: true, would_purge: body, zone, zone_id: zoneId });
  }

  const res = await cfPost<{ id: string }>(`/zones/${zoneId}/purge_cache`, body);
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({ purged: true, details: body, zone, zone_id: zoneId });
}

// --- create_zone ---

const CreateZoneInput = z.object({
  name: z.string().describe("Domain name to add (e.g. example.com)"),
  type: z
    .enum(["full", "partial"])
    .optional()
    .default("full")
    .describe("Zone type: full (Cloudflare nameservers) or partial (CNAME setup)"),
  jump_start: z
    .boolean()
    .optional()
    .default(true)
    .describe("Auto-scan existing DNS records on creation"),
  dry_run: z.boolean().optional().default(false),
});

async function createZone(input: Record<string, unknown>) {
  const { name, type, jump_start, dry_run } = CreateZoneInput.parse(input);
  const accountId = await resolveAccount();

  const body = { name, account: { id: accountId }, type, jump_start };

  if (dry_run) {
    return textResult({ dry_run: true, would_create: body });
  }

  const res = await cfPost<Zone>("/zones", body);
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({
    created: true,
    zone: res.result,
    note: type === "full"
      ? `Update your registrar nameservers to: ${res.result.name_servers?.join(", ") ?? "(see zone details)"}`
      : "Partial (CNAME) setup — add the verification CNAME at your registrar.",
  });
}

// --- delete_zone ---

const DeleteZoneInput = z.object({
  zone: z.string().describe("Domain name or zone ID"),
});

async function deleteZone(input: Record<string, unknown>) {
  const { zone } = DeleteZoneInput.parse(input);
  const zoneId = await resolveZone(zone);

  const current = await cfGet<Zone>(`/zones/${zoneId}`);
  if (isRateLimited(current)) {
    throw new Error(`Rate limited. Retry after ${current.retry_after}s.`);
  }

  const res = await cfDelete(`/zones/${zoneId}`);
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({ deleted: true, zone_id: zoneId, previous_state: current.result });
}

// --- get_zone_settings ---

interface ZoneSetting {
  id: string;
  value: unknown;
  modified_on?: string;
  editable?: boolean;
}

const GetZoneSettingsInput = z.object({
  zone: z.string().describe("Domain name or zone ID"),
});

async function getZoneSettings(input: Record<string, unknown>) {
  const { zone } = GetZoneSettingsInput.parse(input);
  const zoneId = await resolveZone(zone);
  const res = await cfGet<ZoneSetting[]>(`/zones/${zoneId}/settings`);
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({ zone, zone_id: zoneId, settings: res.result });
}

// --- update_zone_settings ---

const UpdateZoneSettingsInput = z.object({
  zone: z.string().describe("Domain name or zone ID"),
  settings: z
    .array(
      z.object({
        id: z.string().describe("Setting ID (e.g. ssl, always_use_https, min_tls_version, security_level)"),
        value: z.unknown().describe("New value for the setting"),
      }),
    )
    .min(1)
    .describe("Settings to update"),
  dry_run: z.boolean().optional().default(false),
});

async function updateZoneSettings(input: Record<string, unknown>) {
  const { zone, settings, dry_run } = UpdateZoneSettingsInput.parse(input);
  const zoneId = await resolveZone(zone);

  const currentRes = await cfGet<ZoneSetting[]>(`/zones/${zoneId}/settings`);
  if (isRateLimited(currentRes)) {
    throw new Error(`Rate limited. Retry after ${currentRes.retry_after}s.`);
  }

  const currentMap = new Map(currentRes.result.map((s) => [s.id, s.value]));
  const changeset = settings.map((s) => ({
    id: s.id,
    previous_value: currentMap.get(s.id) ?? null,
    new_value: s.value,
  }));

  if (dry_run) {
    return textResult({ dry_run: true, zone, zone_id: zoneId, changes: changeset });
  }

  const res = await cfPatch<ZoneSetting[]>(`/zones/${zoneId}/settings`, {
    items: settings,
  });
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({
    updated: true,
    zone,
    zone_id: zoneId,
    changes: changeset,
    new_settings: res.result,
  });
}

export const zoneTools: ToolDef[] = [
  {
    name: "list_zones",
    description: "List all Cloudflare zones in the account. Optionally filter by name or status.",
    inputSchema: ListZonesInput,
    annotations: { readOnlyHint: true },
    handler: listZones,
  },
  {
    name: "get_zone",
    description: "Get detailed information about a specific Cloudflare zone.",
    inputSchema: GetZoneInput,
    annotations: { readOnlyHint: true },
    handler: getZone,
  },
  {
    name: "purge_cache",
    description: "Purge cached content for a zone — all content or specific URLs. Supports dry_run.",
    inputSchema: PurgeCacheInput,
    handler: purgeCache,
  },
  {
    name: "create_zone",
    description:
      "Add a domain to Cloudflare. Returns nameservers to configure at your registrar. Supports dry_run.",
    inputSchema: CreateZoneInput,
    handler: createZone,
  },
  {
    name: "delete_zone",
    description:
      "Remove a domain from Cloudflare. Irreversible — all DNS records, settings, and configurations will be lost.",
    inputSchema: DeleteZoneInput,
    annotations: { destructiveHint: true },
    handler: deleteZone,
  },
  {
    name: "get_zone_settings",
    description:
      "Get all settings for a zone (SSL mode, TLS version, security level, etc.).",
    inputSchema: GetZoneSettingsInput,
    annotations: { readOnlyHint: true },
    handler: getZoneSettings,
  },
  {
    name: "update_zone_settings",
    description:
      "Update zone settings (e.g. ssl, always_use_https, min_tls_version, security_level). Shows previous values. Supports dry_run.",
    inputSchema: UpdateZoneSettingsInput,
    handler: updateZoneSettings,
  },
];
