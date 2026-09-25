// Issue #34 — pure endpoint-liveness verdicts. Types + pure helpers ONLY:
// imports nothing outside policy/types.ts; no fs, no env reads, no clock (the
// caller injects nowMs), no randomness — same input ⇒ same output, always.
//
// The I/O half lives in src/directory.ts (findEntryForUrl locates the entry a
// URL belongs to; recordLiveness persists probe results atomically); the glue
// is buildPolicyContext (src/policy/config.ts), which computes the verdict and
// injects it on the PolicyContext so the policy engine stays pure (L1).
//
// Pin-set semantics (L2) and gate scope (L3) are implemented verbatim below —
// see the plan/issue for the ratified resolutions; do not re-litigate here.

import type {
  EndpointLiveness,
  LivenessConfig,
  LivenessStatus,
} from "./types.js";

/** The minimal structural shape of a directory row this module needs — kept
 * structural so the pure core never imports the I/O half (src/directory.ts). */
export interface LivenessDirectoryRow {
  base_url: string;
  source?: string;
  liveness?: { probed_at: string; status: LivenessStatus };
}

/** A pinned directory row: its normalised origin plus the optional path
 * constraint the config put on it (L2). `paths` undefined ⇒ every path on the
 * origin is pinned. */
export interface PinnedRow {
  origin: string;
  paths?: string[];
}

/** Is a probe record too old to trust? A MISSING or unparsable probed_at is
 * ALWAYS stale (fail closed) — liveness can never be inferred from garbage. */
export function isStale(record: { probed_at?: string } | undefined, maxAgeSeconds: number, nowMs: number): boolean {
  const raw = record?.probed_at;
  if (typeof raw !== "string" || raw === "") return true;
  const probedMs = Date.parse(raw);
  if (!Number.isFinite(probedMs)) return true;
  return nowMs - probedMs > maxAgeSeconds * 1000;
}

/** Normalise a URL to its origin (scheme://host[:port] — host lowercased,
 * default ports removed, trailing slash gone). Only http/https qualify;
 * unparseable or other-scheme input ⇒ undefined (never throws). */
export function entryOrigin(baseUrl: string): string | undefined {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** Compute the pin set (L2) from the config + the directory rows:
 *  - allowlist ABSENT ⇒ every directory row with source === "seed" is pinned
 *    (any path) — the operator-curated baseline is the default pin set.
 *  - allowlist [] ⇒ the pin set is EMPTY: no endpoint is live (strict mode,
 *    see livenessVerdict).
 *  - allowlist [{ base_url, paths? }] ⇒ each config entry pins the directory
 *    rows whose origin matches its base_url, carrying that entry's paths
 *    constraint. A config entry with NO matching directory row contributes
 *    NOTHING — liveness records live on directory entries and this change
 *    deliberately never grows the catalog (documented fail-closed wart). */
export function pinnedEntryFor(cfg: LivenessConfig, entries: LivenessDirectoryRow[]): PinnedRow[] {
  if (cfg.allowlist === undefined) {
    const rows: PinnedRow[] = [];
    for (const e of entries) {
      if (e.source !== "seed") continue;
      const origin = entryOrigin(e.base_url);
      if (origin !== undefined) rows.push({ origin });
    }
    return rows;
  }
  const rows: PinnedRow[] = [];
  for (const cfgEntry of cfg.allowlist) {
    const origin = entryOrigin(cfgEntry.base_url);
    if (origin === undefined) continue;
    const matches = entries.some((e) => entryOrigin(e.base_url) === origin);
    if (!matches) continue; // config-only base_url: pinned nothing
    rows.push({
      origin,
      ...(cfgEntry.paths !== undefined ? { paths: [...cfgEntry.paths] } : {}),
    });
  }
  return rows;
}

/** Does ONE configured allowlist path pattern match a request pathname
 * (issue #36)? Exact literals keep exact string equality — no prefix
 * semantics. A pattern ending in a single trailing `*` is a PREFIX wildcard:
 * the prefix is everything before the `*`, and it matches any pathname under
 * that prefix with a NON-EMPTY remainder — so `/price/*` matches
 * `/price/DezX…` but never the bare prefix `/price` or the bare collection
 * route `/price/` (neither is a parametrized instance). A `*` anywhere other
 * than the final character is NOT a wildcard — the config validator rejects
 * those forms loudly; here they simply compare literally. Pure: no URL
 * parsing, same input ⇒ same output. */
export function pathMatches(pattern: string, pathname: string): boolean {
  if (pattern.endsWith("*") && !pattern.slice(0, -1).includes("*")) {
    const prefix = pattern.slice(0, -1);
    return pathname.startsWith(prefix) && pathname.length > prefix.length;
  }
  return pattern === pathname;
}

/** Is a target URL pinned by the pin set? Origin match; when the pinning row
 * carries `paths`, the URL's pathname must match one of the configured
 * patterns (L2): exact string equality for literals, or the trailing-`*`
 * prefix wildcard (`/price/*` matches `/price/<any-address>` — issue #36);
 * query strings never participate (only the pathname is compared). An
 * unparseable URL is pinned by nothing (fail closed). */
export function urlOnAllowlist(url: string, pinned: PinnedRow[]): boolean {
  let origin: string;
  let pathname: string;
  try {
    const u = new URL(url);
    origin = u.origin;
    pathname = u.pathname;
  } catch {
    return false;
  }
  for (const row of pinned) {
    if (row.origin !== origin) continue;
    if (row.paths === undefined) return true;
    if (row.paths.some((p) => pathMatches(p, pathname))) return true;
  }
  return false;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface LivenessVerdictArgs {
  url: string;
  /** The directory row for the URL's origin (findEntryForUrl), or undefined
   * when the target is NOT a catalog row — that distinction drives L3. */
  entry?: LivenessDirectoryRow;
  cfg: LivenessConfig;
  /** Injected clock (the pure module never reads Date.now itself). */
  nowMs: number;
}

/** The liveness verdict for a prospective payment target — L2 + L3 verbatim:
 *
 *  - require_fresh_402 false ⇒ ok UNCONDITIONALLY (the issue's escape hatch;
 *    the metadata fields still report the honest record).
 *  - Target IS a catalog row: pinned + fresh live_402 ⇒ ok; not pinned ⇒
 *    not ok ("catalog membership is not proof of liveness"); pinned but the
 *    record is missing / stale / no_402 / error ⇒ not ok.
 *  - Target is NOT a catalog row: allowlist ABSENT ⇒ the gate is inert (ok) —
 *    no catalog claim to falsify, services.unknown / caps govern as today;
 *    an EXPLICIT allowlist (including []) ⇒ strict mode, not ok ("not in the
 *    liveness allowlist").
 *
 * `reason` carries the exact message the engine emits for ENDPOINT_NOT_LIVE. */
export function livenessVerdict(args: LivenessVerdictArgs): EndpointLiveness {
  const { url, entry, cfg, nowMs } = args;
  const record = entry?.liveness;
  const status: EndpointLiveness["status"] = record?.status ?? "never_probed";
  const stale = isStale(record, cfg.max_age_seconds, nowMs);
  const host = hostOf(url);

  if (!cfg.require_fresh_402) {
    // Off-switch (L3): ok unconditionally. The metadata stays truthful so
    // x402_check_payment can still report what the record says.
    return {
      ok: true,
      status,
      stale,
      on_allowlist: entry !== undefined && urlOnAllowlist(url, pinnedEntryFor(cfg, [entry])),
    };
  }

  if (entry === undefined) {
    // Not a catalog row.
    if (cfg.allowlist === undefined) {
      // Omitted allowlist ⇒ inert: there is no catalog claim to falsify.
      return { ok: true, status, stale, on_allowlist: false };
    }
    return {
      ok: false,
      status,
      stale,
      on_allowlist: false,
      reason: `Endpoint ${host} is not in the liveness allowlist — an explicit liveness.allowlist is strict mode and refuses every unlisted host (fail-closed)`,
    };
  }

  const onAllowlist = urlOnAllowlist(url, pinnedEntryFor(cfg, [entry]));

  if (!onAllowlist) {
    return {
      ok: false,
      status,
      stale,
      on_allowlist: false,
      reason: `Endpoint ${host} is a directory row but is not pinned — catalog membership is not proof of liveness (pin it via liveness.allowlist, or as a seed entry when the allowlist is omitted)`,
    };
  }

  if (status !== "live_402") {
    const detail = status === "never_probed"
      ? "has never been probed (run x402_probe_allowlist)"
      : status === "no_402"
        ? "did not answer a payment challenge on its latest probe"
        : "failed its latest probe (network error or timeout)";
    return {
      ok: false,
      status,
      stale,
      on_allowlist: true,
      reason: `Endpoint ${host} is pinned but ${detail} — a fresh live 402 probe is required (fail-closed)`,
    };
  }

  if (stale) {
    return {
      ok: false,
      status,
      stale,
      on_allowlist: true,
      reason: `Endpoint ${host} was last probed live at ${record?.probed_at ?? "unknown"}, older than liveness.max_age_seconds (${cfg.max_age_seconds}s) — refresh it with x402_probe_allowlist (fail-closed)`,
    };
  }

  return { ok: true, status, stale, on_allowlist: true };
}
