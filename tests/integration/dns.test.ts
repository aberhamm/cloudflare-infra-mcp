import { describe, it, expect } from "vitest";
import "./setup.js";
import { dnsTools } from "../../src/dns.js";

const list = dnsTools.find((t) => t.name === "list_dns_records")!;
const upsert = dnsTools.find((t) => t.name === "upsert_dns_record")!;
const exportTool = dnsTools.find((t) => t.name === "export_dns_records")!;
const deleteTool = dnsTools.find((t) => t.name === "delete_dns_record")!;

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("DNS tools (integration)", () => {
  it("list_dns_records returns records for a zone", async () => {
    const result = await list.handler({ zone: "example.com" });
    const data = parseResult(result);
    expect(data.count).toBe(2);
    expect(data.records[0].type).toBe("A");
    expect(data.zone_id).toBe("abc123def456abc123def456abc12345");
  });

  it("upsert_dns_record dry_run shows preview", async () => {
    const result = await upsert.handler({
      zone: "example.com",
      type: "A",
      name: "test.example.com",
      content: "5.6.7.8",
      dry_run: true,
    });
    const data = parseResult(result);
    expect(data.dry_run).toBe(true);
    expect(data.would_create).toBe(true);
  });

  it("upsert_dns_record creates new record", async () => {
    const result = await upsert.handler({
      zone: "example.com",
      type: "TXT",
      name: "test.example.com",
      content: "v=test",
    });
    const data = parseResult(result);
    expect(data.action).toBe("created");
    expect(data.record.type).toBe("TXT");
  });

  it("export_dns_records returns BIND format", async () => {
    const result = await exportTool.handler({ zone: "example.com" });
    const data = parseResult(result);
    expect(data.format).toBe("BIND");
    expect(data.content).toContain("example.com");
  });

  it("delete_dns_record errors on missing identifiers", async () => {
    const result = await deleteTool.handler({ zone: "example.com" });
    expect(result.isError).toBe(true);
  });
});
