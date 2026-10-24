// Issue #64 — optional extra request headers for sellers that need them,
// DENY-BY-DEFAULT.
//
// A caller may pass `headers?: Record<string, string>` to x402_fetch, but ONLY
// header NAMES on the operator-configured allowlist are accepted:
//   - X402_EXTRA_HEADER_ALLOWLIST: comma-separated names, case-insensitive,
//     EMPTY by default (no allowlist ⇒ every extra header is refused).
//   - A HARD deny list that configuration cannot override (D5): authorization,
//     cookie, proxy-authorization, host, content-length, transfer-encoding,
//     connection (also hop-by-hop: keep-alive, te, trailer, upgrade) and any
//     name starting `payment-` or `x-payment` — the SDK owns those on the paid
//     leg. Refused even when allowlisted.
//   - Names validated as RFC 7230 tokens; values must not contain CR, LF or
//     NUL; ≤ 1024 characters per value; ≤ 16 headers; no duplicate names that
//     differ only by case.
//   - Refusal is a stable HEADER_REFUSED code BEFORE any request.
//   - Header VALUES are never logged and never written to the ledger — callers
//     may log the NAMES only (the caller renders them itself via the returned
//     `names` list).
//
// Pure module: no fetch, no ledger, no policy import.

/** The hard deny list — never overridable by configuration. */
const HARD_DENIED_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  // hop-by-hop
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);
const HARD_DENIED_PREFIXES = ["payment-", "x-payment"];

const MAX_VALUE_CHARS = 1024;
const MAX_HEADER_COUNT = 16;

/** RFC 7230 token: !#$%&'*+\-.^_`|~ plus alphanumerics. */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type ExtraHeadersCheck =
  | { ok: true; headers: Record<string, string>; names: string[] }
  | { ok: false; code: "HEADER_REFUSED"; message: string };

export interface ExtraHeaderOptions {
  /** Test hook: override the allowlist source instead of process.env. */
  allowlist?: string[];
}

/** Lower-cased entries from X402_EXTRA_HEADER_ALLOWLIST. Empty by default. */
export function extraHeaderAllowlistFromEnv(): string[] {
  const raw = process.env.X402_EXTRA_HEADER_ALLOWLIST;
  if (!raw) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");
}

function hardDenied(name: string): boolean {
  if (HARD_DENIED_NAMES.has(name)) return true;
  return HARD_DENIED_PREFIXES.some((p) => name.startsWith(p));
}

/** Validate + filter the caller's extra headers (issue #64 reqs 2-4).
 * `raw` is exactly the tool-argument value. Returns the accepted headers
 * (name → value) plus the accepted NAMES for name-only logging, or a
 * HEADER_REFUSED refusal naming the offending header NAME (a value never
 * appears in any message). */
export function checkExtraHeaders(raw: unknown, opts: ExtraHeaderOptions = {}): ExtraHeadersCheck {
  const refuse = (message: string): ExtraHeadersCheck => ({ ok: false, code: "HEADER_REFUSED", message });
  if (raw === undefined || raw === null) return { ok: true, headers: {}, names: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return refuse("headers must be a map of header names to string values");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return { ok: true, headers: {}, names: [] };
  if (entries.length > MAX_HEADER_COUNT) {
    return refuse(`too many headers: ${entries.length} given, at most ${MAX_HEADER_COUNT} allowed (issue #64 req 4)`);
  }

  const allowlist = new Set(opts.allowlist ?? extraHeaderAllowlistFromEnv());
  const seen = new Map<string, string>(); // lowercased name → original name
  const out: Record<string, string> = {};
  const names: string[] = [];

  for (const [rawName, rawValue] of entries) {
    const name = String(rawName).toLowerCase();
    if (!TOKEN_RE.test(String(rawName))) {
      return refuse(`header name "${rawName}" is not a valid RFC 7230 token (issue #64 req 4)`);
    }
    if (hardDenied(name)) {
      return refuse(`header "${name}" is on the hard deny list and can never be sent — not even via the allowlist (issue #64 req 3)`);
    }
    if (!allowlist.has(name)) {
      return refuse(`header "${name}" is not on X402_EXTRA_HEADER_ALLOWLIST — deny by default (issue #64 req 2)`);
    }
    const first = seen.get(name);
    if (first !== undefined && first !== String(rawName)) {
      return refuse(`duplicate header "${name}" given in different cases (issue #64 req 4)`);
    }
    if (typeof rawValue !== "string") {
      return refuse(`header "${name}" value must be a string`);
    }
    if (rawValue.includes("\r") || rawValue.includes("\n") || rawValue.includes("\0")) {
      return refuse(`header "${name}" value must not contain CR, LF or NUL characters (issue #64 req 4)`);
    }
    if (rawValue.length > MAX_VALUE_CHARS) {
      return refuse(`header "${name}" value is longer than ${MAX_VALUE_CHARS} characters (issue #64 req 4)`);
    }
    seen.set(name, String(rawName));
    out[name] = rawValue;
    names.push(name);
  }
  return { ok: true, headers: out, names };
}