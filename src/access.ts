import { z } from "zod";
import { cfGet, cfPost, isRateLimited, paginate } from "./utils/cf-client.js";
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

// --- create_access_policy ---

const CreateAccessPolicyInput = z.object({
  app_id: z.string().describe("Access application ID"),
  name: z.string().describe("Policy name"),
  decision: z.enum(["allow", "deny", "bypass"]).default("allow"),
  include: z
    .array(
      z.object({
        email: z.object({ email: z.string() }).optional(),
        email_domain: z.object({ domain: z.string() }).optional(),
        ip: z.object({ ip: z.string() }).optional(),
        service_token: z.object({}).optional(),
      }),
    )
    .describe("Include rules — at least one must match for access"),
  precedence: z.number().optional().default(1),
  dry_run: z.boolean().optional().default(false),
});

async function createAccessPolicy(input: Record<string, unknown>) {
  const { app_id, name, decision, include, precedence, dry_run } =
    CreateAccessPolicyInput.parse(input);
  const accountId = await resolveAccount();

  // Flatten include rules into CF format
  const includeRules = include.map((rule) => {
    if (rule.email) return { email: rule.email };
    if (rule.email_domain) return { email_domain: rule.email_domain };
    if (rule.ip) return { ip: rule.ip };
    if (rule.service_token) return { service_token: {} };
    return rule;
  });

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
    name: "create_access_policy",
    description:
      "Create an access policy (allow/deny by email, domain, IP, or service token). Supports dry_run.",
    inputSchema: CreateAccessPolicyInput,
    handler: createAccessPolicy,
  },
];
