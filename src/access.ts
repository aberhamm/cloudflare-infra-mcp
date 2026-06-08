import { z } from "zod";
import {
  CfApiError,
  cfGet,
  cfPost,
  isRateLimited,
  paginate,
} from "./utils/cf-client.js";
import { resolveAccount } from "./utils/account-resolver.js";
import type { ToolDef } from "./server.js";
import { textResult } from "./server.js";

interface AccessApp {
  id: string;
  name: string;
  domain: string;
  type: string;
  session_duration: string;
  created_at: string;
  updated_at: string;
}

interface AccessPolicy {
  id: string;
  name: string;
  decision: string;
  precedence: number;
  include: Array<Record<string, unknown>>;
  exclude: Array<Record<string, unknown>>;
  require: Array<Record<string, unknown>>;
}

interface AccessServiceToken {
  id: string;
  name: string;
  client_id: string;
  duration: string;
  expires_at: string;
  created_at?: string;
  updated_at?: string;
}

interface AccessServiceTokenCreateResponse extends AccessServiceToken {
  client_secret: string;
  client_secret_version?: number;
}

type PermissionCheckStatus = "ok" | "missing_permission" | "rate_limited" | "error";

interface PermissionCheck {
  name: string;
  endpoint: string;
  required_permission: string;
  status: PermissionCheckStatus;
  status_code?: number;
  error_codes?: number[];
  message?: string;
  retry_after?: number;
}

// --- list_access_applications ---

const ListAccessAppsInput = z.object({});

async function listAccessApplications(input: Record<string, unknown>) {
  ListAccessAppsInput.parse(input);
  const accountId = await resolveAccount();
  const apps = await paginate<AccessApp>(`/accounts/${accountId}/access/apps`);
  return textResult({ applications: apps, count: apps.length });
}

// --- create_access_application ---

const CreateAccessAppInput = z.object({
  name: z.string().describe("Application name"),
  domain: z.string().describe("Public hostname to protect (e.g. app.example.com)"),
  session_duration: z
    .string()
    .optional()
    .default("24h")
    .describe("Session duration (e.g. 24h, 30m)"),
  type: z
    .enum(["self_hosted", "ssh", "vnc", "bookmark"])
    .optional()
    .default("self_hosted"),
  dry_run: z.boolean().optional().default(false),
});

async function createAccessApplication(input: Record<string, unknown>) {
  const { name, domain, session_duration, type, dry_run } =
    CreateAccessAppInput.parse(input);
  const accountId = await resolveAccount();

  const app = { name, domain, session_duration, type };

  if (dry_run) {
    return textResult({ dry_run: true, would_create: app, account_id: accountId });
  }

  const res = await cfPost<AccessApp>(`/accounts/${accountId}/access/apps`, app);
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({ created: true, application: res.result });
}

// --- list_access_policies ---

const ListAccessPoliciesInput = z.object({
  app_id: z.string().describe("Access application ID"),
});

async function listAccessPolicies(input: Record<string, unknown>) {
  const { app_id } = ListAccessPoliciesInput.parse(input);
  const accountId = await resolveAccount();
  const policies = await paginate<AccessPolicy>(
    `/accounts/${accountId}/access/apps/${app_id}/policies`,
  );
  return textResult({ app_id, policies, count: policies.length });
}

// --- list_access_service_tokens ---

const ListAccessServiceTokensInput = z.object({
  name: z.string().optional().describe("Optional exact service token name filter"),
});

async function listAccessServiceTokens(input: Record<string, unknown>) {
  const { name } = ListAccessServiceTokensInput.parse(input);
  const accountId = await resolveAccount();
  const tokens = await paginate<AccessServiceToken>(
    `/accounts/${accountId}/access/service_tokens`,
  );
  const filtered = name ? tokens.filter((token) => token.name === name) : tokens;
  return textResult({ service_tokens: filtered, count: filtered.length });
}

// --- create_access_service_token ---

const CreateAccessServiceTokenInput = z.object({
  name: z.string().describe("Service token name"),
  duration: z
    .string()
    .optional()
    .default("8760h")
    .describe("How long the token is valid. Defaults to one year."),
  dry_run: z.boolean().optional().default(false),
});

async function createAccessServiceToken(input: Record<string, unknown>) {
  const { name, duration, dry_run } = CreateAccessServiceTokenInput.parse(input);
  const accountId = await resolveAccount();
  const serviceToken = { name, duration };

  if (dry_run) {
    return textResult({
      dry_run: true,
      account_id: accountId,
      would_create: serviceToken,
      note: "Cloudflare returns the client_secret only on the real create call.",
    });
  }

  const res = await cfPost<AccessServiceTokenCreateResponse>(
    `/accounts/${accountId}/access/service_tokens`,
    serviceToken,
  );
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({
    created: true,
    service_token: res.result,
    warning: "Cloudflare returns client_secret only once. Store it securely now.",
  });
}

// --- create_access_policy ---

const AccessIncludeRuleInput = z
  .object({
    email: z.object({ email: z.string() }).optional(),
    email_domain: z.object({ domain: z.string() }).optional(),
    ip: z.object({ ip: z.string() }).optional(),
    service_token: z
      .object({ token_id: z.string().min(1).describe("Access service token ID") })
      .optional(),
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
    "Include rule must contain exactly one selector",
  );

const CreateAccessPolicyInput = z.object({
  app_id: z.string().describe("Access application ID"),
  name: z.string().describe("Policy name"),
  decision: z.enum(["allow", "deny", "non_identity", "bypass"]).default("allow"),
  include: z
    .array(AccessIncludeRuleInput)
    .min(1)
    .describe("Include rules — at least one must match for access"),
  precedence: z.number().optional().default(1),
  dry_run: z.boolean().optional().default(false),
});

function normalizeIncludeRule(
  rule: z.infer<typeof AccessIncludeRuleInput>,
): Record<string, unknown> {
  if (rule.email) return { email: rule.email };
  if (rule.email_domain) return { email_domain: rule.email_domain };
  if (rule.ip) return { ip: rule.ip };
  if (rule.service_token) return { service_token: rule.service_token };
  if (rule.any_valid_service_token) return { any_valid_service_token: {} };
  return rule;
}

function assertServiceTokenDecision(
  decision: string,
  include: Array<z.infer<typeof AccessIncludeRuleInput>>,
): void {
  const hasServiceTokenRule = include.some(
    (rule) => rule.service_token || rule.any_valid_service_token,
  );
  if (hasServiceTokenRule && decision !== "non_identity" && decision !== "bypass") {
    throw new Error(
      "Service token include rules require decision 'non_identity' (Service Auth) or 'bypass'.",
    );
  }
}

async function createAccessPolicy(input: Record<string, unknown>) {
  const { app_id, name, decision, include, precedence, dry_run } =
    CreateAccessPolicyInput.parse(input);
  const accountId = await resolveAccount();
  assertServiceTokenDecision(decision, include);

  // Flatten include rules into CF format
  const includeRules = include.map(normalizeIncludeRule);

  const policy = { name, decision, include: includeRules, precedence };

  if (dry_run) {
    return textResult({ dry_run: true, app_id, would_create: policy });
  }

  const res = await cfPost<AccessPolicy>(
    `/accounts/${accountId}/access/apps/${app_id}/policies`,
    policy,
  );
  if (isRateLimited(res)) {
    throw new Error(`Rate limited. Retry after ${res.retry_after}s.`);
  }
  return textResult({ created: true, policy: res.result });
}

// --- create_access_service_token_policy ---

const CreateAccessServiceTokenPolicyInput = z.object({
  app_id: z.string().describe("Access application ID"),
  service_token_id: z.string().describe("Access service token ID"),
  name: z.string().optional().default("Service token access"),
  precedence: z.number().optional().default(2),
  dry_run: z.boolean().optional().default(false),
});

async function createAccessServiceTokenPolicy(input: Record<string, unknown>) {
  const { app_id, service_token_id, name, precedence, dry_run } =
    CreateAccessServiceTokenPolicyInput.parse(input);
  return createAccessPolicy({
    app_id,
    name,
    decision: "non_identity",
    include: [{ service_token: { token_id: service_token_id } }],
    precedence,
    dry_run,
  });
}

// --- diagnose_cloudflare_permissions ---

const DiagnoseCloudflarePermissionsInput = z.object({
  zone_id: z
    .string()
    .optional()
    .describe("Optional zone ID to include zone-scoped DNS and WAF read checks"),
  app_id: z
    .string()
    .optional()
    .describe("Optional Access application ID to include policy read checks"),
});

async function runPermissionCheck(
  name: string,
  endpoint: string,
  requiredPermission: string,
  params?: Record<string, string | number | undefined>,
): Promise<PermissionCheck> {
  try {
    const res = await cfGet<unknown>(endpoint, params);
    if (isRateLimited(res)) {
      return {
        name,
        endpoint,
        required_permission: requiredPermission,
        status: "rate_limited",
        retry_after: res.retry_after,
      };
    }
    return {
      name,
      endpoint,
      required_permission: requiredPermission,
      status: "ok",
    };
  } catch (err) {
    if (err instanceof CfApiError) {
      const message = err.errors.map((e) => e.message).join("; ");
      const isAuthError =
        err.status === 401 ||
        err.status === 403 ||
        err.errors.some((e) => e.code === 10000 || /auth|permission/i.test(e.message));
      return {
        name,
        endpoint,
        required_permission: requiredPermission,
        status: isAuthError ? "missing_permission" : "error",
        status_code: err.status,
        error_codes: err.errors.map((e) => e.code),
        message,
      };
    }
    return {
      name,
      endpoint,
      required_permission: requiredPermission,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function diagnoseCloudflarePermissions(input: Record<string, unknown>) {
  const { zone_id, app_id } = DiagnoseCloudflarePermissionsInput.parse(input);
  const accountId = await resolveAccount();

  const checks: PermissionCheck[] = [];
  checks.push(
    await runPermissionCheck(
      "cloudflare_tunnel_read",
      `/accounts/${accountId}/cfd_tunnel`,
      "Account -> Cloudflare Tunnel -> Read",
      { per_page: 1 },
    ),
  );
  checks.push(
    await runPermissionCheck(
      "access_apps_read",
      `/accounts/${accountId}/access/apps`,
      "Account -> Access: Apps and Policies -> Read",
      { per_page: 1 },
    ),
  );
  checks.push(
    await runPermissionCheck(
      "access_service_tokens_read",
      `/accounts/${accountId}/access/service_tokens`,
      "Account -> Access: Service Tokens -> Read",
      { per_page: 1 },
    ),
  );

  if (app_id) {
    checks.push(
      await runPermissionCheck(
        "access_policies_read",
        `/accounts/${accountId}/access/apps/${app_id}/policies`,
        "Account -> Access: Apps and Policies -> Read",
        { per_page: 1 },
      ),
    );
  }

  if (zone_id) {
    checks.push(
      await runPermissionCheck(
        "zone_read",
        `/zones/${zone_id}`,
        "Zone -> Zone -> Read",
      ),
    );
    checks.push(
      await runPermissionCheck(
        "dns_records_read",
        `/zones/${zone_id}/dns_records`,
        "Zone -> DNS -> Read",
        { per_page: 1 },
      ),
    );
    checks.push(
      await runPermissionCheck(
        "zone_rulesets_read",
        `/zones/${zone_id}/rulesets`,
        "Zone -> Zone Rulesets -> Read",
        { per_page: 1 },
      ),
    );
  }

  const missing = checks.filter((check) => check.status === "missing_permission");
  const rateLimited = checks.filter((check) => check.status === "rate_limited");
  const errors = checks.filter((check) => check.status === "error");
  const untestedWritePermissions = [
    "Zone -> DNS -> Edit",
    "Zone -> Zone Rulesets -> Edit",
    "Zone -> Zone WAF -> Edit",
    "Account -> Cloudflare Tunnel -> Edit",
    "Account -> Access: Apps and Policies -> Edit",
    "Account -> Access: Service Tokens -> Edit",
  ];

  return textResult({
    account_id: accountId,
    zone_id: zone_id ?? null,
    app_id: app_id ?? null,
    checks,
    summary: {
      ok: checks.filter((check) => check.status === "ok").length,
      missing_permission: missing.length,
      rate_limited: rateLimited.length,
      error: errors.length,
    },
    missing_permissions: missing.map((check) => check.required_permission),
    untested_write_permissions: untestedWritePermissions,
    note:
      "This diagnostic is read-only. Edit permissions cannot be proven without making a mutating Cloudflare API call.",
  });
}

export const accessTools: ToolDef[] = [
  {
    name: "list_access_applications",
    description: "List all Zero Trust Access applications in the account.",
    inputSchema: ListAccessAppsInput,
    annotations: { readOnlyHint: true },
    handler: listAccessApplications,
  },
  {
    name: "create_access_application",
    description:
      "Create a Zero Trust Access application to protect a hostname. Supports dry_run.",
    inputSchema: CreateAccessAppInput,
    handler: createAccessApplication,
  },
  {
    name: "list_access_policies",
    description: "List policies for a Zero Trust Access application.",
    inputSchema: ListAccessPoliciesInput,
    annotations: { readOnlyHint: true },
    handler: listAccessPolicies,
  },
  {
    name: "list_access_service_tokens",
    description:
      "List Zero Trust Access service tokens in the account, optionally filtered by exact name.",
    inputSchema: ListAccessServiceTokensInput,
    annotations: { readOnlyHint: true },
    handler: listAccessServiceTokens,
  },
  {
    name: "create_access_service_token",
    description:
      "Create a Zero Trust Access service token. Returns client_secret only on creation. Supports dry_run.",
    inputSchema: CreateAccessServiceTokenInput,
    handler: createAccessServiceToken,
  },
  {
    name: "create_access_policy",
    description:
      "Create an access policy (allow/deny by email, domain, IP, or service token; use non_identity for Service Auth). Supports dry_run.",
    inputSchema: CreateAccessPolicyInput,
    handler: createAccessPolicy,
  },
  {
    name: "create_access_service_token_policy",
    description:
      "Create a Service Auth policy for one Access service token on an application. Supports dry_run.",
    inputSchema: CreateAccessServiceTokenPolicyInput,
    handler: createAccessServiceTokenPolicy,
  },
  {
    name: "diagnose_cloudflare_permissions",
    description:
      "Read-only diagnostic for Cloudflare token permissions across tunnels, Access apps, service tokens, and optional zone checks.",
    inputSchema: DiagnoseCloudflarePermissionsInput,
    annotations: { readOnlyHint: true },
    handler: diagnoseCloudflarePermissions,
  },
];
