import { cfGet, isRateLimited } from "./cf-client.js";

interface Account {
  id: string;
  name: string;
}

let cachedAccountId: string | undefined;

export async function resolveAccount(): Promise<string> {
  if (cachedAccountId) return cachedAccountId;

  const envId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (envId) {
    cachedAccountId = envId;
    return envId;
  }

  const res = await cfGet<Account[]>("/accounts", { per_page: 5 });
  if (isRateLimited(res)) {
    throw new Error(`Rate limited resolving account. Retry after ${res.retry_after}s.`);
  }

  if (res.result.length === 0) {
    throw new Error(
      "No accounts found for this API token. Set CLOUDFLARE_ACCOUNT_ID explicitly.",
    );
  }

  cachedAccountId = res.result[0].id;
  return cachedAccountId;
}

export function clearAccountCache(): void {
  cachedAccountId = undefined;
}
