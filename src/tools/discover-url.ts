import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isIP } from "net";
import { lookup } from "dns/promises";
import { addToDirectory } from "../directory.js";
import { fetchJson, fetchRootPaymentChallenge, parseChainFromNetwork } from "./probe-utils.js";
// Issue #58 (D1): the SSRF address classifiers live in src/transport/guard.ts
// now — one shared guard for every tool that fetches a caller- or
// third-party-supplied URL. Re-exported here so existing imports keep working.
import { isPrivateIPv4, isPrivateIPv6, isPrivateAddress } from "../transport/guard.js";
export { isPrivateIPv4, isPrivateIPv6, isPrivateAddress };

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

// --- SSRF guard (#18.6) ----------------------------------------------------
// Discovery fetches attacker-influenced URLs, so the tool handler refuses any
// host that resolves to a private, loopback or link-local address BEFORE the
// first request (structured error: refused_private_address). Refuse-at-resolve
// covers the practical attack; full DNS-rebinding prevention needs socket-level
// pinning and remains a documented known limitation, as does redirect-following
// in the shared probe helpers (fetchJson/fetchRootPaymentChallenge).
//
// Issue #58 (D1): the address classifiers moved to src/transport/guard.ts and
// are re-exported from this module (above); this file keeps its own
// discovery-shaped refusal + resolve flow (unresolvable hosts fall through to
// the normal not-found path, unlike the stricter guardUrl refusals).

function refusalFor(url: string): object {
  return {
    url,
    x402_enabled: false,
    error: "refused_private_address",
    detail: "Host resolves to a private, loopback or link-local address; discovery refused before any request (SSRF guard, #18.6). DNS-rebinding prevention via socket pinning is a documented known limitation.",
    discovered_at: new Date().toISOString(),
  };
}

/** Resolve the target host and return a structured refusal object if it maps
 * to a private/loopback/link-local address, else null. Literal IPs are judged
 * directly; hostnames are resolved (all families). Unresolvable hosts are NOT
 * refused here — the fetch itself fails and yields the normal not-found path. */
async function privateAddressRefusal(rawUrl: string): Promise<object | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null; // unparseable URL: let the fetch fail through the normal path
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  const kind = isIP(host);
  if (kind === 4) return isPrivateIPv4(host) ? refusalFor(rawUrl) : null;
  if (kind === 6) return isPrivateIPv6(host) ? refusalFor(rawUrl) : null;
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await lookup(host, { all: true, verbatim: true });
  } catch {
    return null;
  }
  const unsafe = resolved.some((r) => (r.family === 6 ? isPrivateIPv6(r.address) : isPrivateIPv4(r.address)));
  return unsafe ? refusalFor(rawUrl) : null;
}

// --- bounded response reading ----------------------------------------------

/** Read a response body up to limit bytes and TRUNCATE (cancel the stream,
 * return what was read) when it exceeds the limit. Adapted from casper-fetch.ts
 * boundedText(), which instead throws: on the payment path an oversized body is
 * an attack signal, while discovery content is advisory and degrades gracefully. */
export async function boundedTruncatedText(response: Response, limit = 65536): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = limit - size;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        await reader.cancel();
        break;
      }
      size += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchText(url: string, timeoutMs: number = 10000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    // redirect: "error" — a redirect target is never resolved by the SSRF guard,
    // so redirects must never be followed (same rule as the payment fetch paths).
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return await boundedTruncatedText(resp);
  } catch {
    return null;
  }
}

function serviceInfoFromOpenApi(spec: any): any | null {
  if (!spec?.info || !spec?.paths) return null;
  const endpoints: Array<{ path: string; method: string; price_usdc: string; description: string }> = [];
  for (const [path, methods] of Object.entries<any>(spec.paths)) {
    for (const method of ["get", "post"]) {
      const op = methods?.[method];
      if (!op) continue;
      const raw = String(op.summary || op.description || "");
      endpoints.push({
        path,
        method: method.toUpperCase(),
        price_usdc: "",
        description: raw.substring(0, 120),
      });
      if (endpoints.length >= 50) break;
    }
    if (endpoints.length >= 50) break;
  }
  return {
    name: spec.info.title,
    description: spec.info.description,
    category: "other",
    endpoints: endpoints.length > 0 ? endpoints : undefined,
    tags: undefined,
  };
}

export function registerDiscoverUrlTool(server: McpServer): void {
  server.tool(
    "x402_discover_url",
    "Discover any x402 service by URL. Fetches /.well-known/x402 (payment details), /.well-known/ai-catalog.json (capabilities), and /llms.txt (agent summary). Returns a unified discovery object with chains, wallet, endpoints, and prices. Discovery only records what a service advertises; discovering a host never makes it payable — the allowlist and the payment policy still decide every paid leg, and this tool never pays.",
    {
      url: z.string().describe("Base URL of the service to discover (e.g. https://svm402.com)"),
    },
    async (args) => {
      const baseUrl = args.url.replace(/\/$/, "");
      const errors: string[] = [];

      // SSRF guard (#18.6): resolve and judge the target BEFORE any request.
      const refusal = await privateAddressRefusal(baseUrl);
      if (refusal) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(refusal, null, 2),
          }],
        };
      }

      // Step 1: Fetch /.well-known/x402
      let x402Data = await fetchJson(`${baseUrl}/.well-known/x402`);
      const wellKnownPresent = x402Data !== null;

      // Fetch openapi.json early when we may need its paths for the 402 probe
      // (preference order for service info is still ai-catalog > x402 > openapi)
      let earlyOpenApi: any = null;
      const catalog = await fetchJson(`${baseUrl}/.well-known/ai-catalog.json`);
      if (!catalog) {
        earlyOpenApi = await fetchJson(`${baseUrl}/openapi.json`);
      }

      if (!x402Data) {
        // Fallback: probe the root URL for a 402 PAYMENT-REQUIRED challenge header
        const challenge = await fetchRootPaymentChallenge(baseUrl);
        if (challenge) {
          x402Data = challenge;
          errors.push("No /.well-known/x402 found, fell back to root 402 PAYMENT-REQUIRED challenge");
        }
      }
      if (!x402Data && earlyOpenApi?.paths) {
        // Root yielded no challenge (e.g. marketing redirect) — probe OpenAPI GET paths
        const getPaths: string[] = [];
        for (const [p, methods] of Object.entries<any>(earlyOpenApi.paths)) {
          if (methods?.get) getPaths.push(p);
          if (getPaths.length >= 3) break;
        }
        for (const p of getPaths) {
          const challenge = await fetchRootPaymentChallenge(`${baseUrl}${p}`);
          if (challenge) {
            x402Data = challenge;
            errors.push(`No /.well-known/x402 found, fell back to 402 challenge on ${p}`);
            break;
          }
        }
      }
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

      // Minimal v1 well-known (version + resources, no accepts): payment info is
      // incomplete even though the service is x402-enabled. Run the same 402
      // challenge fallback chain (root, then OpenAPI GET paths) to fill it in.
      const wellKnownFromFetch = wellKnownPresent;
      if (chains.length === 0 && wellKnownFromFetch) {
        let challenge = await fetchRootPaymentChallenge(baseUrl);
        let challengePath = "root";
        if (!challenge && earlyOpenApi?.paths) {
          const getPaths: string[] = [];
          for (const [p, methods] of Object.entries<any>(earlyOpenApi.paths)) {
            if (methods?.get) getPaths.push(p);
            if (getPaths.length >= 3) break;
          }
          for (const p of getPaths) {
            challenge = await fetchRootPaymentChallenge(`${baseUrl}${p}`);
            if (challenge) { challengePath = p; break; }
          }
        }
        if (challenge) {
          const cAccepts = challenge.accepts || challenge.accept || [];
          if (Array.isArray(cAccepts) && cAccepts.length > 0) {
            chains = [...new Set(cAccepts.map((a: any) => parseChainFromNetwork(a.network || "")))];
            sellerWallet = sellerWallet || cAccepts[0]?.payTo;
            schemes = [...new Set(cAccepts.map((a: any) => a.scheme))];
            tokens = [...new Set(cAccepts.map((a: any) => a.extra?.name).filter(Boolean))];
          } else {
            const network = challenge.network || challenge.payment_network || "";
            if (network) chains = [parseChainFromNetwork(network)];
            sellerWallet = sellerWallet || challenge.seller_wallet || challenge.payTo || challenge.payment_address;
            if (challenge.payment_scheme) schemes = [challenge.payment_scheme];
            if (challenge.currency) tokens = [challenge.currency];
          }
          errors.push(`Well-known x402 has no accepts, payment info from 402 challenge on ${challengePath}`);
        }
      }

      // Step 2: Fetch /llms.txt
      const llmsTxt = await fetchText(`${baseUrl}/llms.txt`);
      if (!llmsTxt) errors.push("No /llms.txt found");

      // Step 3: OpenAPI fallback for service info (fetched early when ai-catalog absent)
      let serviceFromOpenApi: any = null;
      if (!catalog) {
        if (earlyOpenApi) {
          serviceFromOpenApi = serviceInfoFromOpenApi(earlyOpenApi);
          if (serviceFromOpenApi) {
            errors.push("No /.well-known/ai-catalog.json found, fell back to openapi.json");
          } else {
            errors.push("No /.well-known/ai-catalog.json found");
          }
        } else {
          errors.push("No /.well-known/ai-catalog.json found");
        }
      }

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
      } else if (serviceFromOpenApi) {
        serviceInfo = serviceFromOpenApi;
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