// Issue #30 — per-service settled-amount baselines for rule 4.6, extending the
// PR #21 payment ledger (no parallel state files): the ledger
// x402-payments.jsonl is the single source of truth. Conventions deliberately
// mirror src/policy/budget-store.ts:
//
// - LEDGER location captured at module load through src/ledger-path.ts (tests
//   use fresh query-busted imports with the env preset).
// - Rehydration is byte-mark based: rows of the ledger beyond the mark are
//   integrated exactly once, corrupted ledger lines are skipped — logging is
//   best-effort, so is reading it back.
// - hostnameOf() lowercased-host helper; unparseable ledger URLs excluded.
//
// Scope rule (symmetric with the USD ledger stores): Casper entries are
// excluded everywhere — Casper settles in wCSPR motes, its spend authority
// stays casper/budget.ts (fail-closed, untouched), and rule 4.6 is inert on
// the mote-denominated leg anyway (conflict A).
//
// Baselines are NOT day-scoped (deliberate): the window is the last N settled
// amounts for the host, not today's — a service priced ~$0.01 every day is
// still anomalous at $1 the next day. The byte-mark rehydration has no day
// boundary either.
//
// Seeding (seedFromDirectory): when a host has NO settled baseline yet, the
// advertised directory price seeds a one-sample baseline that is RETURNED to
// the caller but NOT stored — rehydration parity stays exact (a restart
// rebuilds from the ledger alone; the seed re-derives deterministically on the
// next read while the host remains unsettled). The first settled amount then
// becomes the first real sample (the store seeds from the first settled
// amount when no directory price exists — graceful fallback).
//
// Read gating: getAnomalyInputs returns {} while anomaly.enabled is false (the
// compat default) — no rehydration, no directory work at all. recordSettled-
// Amount stays ungated on purpose: the ledger (and therefore the baseline)
// must stay consistent with what logPayment already wrote, so a later opt-in
// rehydrates the full history (the ledger is the source of truth).

import { existsSync, readFileSync } from "fs";
import { loadPolicyConfig } from "./config.js";
import { emptyBaseline, updateBaseline } from "./anomaly.js";
import { advertisedPriceUsd } from "../directory.js";
// Issue #54 (req 3): the ledger path resolver shared by every ledger reader
// (see the capture comment below).
import { resolveLedger } from "../ledger-path.js";
import type { AnomalyInputs, PriceBaseline } from "./types.js";

const LEDGER = resolveLedger();
// Issue #54: the primary ledger (writes land here) and the optional read-only
// legacy working-directory ledger (read once; an upgrade must never reset
// today's baselines to 0). Captured once at module load, mirroring the
// pre-#54 capture-at-load semantics.
const LEDGER_PRIMARY = LEDGER.primary;
const LEDGER_LEGACY = LEDGER.legacyReadOnly;

/** Has the legacy ledger been integrated (it is read-only and never grows,
 * so one integration is forever valid)? */
let legacyIntegrated = false;

/** Per-host settled-amount baselines (lowercased hostname → last-N amounts). */
const baselines = new Map<string, PriceBaseline>();

/** Bytes of the primary ledger already integrated into `baselines` — either by
 * a rehydration read or by a recordSettledAmount call whose own ledger row
 * (logPayment writes it right before that call — same #45 guard) the read
 * itself integrated. Rehydration reads only bytes beyond this mark, so a
 * fresh process rebuilds the whole history from the ledger (restart parity)
 * while a running process NEVER re-counts the rows its own settlements
 * flushed (the #53 body-shape matrix caught the once-flag variant
 * double-counting a process's first settlement when nothing had read the
 * ledger before the read happened). A replaced/rolled-over ledger (shorter
 * than the mark) re-reads whole. */
let integratedBytes = 0;

/** Integrate ledger rows beyond the mark into `baselines`. Returns the LAST
 * row it integrated, or null when nothing new was read — recordSettledAmount
 * uses it to recognise the row of its own settlement (flushed by logPayment
 * immediately before the call) and skip re-adding it. */
function rehydrateFromLedger(window: number): { url: string; amount: number } | null {
  // Issue #54: the legacy working-directory ledger is integrated exactly once
  // (it is read-only and never grows, so once is forever). It comes first so
  // the integration order stays chronological (legacy → primary).
  let last = integrateLegacyOnce(window);
  if (!existsSync(LEDGER_PRIMARY)) return last;
  try {
    const buf = readFileSync(LEDGER_PRIMARY);
    if (buf.length === integratedBytes) return last; // nothing new on disk (legacy may have had rows)
    const start = integratedBytes <= buf.length ? integratedBytes : 0; // replaced ⇒ re-read whole
    const text = buf.subarray(start).toString("utf-8"); // start is a line boundary
    for (const line of text.split("\n")) {
      try {
        const e = JSON.parse(line) as { status?: string; chain?: string; url?: string; amount_usdc?: number };
        if (e.status === "success" && e.chain !== "casper" && typeof e.url === "string") {
          const amount = e.amount_usdc;
          // Same filter as recordSettledAmount (below): rehydration must
          // rebuild exactly the values the writer produced — rehydration parity.
          if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) continue;
          const host = hostnameOf(e.url);
          if (host !== null) {
            baselines.set(host, updateBaseline(baselines.get(host) ?? emptyBaseline(), amount, window));
            last = { url: e.url, amount };
          }
        }
      } catch {
        // Corrupted ledger lines are skipped — logging is best-effort, so is
        // reading it back; a mid-line slice at the rehydration boundary is
        // skipped harmlessly (these bytes were already integrated).
      }
    }
    // The read window closes at the BYTE level: every byte seen — including
    // skipped/corrupted lines and the final (empty) split piece — is now
    // integrated exactly once. Counting the newline bytes per piece instead
    // mis-counted the terminator of the final split piece by one, pushing the
    // mark past the file and making every next read start over at 0 — each
    // read re-integrating the whole history again (observed as quadratic
    // sample growth in the #57 fetch tests).
    integratedBytes = buf.length;
    return last;
  } catch (err) {
    console.error(`[x402] Failed to rehydrate price baselines from ledger: ${err}`);
    return null;
  }
}

/** Integrate the read-only legacy working-directory ledger exactly once,
 * with the same row filter as the primary stream. Returns the last row it
 * integrated (may be a legacy row — the recordSettledAmount owner-row skip
 * stays safe: logPayment's row for the very settlement being recorded is
 * beyond the primary mark and always integrated by the primary read). */
function integrateLegacyOnce(window: number): { url: string; amount: number } | null {
  if (legacyIntegrated || LEDGER_LEGACY === undefined) return null;
  legacyIntegrated = true; // set before I/O — read-once even if the read throws
  if (!existsSync(LEDGER_LEGACY)) return null;
  let last: { url: string; amount: number } | null = null;
  try {
    for (const line of readFileSync(LEDGER_LEGACY, "utf-8").split("\n")) {
      try {
        const e = JSON.parse(line) as { status?: string; chain?: string; url?: string; amount_usdc?: number };
        if (e.status === "success" && e.chain !== "casper" && typeof e.url === "string") {
          const amount = e.amount_usdc;
          if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) continue;
          const host = hostnameOf(e.url);
          if (host !== null) {
            baselines.set(host, updateBaseline(baselines.get(host) ?? emptyBaseline(), amount, window));
            last = { url: e.url, amount };
          }
        }
      } catch {
        // Corrupted legacy lines are skipped — same rule as the primary stream.
      }
    }
  } catch (err) {
    console.error(`[x402] Failed to read legacy ledger ${LEDGER_LEGACY}: ${err}`);
  }
  return last;
}

/** Lowercased hostname of a URL, or null when unparseable (such entries are
 * excluded from baseline accounting — there is no service to baseline). */
function hostnameOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/** The effective anomaly block (file-loaded, no env override). A config with
 * errors resolves to the fail-closed disabled default — harmless: payments
 * are disabled then anyway. */
function effectiveAnomaly() {
  return loadPolicyConfig().config.anomaly;
}

/** Caller-supplied inputs for rule 4.6 (issue #30). Returns {} while the
 * anomaly gate is disabled (the compat default — no baseline work at all);
 * otherwise rehydrates once from the ledger and returns the host's baseline,
 * seeding a NOT-STORED one-sample baseline from the advertised directory
 * price when seedFromDirectory is on and the host has never settled. */
export function getAnomalyInputs(url: string): AnomalyInputs {
  const anomaly = effectiveAnomaly();
  if (!anomaly.enabled) return {};
  const host = hostnameOf(url);
  if (host === null) return {};
  rehydrateFromLedger(anomaly.window);
  const stored = baselines.get(host);
  const baseline = stored ? { samples: [...stored.samples], mean: stored.mean, stdev: stored.stdev } : emptyBaseline();
  if (baseline.samples.length === 0 && anomaly.seedFromDirectory) {
    const price = advertisedPriceUsd(url);
    if (price !== undefined && Number.isFinite(price) && price > 0) {
      // Seed from the advertised price as a first comparison point; the seed
      // is derived per call, never stored (see the module header).
      return { baseline: updateBaseline(baseline, price, anomaly.window), directoryPriceUsd: price };
    }
  }
  return { baseline };
}

/** Record a settled USD amount against its service host, in memory. The ONLY
 * writer of baselines. Call this right next to recordServicePayment, inside
 * the same successful-settlement guard as logPayment (resp.status === 200) so
 * a denied spike can never poison the baseline and rehydration stays at
 * parity. Non-finite/<=0 amounts are ignored. Not gated on anomaly.enabled:
 * the ledger already carries the entry, so a later opt-in rehydrates it. */
export function recordSettledAmount(url: string, amountUsdc: number): void {
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) return;
  const host = hostnameOf(url);
  if (host === null) return;
  const window = effectiveAnomaly().window;
  // Integrate rows newer than the mark first: a fresh process picks up its
  // full here — INCLUDING the row of this very settlement (logPayment flushed
  // it right before this call), whose (url, amount) match identifies it, so
  // the in-memory add below is skipped for it and the baseline never
  // double-counts.
  const lastIntegrated = rehydrateFromLedger(window);
  const justIntegratedOwnRow = lastIntegrated !== null
    && lastIntegrated.url === url
    && lastIntegrated.amount === amountUsdc;
  if (!justIntegratedOwnRow) {
    baselines.set(host, updateBaseline(baselines.get(host) ?? emptyBaseline(), amountUsdc, window));
  }
}

/** The stored baseline for one host (case-insensitive) — rehydrating first.
 * Returns a defensive copy, or undefined when the host has no baseline.
 * Exported for tests. */
export function getBaseline(host: string): PriceBaseline | undefined {
  rehydrateFromLedger(effectiveAnomaly().window);
  const b = baselines.get((host || "").toLowerCase());
  return b ? { samples: [...b.samples], mean: b.mean, stdev: b.stdev } : undefined;
}