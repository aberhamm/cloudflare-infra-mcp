# cloudflare-infra-mcp

MCP server for Cloudflare infrastructure operations — DNS, WAF, tunnels, and Zero Trust Access.

## Why this exists

Cloudflare's ecosystem has **16+ MCP servers** already. They all focus on the developer platform: Workers, KV, R2, D1, Pages. The official Cloudflare MCP server ([cloudflare/mcp-server-cloudflare](https://github.com/cloudflare/mcp-server-cloudflare)) covers code deployment, not infrastructure management.

**What's missing is the control plane.** If you manage DNS records, write WAF rules, configure tunnels, or set up Zero Trust Access policies, you're still clicking through the dashboard. This server fills that gap.

### What exists today

| Server | Focus | Mutations | Infrastructure |
|--------|-------|-----------|---------------|
| [Cloudflare official](https://github.com/cloudflare/mcp-server-cloudflare) | Workers, KV, R2, D1 | Yes | No |
| [pocc/cloudflare-mcp](https://github.com/pocc/cloudflare-mcp) | Analytics, zones | Read-only | Partial |
| [wrxck/cloudflare-mcp](https://github.com/wrxck/cloudflare-mcp) | Auto-generated from API | Yes | 2,655 tools (uncurated) |

### What this server adds

- **DNS record management** — list, create/update (idempotent upsert), delete, export as BIND
- **WAF custom rules** — create block/challenge/skip/log rules with CF expressions, dry-run preview
- **Cloudflare Tunnels** — create remotely-managed tunnels, configure ingress, get run tokens
- **Zero Trust Access** — create applications, policies, and service tokens (email, domain, IP, service token)
- **Composable operations** — `setup_tunnel_with_dns` (tunnel + CNAME + ingress in one call), `block_ips` (IP Lists + WAF rule for Fail2Ban integration), `setup_access_for_tunnel`
- **Safety** — `dry_run` on all mutations, destructive operations tagged in MCP metadata, previous/new state diffs on every write

## Quick start

### With Claude Code

```json
{
  "mcpServers": {
    "cloudflare-infra": {
      "command": "npx",
      "args": ["-y", "cloudflare-infra-mcp"],
      "env": {
        "CLOUDFLARE_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

### With Docker MCP Gateway

```yaml
cloudflare-infra:
  title: Cloudflare Infrastructure
  type: server
  image: mcp-cloudflare-infra:local
  secrets:
    - name: cloudflare.api_token
      env: CLOUDFLARE_API_TOKEN
```

### API Token

Create a scoped token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) with these permissions:

| Scope | Permission |
|-------|-----------|
| Zone | DNS → Edit |
| Zone | Zone Rulesets → Edit |
| Zone | Zone WAF → Edit |
| Account | Cloudflare Tunnel → Edit |
| Account | Access: Apps and Policies → Edit |
| Account | Access: Service Tokens → Read |
| Account | Access: Service Tokens → Edit |

Set zone resources to **All zones** or select specific ones. You can start with just DNS and add scopes as needed — tools will return clear auth errors for missing permissions.

## Tools (28)

### Zones (3)

| Tool | Description |
|------|-------------|
| `list_zones` | List all zones, filter by name or status |
| `get_zone` | Get zone details by domain name or ID |
| `purge_cache` | Purge all cached content or specific URLs |

### DNS (4)

| Tool | Description |
|------|-------------|
| `list_dns_records` | List records, filter by type and name |
| `upsert_dns_record` | Create or update — idempotent match on type+name+content |
| `delete_dns_record` | Delete by ID or type+name+content lookup |
| `export_dns_records` | Export zone file in BIND format |

### WAF Custom Rules (5)

| Tool | Description |
|------|-------------|
| `list_waf_custom_rules` | List all custom rules with expressions and actions |
| `create_waf_custom_rule` | Create block/challenge/skip/log rule from CF expression |
| `update_waf_custom_rule` | Modify expression, action, or enabled state |
| `delete_waf_custom_rule` | Remove a rule (destructive) |
| `list_waf_managed_rulesets` | List managed rulesets (OWASP, CF Managed) |

### Tunnels (5)

| Tool | Description |
|------|-------------|
| `list_tunnels` | List tunnels, filter by name or status |
| `create_tunnel` | Create remotely-managed tunnel, returns run token |
| `delete_tunnel` | Remove tunnel (destructive) |
| `get_tunnel_config` | Get ingress configuration |
| `update_tunnel_config` | Set hostname → service routing |

### Zero Trust Access (8)

| Tool | Description |
|------|-------------|
| `list_access_applications` | List Access applications |
| `create_access_application` | Create self-hosted application for a hostname |
| `list_access_policies` | List policies for an application |
| `list_access_service_tokens` | List service tokens, optionally filtered by exact name |
| `create_access_service_token` | Create a service token and return the one-time client secret |
| `create_access_policy` | Allow/deny by email, domain, IP, or service token |
| `create_access_service_token_policy` | Create a Service Auth policy for one service token |
| `diagnose_cloudflare_permissions` | Read-only permission diagnostic for tunnels, Access, service tokens, and optional zone checks |

### Composable Operations (3)

| Tool | Description |
|------|-------------|
| `setup_tunnel_with_dns` | Create tunnel + configure ingress + create CNAME |
| `block_ips` | Add IPs to a named IP List + ensure WAF rule |
| `setup_access_for_tunnel` | Create Access app + policy for a tunneled hostname |

Composable operations track progress step-by-step. On partial failure, the response includes `completed_steps`, `failed_step` with the error, and a `cleanup_hint` explaining what to do.

## Safety

Every mutating tool supports `dry_run: true` — returns a preview of what would change without applying it. Destructive tools (`delete_*`) are tagged in MCP metadata so clients can require confirmation.

All writes return both previous and new state so the agent can verify what changed.

Rate limits are surfaced (429 + `retry_after`) but not auto-retried — the calling agent decides whether and when to retry.

## Architecture

- **Raw `fetch` + Zod** — not the Cloudflare npm SDK (coverage is uneven across endpoints)
- **Zone-by-name resolution** — every tool accepts domain names (`matthew.systems`) or zone IDs; names are resolved and cached
- **Account auto-discovery** — tunnel and Access tools auto-discover the account ID from the token, or accept `CLOUDFLARE_ACCOUNT_ID` env var
- **Two runtime dependencies** — `@modelcontextprotocol/sdk` and `zod`

## Development

```bash
npm install
npm run typecheck    # type check
npm test             # unit + integration tests (32 tests, msw mocks)

# Live smoke tests (requires real token)
CLOUDFLARE_API_TOKEN=xxx SMOKE_TEST_ZONE=example.com npm run test:smoke
```

## License

MIT
