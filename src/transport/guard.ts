// Issue #58 — one shared transport guard for every tool that fetches a
// caller- or third-party-supplied URL (x402_fetch probe + paid leg,
// x402_health, x402_crawl_directory, the shared probe utils used by
// x402_probe_allowlist, and x402_discover_url).
//
// guardUrl(rawUrl) classifies a URL BEFORE any request is sent:
//   - literal private/loopback/link-local/unspecified IPv4 + IPv6 addresses
//     (including IPv4-mapped IPv6) are refused (PRIVATE_HOST_REFUSED);
//   - hostnames are resolved and EVERY answer must be public — one private
//     answer refutes (mixed answers = DNS rebinding in progress);
//   - `localhost`/`.localhost` names are refused without a resolver;
//   - URLs carrying user info (user:pass@host) are refused (URL_INVALID);
//   - non-http(s) schemes are refused (HTTP_NOT_ALLOWED), and plain `http`
//     is https-only for public hosts — `http` is allowed ONLY for hosts on
//     the explicit private-host allowlist (below);
//   - resolution failure does NOT refuse: the fetch then fails through the
//     normal network-error path.
//
// X402_ALLOW_PRIVATE_HOSTS (D2): comma-separated `host` or `host:port`
// entries, case-insensitive, EMPTY by default, read from process.env ONLY —
// never from tool arguments, so a tool caller can never extend it. A URL
// whose host matches an entry is exempt from the private-address refusal and
// may use `http` (the local mock-seller and test-sandbox path; issue #58
// req 6). Public hosts stay https-only.
//
// Refuse-at-resolve covers the practical SSRF attack; connect-time socket
// pinning (narrowing the DNS-rebinding window between this check and the TCP
// connect) remains a documented known limitation, as does redirect-following
// (guardedFetch below refuses every 3xx instead of following it).
//
// The default resolver is node's dns/promises lookup with `{ all: true }`,
// cached briefly (30 s) so a burst of tool calls does not hammer the
// resolver. Cache entries are per-host. Injected resolvers (unit tests)
// bypass the cache entirely.

import { isIP } from "net";
import { lookup } from "dns/promises";

/** Refusal codes carried by guardUrl results and TransportRefusal errors. */
export type GuardCode = "PRIVATE_HOST_REFUSED" | "REDIRECT_REFUSED" | "HTTP_NOT_ALLOWED" | "URL_INVALID";

/** Injectable resolver (tests never touch real DNS). Same shape as
 * dns/promises `lookup({ all: true, verbatim: true })`. */
export type ResolveFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

export interface GuardOptions {
  /** Override the hostname resolution (unit tests). Default: real DNS. */
  resolve?: ResolveFn;
}

export type GuardResult =
  | { ok: true; url: string }
  | { ok: false; code: GuardCode; message: string };

// --- address classifiers (moved verbatim from src/tools/discover-url.ts) ----

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
export function expandIPv6(ip: string): number[] | null {
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

// --- allowlist (issue #58 req 6) ---------------------------------------------

/** Lower-case, whitespace-trimmed entries from X402_ALLOW_PRIVATE_HOSTS.
 * Empty by default. Each entry is `host` or `host:port` (host may be a
 * bracketed IPv6 literal). Malformed entries are dropped — the allowlist can
 * only ever narrow the refusal set for the operator who sets it, never widen
 * anything else. */
export function allowPrivateHostsFromEnv(): string[] {
  const raw = process.env.X402_ALLOW_PRIVATE_HOSTS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");
}

function hostPortOf(hostname: string, port: string): { host: string; port: string } {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return { host, port };
}

/** Split an allowlist entry into host + optional port (undefined = any port).
 * Bracketed IPv6 entries keep their colons intact. */
function splitEntry(entry: string): { host: string; port?: string } {
  if (entry.includes("[")) {
    const m = /^\[([0-9a-f:.]+)\](?::(\d+))?$/.exec(entry);
    if (!m) return { host: entry };
    return { host: m[1], port: m[2] };
  }
  const firstColon = entry.indexOf(":");
  const lastColon = entry.lastIndexOf(":");
  // Bare IPv6 (multiple colons, no brackets) is a host with no port.
  if (firstColon === -1 || firstColon === lastColon) {
    const idx = entry.indexOf(":");
    if (idx === -1) return { host: entry };
    const host = entry.slice(0, idx);
    const port = entry.slice(idx + 1);
    if (/^\d+$/.test(port)) return { host, port };
    return { host: entry };
  }
  return { host: entry };
}

/** True when the URL's host (+port when the entry carries one) matches an
 * X402_ALLOW_PRIVATE_HOSTS entry. */
export function hostAllowlisted(url: URL): boolean {
  const { host, port } = hostPortOf(url.hostname, url.port);
  const effectivePort = port !== "" ? port : url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
  for (const entry of allowPrivateHostsFromEnv()) {
    const e = splitEntry(entry);
    if (e.host !== host) continue;
    if (e.port === undefined) return true;               // any port
    if (e.port === port) return true;                    // exact (explicit) port
    if (e.port === effectivePort) return true;           // default port spelled out
  }
  return false;
}

function isLocalhostName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

// --- resolver ----------------------------------------------------------------

const RESOLVE_TTL_MS = 30_000;
const RESOLVE_CACHE_MAX = 512;
type CacheEntry = { at: number; answers?: Array<{ address: string; family: number }>; error?: Error };
const resolveCache = new Map<string, CacheEntry>();

function cacheClear(): void {
  const now = Date.now();
  for (const [k, v] of resolveCache) {
    if (now - v.at > RESOLVE_TTL_MS) resolveCache.delete(k);
  }
}

/** The default resolver: real DNS with `{ all: true, verbatim: true }`,
 * memoised for RESOLVE_TTL_MS. Errors are cached too (a dead host fails fast
 * across a probe burst instead of re-storming the resolver). */
export const defaultResolve: ResolveFn = async (host) => {
  const now = Date.now();
  const hit = resolveCache.get(host);
  if (hit && now - hit.at < RESOLVE_TTL_MS) {
    if (hit.error) throw hit.error;
    return hit.answers!;
  }
  if (resolveCache.size > RESOLVE_CACHE_MAX) cacheClear();
  try {
    const answers = (await lookup(host, { all: true, verbatim: true })) as Array<{ address: string; family: number }>;
    const mapped = answers.map((a) => ({ address: a.address, family: a.family }));
    resolveCache.set(host, { at: now, answers: mapped });
    return mapped;
  } catch (err: any) {
    const error = err instanceof Error ? err : new Error(String(err));
    resolveCache.set(host, { at: now, error });
    throw error;
  }
};

// --- guardUrl ------------------------------------------------------------------

function privateHostMessage(host: string): string {
  return `Host ${host} is private, loopback or link-local (or resolves to such an address); refused before any request (SSRF guard, issue #58). DNS-rebinding prevention via socket pinning is a documented known limitation.`;
}

/** Classify a URL BEFORE any request is sent — the shared gate every guarded
 * fetch runs first. See the module header for the refusal rules. Never
 * throws: refusals come back as { ok: false, code, message }. */
export async function guardUrl(rawUrl: string, opts: GuardOptions = {}): Promise<GuardResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, code: "URL_INVALID", message: "URL could not be parsed; refused before any request (issue #58)." };
  }
  // Credentials in URLs are refused outright: they leak through referrers,
  // logs and error echoes, and a userinfo section can make a hostile string
  // look like a trusted host.
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      code: "URL_INVALID",
      message: "URL must not carry user info (user:pass@host); refused before any request (issue #58).",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      code: "HTTP_NOT_ALLOWED",
      message: `Scheme ${parsed.protocol} is not allowed — only http(s) requests are sent by guarded tools (issue #58).`,
    };
  }
  const { host } = hostPortOf(parsed.hostname, parsed.port);

  // Operator allowlist first: an allowlisted host is exempt from the private
  // refusal (mock sellers, sandbox stacks) and may use plain http. Its
  // resolution is skipped — the operator explicitly trusted the host.
  const allowlisted = hostAllowlisted(parsed);
  if (allowlisted) return { ok: true, url: rawUrl };

  if (isLocalhostName(host)) {
    return { ok: false, code: "PRIVATE_HOST_REFUSED", message: privateHostMessage(host) };
  }

  const kind = isIP(host);
  if (kind === 4 && isPrivateIPv4(host)) {
    return { ok: false, code: "PRIVATE_HOST_REFUSED", message: privateHostMessage(host) };
  }
  if (kind === 6 && isPrivateIPv6(host)) {
    return { ok: false, code: "PRIVATE_HOST_REFUSED", message: privateHostMessage(host) };
  }
  if (kind === 0) {
    // A real hostname: resolve it and require every answer to be public.
    const resolve = opts.resolve ?? defaultResolve;
    let answers: Array<{ address: string; family: number }>;
    try {
      answers = await resolve(host);
    } catch {
      // Unresolvable: NOT refused here — the fetch fails through the normal
      // network-error path (same rule the discovery guard has always had).
      return { ok: true, url: rawUrl };
    }
    const unsafe = answers.some((r) => (r.family === 6 ? isPrivateIPv6(r.address) : isPrivateIPv4(r.address)));
    if (unsafe) {
      return { ok: false, code: "PRIVATE_HOST_REFUSED", message: privateHostMessage(host) };
    }
  }

  // Plain http is https-only for public hosts (issue #58 req 7); allowlisted
  // private hosts were already accepted above.
  if (parsed.protocol === "http:") {
    return {
      ok: false,
      code: "HTTP_NOT_ALLOWED",
      message: "Plain http is refused for public hosts — https only. http is allowed only for hosts on X402_ALLOW_PRIVATE_HOSTS (issue #58 req 7).",
    };
  }
  return { ok: true, url: rawUrl };
}

// --- guardedFetch (issue #58 req 1/5) -----------------------------------------

/** A tool-level refusal caused by the transport guard. Carries the stable
 * code (`PRIVATE_HOST_REFUSED` / `REDIRECT_REFUSED` / `HTTP_NOT_ALLOWED` /
 * `URL_INVALID`) plus a fixed detail message; tools render these as
 * { error: code, detail } before any payment attempt. */
export class TransportRefusal extends Error {
  readonly code: GuardCode;
  readonly detail: string;
  constructor(code: GuardCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "TransportRefusal";
    this.code = code;
    this.detail = detail;
  }
}

export function isTransportRefusal(err: unknown): err is TransportRefusal {
  return err instanceof TransportRefusal;
}

/** Rebuild a foreign Request with redirect: "manual" so NO call path can
 * follow a redirect. Body is buffered to an ArrayBuffer (the Request body may
 * be a stream; buffering needs no duplex flag). Our own paid leg never hits
 * this: it passes redirect: "manual" in its init, so the SDK-built Requests
 * already carry the manual mode and are passed to fetch as-is. */
async function asManualRequest(req: Request): Promise<Request> {
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : undefined;
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? body : undefined,
    redirect: "manual",
    signal: req.signal,
  });
}

/** THE one fetch all guarded tools go through (issue #58 req 1):
 *   1. guardUrl — refuse private/loopback/link-local/unspecified hosts and
 *      non-https targets BEFORE anything is sent (no payment attempt);
 *   2. redirect: "manual" — a 3xx response is refused with REDIRECT_REFUSED;
 *      the Location is never read and the target is never fetched.
 *
 * Disclosed deviation from the issue's letter (`redirect: "error"`): manual
 * mode also never follows a redirect, but — unlike the indistinct TypeError
 * `error` mode produces — it lets the guard emit the stable REDIRECT_REFUSED
 * code. Accepts either (url, init) or a Request (the x402 SDK's paid leg
 * calls its wrapped fetch with a Request).
 *
 * Throws TransportRefusal on refusal; every tool call site turns that into
 * its refusal result. */
export async function guardedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const urlStr = input instanceof Request ? input.url : String(input);
  const verdict = await guardUrl(urlStr);
  if (verdict.ok === false) throw new TransportRefusal(verdict.code, verdict.message);
  const manualInit = { ...(init ?? {}), redirect: "manual" } as RequestInit;
  const resp = input instanceof Request
    ? (input.redirect === "manual"
        ? await globalThis.fetch(input) // our paid-leg Requests are built with manual mode — passed through verbatim
        : await globalThis.fetch(await asManualRequest(input)))
    : await globalThis.fetch(urlStr, manualInit);
  if (resp.status >= 300 && resp.status < 400) {
    throw new TransportRefusal(
      "REDIRECT_REFUSED",
      `The endpoint answered HTTP ${resp.status} (a redirect); redirects are never followed by guarded tools (issue #58).`,
    );
  }
  return resp;
}