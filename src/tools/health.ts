import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadDirectory } from "../directory.js";

export function registerHealthCheckTool(server: McpServer): void {
  server.tool(
    "x402_health",
    "Check if an x402 service is live and responding with 402 Payment Required. Verifies the service is operational before an agent pays for it.",
    {
      name: z.string().optional().describe("Service name from directory (e.g. 'svm402')"),
      url: z.string().optional().describe("Direct URL to probe (alternative to name)"),
    },
    async (args) => {
      let targetUrl: string;
      let serviceName: string;

      if (args.url) {
        targetUrl = args.url;
        serviceName = args.url;
      } else if (args.name) {
        const dir = loadDirectory();
        const entry = dir.endpoints.find(
          (e) => e.name.toLowerCase() === args.name!.toLowerCase()
        );
        if (!entry) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: `Service '${args.name}' not found in directory` }),
            }],
          };
        }
        targetUrl = entry.base_url;
        serviceName = entry.name;
      } else {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: "Provide either 'name' or 'url'" }),
          }],
        };
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(targetUrl, { signal: controller.signal });
        clearTimeout(timeout);

        const result = {
          service: serviceName,
          url: targetUrl,
          live: true,
          status_code: resp.status,
          x402_enabled: resp.status === 402,
          response_time_ms: 0, // would need performance tracking
          checked_at: new Date().toISOString(),
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              service: serviceName,
              url: targetUrl,
              live: false,
              error: err.message,
              checked_at: new Date().toISOString(),
            }),
          }],
        };
      }
    }
  );
}