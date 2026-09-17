import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchJson, fetchRootPaymentChallenge, isX402Manifest, parseChainFromNetwork } from "./probe-utils.js";

interface BatchResult {
  url: string;
  x402_enabled: boolean;
  service_name?: string;
  chains: string[];
  error?: string;
  notes?: string[];
}

function chainsFromManifest(data: any): string[] {
  const accepts = data.accepts || data.accept || [];
  const acceptList = Array.isArray(accepts) ? accepts : [accepts];
  const chains = [...new Set(acceptList.map((a: any) => parseChainFromNetwork(a.network || data.network || "")).filter(Boolean))] as string[];
  if (chains.length === 0 && data.network) chains.push(parseChainFromNetwork(data.network));
  return chains;
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
        const notes: string[] = [];
        try {
          // Fetch well-known x402 — must be valid JSON with an x402 manifest
          // shape; an HTML catch-all 200 or junk body does NOT count.
          const x402Data = await fetchJson(`${baseUrl}/.well-known/x402`);

          let chains: string[] = [];
          let x402Enabled = false;

          if (x402Data !== null && isX402Manifest(x402Data)) {
            x402Enabled = true;
            chains = chainsFromManifest(x402Data);
          } else if (x402Data !== null) {
            notes.push("Well-known x402 returned JSON but not an x402 manifest shape");
          } else {
            // Fall back to root 402 PAYMENT-REQUIRED challenge (bounded, never pays)
            const challenge = await fetchRootPaymentChallenge(baseUrl);
            if (challenge && isX402Manifest(challenge)) {
              x402Enabled = true;
              chains = chainsFromManifest(challenge);
              notes.push("No /.well-known/x402 JSON found, fell back to root 402 PAYMENT-REQUIRED challenge");
            } else {
              // Last resort: a valid ai-catalog.json implies x402 support
              const catalog = await fetchJson(`${baseUrl}/.well-known/ai-catalog.json`);
              if (catalog !== null) {
                x402Enabled = true; // has ai-catalog, likely x402
                notes.push("No /.well-known/x402 JSON found, enabled via ai-catalog.json");
              }
            }
          }

          // Try to get service name from ai-catalog
          let serviceName: string | undefined;
          const catalog = await fetchJson(`${baseUrl}/.well-known/ai-catalog.json`);
          if (catalog !== null) {
            if (catalog.entries && catalog.entries[0]) {
              serviceName = catalog.entries[0].displayName || catalog.host?.displayName;
            } else if (catalog.name) {
              serviceName = catalog.name;
            }
          }

          const result: BatchResult = {
            url: baseUrl,
            x402_enabled: x402Enabled,
            service_name: serviceName,
            chains,
          };
          if (!x402Enabled) {
            result.notes = [...notes, "No valid x402 manifest found (well-known was missing, HTML, or non-manifest JSON)"];
          } else if (notes.length > 0) {
            result.notes = notes;
          }
          return result;
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