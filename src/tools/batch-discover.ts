import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface BatchResult {
  url: string;
  x402_enabled: boolean;
  service_name?: string;
  chains: string[];
  error?: string;
}

export function registerBatchDiscoverTool(server: McpServer): void {
  server.tool(
    "x402_discover_urls",
    "Batch discover multiple x402 services in parallel. Provide a list of URLs, each is probed for /.well-known/x402 and ai-catalog.json. Returns a summary array.",
    {
      urls: z.array(z.string()).describe("Array of base URLs to discover (e.g. [\"https://svm402.com\", \"https://2s.io\"])"),
    },
    async (args) => {
      const results: BatchResult[] = [];

      // Probe all URLs in parallel
      const promises = args.urls.map(async (url) => {
        const baseUrl = url.replace(/\/$/, "");
        try {
          // Fetch well-known x402
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          const x402Resp = await fetch(`${baseUrl}/.well-known/x402`, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
          });
          clearTimeout(timeout);

          let chains: string[] = [];
          let x402Enabled = false;

          if (x402Resp.ok) {
            x402Enabled = true;
            const x402Data = await x402Resp.json();
            const accepts = x402Data.accepts || x402Data.accept || [];
            const acceptList = Array.isArray(accepts) ? accepts : [accepts];
            chains = [...new Set(acceptList.map((a: any) => {
              const net = a.network || x402Data.network || "";
              if (net.includes("solana") || net.includes("5eykt4")) return "solana";
              if (net.includes("eip155") || net.includes("8453")) return "base";
              return net;
            }))];
            if (chains.length === 0 && x402Data.network) {
              const net = x402Data.network;
              if (net.includes("solana") || net.includes("5eykt4")) chains = ["solana"];
              else if (net.includes("eip155") || net.includes("8453")) chains = ["base"];
              else chains = [net];
            }
          } else {
            // Try ai-catalog as fallback
            const catResp = await fetch(`${baseUrl}/.well-known/ai-catalog.json`, {
              signal: controller.signal,
              headers: { Accept: "application/json" },
            });
            if (catResp.ok) {
              x402Enabled = true; // has ai-catalog, likely x402
            }
          }

          // Try to get service name from ai-catalog
          let serviceName: string | undefined;
          try {
            const catResp = await fetch(`${baseUrl}/.well-known/ai-catalog.json`, {
              headers: { Accept: "application/json" },
            });
            if (catResp.ok) {
              const catalog = await catResp.json();
              if (catalog.entries && catalog.entries[0]) {
                serviceName = catalog.entries[0].displayName || catalog.host?.displayName;
              } else if (catalog.name) {
                serviceName = catalog.name;
              }
            }
          } catch {}

          return {
            url: baseUrl,
            x402_enabled: x402Enabled,
            service_name: serviceName,
            chains,
          } as BatchResult;
        } catch (err: any) {
          return {
            url: baseUrl,
            x402_enabled: false,
            chains: [],
            error: err.message,
          } as BatchResult;
        }
      });

      const settled = await Promise.all(promises);
      results.push(...settled);

      const summary = {
        total: results.length,
        x402_enabled: results.filter((r) => r.x402_enabled).length,
        results,
        discovered_at: new Date().toISOString(),
      };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(summary, null, 2),
        }],
      };
    }
  );
}