import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { paginate, setApiToken } from "../../src/utils/cf-client.js";

const BASE = "https://api.cloudflare.com/client/v4";

interface Item {
  id: string;
  name: string;
}

function makeItems(count: number, startIndex = 0): Item[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${startIndex + i}`,
    name: `Item ${startIndex + i}`,
  }));
}

function makeCfResponse(
  items: Item[],
  resultInfo?: Record<string, unknown> | null,
) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: items,
    ...(resultInfo !== null ? { result_info: resultInfo } : {}),
  };
}

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  setApiToken("test-token");
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

describe("paginate()", () => {
  it("pages through results using total_pages", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${BASE}/test/items`, ({ request }) => {
        requestCount++;
        const url = new URL(request.url);
        const page = parseInt(url.searchParams.get("page") ?? "1", 10);

        if (page === 1) {
          return HttpResponse.json(
            makeCfResponse(makeItems(50, 0), {
              page: 1,
              per_page: 50,
              total_pages: 3,
              count: 50,
              total_count: 120,
            }),
          );
        }
        if (page === 2) {
          return HttpResponse.json(
            makeCfResponse(makeItems(50, 50), {
              page: 2,
              per_page: 50,
              total_pages: 3,
              count: 50,
              total_count: 120,
            }),
          );
        }
        // page 3 — partial last page
        return HttpResponse.json(
          makeCfResponse(makeItems(20, 100), {
            page: 3,
            per_page: 50,
            total_pages: 3,
            count: 20,
            total_count: 120,
          }),
        );
      }),
    );

    const results = await paginate<Item>("/test/items");
    expect(results).toHaveLength(120);
    expect(results[0].id).toBe("item-0");
    expect(results[119].id).toBe("item-119");
    expect(requestCount).toBe(3);
  });

  it("stops when result_info is missing total_pages (tunnel-style API)", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${BASE}/test/tunnels`, () => {
        requestCount++;
        // Cloudflare tunnels API returns result_info without total_pages
        return HttpResponse.json(
          makeCfResponse(makeItems(5), {
            page: 1,
            per_page: 50,
            count: 5,
            total_count: 5,
          }),
        );
      }),
    );

    const results = await paginate<Item>("/test/tunnels");
    expect(results).toHaveLength(5);
    // Must stop after 1 request — not loop forever
    expect(requestCount).toBe(1);
  });

  it("stops when result_info is missing entirely", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${BASE}/test/no-info`, () => {
        requestCount++;
        return HttpResponse.json({
          success: true,
          errors: [],
          messages: [],
          result: makeItems(3),
        });
      }),
    );

    const results = await paginate<Item>("/test/no-info");
    expect(results).toHaveLength(3);
    expect(requestCount).toBe(1);
  });

  it("stops when result.length < perPage on last page with total_pages", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${BASE}/test/partial`, ({ request }) => {
        requestCount++;
        const url = new URL(request.url);
        const page = parseInt(url.searchParams.get("page") ?? "1", 10);

        if (page === 1) {
          return HttpResponse.json(
            makeCfResponse(makeItems(50, 0), {
              page: 1,
              per_page: 50,
              total_pages: 2,
              count: 50,
              total_count: 65,
            }),
          );
        }
        // page 2 — partial, < perPage — stops via length check
        return HttpResponse.json(
          makeCfResponse(makeItems(15, 50), {
            page: 2,
            per_page: 50,
            total_pages: 2,
            count: 15,
            total_count: 65,
          }),
        );
      }),
    );

    const results = await paginate<Item>("/test/partial");
    expect(results).toHaveLength(65);
    expect(requestCount).toBe(2);
  });

  it("throws on rate limiting mid-pagination", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${BASE}/test/rate-limited`, ({ request }) => {
        requestCount++;
        const url = new URL(request.url);
        const page = parseInt(url.searchParams.get("page") ?? "1", 10);

        if (page === 1) {
          return HttpResponse.json(
            makeCfResponse(makeItems(50, 0), {
              page: 1,
              per_page: 50,
              total_pages: 3,
              count: 50,
              total_count: 150,
            }),
          );
        }
        // page 2 — rate limited
        return new HttpResponse(null, {
          status: 429,
          headers: { "retry-after": "30" },
        });
      }),
    );

    await expect(paginate<Item>("/test/rate-limited")).rejects.toThrow(
      "Rate limited",
    );
    expect(requestCount).toBe(2);
  });

  it("respects maxResults cap", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${BASE}/test/capped`, ({ request }) => {
        requestCount++;
        const url = new URL(request.url);
        const page = parseInt(url.searchParams.get("page") ?? "1", 10);

        return HttpResponse.json(
          makeCfResponse(makeItems(50, (page - 1) * 50), {
            page,
            per_page: 50,
            total_pages: 10,
            count: 50,
            total_count: 500,
          }),
        );
      }),
    );

    const results = await paginate<Item>("/test/capped", undefined, 75);
    // Should return exactly 75 (maxResults), fetched 2 pages (50 + 50 = 100, sliced to 75)
    expect(results).toHaveLength(75);
    expect(requestCount).toBe(2);
  });

  it("returns empty array when first page has no results", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${BASE}/test/empty`, () => {
        requestCount++;
        return HttpResponse.json(
          makeCfResponse([], {
            page: 1,
            per_page: 50,
            total_pages: 0,
            count: 0,
            total_count: 0,
          }),
        );
      }),
    );

    const results = await paginate<Item>("/test/empty");
    expect(results).toHaveLength(0);
    expect(requestCount).toBe(1);
  });
});
