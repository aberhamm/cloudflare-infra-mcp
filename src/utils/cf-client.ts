const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export interface CfApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
}

export interface CfRateLimited {
  rate_limited: true;
  retry_after: number;
}

export class CfApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errors: Array<{ code: number; message: string }>,
  ) {
    const msg = errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
    super(`Cloudflare API error (${status}): ${msg}`);
    this.name = "CfApiError";
  }
}

let apiToken: string | undefined;

export function setApiToken(token: string): void {
  apiToken = token;
}

function getToken(): string {
  if (!apiToken) {
    throw new Error("CLOUDFLARE_API_TOKEN not configured");
  }
  return apiToken;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, string | number | undefined>,
): Promise<CfApiResponse<T> | CfRateLimited> {
  const url = new URL(`${CF_API_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${getToken().trim()}`,
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
    return { rate_limited: true, retry_after: retryAfter };
  }

  const json = (await res.json()) as CfApiResponse<T>;

  if (!json.success) {
    throw new CfApiError(res.status, json.errors);
  }

  return json;
}

export async function cfGet<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<CfApiResponse<T> | CfRateLimited> {
  return request<T>("GET", path, undefined, params);
}

export async function cfPost<T>(
  path: string,
  body: unknown,
): Promise<CfApiResponse<T> | CfRateLimited> {
  return request<T>("POST", path, body);
}

export async function cfPut<T>(
  path: string,
  body: unknown,
): Promise<CfApiResponse<T> | CfRateLimited> {
  return request<T>("PUT", path, body);
}

export async function cfPatch<T>(
  path: string,
  body: unknown,
): Promise<CfApiResponse<T> | CfRateLimited> {
  return request<T>("PATCH", path, body);
}

export async function cfDelete<T = null>(
  path: string,
): Promise<CfApiResponse<T> | CfRateLimited> {
  return request<T>("DELETE", path);
}

export function isRateLimited(
  res: CfApiResponse<unknown> | CfRateLimited,
): res is CfRateLimited {
  return "rate_limited" in res && res.rate_limited === true;
}

export async function paginate<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  maxResults = 1000,
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  const perPage = 50;

  while (results.length < maxResults) {
    const res = await cfGet<T[]>(path, { ...params, page, per_page: perPage });
    if (isRateLimited(res)) {
      throw new Error(`Rate limited. Retry after ${res.retry_after} seconds.`);
    }

    results.push(...res.result);

    const info = res.result_info;
    if (!info || page >= info.total_pages) break;
    page++;
  }

  return results.slice(0, maxResults);
}

export async function cfGetRaw(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<string> {
  const url = new URL(`${CF_API_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${getToken()}` },
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after") ?? "60";
    throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
  }

  return res.text();
}
