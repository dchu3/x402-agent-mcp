// Issue #30 — price anomaly detection: the pure half of rule 4.6.
//
// This module is part of the pure policy core: it imports types only and does
// NO I/O, NO env reads, NO clock access — same input ⇒ same output, always
// (same discipline as src/policy/engine.ts). The I/O side — rehydrating the
// per-service settled-amount baseline from the payment ledger and seeding it
// from the advertised directory price — lives in src/policy/anomaly-store.ts
// and is passed INTO the engine as AnomalyInputs; the engine never fetches a
// baseline or a price itself.

import type { AnomalyConfig } from "./types.js";

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