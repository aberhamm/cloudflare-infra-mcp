import { z } from "zod";
import { cfGet, cfPost, isRateLimited, paginate } from "./utils/cf-client.js";
import { resolveZone } from "./utils/zone-resolver.js";
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
];
