import { CASPER_CHAIN, isCasperNetwork } from "../casper/networks.js";
import { aliasForCaip2 } from "../evm/networks.js";

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

/** Map an x402 network identifier to a human chain name. Issue #32: EVM
 * ids resolve through the shared CAIP-2 vocabulary (src/evm/networks.ts) —
 * eip155:137 ⇒ "polygon", eip155:42161 ⇒ "arbitrum", eip155:1 ⇒ "ethereum",
 * and an UNKNOWN eip155:* id returns VERBATIM (never "base" — that substring
 * collapse was the #32 bug). Solana/Casper checks and the raw-string fallback
 * are unchanged. */
export function parseChainFromNetwork(network: string): string {
  if (network.includes("solana") || network.includes("5eykt4")) return "solana";
  const evmAlias = aliasForCaip2(network);
  if (evmAlias !== "") return evmAlias;
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

/** A discriminated liveness probe outcome (issue #34). Unlike
 * fetchRootPaymentChallenge — which returns null for BOTH "answered without a
 * 402" and "network error/timeout" and so cannot classify liveness — this
 * separates the three cases the directory's liveness record must capture. */
export interface LivenessProbeResult {
  kind: "live_402" | "no_402" | "error";
  /** The decoded payment challenge object — present only on live_402. */
  challenge?: any;
  /** Wall-clock duration of the probe attempt, measured around the fetch. */
  latency_ms: number;
  /** Diagnostic message — present only on error (timeout, DNS, refused, …). */
  error?: string;
}

/** Probe a URL for a 402 PAYMENT-REQUIRED challenge and classify the outcome
 * (issue #34, L6):
 *   - status 402 with a decodable payment-required header ⇒ live_402 (with the
 *     parsed challenge object)
 *   - any other answered response, or a 402 whose header does not decode ⇒
 *     no_402
 *   - a thrown/aborted request (timeout, network failure) ⇒ error (never live)
 * Redirects are never followed (redirect: "error"), only the response header
 * is read, and nothing is ever paid or authenticated — one shared HTTP stack
 * (this module), no second client. */
export async function probePaymentChallenge(url: string, timeoutMs: number = 10000): Promise<LivenessProbeResult> {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, { signal: controller.signal, redirect: "error" });
    } finally {
      clearTimeout(timeout);
    }
    if (resp.status !== 402) {
      return { kind: "no_402", latency_ms: Date.now() - started };
    }
    const challenge = decodePaymentRequiredHeader(resp.headers.get("payment-required"));
    if (!challenge) {
      return { kind: "no_402", latency_ms: Date.now() - started };
    }
    return { kind: "live_402", challenge, latency_ms: Date.now() - started };
  } catch (err: any) {
    return { kind: "error", latency_ms: Date.now() - started, error: String(err?.message ?? err).slice(0, 200) };
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

// ---------------------------------------------------------------------------
// Issue #38 — bounded multi-path candidate discovery. Most x402 hosts serve a
// free 200/404 landing page at root and challenge on an API PATH, so a
// root-only probe records a permanent no_402 for a demonstrably payable
// service (and the fail-closed liveness gate then refuses it forever). These
// helpers let the refresh probe build a BOUNDED candidate URL list — advertised
// paths, the base_url itself, and noise-filtered /openapi.json GET paths — and
// walk it with early exit. Substitution is for REQUEST-URL construction only;
// discovery is bounded, free, never follows redirects, and never pays.
// ---------------------------------------------------------------------------

/** The substitute token for parametrized probe candidates (issue #38, P3).
 * MEASURED (plan fact 5): a clearly-marked placeholder is a valid
 * representative probe — /price/x402-probe answers 402 where /price/{address}
 * is the advertised shape. */
export const PROBE_PLACEHOLDER = "x402-probe";

/** Substitute path/query placeholders in a candidate path with the probe
 * token (issue #38, P3): a trailing `*` and each `{...}` placeholder — in a
 * path segment or in a query string — become `x402-probe`. Anything without
 * placeholders is returned byte-identical. Callers apply this ONLY when
 * building a request URL; the configured/advertised path string itself is
 * never mutated. */
export function probePlaceholderUrl(path: string): string {
  return path
    .replace(/\*$/, PROBE_PLACEHOLDER)
    .replace(/\{[^{}]*\}/g, PROBE_PLACEHOLDER);
}

/** Paths treated as noise when picking /openapi.json discovery candidates
 * (issue #38, P2): free static/well-known/health endpoints. They are dropped
 * BEFORE the discovery cap so they can never starve the paid paths — the
 * measured failure mode of findPaymentChallenge's 3-path insertion-order
 * budget (plan fact 3: /.well-known/x402, /health and /llms.txt consumed the
 * budget before /weather/current was ever reached). */
const OPENAPI_NOISE_PATHS = new Set(["/llms.txt", "/robots.txt", "/favicon.ico", "/health", "/openapi.json"]);

/** Discovery cap (issue #38, P2): at most this many GET paths are taken from
 * one /openapi.json spec, after the noise filter, in insertion order. */
export const OPENAPI_PROBE_PATH_LIMIT = 8;

/** Select the discovery candidate paths from an OpenAPI spec (issue #38, P2):
 * entries with a `get` operation only, noise-filtered, capped, ORDER
 * PRESERVED (insertion order — the spec's own ordering is the service's self-
 * description). Never throws: a junk spec (null, non-object, missing/odd
 * `paths`) yields []. Paths are returned verbatim from the spec. */
export function openApiProbePaths(spec: any, limit: number = OPENAPI_PROBE_PATH_LIMIT): string[] {
  if (!spec || typeof spec !== "object" || !spec.paths || typeof spec.paths !== "object") return [];
  const out: string[] = [];
  for (const [path, methods] of Object.entries<any>(spec.paths)) {
    if (out.length >= limit) break;
    if (!methods?.get) continue;
    if (path.startsWith("/.well-known/") || OPENAPI_NOISE_PATHS.has(path)) continue;
    out.push(path);
  }
  return out;
}

/** The aggregate outcome of one bounded candidate walk (issue #38, P5): the
 * liveness outcome plus the EXACT URL that produced it — the first live_402
 * candidate when one exists, else the first candidate that answered
 * (no_402), else the last candidate attempted (all-error). */
export interface AggregateProbeResult {
  result: LivenessProbeResult;
  probe_url: string;
}

/** Walk candidate URLs with the per-URL probe and aggregate the outcomes
 * (issue #38, P5/P6): a bounded sequential walk over the existing
 * probePaymentChallenge (one shared HTTP stack — no second client, no new
 * dependency, nothing ever paid).
 *   - the FIRST live_402 wins and probe_url records that exact URL (early
 *     exit — later candidates are never fetched);
 *   - else no_402 when at least one candidate answered (any non-error
 *     outcome — the highest-precedence answered candidate is reported);
 *   - else error when EVERY candidate threw/aborted (the last attempt's
 *     diagnostic and URL);
 *   - zero candidates ⇒ a deterministic error outcome ("no candidate URLs").
 * Candidates are de-duplicated by exact string equality (P4) and the walk is
 * capped at `limit` URLs (default 5). Never throws. */
export async function probeChallengeAcross(urls: string[], timeoutMs: number = 10000, limit: number = 5): Promise<AggregateProbeResult> {
  const candidates = [...new Set(urls)].slice(0, Math.max(0, limit));
  let firstAnswered: AggregateProbeResult | undefined;
  let last: AggregateProbeResult | undefined;
  for (const url of candidates) {
    const result = await probePaymentChallenge(url, timeoutMs);
    const at: AggregateProbeResult = { result, probe_url: url };
    if (result.kind === "live_402") return at;
    if (result.kind === "no_402" && firstAnswered === undefined) firstAnswered = at;
    last = at;
  }
  if (firstAnswered) return firstAnswered;
  if (last) return last; // every candidate errored — the last attempt is the record
  return {
    result: { kind: "error", latency_ms: 0, error: "no candidate URLs to probe" },
    probe_url: "",
  };
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
