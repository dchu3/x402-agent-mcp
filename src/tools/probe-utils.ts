import { CASPER_CHAIN, isCasperNetwork } from "../casper/networks.js";

/** Fetch a URL and return its parsed JSON body, or null on any failure
 * (network error, non-2xx, or body that is not valid JSON — e.g. an HTML
 * catch-all page served with a 200). */
export async function fetchJson(url: string, timeoutMs: number = 10000): Promise<any | null> {
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

/** Shape check: is this body an x402 manifest / payment challenge?
 * Accepts v2-style {accepts|accept:[...]}, v1 flat {network|payment_network},
 * and minimal {version, resources:[...]} well-known manifests. Rejects
 * scalars, arrays, null, and arbitrary objects (e.g. parsed HTML is already
 * excluded by fetchJson, but JSON-looking junk is filtered here). */
export function isX402Manifest(data: any): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (Array.isArray(data.accepts) || Array.isArray(data.accept)) return true;
  if (typeof data.x402Version === "number" || typeof data.x402_version === "number") return true;
  if (typeof data.network === "string" || typeof data.payment_network === "string") return true;
  if (typeof data.payment_scheme === "string" || typeof data.seller_wallet === "string") return true;
  if (typeof data.version === "number" && Array.isArray(data.resources)) return true;
  return false;
}

/** Map an x402 network identifier to a human chain name. */
export function parseChainFromNetwork(network: string): string {
  if (network.includes("solana") || network.includes("5eykt4")) return "solana";
  if (network.includes("eip155") || network.includes("8453")) return "base";
  if (isCasperNetwork(network)) return CASPER_CHAIN;
  return network;
}

/** Decode a PAYMENT-REQUIRED header (base64url JSON). */
export function decodePaymentRequiredHeader(header: string | null): any | null {
  if (!header) return null;
  try {
    // base64url → base64
    const b64 = header.replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (b64.length % 4)) % 4;
    return JSON.parse(Buffer.from(b64 + "=".repeat(pad), "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

/** Probe a URL for a 402 PAYMENT-REQUIRED challenge header. */
export async function fetchRootPaymentChallenge(url: string, timeoutMs: number = 10000): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return decodePaymentRequiredHeader(resp.headers.get("payment-required"));
  } catch {
    return null;
  }
}

export interface ChallengeHit {
  challenge: any;
  /** "root" or the OpenAPI path that answered with 402 */
  path: string;
}

/** Find a 402 PAYMENT-REQUIRED challenge for a service: GET / first, then up to
 * 3 GET paths from /openapi.json. Many x402 hosts serve a 200 HTML landing page
 * at the root and only challenge on API paths. Bounded, never pays, never sends
 * credentials. */
export async function findPaymentChallenge(baseUrl: string, timeoutMs: number = 10000): Promise<ChallengeHit | null> {
  const root = await fetchRootPaymentChallenge(baseUrl, timeoutMs);
  if (root) return { challenge: root, path: "root" };

  const spec = await fetchJson(`${baseUrl}/openapi.json`, timeoutMs);
  if (!spec?.paths) return null;
  const getPaths: string[] = [];
  for (const [p, methods] of Object.entries<any>(spec.paths)) {
    if (methods?.get) getPaths.push(p);
    if (getPaths.length >= 3) break;
  }
  for (const p of getPaths) {
    const challenge = await fetchRootPaymentChallenge(`${baseUrl}${p}`, timeoutMs);
    if (challenge) return { challenge, path: p };
  }
  return null;
}

/** Extract chains from an x402 manifest/challenge: accepts[].network, flat
 * network, or SIWX extensions.supportedChains (challenge with empty accepts,
 * e.g. SIWX wallet-auth-gated services). */
export function chainsFromManifest(data: any): string[] {
  const accepts = data.accepts || data.accept || [];
  const acceptList = Array.isArray(accepts) ? accepts : [accepts];
  const chains = [...new Set(acceptList.map((a: any) => parseChainFromNetwork(a?.network || data.network || "")).filter(Boolean))] as string[];
  if (chains.length === 0 && data.network) chains.push(parseChainFromNetwork(data.network));
  if (chains.length === 0) {
    const supported = data.extensions?.["sign-in-with-x"]?.supportedChains;
    if (Array.isArray(supported)) {
      for (const c of supported) {
        const chain = parseChainFromNetwork(c?.chainId || "");
        if (chain && !chains.includes(chain)) chains.push(chain);
      }
    }
  }
  return chains;
}
