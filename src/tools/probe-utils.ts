import { CASPER_CHAIN, isCasperNetwork } from "../casper/networks.js";
import { aliasForCaip2 } from "../evm/networks.js";
// Issue #59 (req 6): exact Solana CAIP-2 ids (public protocol identifiers).
import { SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2, SOLANA_TESTNET_CAIP2 } from "@x402/svm";
// Issue #58: every fetch site in this shared probe surface goes through the
// one transport guard — private/loopback/link-local hosts are refused before
// any request and redirects are refused (REDIRECT_REFUSED), never followed.
// x402_crawl_directory and x402_probe_allowlist probe through these helpers,
// so the guard covers them without a second fetch path.
import { guardedFetch, isTransportRefusal, type GuardCode } from "../transport/guard.js";

/** Fetch a URL and return its parsed JSON body, or null on any failure
 * (network error, non-2xx, or body that is not valid JSON — e.g. an HTML
 * catch-all page served with a 200). */
export async function fetchJson(url: string, timeoutMs: number = 10000): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await guardedFetch(url, {
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
 * collapse was the #32 bug).
 * Issue #59 (req 6): the SOLANA side is exact now too — the chain vocabulary
 * is reached ONLY through the protocol's exact identifiers: the SDK's Solana
 * CAIP-2 ids (mainnet/devnet/testnet), the V1 protocol network name and the
 * bare mainnet genesis (the pre-#59 vocabulary). A namespace whose NAME
 * happens to contain "solana" (<prefix>;solana) or an UNKNOWN solana:*
 * genesis stays VERBATIM — classification is never substring matching. */
export function parseChainFromNetwork(network: string): string {
  if (
    network === "solana"
    || network === SOLANA_MAINNET_CAIP2
    || network === SOLANA_DEVNET_CAIP2
    || network === SOLANA_TESTNET_CAIP2
    || network === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  ) {
    return "solana";
  }
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
    const resp = await guardedFetch(url, { signal: controller.signal });
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
  /** The stable transport refusal code (issue #58: PRIVATE_HOST_REFUSED,
   * REDIRECT_REFUSED, HTTP_NOT_ALLOWED, URL_INVALID) when this error outcome
   * IS a transport-guard refusal — absent for timeouts, network failures and
   * the oversized-payment-data outcomes (those surface through `error` with
   * the paid flow's own cap wording). */
  error_code?: GuardCode;
}

/** The paid flow's own payment-data caps, applied here too (issue #67 req 1:
 * the probe must refuse what the paid probe refuses): `fetch.ts` refuses a
 * payment-required header longer than 64 KiB ("Payment header exceeds size
 * limit") and the paid bounded read (`casper-fetch.boundedText`) refuses a
 * body past 64 KiB ("Payment response exceeds size limit"). */
const PAYMENT_REQUIRED_HEADER_CAP = 65_536;
const PAYMENT_REQUIRED_BODY_CAP = 65_536;

/** Bounded body read for the header-less-402 fallback (adapted from
 * casper-fetch's boundedText, which throws on oversize). Kept local so this
 * shared probe surface stays free of the payment SDK casper-fetch imports.
 * Reads at most PAYMENT_REQUIRED_BODY_CAP bytes and throws when the body
 * exceeds it — an oversized body is an attack signal, never read on. */
async function boundedProbeBody(response: Response, limit: number = PAYMENT_REQUIRED_BODY_CAP): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Payment response exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Probe a URL for a 402 PAYMENT-REQUIRED challenge and classify the outcome
 * (issue #34, L6; issue #67 req 1 — the guard/cap outcomes x402_inspect
 * reports):
 *   - status 402 with a decodable payment-required header ⇒ live_402 (with the
 *     parsed challenge object); a payment-required header longer than 64 KiB
 *     is an error outcome (never parsed, the paid probe's own cap);
 *   - a 402 with NO payment-required header falls back to the bounded BODY
 *     read the paid probe uses header-less (a JSON object body ⇒ live_402;
 *     a body past 64 KiB is an error outcome, anything else ⇒ no_402);
 *   - any other answered response, or a 402 whose header does not decode ⇒
 *     no_402
 *   - a thrown/aborted request (timeout, network failure, transport refusal)
 *     ⇒ error (never live); a transport refusal carries its stable code in
 *     `error_code` (PRIVATE_HOST_REFUSED / REDIRECT_REFUSED / …).
 * Redirects are never followed (redirect: "manual" — a 3xx is refused
 * REDIRECT_REFUSED by the transport guard, issue #58), only the response
 * header is read, and nothing is ever paid or authenticated — one shared HTTP
 * stack (this module), no second client. */
export async function probePaymentChallenge(url: string, timeoutMs: number = 10000): Promise<LivenessProbeResult> {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await guardedFetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (resp.status !== 402) {
      return { kind: "no_402", latency_ms: Date.now() - started };
    }
    const encoded = resp.headers.get("payment-required");
    // Issue #67 req 1: the SAME oversize caps the paid probe refuses with —
    // an oversized payment payload is an attack signal, never parsed.
    if (encoded !== null && encoded.length > PAYMENT_REQUIRED_HEADER_CAP) {
      return { kind: "error", latency_ms: Date.now() - started, error: "Payment header exceeds size limit" };
    }
    const challenge = decodePaymentRequiredHeader(encoded);
    if (challenge) {
      return { kind: "live_402", challenge, latency_ms: Date.now() - started };
    }
    if (encoded === null) {
      // Header absent: exactly the fallback the paid probe parses on a 402
      // (header else bounded body). An oversized body is refused as an error
      // outcome — bounded read, never read on; a body that is not a JSON
      // object is just "answered, nothing decodable" (no_402).
      let body: string;
      try {
        body = await boundedProbeBody(resp);
      } catch (err: any) {
        return { kind: "error", latency_ms: Date.now() - started, error: String(err?.message ?? err).slice(0, 200) };
      }
      try {
        const parsed = JSON.parse(body) as unknown;
        if (parsed !== null && typeof parsed === "object") {
          return { kind: "live_402", challenge: parsed, latency_ms: Date.now() - started };
        }
      } catch {
        // not a JSON object body — no_402 below
      }
    }
    return { kind: "no_402", latency_ms: Date.now() - started };
  } catch (err: any) {
    // Issue #58: a transport guard refusal reports as a stable error outcome
    // ("PRIVATE_HOST_REFUSED: …" / "REDIRECT_REFUSED: …") — never live, never
    // followed. The refusal detail already carries the stable code.
    if (isTransportRefusal(err)) {
      return { kind: "error", latency_ms: Date.now() - started, error: err.message, error_code: err.code };
    }
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
 * MEASURED: a clearly-marked placeholder is a valid representative probe —
 * a placeholder probe can answer 402 on an advertised parametrized route.
 * Note (issue #50): address-token routes that validate the parameter
 * pre-settle answer 400 for the placeholder token — there the operator's
 * directory-row pin may carry a REAL example token instead; the placeholder
 * stays the generic representative for wildcard/advertised-path probes
 * elsewhere. (Which concrete routes a given service serves rotates, so no
 * per-service route is named here.) */
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
