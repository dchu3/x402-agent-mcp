// Issue #54 (req 1) — the reserve-before-sign registry: overlapping tool
// calls must not each pass the same remaining budget while one is still
// being paid. A call holds a reservation (the signed candidate amount)
// between the cap checks and the ledger write; the hold is converted into
// ledger accounting via settleReservation() once the payment is signed, or
// freed via releaseReservation() on every path that never signed.
//
// RACE MODEL: Node runs callbacks on a single thread, so the check+insert
// pair inside reserveSpend() is atomic with respect to every other callback —
// overlapping tool calls can only interleave at await/yield boundaries, and
// none occur inside reserveSpend(). No locks are needed for the stdio,
// single-process MCP deployment this server targets. (The reservation tests
// interleave deliberately by awaiting between reserves, exactly as
// overlapping tool calls do.)
//
// Scope rule: the 'global' scope always participates (the daily cap is
// global), plus the requested extra scopes ('service:<host>' from fetch.ts)
// so per-service context can observe outstanding holds. Holds are
// process-local by design: a mid-payment restart frees the hold — the
// over-count direction that would hide spend is a restart-parity concern of
// ledger rehydration, not of this registry.
//
// Caps come from MAX_DAILY_SPEND / MAX_PAYMENT_PER_CALL read LIVE per call
// (never cached at module load), exactly like checkSpendingLimit.

import { getDailySpent, getMaxDailySpend, getMaxPerCall } from "./payment-utils.js";

export interface ReservationInput {
  amountUsd: number;
  /** Extra scopes besides the always-on 'global' scope (e.g. 'service:host'). */
  scopes?: string[];
}

export type ReservationResult = { ok: true; id: string } | { ok: false; reason: string };

interface Reservation {
  id: string;
  amountUsd: number;
  scopes: string[];
}

const active = new Map<string, Reservation>();
let counter = 0;

/** Float64 addition noise allowance for cap comparison: sums of 1e-2-scale
 * USD values land within ~1e-15 relative error, so `0.01 + 0.01 + 0.01`
 * exceeds the literal `0.03` cap by 2 ULP (~5.6e-18) — an epsilon of 1e-9
 * USD (a hundred-millionth of a cent) absorbs representation noise only; it
 * can never admit a genuinely larger amount (any semantic overshoot is
 * ≥ 1e-4, the ledger's recorded precision scale). */
const FLOAT_EPSILON_USD = 1e-9;

/** Reserve USD spend synchronously: check the caps and insert the hold as
 * one synchronous step (single-threaded atomicity). Returns the reservation
 * id, or a refusal naming the cap that bound. */
export function reserveSpend(input: ReservationInput): ReservationResult {
  const amountUsd = input.amountUsd;
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    return { ok: false, reason: `reservation amount $${amountUsd} is not a finite non-negative spend` };
  }
  const maxPerCall = getMaxPerCall();
  if (amountUsd > maxPerCall) {
    return { ok: false, reason: `reserve $${amountUsd} exceeds MAX_PAYMENT_PER_CALL $${maxPerCall}` };
  }
  // Dedupe while keeping order; 'global' always participates.
  const seen = new Set<string>(["global"]);
  const scopes: string[] = ["global"];
  for (const s of input.scopes ?? []) {
    if (!seen.has(s)) {
      seen.add(s);
      scopes.push(s);
    }
  }
  const reservedGlobal = reservedUsd("global");
  const maxDaily = getMaxDailySpend();
  const spent = getDailySpent();
  if (spent + reservedGlobal + amountUsd > maxDaily + FLOAT_EPSILON_USD) {
    return {
      ok: false,
      reason:
        `reserve $${amountUsd} would exceed MAX_DAILY_SPEND $${maxDaily} ` +
        `(spent $${spent.toFixed(4)} + reserved $${reservedGlobal.toFixed(4)} today)`,
    };
  }
  counter += 1;
  const id = `resv-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  active.set(id, { id, amountUsd, scopes });
  return { ok: true, id };
}

/** Convert a hold into ledger accounting: the payment was signed and the
 * ledger write (logPayment) accounts the amount from here on, exactly once
 * (a second settle/release of the same id is a no-op). */
export function settleReservation(id: string): void {
  active.delete(id);
}

/** Free a hold whose payment never signed (policy/limit refusal, intent
 * abort, throw before signing): the budget is available to the next caller
 * again. A second release/settle of the same id is a no-op. */
export function releaseReservation(id: string): void {
  active.delete(id);
}

/** USD currently held by outstanding reservations for one scope. */
export function reservedUsd(scope: string): number {
  let total = 0;
  for (const r of active.values()) {
    if (r.scopes.includes(scope)) total += r.amountUsd;
  }
  return total;
}

/** Test hook: clear every hold (fresh state between scenarios). Not part of
 * the runtime surface — tests call it in afterEach. */
export function _resetReservationsForTests(): void {
  active.clear();
  counter = 0;
}