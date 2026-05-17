import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { ToolDef } from "../../src/server.js";
import { createServer, textResult } from "../../src/server.js";

function makeTool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: overrides.name ?? "test_tool",
    description: "A test tool",
    inputSchema: z.object({ foo: z.string() }),
    handler: async (input) => textResult({ echo: input }),
    ...overrides,
  };
}

describe("tool registration", () => {
  it("registers tool with annotations", () => {
    const server = createServer([
      makeTool({ name: "with_annotations", annotations: { readOnlyHint: true } }),
    ]);
    expect(server).toBeDefined();
  });

  it("registers tool without annotations", () => {
    const server = createServer([makeTool({ name: "no_annotations" })]);
    expect(server).toBeDefined();
  });

  it("registers mix of annotated and unannotated tools", () => {
    const server = createServer([
      makeTool({ name: "read_tool", annotations: { readOnlyHint: true } }),
      makeTool({ name: "write_tool" }),
      makeTool({ name: "destructive_tool", annotations: { destructiveHint: true } }),
    ]);
    expect(server).toBeDefined();
  });

  it("handler is callable for unannotated tools", async () => {
    let called = false;
    const tool = makeTool({
      name: "callable_test",
      handler: async () => {
        called = true;
        return textResult({ ok: true });
      },
    });
    createServer([tool]);
    // Directly verify the handler is a function (not swallowed by SDK)
    const result = await tool.handler({ foo: "bar" });
    expect(called).toBe(true);
    expect(result.content[0].type).toBe("text");
  });
});
