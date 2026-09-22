// Issue #30 — per-service settled-amount baselines for rule 4.6, extending the
// PR #21 payment ledger (no parallel state files): the ledger
// x402-payments.jsonl is the single source of truth. Conventions deliberately
// mirror src/policy/budget-store.ts:
//
// - PAYMENT_LOG_PATH captured at module load (tests use fresh query-busted
//   imports with the env preset).
// - Lazy one-shot rehydration with the flag set before any I/O — never a
//   double-read, even if the read throws. Corrupted ledger lines are skipped —
//   logging is best-effort, so is reading it back.
// - hostnameOf() lowercased-host helper; unparseable ledger URLs excluded.
//
// Scope rule (symmetric with the USD ledger stores): Casper entries are
// excluded everywhere — Casper settles in wCSPR motes, its spend authority
// stays casper/budget.ts (fail-closed, untouched), and rule 4.6 is inert on
// the mote-denominated leg anyway (conflict A).
//
// Baselines are NOT day-scoped (deliberate): the window is the last N settled
// amounts for the host, not today's — a service priced ~$0.01 every day is
// still anomalous at $1 the next day. The one-shot rehydration therefore also
// has no day boundary.
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
import type { AnomalyInputs, PriceBaseline } from "./types.js";

const PAYMENT_LOG_PATH = process.env.PAYMENT_LOG_PATH || "./x402-payments.jsonl";

/** Per-host settled-amount baselines (lowercased hostname → last-N amounts). */
const baselines = new Map<string, PriceBaseline>();

let rehydrated = false;

function rehydrateFromLedger(window: number): void {
  if (rehydrated) return;
  rehydrated = true; // set before any I/O — never double-read, even if read throws
  if (!existsSync(PAYMENT_LOG_PATH)) return;
  try {
    for (const line of readFileSync(PAYMENT_LOG_PATH, "utf-8").split("\n")) {
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
          }
        }
      } catch {
        // Corrupted ledger lines are skipped — logging is best-effort, so is reading it back
      }
    }
  } catch (err) {
    console.error(`[x402] Failed to rehydrate price baselines from ledger: ${err}`);
  }
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
  rehydrateFromLedger(window);
  baselines.set(host, updateBaseline(baselines.get(host) ?? emptyBaseline(), amountUsdc, window));
}

/** The stored baseline for one host (case-insensitive) — rehydrating first.
 * Returns a defensive copy, or undefined when the host has no baseline.
 * Exported for tests. */
export function getBaseline(host: string): PriceBaseline | undefined {
  rehydrateFromLedger(effectiveAnomaly().window);
  const b = baselines.get((host || "").toLowerCase());
  return b ? { samples: [...b.samples], mean: b.mean, stdev: b.stdev } : undefined;
}