import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolAnnotations, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.AnyZodObject;
  annotations?: ToolAnnotations;
  handler: (input: Record<string, unknown>) => Promise<CallToolResult>;
}

export type ToolResult = CallToolResult;

export function textResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export function createServer(tools: ToolDef[]): McpServer {
  const server = new McpServer({
    name: "cloudflare-infra-mcp",
    version: "0.1.0",
  });

  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema.shape,
      tool.annotations ?? {},
      async (args: Record<string, unknown>) => {
        try {
          return await tool.handler(args);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorResult(msg);
        }
      },
    );
  }

  return server;
}
