import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadDirectory } from "../directory.js";
import type { EndpointEntry } from "../directory.js";
import { loadPolicyConfig } from "../policy/config.js";
import { entryOrigin, isStale, pinnedEntryFor } from "../policy/liveness.js";
import type { PinnedRow } from "../policy/liveness.js";

// Issue #34 — liveness-ranked discovery. x402_search no longer treats every
// directory row as live: rows are ranked by their recorded last-successful-402
// probe, carry a per-row `liveness` block and a `live` flag, and UNPINNED rows
// (L2 pin set: seed rows when liveness.allowlist is omitted, else the
// allowlisted origins) are withheld by default (catalog membership is not
// proof of liveness) — pass include_unverified: true to see them anyway.
// This tool performs ZERO network calls (tripwire-tested): probing happens in
// x402_probe_allowlist, never here.

/** Per-row liveness view for search emission (issue #34, L4): entry-level,
 * exactly as the issue specifies. A missing record reports
 * { status: "never_probed", probed_at: null, stale: true }. */
export function rowLiveness(
  entry: EndpointEntry,
  pinned: PinnedRow[],
  maxAgeSeconds: number,
  nowMs: number,
): { pinned: boolean; live: boolean; liveness: { status: string; probed_at: string | null; stale: boolean } } {
  const origin = entryOrigin(entry.base_url);
  const isPinned = origin !== undefined && pinned.some((r) => r.origin === origin);
  const record = entry.liveness;
  const stale = isStale(record, maxAgeSeconds, nowMs);
  const live = isPinned && record?.status === "live_402" && !stale;
  return {
    pinned: isPinned,
    live,
    liveness: record === undefined
      ? { status: "never_probed", probed_at: null, stale: true }
      : { status: record.status, probed_at: record.probed_at, stale },
  };
}

export function registerSearchTool(server: McpServer): void {
  server.tool(
    "x402_search",
    "Search for x402 endpoints by keyword, category, or chain. Returns matching services with descriptions, prices, URLs, and their liveness verdict — ranked live-first (fresh 402 probes before stale/unprobed). Unpinned rows are withheld by default (directory membership is not proof of liveness, issue #34); pass include_unverified: true to include them. Never performs any network call — refresh liveness with x402_probe_allowlist.",
    {
      query: z.string().optional().describe("Search keyword (matches name, description, tags)"),
      category: z.string().optional().describe("Filter by category: analysis, search, social, news, travel, ai, media, blockchain, multi"),
      chain: z.string().optional().describe("Filter by chain: base, solana, casper, polygon, arbitrum"),
      include_unverified: z.boolean().optional().describe("Include rows that are NOT on the liveness pin set (withheld by default — unpinned rows are never live)"),
    },
    async (args) => {
      const dir = loadDirectory();
      // The pin set comes from the SAME liveness config the payment gate uses
      // (L2). A fail-closed config state carries allowlist: [] — strict mode,
      // nothing pinned, nothing live.
      const livenessCfg = loadPolicyConfig().config.liveness;
      const nowMs = Date.now();
      const pinned = pinnedEntryFor(livenessCfg, dir.endpoints);

      let results = dir.endpoints;

      if (args.category) {
        results = results.filter((e) => e.category === args.category);
      }
      if (args.chain) {
        results = results.filter((e) => e.chain === args.chain);
      }
      if (args.query) {
        const q = args.query.toLowerCase();
        results = results.filter(
          (e) =>
            e.name.toLowerCase().includes(q) ||
            e.description.toLowerCase().includes(q) ||
            e.tags.some((t) => t.toLowerCase().includes(q))
        );
      }

      // Annotate, then withhold unpinned rows unless explicitly requested.
      const annotated = results.map((entry) => ({ entry, ...rowLiveness(entry, pinned, livenessCfg.max_age_seconds, nowMs) }));
      const included = args.include_unverified === true ? annotated : annotated.filter((a) => a.pinned);

      // Rank: fresh live_402 first (newest probed_at first), then rows with a
      // record that is stale / no_402 / error, then never-probed. Stable
      // within tiers (directory order preserved). Ties in tier 0 resolve on
      // the ISO timestamp string (chronological == lexicographic for ISO).
      const ranked = [...included].sort((a, b) => {
        const tier = (x: typeof a) => (x.live ? 0 : x.entry.liveness ? 1 : 2);
        const ta = tier(a);
        const tb = tier(b);
        if (ta !== tb) return ta - tb;
        if (ta === 0) return (b.entry.liveness?.probed_at ?? "").localeCompare(a.entry.liveness?.probed_at ?? "");
        return 0;
      });

      const summary = {
        query: args.query || "all",
        category: args.category || "all",
        chain: args.chain || "all",
        results: ranked.map((a) => ({
          name: a.entry.name,
          description: a.entry.description,
          base_url: a.entry.base_url,
          chain: a.entry.chain,
          category: a.entry.category,
          tags: a.entry.tags,
          endpoint_count: a.entry.endpoints.length,
          endpoints: a.entry.endpoints.length > 0 ? a.entry.endpoints : undefined,
          live: a.live,
          liveness: a.liveness,
        })),
        total: ranked.length,
        live_total: ranked.filter((a) => a.live).length,
        unverified_withheld: annotated.length - included.length,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    }
  );
}
