import { describe, it, expect } from "vitest";
import "./setup.js";
import { zoneTools } from "../../src/zones.js";

const listZones = zoneTools.find((t) => t.name === "list_zones")!;
const getZone = zoneTools.find((t) => t.name === "get_zone")!;

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("Zone tools (integration)", () => {
  it("list_zones returns zones", async () => {
    const result = await listZones.handler({});
    const data = parseResult(result);
    expect(data.count).toBe(1);
    expect(data.zones[0].name).toBe("example.com");
  });

  it("get_zone resolves by domain name", async () => {
    const result = await getZone.handler({ zone: "example.com" });
    const data = parseResult(result);
    expect(data.id).toBe("abc123def456abc123def456abc12345");
    expect(data.name).toBe("example.com");
  });

  it("get_zone errors on unknown zone", async () => {
    await expect(getZone.handler({ zone: "nonexistent.com" })).rejects.toThrow(
      "Zone not found",
    );
  });
});
