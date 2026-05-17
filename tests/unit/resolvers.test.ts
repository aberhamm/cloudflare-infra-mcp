import { describe, it, expect } from "vitest";
import { isZoneId } from "../../src/utils/zone-resolver.js";

describe("zone resolver", () => {
  it("recognizes valid zone IDs (32-char hex)", () => {
    expect(isZoneId("8066ef16cb9c768b3fe2134f14913611")).toBe(true);
    expect(isZoneId("abcdef0123456789abcdef0123456789")).toBe(true);
  });

  it("rejects domain names", () => {
    expect(isZoneId("example.com")).toBe(false);
    expect(isZoneId("matthew.systems")).toBe(false);
  });

  it("rejects short hex strings", () => {
    expect(isZoneId("8066ef16cb9c768b")).toBe(false);
  });

  it("rejects hex strings with uppercase (CF IDs are lowercase)", () => {
    expect(isZoneId("8066EF16CB9C768B3FE2134F14913611")).toBe(false);
  });
});
