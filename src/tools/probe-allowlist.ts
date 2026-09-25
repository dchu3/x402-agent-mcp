// Issue #34 (L5) — x402_probe_allowlist: the liveness REFRESH probe.
//
// Probes the pin set (L2): the directory's seed rows when liveness.allowlist
// is omitted, else the directory rows whose origin the explicit allowlist
// names. Concurrency is capped at 4; each probe has a 10 s timeout with
// redirect: "error"; nothing is ever paid and no credentials are ever sent —
// this tool imports NO wallet/payment code (the no-bypass suite pins that).
//
// Issue #38 — each row is probed across a BOUNDED candidate URL list, in this
// exact precedence order (P1): (1) the allowlist entry's configured `paths`
// when present — operator intent, exhaustive, NO discovery; (2) the directory
// row's advertised endpoints[] paths whose method is GET (or absent), with
// `{param}`/`*` placeholders substituted ONLY in the built request URL (P3);
// (3) the row's base_url itself; (4) up to 8 noise-filtered GET paths
// discovered from the row's /openapi.json (P2 — the discovery fallback that
// fixes the live "free root, paid API path" shape). Candidates are
// de-duplicated by exact string equality and the walk is capped at 5 URLs per
// row (P4), so worst case per row is 5 probes + 1 spec GET. The FIRST
// live_402 wins and its exact URL is the record's probe_url; else no_402 when
// any candidate answered; else error (P5). Root-only services are unaffected.
//
// Every result is recorded on the directory entry through recordLiveness
// (atomic write over livePaths(), the addToDirectory path — the
// X402_DIRECTORY_PATH override is consulted first). Timeout/network failure
// records status "error" (never live). x402_search ranks by these records and
// policy rule 4.7 (ENDPOINT_NOT_LIVE) refuses payment off the pin set; the
// operator's refresh cadence is their scheduler (e.g. cron) — there is no
// background probing inside the MCP.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadDirectory, recordLiveness } from "../directory.js";
import type { EndpointEntry, LivenessRecord } from "../directory.js";
import { probeChallengeAcross, fetchJson, openApiProbePaths, probePlaceholderUrl } from "./probe-utils.js";
import type { LivenessProbeResult } from "./probe-utils.js";
import { loadPolicyConfig } from "../policy/config.js";
import { entryOrigin, pinnedEntryFor } from "../policy/liveness.js";
import type { LivenessAllowlistEntry } from "../policy/types.js";

/** Per-probe timeout (L5): 10 s, matching the module's other probe helpers. */
const PROBE_TIMEOUT_MS = 10000;
/** Bounded concurrency (L5): at most 4 probes in flight. */
const CONCURRENCY_CAP = 4;
/** The accepts snapshot caps (L5): at most 8 entries, 200 chars per field. */
const ACCEPTS_MAX_ENTRIES = 8;
const ACCEPTS_FIELD_MAX = 200;

/** The accepts snapshot for a live_402 challenge (L4): present ONLY on a 402
 * with a parseable accepts array — never invented on no_402/error. */
function acceptsSnapshot(challenge: any): LivenessRecord["accepts"] | undefined {
  if (!challenge || typeof challenge !== "object") return undefined;
  const accepts = challenge.accepts ?? challenge.accept;
  if (!Array.isArray(accepts)) return undefined;
  return accepts.slice(0, ACCEPTS_MAX_ENTRIES).map((a: any) => {
    const out: { scheme?: string; network?: string; amount?: string; payTo?: string; asset?: string } = {};
    for (const key of ["scheme", "network", "amount", "payTo", "asset"] as const) {
      if (typeof a?.[key] === "string") out[key] = a[key].slice(0, ACCEPTS_FIELD_MAX);
    }
    return out;
  });
}

/** Bounded candidate walk per row (issue #38, P4): at most this many
 * de-duplicated URLs are probed per row — bounded work, bounded latency. */
const MAX_PROBE_CANDIDATES = 5;
/** Discovery cap (issue #38, P2): at most this many GET paths are taken from
 * one /openapi.json spec after the noise filter. */
const MAX_DISCOVERY_PATHS = 8;

/** Build the candidate URL list for one row (issue #38, P1 precedence):
 * (1) an allowlist entry's configured `paths`, when present — operator intent,
 *     EXHAUSTIVE, no discovery (fact 7); placeholders are substituted ONLY
 *     here, when building the request URL (P3) — the configured string itself
 *     is never mutated;
 * (2) the directory row's advertised endpoints[] paths whose method is GET or
 *     absent, placeholders substituted (P3);
 * (3) the row's base_url itself;
 * (4) up to MAX_DISCOVERY_PATHS noise-filtered GET paths from the row's
 *     /openapi.json (P2) — fetched once per row via the shared fetchJson.
 * The unconfigured list is exact-string de-duplicated and capped at
 * MAX_PROBE_CANDIDATES (P4). Never throws. */
async function candidateUrls(origin: string, entry: EndpointEntry, cfgEntry?: LivenessAllowlistEntry): Promise<string[]> {
  if (cfgEntry?.paths !== undefined && cfgEntry.paths.length > 0) {
    return cfgEntry.paths.map((p) => probePlaceholderUrl(`${origin}${p}`));
  }
  const candidates: string[] = [];
  for (const ep of entry.endpoints ?? []) {
    if (typeof ep?.path !== "string" || ep.path === "") continue;
    const method = typeof ep.method === "string" && ep.method !== "" ? ep.method.toUpperCase() : "GET";
    if (method !== "GET") continue;
    const path = ep.path.startsWith("/") ? ep.path : `/${ep.path}`;
    candidates.push(probePlaceholderUrl(`${origin}${path}`));
  }
  candidates.push(entry.base_url);
  const spec = await fetchJson(`${entry.base_url}/openapi.json`, PROBE_TIMEOUT_MS);
  for (const p of openApiProbePaths(spec, MAX_DISCOVERY_PATHS)) {
    const path = p.startsWith("/") ? p : `/${p}`;
    candidates.push(probePlaceholderUrl(`${origin}${path}`));
  }
  return [...new Set(candidates)].slice(0, MAX_PROBE_CANDIDATES);
}

/** Probe an entry across its bounded candidate list (issue #38): first
 * live_402 wins and its exact URL is the record's probe_url; else no_402 when
 * at least one candidate answered; else error. Never throws. */
async function probeEntry(origin: string, entry: EndpointEntry, cfgEntry?: LivenessAllowlistEntry): Promise<{ result: LivenessProbeResult; probe_url: string }> {
  const urls = await candidateUrls(origin, entry, cfgEntry);
  return await probeChallengeAcross(urls, PROBE_TIMEOUT_MS, Math.max(1, urls.length));
}

/** Promise pool: apply fn to items with at most `limit` in flight. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export interface ProbeAllowlistSummaryRow {
  /** The directory entry's base_url. */
  url: string;
  /** The exact URL probed (base_url, or the pinned allowlist path). */
  probe_url: string;
  status: "live_402" | "no_402" | "error";
  latency_ms: number;
  probed_at: string;
  error?: string;
  /** Whether the record landed on the directory entry (false only when no
   * entry matched at write time). */
  recorded: boolean;
}

export function registerProbeAllowlistTool(server: McpServer): void {
  server.tool(
    "x402_probe_allowlist",
    "Refresh the liveness probes for the pinned endpoint set (issue #34): the directory's seed rows when liveness.allowlist is omitted, else the allowlisted origins. Never pays, never follows redirects, never sends credentials; each result is recorded atomically on its directory entry and drives x402_search ranking and the ENDPOINT_NOT_LIVE payment gate. Run it on your own schedule (cron) — x402_search itself never probes.",
    {},
    async () => {
      const { config, configErrors } = loadPolicyConfig();
      const livenessCfg = config.liveness;
      const dir = loadDirectory();
      const explicit = livenessCfg.allowlist !== undefined;
      const pinned = pinnedEntryFor(livenessCfg, dir.endpoints);

      // The rows to refresh: directory entries whose ORIGIN the pin set names.
      const rows = dir.endpoints.filter((entry) => {
        const origin = entryOrigin(entry.base_url);
        return origin !== undefined && pinned.some((r) => r.origin === origin);
      });

      const summaries = await mapWithConcurrency(rows, CONCURRENCY_CAP, async (entry): Promise<ProbeAllowlistSummaryRow> => {
        const origin = entryOrigin(entry.base_url)!; // rows are pre-filtered on a parseable origin
        // In explicit mode the allowlist entry (with its paths) drives which
        // URLs are probed (L2); first matching config entry wins.
        const cfgEntry = explicit
          ? livenessCfg.allowlist!.find((a) => entryOrigin(a.base_url) === origin)
          : undefined;
        const { result, probe_url } = await probeEntry(origin, entry, cfgEntry);
        const record: LivenessRecord = {
          probed_at: new Date().toISOString(),
          status: result.kind,
          latency_ms: result.latency_ms,
          probe_url,
          ...(result.kind === "live_402" ? (() => {
            const snap = acceptsSnapshot(result.challenge);
            return snap !== undefined ? { accepts: snap } : {};
          })() : {}),
        };
        const recorded = recordLiveness(entry.base_url, record);
        const row: ProbeAllowlistSummaryRow = {
          url: entry.base_url,
          probe_url,
          status: result.kind,
          latency_ms: result.latency_ms,
          probed_at: record.probed_at,
          recorded,
        };
        if (result.kind === "error") row.error = result.error ?? "unknown probe error";
        return row;
      });

      const summary = {
        mode: explicit ? "explicit" : "seed",
        config_valid: configErrors.length === 0,
        probed: summaries.length,
        live_total: summaries.filter((s) => s.status === "live_402").length,
        results: summaries,
        note: summaries.length === 0
          ? "No pinned directory rows to probe (empty directory, or an explicit allowlist matching no rows — the pin set is empty)."
          : "Liveness records updated. x402_search ranks by these records; the payment gate (ENDPOINT_NOT_LIVE) refuses endpoints off the pin set or with a stale/failed record.",
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    }
  );
}
