import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addToDirectory } from "../directory.js";
import { fetchJson, findPaymentChallenge, isX402Manifest, chainsFromManifest } from "./probe-utils.js";

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
    // Hostname-derived fallback name — strip a leading www.
    let name = baseUrl.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "").split(".")[0];
    let description = "";
    let chains: string[] = [];

    // 1. /.well-known/x402 — must parse as JSON AND look like an x402 manifest.
    //    An HTML catch-all 200 (SPA host) or junk body is not x402 support.
    const x402Data = await fetchJson(`${baseUrl}/.well-known/x402`, 8000);
    let x402Enabled = x402Data !== null && isX402Manifest(x402Data);
    if (x402Enabled) {
      chains = chainsFromManifest(x402Data);
      name = x402Data.service || x402Data.name || name;
      description = x402Data.description || "";
    }

    // 2. 402 PAYMENT-REQUIRED challenge fallback (root, then openapi.json GET
    //    paths — many x402 hosts serve a 200 HTML landing page at / ).
    //    Bounded, never pays, never sends credentials.
    const hit = !x402Enabled ? await findPaymentChallenge(baseUrl, 8000) : null;
    if (hit && isX402Manifest(hit.challenge)) {
      x402Enabled = true;
      if (chains.length === 0) chains = chainsFromManifest(hit.challenge);
    }

    // 3. ai-catalog: real service name/description source; x402 signal on its own
    const catalog = await fetchJson(`${baseUrl}/.well-known/ai-catalog.json`, 8000);
    if (catalog !== null) {
      if (catalog.entries && catalog.entries[0]) {
        name = catalog.entries[0].displayName || catalog.host?.displayName || name;
        description = description || catalog.entries[0].description || "";
      } else if (catalog.name) {
        name = catalog.name;
        description = description || catalog.description || "";
      }
      if (!x402Enabled) {
        x402Enabled = true; // has ai-catalog, likely x402
      }
    }

    if (!x402Enabled) return null; // not x402

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

// x402scan retired its /resources page (now 404) and has no public JSON
// listing endpoint (/api/public/services is also 404), so scraping the
// server-rendered /all page — the "All" sellers tab — is the only supported
// source. Its payload embeds each service's origin, which is what we scrape.
// Ordered scrape candidates, tried in sequence — the first source to serve an
// OK page wins. /all is the cleanest listing (~293 candidate hosts after
// extraction); the homepage embeds the same seller payloads with ~5x the
// noise (duplicate origin variants, shared-deploy and static asset hosts),
// so it stays the backup. A future URL move or outage at any one source
// degrades to the next candidate instead of killing the crawl.
export const X402SCAN_SOURCES = [
  "https://www.x402scan.com/all",
  "https://www.x402scan.com/",
] as const;

async function fetchListingHtml(pageUrl: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(pageUrl, { signal: controller.signal });
    // fetch resolves on ANY status. A 404/redirect-to-error page returns HTML
    // with no service URLs — fail loudly with the HTTP status instead of
    // silently scraping an error page.
    if (!resp.ok) {
      throw new Error(`${pageUrl} returned HTTP ${resp.status}`);
    }
    return await resp.text();
  } finally {
    clearTimeout(timeout);
  }
}

export function registerCrawlX402ScanTool(server: McpServer): void {
  server.tool(
    "x402_crawl_directory",
    "Crawl the x402scan.com all-services page to discover new x402 endpoints. Extracts service URLs, probes each for x402 support, and auto-adds confirmed services to the local directory. Returns summary of newly discovered services.",
    {
      max_results: z.number().optional().describe("Maximum number of new services to add (default: 20)"),
    },
    async (args) => {
      const maxResults = args.max_results || 20;

      // Step 1: Scrape the x402scan listing. Iterate the candidate sources in
      // order — the first that serves HTML wins, and a dead or moved source
      // degrades to the next instead of dying. All candidates failing is an
      // explicit error naming each failure.
      let urls: string[] = [];
      try {
        let html: string | null = null;
        const failures: string[] = [];
        for (const source of X402SCAN_SOURCES) {
          try {
            html = await fetchListingHtml(source);
            break;
          } catch (err: any) {
            failures.push(err.message);
          }
        }
        if (html === null) {
          throw new Error(`all sources failed (${failures.join("; ")})`);
        }
        // An OK page that yields zero candidate URLs is a legitimate,
        // distinguishable outcome — the listing may genuinely be empty or
        // match nothing. The normal summary reports urls_scraped: 0. Only
        // fetch-level failure (non-OK / throw / every candidate down) is an
        // error; content emptiness is data.
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
              source: "discovery", // #18.2/#18.7 provenance baseline for #19 trust levels
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