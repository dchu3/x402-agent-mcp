import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadDirectory } from "../directory.js";

export function registerSearchTool(server: McpServer): void {
  server.tool(
    "x402_search",
    "Search for x402 endpoints by keyword, category, or chain. Returns matching services with descriptions, prices, and URLs.",
    {
      query: z.string().optional().describe("Search keyword (matches name, description, tags)"),
      category: z.string().optional().describe("Filter by category: analysis, search, social, news, travel, ai, media, blockchain, multi"),
      chain: z.string().optional().describe("Filter by chain: base, solana"),
    },
    async (args) => {
      const dir = loadDirectory();
      let results = dir.endpoints;

      if (args.category) {
        results = results.filter((e) => e.category === args.category);
      }
      if (args.chain) {
        results = results.filter((e) => e.chain === args.chain);
      }
      if (args.query) {
        const q = args.query.toLowerCase();
        results = results.filter(
          (e) =>
            e.name.toLowerCase().includes(q) ||
            e.description.toLowerCase().includes(q) ||
            e.tags.some((t) => t.toLowerCase().includes(q))
        );
      }

      const summary = {
        query: args.query || "all",
        category: args.category || "all",
        chain: args.chain || "all",
        results: results.map((e) => ({
          name: e.name,
          description: e.description,
          base_url: e.base_url,
          chain: e.chain,
          category: e.category,
          tags: e.tags,
          endpoint_count: e.endpoints.length,
          endpoints: e.endpoints.length > 0 ? e.endpoints : undefined,
        })),
        total: results.length,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    }
  );
}