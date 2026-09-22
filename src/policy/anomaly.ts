// Issue #30 — price anomaly detection: the pure half of rule 4.6.
//
// This module is part of the pure policy core: it imports types only and does
// NO I/O, NO env reads, NO clock access — same input ⇒ same output, always
// (same discipline as src/policy/engine.ts). The I/O side — rehydrating the
// per-service settled-amount baseline from the payment ledger and seeding it
// from the advertised directory price — lives in src/policy/anomaly-store.ts
// and is passed INTO the engine as AnomalyInputs; the engine never fetches a
// baseline or a price itself.
//
// Rule 4.6 bands (the band decides routing — see engine.ts):
//   "none"     — within tolerance (or the rule is inert); no reason emitted.
//   "seed"     — no baseline yet: allow, never annotated (the first call is
//                never flagged; seeding happens in the store, not here).
//   "approval" — middle band: PRICE_ANOMALY + APPROVAL_REQUIRED (conflict D:
//                a thin/zero-variance baseline can ONLY reach this band).
//   "deny"     — high band (or a non-positive amount on a USD chain): a hard
//                deny via the engine's local hardDeny flag, NOT via DENY_CODES
//                (conflict C).
// Casper is inert everywhere (conflict A): the mote-denominated leg passes
// amount 0 by design and its spend authority stays casper/budget.ts.

import type { AnomalyBand, AnomalyConfig, AnomalyInputs, PolicyReason, PriceBaseline } from "./types.js";

/** The documented default `anomaly` block — also the behavior-compat default:
 * `enabled: false`, so the rule is inert until an operator opts in (conflict B
 * of the issue's conflict resolutions). The unchanged pre-existing test suite
 * is the compat proof. Both src/policy/config.ts defaults (compat + fail-
 * closed) copy this object; never alias it. */
export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  enabled: false,
  window: 20,
  warnZ: 2.0,
  denyZ: 3.0,
  minSamples: 5,
  seedFromDirectory: true,
  defaultTolerance: 2.0,
};

/** A pristine, empty baseline (no settled amounts yet). */
export function emptyBaseline(): PriceBaseline {
  return { samples: [], mean: 0, stdev: 0 };
}

/** Population standard deviation; 0 below two samples (a single observation
 * carries no variance information — the caller then takes the multiplier path). */
function populationStdev(samples: number[], mean: number): number {
  if (samples.length < 2) return 0;
  const variance = samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / samples.length;
  return Math.sqrt(variance);
}

/** Append a settled amount to a baseline and recompute mean/stdev over the
 * last `window` samples (oldest dropped). PURE: never mutates its argument —
 * every path returns a fresh object. Non-finite and negative amounts are
 * ignored (a settled amount cannot be negative; garbage must not poison the
 * baseline). */
export function updateBaseline(baseline: PriceBaseline, settledAmount: number, window: number = DEFAULT_ANOMALY_CONFIG.window): PriceBaseline {
  if (!Number.isFinite(settledAmount) || settledAmount < 0) {
    return { samples: [...baseline.samples], mean: baseline.mean, stdev: baseline.stdev };
  }
  const w = Number.isFinite(window) && window >= 1 ? Math.floor(window) : DEFAULT_ANOMALY_CONFIG.window;
  const appended = [...baseline.samples, settledAmount];
  const samples = appended.length > w ? appended.slice(appended.length - w) : appended;
  const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
  return { samples, mean, stdev: populationStdev(samples, mean) };
}

/** Compact numeric rendering for human-readable messages only — the machine
 * payload (detail) always carries the exact values. */
function r(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(4)) : n;
}

/** Evaluate rule 4.6 for one prospective payment. `cfg` is the validated
 * anomaly block, `chain`/`host`/`amount` come from the PolicyContext, and
 * `inputs` carries the caller-supplied baseline (+ optional directory price).
 * Returns the band and, when the payment is annotated, the PRICE_ANOMALY
 * reason (code + message + detail). Never throws; never touches the inputs. */
export function evaluatePriceAnomaly(
  cfg: AnomalyConfig,
  chain: string,
  host: string,
  amount: number,
  inputs: AnomalyInputs = {},
): { band: AnomalyBand; reason?: PolicyReason } {
  // 1. The rule is opt-in: disabled (the compat default) ⇒ inert, always.
  if (!cfg.enabled) return { band: "none" };
  // 2. The Casper leg is inert (conflict A): amounts are mote-denominated
  // (amount 0 by design at the gate) and casper/budget.ts is its spend
  // authority — the same scope rule the USD-ledger stores document.
  if (chain === "casper") return { band: "none" };
  // 3. A non-positive or non-finite amount on a USD chain fails closed.
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      band: "deny",
      reason: {
        code: "PRICE_ANOMALY",
        message: `Payment amount ${amount} to ${host} is not a positive finite number — the price anomaly gate fails closed (rule 4.6)`,
        detail: { reason: "non-positive-amount", amount, host },
      },
    };
  }
  // 4. No baseline yet ⇒ the seed band: allow, and no reason is emitted — the
  // first call for a host is never annotated (nothing to compare against).
  const baseline = inputs.baseline;
  if (!baseline || baseline.samples.length === 0) return { band: "seed" };

  const samples = baseline.samples;
  const mean = baseline.mean;
  const stdev = baseline.stdev;
  const stats = { mean, stdev, samples: samples.length, window: cfg.window, amount, host };

  // 5. Thin or zero-variance baseline ⇒ the multiplier path against a
  // reference price. Statistics are the evidence for a hard deny; a stub
  // baseline is not evidence — so this path can only reach the approval band
  // (conflict D: 1–2 samples yield stdev 0 ⇒ z = ∞ ⇒ everything would deny).
  if (samples.length < cfg.minSamples || stdev === 0) {
    const reference = mean > 0 ? mean : inputs.directoryPriceUsd;
    if (reference !== undefined && Number.isFinite(reference) && reference > 0 && amount > reference * cfg.defaultTolerance) {
      const ratio = amount / reference;
      return {
        band: "approval",
        reason: {
          code: "PRICE_ANOMALY",
          message: `Payment $${r(amount)} to ${host} is ${r(ratio)}x the reference price $${r(reference)} (baseline mean $${r(mean)}, stdev $${r(stdev)} over ${samples.length} samples, window ${cfg.window}) — human confirmation required before paying (rule 4.6)`,
          detail: { ratio, mean, stdev, samples: samples.length, window: cfg.window, band: "approval", amount, host },
        },
      };
    }
    return { band: "none" };
  }

  // 6. Z-score path against the settled baseline.
  const zScore = (amount - mean) / stdev;
  if (zScore < cfg.warnZ) return { band: "none" };
  const shared = { mean, stdev, samples: samples.length, window: cfg.window, amount, host };
  if (zScore < cfg.denyZ) {
    return {
      band: "approval",
      reason: {
        code: "PRICE_ANOMALY",
        message: `Payment $${r(amount)} to ${host} is a price anomaly: z=${r(zScore)} vs baseline mean $${r(mean)}, stdev $${r(stdev)} over ${samples.length} samples (window ${cfg.window}) — human confirmation required before paying (rule 4.6)`,
        detail: { zScore, ...shared, band: "approval" },
      },
    };
  }
  return {
    band: "deny",
    reason: {
      code: "PRICE_ANOMALY",
      message: `Payment $${r(amount)} to ${host} is a severe price anomaly: z=${r(zScore)} vs baseline mean $${r(mean)}, stdev $${r(stdev)} over ${samples.length} samples (window ${cfg.window}) — payment denied (rule 4.6)`,
      detail: { zScore, ...shared, band: "deny" },
    },
  };
}