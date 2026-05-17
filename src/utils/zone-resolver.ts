import { cfGet, isRateLimited } from "./cf-client.js";

interface Zone {
  id: string;
  name: string;
  status: string;
}

const cache = new Map<string, string>();
const ZONE_ID_REGEX = /^[0-9a-f]{32}$/;

export function isZoneId(input: string): boolean {
  return ZONE_ID_REGEX.test(input);
}

export async function resolveZone(zoneInput: string): Promise<string> {
  if (isZoneId(zoneInput)) return zoneInput;

  const cached = cache.get(zoneInput);
  if (cached) return cached;

  const res = await cfGet<Zone[]>("/zones", { name: zoneInput });
  if (isRateLimited(res)) {
    throw new Error(`Rate limited resolving zone "${zoneInput}". Retry after ${res.retry_after}s.`);
  }

  if (res.result.length === 0) {
    throw new Error(`Zone not found: "${zoneInput}"`);
  }

  const zoneId = res.result[0].id;
  cache.set(zoneInput, zoneId);
  return zoneId;
}

export function clearZoneCache(): void {
  cache.clear();
}
