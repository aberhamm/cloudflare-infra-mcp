import { z } from "zod";
import {
  cfGet,
  cfPost,
  cfPut,
  cfDelete,
  cfGetRaw,
  isRateLimited,
  paginate,
} from "./utils/cf-client.js";
import { resolveZone } from "./utils/zone-resolver.js";
import type { ToolDef } from "./server.js";
import { textResult, errorResult } from "./server.js";

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  priority?: number;
  created_on: string;
  modified_on: string;
}

// --- list_dns_records ---

const ListDnsInput = z.object({
  zone: z.string().describe("Domain name or zone ID"),
  type: z
    .enum(["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "NS", "CAA", "PTR"])
    .optional()
    .describe("Filter by record type"),
  name: z.string().optional().describe("Filter by record name (FQDN)"),
});

async function listDnsRecords(input: Record<string, unknown>) {
  const { zone, type, name } = ListDnsInput.parse(input);
  const zoneId = await resolveZone(zone);
  const records = await paginate<DnsRecord>(`/zones/${zoneId}/dns_records`, {
    type,
    name,
  });
  return textResult({ zone, zone_id: zoneId, records, count: records.length });
}

// --- upsert_dns_record ---

const UpsertDnsInput = z.object({
  zone: z.string().describe("Domain name or zone ID"),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "SRV"]),
  name: z.string().describe("Record name (e.g. 'www' or 'www.example.com')"),
  content: z.string().describe("Record value (IP, hostname, text content)"),
  proxied: z.boolean().optional().default(false),
  ttl: z.number().optional().default(1).describe("TTL in seconds (1 = auto)"),
  priority: z
    .number()
    .optional()
    .describe("Priority (required for MX, SRV)"),
  dry_run: z.boolean().optional().default(false),
});

async function upsertDnsRecord(input: Record<string, unknown>) {
  const { zone, type, name, content, proxied, ttl, priority, dry_run } =
    UpsertDnsInput.parse(input);
  const zoneId = await resolveZone(zone);

  // Resolve FQDN if short name given
  const fqdn = name.includes(".") ? name : `${name}.${zone}`;

  // Check for CNAME exclusivity: CNAME cannot coexist with other record types
  if (type === "CNAME") {
    const existing = await paginate<DnsRecord>(`/zones/${zoneId}/dns_records`, {
      name: fqdn,
    });
    const conflicts = existing.filter((r) => r.type !== "CNAME");
    if (conflicts.length > 0) {
      return errorResult(
        `Cannot create CNAME for "${fqdn}" — conflicts with existing ${conflicts.map((r) => r.type).join(", ")} record(s). Remove them first.`,
      );
    }
  }

  // Find existing record matching type+name+content (idempotent upsert)
  const matches = await paginate<DnsRecord>(`/zones/${zoneId}/dns_records`, {
    type,
    name: fqdn,
  });
  const existing = matches.find((r) => r.content === content);

  const record = {
    type,
    name: fqdn,
    content,
    proxied,
    ttl,
    ...(priority !== undefined && { priority }),
  };

  if (dry_run) {
    return textResult({
      dry_run: true,
      would_create: !existing,
      would_update: !!existing,
      record,
      existing_match: existing ?? null,
    });
  }

  if (existing) {
    // Update existing record
    const res = await cfPut<DnsRecord>(
      `/zones/${zoneId}/dns_records/${existing.id}`,
      record,
    );
    if (isRateLimited(res)) {
      throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
    }
    return textResult({
      action: "updated",
      previous_state: existing,
      new_state: res.result,
    });
  }

  // Create new record
  const res = await cfPost<DnsRecord>(`/zones/${zoneId}/dns_records`, record);
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({ action: "created", record: res.result });
}

// --- delete_dns_record ---

const DeleteDnsInput = z.object({
  zone: z.string().describe("Domain name or zone ID"),
  record_id: z
    .string()
    .optional()
    .describe("Record ID to delete (use this OR type+name+content)"),
  type: z.string().optional(),
  name: z.string().optional(),
  content: z.string().optional(),
});

async function deleteDnsRecord(input: Record<string, unknown>) {
  const { zone, record_id, type, name, content } = DeleteDnsInput.parse(input);
  const zoneId = await resolveZone(zone);

  let targetId = record_id;
  let existing: DnsRecord | undefined;

  if (!targetId) {
    if (!type || !name) {
      return errorResult("Provide record_id, or type+name(+content) to identify the record.");
    }
    const fqdn = name.includes(".") ? name : `${name}.${zone}`;
    const matches = await paginate<DnsRecord>(`/zones/${zoneId}/dns_records`, {
      type,
      name: fqdn,
    });
    if (content) {
      existing = matches.find((r) => r.content === content);
    } else if (matches.length === 1) {
      existing = matches[0];
    } else if (matches.length > 1) {
      return errorResult(
        `Multiple ${type} records found for "${fqdn}". Specify content to disambiguate: ${matches.map((r) => r.content).join(", ")}`,
      );
    }
    if (!existing) {
      return errorResult(`No matching record found for ${type} ${name} in zone ${zone}.`);
    }
    targetId = existing.id;
  }

  const res = await cfDelete(`/zones/${zoneId}/dns_records/${targetId}`);
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({ deleted: true, record_id: targetId, previous_state: existing });
}

// --- export_dns_records ---

const ExportDnsInput = z.object({
  zone: z.string().describe("Domain name or zone ID"),
});

async function exportDnsRecords(input: Record<string, unknown>) {
  const { zone } = ExportDnsInput.parse(input);
  const zoneId = await resolveZone(zone);
  const bindZone = await cfGetRaw(`/zones/${zoneId}/dns_records/export`);
  return textResult({ zone, zone_id: zoneId, format: "BIND", content: bindZone });
}

export const dnsTools: ToolDef[] = [
  {
    name: "list_dns_records",
    description:
      "List DNS records for a zone. Filter by type (A, AAAA, CNAME, MX, TXT, etc.) and/or name.",
    inputSchema: ListDnsInput,
    annotations: { readOnlyHint: true },
    handler: listDnsRecords,
  },
  {
    name: "upsert_dns_record",
    description:
      "Create or update a DNS record. Idempotent — matches on type+name+content. Checks CNAME exclusivity. Supports dry_run.",
    inputSchema: UpsertDnsInput,
    handler: upsertDnsRecord,
  },
  {
    name: "delete_dns_record",
    description:
      "Delete a DNS record by ID or by type+name+content lookup. Irreversible.",
    inputSchema: DeleteDnsInput,
    annotations: { destructiveHint: true },
    handler: deleteDnsRecord,
  },
  {
    name: "export_dns_records",
    description: "Export all DNS records for a zone in BIND zone file format.",
    inputSchema: ExportDnsInput,
    annotations: { readOnlyHint: true },
    handler: exportDnsRecords,
  },
];
