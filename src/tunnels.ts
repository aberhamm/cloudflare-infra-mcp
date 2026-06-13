import { randomBytes } from "node:crypto";
import { z } from "zod";
import { cfGet, cfPost, cfPut, cfDelete, isRateLimited, paginate } from "./utils/cf-client.js";
import { resolveAccount } from "./utils/account-resolver.js";
import type { ToolDef } from "./server.js";
import { textResult, errorResult } from "./server.js";

interface Tunnel {
  id: string;
  name: string;
  status: string;
  created_at: string;
  remote_config: boolean;
  connections: Array<{ colo_name: string; is_pending_reconnect: boolean }>;
}

interface TunnelConfig {
  config: {
    ingress: Array<{
      hostname?: string;
      service: string;
      path?: string;
    }>;
  };
}

// --- list_tunnels ---

const ListTunnelsInput = z.object({
  name: z.string().optional().describe("Filter by tunnel name"),
  status: z
    .enum(["active", "inactive", "degraded"])
    .optional(),
});

async function listTunnels(input: Record<string, unknown>) {
  const { name, status } = ListTunnelsInput.parse(input);
  const accountId = await resolveAccount();
  const tunnels = await paginate<Tunnel>(
    `/accounts/${accountId}/cfd_tunnel`,
    { name, status, is_deleted: "false" },
  );
  return textResult({ tunnels, count: tunnels.length });
}

// --- create_tunnel ---

const CreateTunnelInput = z.object({
  name: z.string().describe("Tunnel name"),
  dry_run: z.boolean().optional().default(false),
});

async function createTunnel(input: Record<string, unknown>) {
  const { name, dry_run } = CreateTunnelInput.parse(input);
  const accountId = await resolveAccount();

  if (dry_run) {
    return textResult({
      dry_run: true,
      would_create: { name, type: "remotely-managed" },
      account_id: accountId,
    });
  }

  const res = await cfPost<Tunnel & { token?: string }>(
    `/accounts/${accountId}/cfd_tunnel`,
    { name, config_src: "cloudflare", tunnel_secret: randomBytes(32).toString("base64") },
  );
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }

  // Fetch token for the tunnel
  const tokenRes = await cfGet<string>(
    `/accounts/${accountId}/cfd_tunnel/${res.result.id}/token`,
  );
  const token = isRateLimited(tokenRes) ? "(rate limited — fetch token separately)" : tokenRes.result;

  return textResult({
    created: true,
    tunnel: res.result,
    token,
    run_command: `cloudflared tunnel run --token ${token}`,
  });
}

// --- delete_tunnel ---

const DeleteTunnelInput = z.object({
  tunnel_id: z.string().describe("Tunnel ID to delete"),
});

async function deleteTunnel(input: Record<string, unknown>) {
  const { tunnel_id } = DeleteTunnelInput.parse(input);
  const accountId = await resolveAccount();

  // Get current state before deletion
  const current = await cfGet<Tunnel>(`/accounts/${accountId}/cfd_tunnel/${tunnel_id}`);
  if (isRateLimited(current)) {
    throw new Error(`Rate limited. Retry after ${current.retry_after}s.`);
  }

  const res = await cfDelete(`/accounts/${accountId}/cfd_tunnel/${tunnel_id}`);
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({ deleted: true, tunnel_id, previous_state: current.result });
}

// --- get_tunnel_config ---

const GetTunnelConfigInput = z.object({
  tunnel_id: z.string().describe("Tunnel ID"),
});

async function getTunnelConfig(input: Record<string, unknown>) {
  const { tunnel_id } = GetTunnelConfigInput.parse(input);
  const accountId = await resolveAccount();

  const res = await cfGet<TunnelConfig>(
    `/accounts/${accountId}/cfd_tunnel/${tunnel_id}/configurations`,
  );
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({ tunnel_id, config: res.result });
}

// --- update_tunnel_config ---

const UpdateTunnelConfigInput = z.object({
  tunnel_id: z.string().describe("Tunnel ID"),
  ingress: z
    .array(
      z.object({
        hostname: z.string().optional(),
        service: z.string().describe("Origin service URL (e.g. http://localhost:8080)"),
        path: z.string().optional(),
      }),
    )
    .describe("Ingress rules — last rule must be the catch-all (no hostname)"),
  dry_run: z.boolean().optional().default(false),
});

async function updateTunnelConfig(input: Record<string, unknown>) {
  const { tunnel_id, ingress, dry_run } = UpdateTunnelConfigInput.parse(input);
  const accountId = await resolveAccount();

  // Get current config
  const currentRes = await cfGet<TunnelConfig>(
    `/accounts/${accountId}/cfd_tunnel/${tunnel_id}/configurations`,
  );
  if (isRateLimited(currentRes)) {
    throw new Error(`Rate limited. Retry after ${currentRes.retry_after}s.`);
  }
  const previousConfig = currentRes.result;

  const newConfig = { config: { ingress } };

  if (dry_run) {
    return textResult({
      dry_run: true,
      tunnel_id,
      previous_config: previousConfig,
      would_set: newConfig,
    });
  }

  const res = await cfPut<TunnelConfig>(
    `/accounts/${accountId}/cfd_tunnel/${tunnel_id}/configurations`,
    newConfig,
  );
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({
    updated: true,
    tunnel_id,
    previous_config: previousConfig,
    new_config: res.result,
  });
}

export const tunnelTools: ToolDef[] = [
  {
    name: "list_tunnels",
    description: "List Cloudflare Tunnels in the account. Filter by name or status.",
    inputSchema: ListTunnelsInput,
    annotations: { readOnlyHint: true },
    handler: listTunnels,
  },
  {
    name: "create_tunnel",
    description:
      "Create a remotely-managed Cloudflare Tunnel. Returns the tunnel token for cloudflared. Supports dry_run.",
    inputSchema: CreateTunnelInput,
    handler: createTunnel,
  },
  {
    name: "delete_tunnel",
    description: "Delete a Cloudflare Tunnel. Irreversible — all connections will be terminated.",
    inputSchema: DeleteTunnelInput,
    annotations: { destructiveHint: true },
    handler: deleteTunnel,
  },
  {
    name: "get_tunnel_config",
    description: "Get the ingress configuration for a Cloudflare Tunnel.",
    inputSchema: GetTunnelConfigInput,
    annotations: { readOnlyHint: true },
    handler: getTunnelConfig,
  },
  {
    name: "update_tunnel_config",
    description:
      "Set ingress rules for a Cloudflare Tunnel (hostname → service routing). Supports dry_run.",
    inputSchema: UpdateTunnelConfigInput,
    handler: updateTunnelConfig,
  },
];
