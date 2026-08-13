import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadDirectory } from "../directory.js";

export function registerDescribeTool(server: McpServer): void {
  server.tool(
    "x402_describe",
    "Get detailed information about a specific x402 endpoint, including all available paths, methods, prices, and well-known discovery files.",
    {
      name: z.string().describe("Service name from x402_search results (e.g. 'svm402', 'Tavily')"),
    },
    async (args) => {
      const dir = loadDirectory();
      const entry = dir.endpoints.find(
        (e) => e.name.toLowerCase() === args.name.toLowerCase()
      );

      if (!entry) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Service '${args.name}' not found. Use x402_search to find available services.` }),
            },
          ],
        };
      }

      const summary = {
        name: entry.name,
        description: entry.description,
        base_url: entry.base_url,
        chain: entry.chain,
        category: entry.category,
        tags: entry.tags,
        endpoints: entry.endpoints,
        well_known: entry.well_known || null,
        discovery_urls: entry.well_known
          ? Object.entries(entry.well_known).map(([k, v]) => ({ type: k, url: `${entry.base_url}${v}` }))
          : [],
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