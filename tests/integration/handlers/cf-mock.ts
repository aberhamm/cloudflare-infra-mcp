import { http, HttpResponse } from "msw";
import zonesFixture from "../../fixtures/zones.json" with { type: "json" };
import dnsFixture from "../../fixtures/dns-records.json" with { type: "json" };
import rulesetsFixture from "../../fixtures/rulesets.json" with { type: "json" };

const BASE = "https://api.cloudflare.com/client/v4";
const ZONE_ID = "abc123def456abc123def456abc12345";

export const handlers = [
  // Zone lookup — by name filter or paginated list
  http.get(`${BASE}/zones`, ({ request }) => {
    const url = new URL(request.url);
    const name = url.searchParams.get("name");
    if (name && name !== "example.com") {
      return HttpResponse.json({
        ...zonesFixture,
        result: [],
        result_info: { page: 1, per_page: 50, total_pages: 1, count: 0, total_count: 0 },
      });
    }
    return HttpResponse.json(zonesFixture);
  }),

  // Zone by ID
  http.get(`${BASE}/zones/${ZONE_ID}`, () => {
    return HttpResponse.json({
      success: true,
      errors: [],
      messages: [],
      result: zonesFixture.result[0],
    });
  }),

  // DNS records - list
  http.get(`${BASE}/zones/${ZONE_ID}/dns_records`, () => {
    return HttpResponse.json(dnsFixture);
  }),

  // DNS records - create
  http.post(`${BASE}/zones/${ZONE_ID}/dns_records`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      success: true,
      errors: [],
      messages: [],
      result: {
        id: "rec_new_001",
        ...body,
        created_on: "2025-06-01T00:00:00Z",
        modified_on: "2025-06-01T00:00:00Z",
      },
    });
  }),

  // DNS records - export
  http.get(`${BASE}/zones/${ZONE_ID}/dns_records/export`, () => {
    return new HttpResponse(
      "; Zone file for example.com\nexample.com. 300 IN A 1.2.3.4\n",
      { headers: { "Content-Type": "text/plain" } },
    );
  }),

  // Rulesets - list
  http.get(`${BASE}/zones/${ZONE_ID}/rulesets`, () => {
    return HttpResponse.json({
      success: true,
      errors: [],
      messages: [],
      result: rulesetsFixture.result.map(({ rules: _rules, ...rs }) => rs),
    });
  }),

  // Rulesets - get specific (with rules)
  http.get(`${BASE}/zones/${ZONE_ID}/rulesets/rs_custom_001`, () => {
    return HttpResponse.json({
      success: true,
      errors: [],
      messages: [],
      result: rulesetsFixture.result[0],
    });
  }),

  // Rulesets - create rule
  http.post(`${BASE}/zones/${ZONE_ID}/rulesets/rs_custom_001/rules`, async ({ request }) => {
    const body = (await request.json()) as Array<Record<string, unknown>>;
    return HttpResponse.json({
      success: true,
      errors: [],
      messages: [],
      result: body.map((rule, i) => ({
        id: `rule_new_${i}`,
        ...rule,
        last_updated: "2025-06-01T00:00:00Z",
      })),
    });
  }),

  // Rulesets - delete rule
  http.delete(`${BASE}/zones/${ZONE_ID}/rulesets/rs_custom_001/rules/rule_001`, () => {
    return HttpResponse.json({
      success: true,
      errors: [],
      messages: [],
      result: null,
    });
  }),
];
