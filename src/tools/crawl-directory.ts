import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addToDirectory } from "../directory.js";

interface CrawledService {
  url: string;
  name: string;
  x402_enabled: boolean;
  chains: string[];
  category: string;
  description: string;
  error?: string;
}

function extractUrlsFromHtml(html: string): string[] {
  // Extract all URLs from the page
  const urlRegex = /https?:\/\/[a-zA-Z0-9.-]+\.[a-z]{2,}[a-zA-Z0-9/._-]*/g;
  const rawUrls = html.match(urlRegex) || [];

  // Filter out non-service URLs
  const skip = [
    "x402scan.com", "schema.org", "w3.org", "cloudflare", "next.js",
    "react", "github.com", "x.com", "twitter.com", "merit.systems",
    "basehub.fun", "exa.ai", "google", "facebook", "apple",
  ];

  const seen = new Set<string>();
  const clean: string[] = [];

  for (let u of rawUrls) {
    u = u.replace(/\\/g, "").replace(/\/$/, "");
    // Remove path components — just want base URL
    try {
      const parsed = new URL(u);
      const baseUrl = `${parsed.protocol}//${parsed.host}`;
      if (skip.some((s) => baseUrl.includes(s))) continue;
      if (!seen.has(baseUrl)) {
        seen.add(baseUrl);
        clean.push(baseUrl);
      }
    } catch {
      continue;
    }
  }

  return clean;
}

function guessCategory(url: string, name: string): string {
  const text = (url + " " + name).toLowerCase();
  if (text.includes("weather")) return "weather";
  if (text.includes("news") || text.includes("search")) return "search";
  if (text.includes("twitter") || text.includes("social") || text.includes("reddit")) return "social";
  if (text.includes("travel") || text.includes("flight")) return "travel";
  if (text.includes("ai") || text.includes("llm") || text.includes("model")) return "ai";
  if (text.includes("blockchain") || text.includes("rpc") || text.includes("ethereum") || text.includes("solana")) return "blockchain";
  if (text.includes("media") || text.includes("voice") || text.includes("tts") || text.includes("stt")) return "media";
  return "multi";
}

async function probeUrl(baseUrl: string): Promise<CrawledService | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    // Try /.well-known/x402 first
    const x402Resp = await fetch(`${baseUrl}/.well-known/x402`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timeout);

    let x402Enabled = false;
    let chains: string[] = [];
    let name = baseUrl.replace(/^https?:\/\//, "").split(".")[0];
    let description = "";

    if (x402Resp.ok) {
      x402Enabled = true;
      try {
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
        name = x402Data.service || x402Data.name || name;
        description = x402Data.description || "";
      } catch {}
    } else {
      // Try ai-catalog as fallback
      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), 8000);
      const catResp = await fetch(`${baseUrl}/.well-known/ai-catalog.json`, {
        signal: controller2.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeout2);

      if (catResp.ok) {
        x402Enabled = true;
        try {
          const catalog = await catResp.json();
          if (catalog.entries && catalog.entries[0]) {
            name = catalog.entries[0].displayName || catalog.host?.displayName || name;
            description = catalog.entries[0].description || "";
          } else if (catalog.name) {
            name = catalog.name;
            description = catalog.description || "";
          }
        } catch {}
      } else {
        return null; // not x402
      }
    }

    return {
      url: baseUrl,
      name,
      x402_enabled: x402Enabled,
      chains,
      category: guessCategory(baseUrl, name),
      description,
    };
  } catch {
    return null;
  }
}

export function registerCrawlX402ScanTool(server: McpServer): void {
  server.tool(
    "x402_crawl_directory",
    "Crawl x402scan.com resources page to discover new x402 endpoints. Extracts service URLs, probes each for x402 support, and auto-adds confirmed services to the local directory. Returns summary of newly discovered services.",
    {
      max_results: z.number().optional().describe("Maximum number of new services to add (default: 20)"),
    },
    async (args) => {
      const maxResults = args.max_results || 20;

      // Step 1: Scrape x402scan resources page
      let urls: string[] = [];
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const resp = await fetch("https://www.x402scan.com/resources", {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const html = await resp.text();
        urls = extractUrlsFromHtml(html);
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `Failed to crawl x402scan: ${err.message}`,
            }),
          }],
        };
      }

      // Step 2: Probe each URL for x402 support (in parallel, max 10 at a time)
      const batchSize = 10;
      const discovered: CrawledService[] = [];
      let added = 0;

      for (let i = 0; i < urls.length && added < maxResults; i += batchSize) {
        const batch = urls.slice(i, i + batchSize);
        const results = await Promise.all(batch.map((u) => probeUrl(u)));

        for (const result of results) {
          if (!result || !result.x402_enabled) continue;
          if (added >= maxResults) break;

          // Try to add to directory
          try {
            const wasAdded = addToDirectory({
              name: result.name,
              description: result.description || `x402 service at ${result.url}`,
              base_url: result.url,
              chain: result.chains[0] || "unknown",
              category: result.category,
              tags: [result.category, "x402", ...result.chains],
              endpoints: [],
            });

            if (wasAdded) {
              added++;
              discovered.push(result);
            }
          } catch {
            // Skip if can't add
          }
        }
      }

      const summary = {
        urls_scraped: urls.length,
        new_services_added: added,
        services: discovered.map((s) => ({
          name: s.name,
          url: s.url,
          chains: s.chains,
          category: s.category,
        })),
        crawled_at: new Date().toISOString(),
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