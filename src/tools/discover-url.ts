import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addToDirectory } from "../directory.js";
import { CASPER_CHAIN, isCasperNetwork } from "../casper/networks.js";

interface WellKnownX402 {
  x402Version?: number;
  accepts?: Array<{
    scheme: string;
    network: string;
    amount?: string;
    asset?: string;
    payTo?: string;
    maxTimeoutSeconds?: number;
    extra?: { name?: string; version?: string };
  }>;
  error?: string;
}

interface AICatalog {
  name?: string;
  description?: string;
  category?: string;
  endpoints?: Array<{
    path: string;
    method: string;
    price_usdc?: string;
    description?: string;
  }>;
  tags?: string[];
}

interface DiscoveryResult {
  url: string;
  x402_enabled: boolean;
  payment?: {
    chains: string[];
    seller_wallet?: string;
    schemes: string[];
    tokens: string[];
  };
  service?: {
    name?: string;
    description?: string;
    category?: string;
    endpoints?: Array<{
      path: string;
      method: string;
      price_usdc?: string;
      description?: string;
    }>;
    tags?: string[];
  };
  llms_txt?: string;
  discovered_at: string;
  errors?: string[];
}

async function fetchJson(url: string, timeoutMs: number = 10000): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function fetchText(url: string, timeoutMs: number = 10000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

function parseChainFromNetwork(network: string): string {
  if (network.includes("solana") || network.includes("5eykt4")) return "solana";
  if (network.includes("eip155") || network.includes("8453")) return "base";
  if (isCasperNetwork(network)) return CASPER_CHAIN;
  return network;
}

export function registerDiscoverUrlTool(server: McpServer): void {
  server.tool(
    "x402_discover_url",
    "Discover any x402 service by URL. Fetches /.well-known/x402 (payment details), /.well-known/ai-catalog.json (capabilities), and /llms.txt (agent summary). Returns a unified discovery object with chains, wallet, endpoints, and prices.",
    {
      url: z.string().describe("Base URL of the service to discover (e.g. https://svm402.com)"),
    },
    async (args) => {
      const baseUrl = args.url.replace(/\/$/, "");
      const errors: string[] = [];

      // Step 1: Fetch /.well-known/x402
      const x402Data = await fetchJson(`${baseUrl}/.well-known/x402`);
      if (!x402Data) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              url: baseUrl,
              x402_enabled: false,
              error: "No /.well-known/x402 found — this service may not be x402-enabled",
              discovered_at: new Date().toISOString(),
            }),
          }],
        };
      }

      // Parse payment info from x402 well-known (supports both v1 and v2 formats)
      let chains: string[] = [];
      let sellerWallet: string | undefined;
      let schemes: string[] = [];
      let tokens: string[] = [];
      let serviceFromX402: any = null;

      const accepts = x402Data.accepts || x402Data.accept || [];
      if (Array.isArray(accepts) && accepts.length > 0) {
        // v2 format with accepts array
        chains = [...new Set(accepts.map((a: any) => parseChainFromNetwork(a.network || "")))];
        sellerWallet = accepts[0]?.payTo;
        schemes = [...new Set(accepts.map((a: any) => a.scheme))];
        tokens = [...new Set(accepts.map((a: any) => a.extra?.name).filter(Boolean))];
      } else {
        // v1 format with flat fields
        const network = x402Data.network || x402Data.payment_network || "";
        if (network) chains = [parseChainFromNetwork(network)];
        sellerWallet = x402Data.seller_wallet || x402Data.payTo || x402Data.payment_address;
        if (x402Data.payment_scheme) schemes = [x402Data.payment_scheme];
        if (x402Data.currency) tokens = [x402Data.currency];
        // If endpoints are in the x402 well-known, save for later
        if (x402Data.endpoints) {
          serviceFromX402 = {
            name: x402Data.service || x402Data.name,
            description: x402Data.description,
            category: x402Data.category,
            endpoints: x402Data.endpoints.map((e: any) => ({
              path: e.path,
              method: e.method || "GET",
              price_usdc: String(e.price_usdc || e.price || ""),
              description: e.description,
            })),
            tags: x402Data.tags,
          };
        }
      }

      // Step 2: Fetch /.well-known/ai-catalog.json
      const catalog = await fetchJson(`${baseUrl}/.well-known/ai-catalog.json`);
      if (!catalog) errors.push("No /.well-known/ai-catalog.json found");

      // Step 3: Fetch /llms.txt
      const llmsTxt = await fetchText(`${baseUrl}/llms.txt`);
      if (!llmsTxt) errors.push("No /llms.txt found");

      // Build result — prefer ai-catalog, fall back to x402 well-known endpoints
      let serviceInfo: any = null;
      if (catalog) {
        // ai-catalog.json format: { host: { displayName }, entries: [{ displayName, description, tags, capabilities }] }
        if (catalog.entries && Array.isArray(catalog.entries)) {
          const entry = catalog.entries[0]; // first entry is the main service
          serviceInfo = {
            name: entry.displayName || catalog.host?.displayName,
            description: entry.description,
            category: entry.type || undefined,
            endpoints: entry.tools
              ? entry.tools.map((t: any) => ({
                  path: t.name,
                  method: "TOOL",
                  price_usdc: t.cost || "",
                  description: t.description,
                }))
              : undefined,
            tags: entry.tags,
          };
        } else {
          // Simple format: { name, description, endpoints }
          serviceInfo = {
            name: catalog.name,
            description: catalog.description,
            category: catalog.category,
            endpoints: catalog.endpoints,
            tags: catalog.tags,
          };
        }
      } else if (serviceFromX402) {
        serviceInfo = serviceFromX402;
      }

      const result: DiscoveryResult = {
        url: baseUrl,
        x402_enabled: true,
        payment: {
          chains,
          seller_wallet: sellerWallet,
          schemes,
          tokens,
        },
        service: serviceInfo || undefined,
        llms_txt: llmsTxt ? llmsTxt.substring(0, 2000) : undefined,
        discovered_at: new Date().toISOString(),
        errors: errors.length > 0 ? errors : undefined,
      };

      // Auto-add to directory if service info was found
      if (serviceInfo && serviceInfo.name) {
        try {
          addToDirectory({
            name: serviceInfo.name,
            description: serviceInfo.description || "",
            base_url: baseUrl,
            chain: chains[0] || "unknown",
            category: serviceInfo.category || "other",
            tags: serviceInfo.tags || [],
            endpoints: (serviceInfo.endpoints || []).map((e: any) => ({
              path: e.path,
              method: e.method || "GET",
              price_usdc: e.price_usdc || "",
              description: e.description || "",
            })),
          });
        } catch (err) {
          // Best-effort — don't fail discovery if directory update fails
          if (!result.errors) result.errors = [];
          result.errors.push(`Auto-add to directory failed: ${err}`);
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}