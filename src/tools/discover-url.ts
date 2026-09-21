import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isIP } from "net";
import { lookup } from "dns/promises";
import { addToDirectory } from "../directory.js";
import { fetchJson, fetchRootPaymentChallenge, parseChainFromNetwork } from "./probe-utils.js";

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

/** True if ip is a private/loopback/link-local/unspecified IPv4 address:
 * 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0/8. Fail closed on junk. */
export function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return true; // unparseable — fail closed
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;   // unspecified / 10/8 / loopback
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16/12
  if (a === 192 && b === 168) return true;             // 192.168/16
  if (a === 169 && b === 254) return true;             // 169.254/16 link-local
  return false;
}

/** Expand an IPv6 literal into 8 numeric hextets, or null if unparseable.
 * Handles '::' compression and a trailing dotted quad (converted to two hextets). */
function expandIPv6(ip: string): number[] | null {
  if (!/^[0-9a-f:.]+$/.test(ip)) return null;
  const hasCompression = ip.includes("::");
  let head: string[];
  let tail: string[];
  if (hasCompression) {
    const parts = ip.split("::");
    if (parts.length !== 2) return null;
    head = parts[0] === "" ? [] : parts[0].split(":");
    tail = parts[1] === "" ? [] : parts[1].split(":");
  } else {
    head = ip.split(":");
    tail = [];
  }
  const lastHead = head[head.length - 1];
  const lastTail = tail[tail.length - 1];
  const dotted = lastTail?.includes(".") ? lastTail : lastHead?.includes(".") ? lastHead : null;
  if (dotted) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(dotted);
    if (!m) return null;
    const hi = ((Number(m[1]) << 8) | Number(m[2])).toString(16);
    const lo = ((Number(m[3]) << 8) | Number(m[4])).toString(16);
    if (lastTail?.includes(".")) tail = [...tail.slice(0, -1), hi, lo];
    else head = [...head.slice(0, -1), hi, lo];
  }
  if (head.length + tail.length > 8) return null;
  const missing = 8 - head.length - tail.length;
  if (!hasCompression && missing !== 0) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail].map((g) => parseInt(g, 16));
  if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/** True if ip is a private/loopback/link-local/unspecified IPv6 address:
 * ::1, :: (unspecified), IPv4-mapped ::ffff:0:0/96 (judged by embedded IPv4),
 * fc00::/7 (ULA), fe80::/10 (link-local). Fail closed on junk. */
export function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  // A dotted-quad tail (IPv4-mapped ::ffff:a.b.c.d, deprecated IPv4-compatible
  // ::a.b.c.d, or NAT64-style literals) is judged by its embedded IPv4 address.
  const colonParts = s.split(":");
  const tail = colonParts[colonParts.length - 1];
  if (tail.includes(".") && isPrivateIPv4(tail)) return true;
  const groups = expandIPv6(s);
  if (!groups) return true; // unparseable — fail closed
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIPv4(`${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`);
  }
  if (groups.every((g) => g === 0)) return true;                       // :: unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return true;                      // fc00::/7
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return true;                      // fe80::/10
  return false;
}

/** Classifier used by the SSRF guard and its tests. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return false;
}

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
    "Discover any x402 service by URL. Fetches /.well-known/x402 (payment details), /.well-known/ai-catalog.json (capabilities), and /llms.txt (agent summary). Returns a unified discovery object with chains, wallet, endpoints, and prices.",
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