import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadDirectory } from "../directory.js";

export function registerListCategoriesTool(server: McpServer): void {
  server.tool(
    "x402_list_categories",
    "List all available x402 endpoint categories with counts.",
    {},
    async () => {
      const dir = loadDirectory();
      const counts: Record<string, number> = {};
      for (const e of dir.endpoints) {
        counts[e.category] = (counts[e.category] || 0) + 1;
      }
      const summary = {
        categories: dir.categories.map((c) => ({
          name: c,
          count: counts[c] || 0,
        })),
        total_endpoints: dir.endpoints.length,
        last_updated: dir.last_updated,
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