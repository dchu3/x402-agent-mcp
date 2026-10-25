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

import { getDailySpent, getDevnetDailySpent, getMaxDailySpend, getMaxPerCall, readCapUsd } from "./payment-utils.js";
// Issue #65 (req 1): the ceiling reads every registered rail's spend through
// the budget registry — ONE accounting read for the whole cross-chain total.
import { getBudgets, railSpendUsd, RAIL_DISABLED_NO_RATE, type BudgetRail } from "./budget-registry.js";

export interface ReservationInput {
  amountUsd: number;
  /** Extra scopes besides the always-on 'global' scope (e.g. 'service:host'). */
  scopes?: string[];
  /** Issue #59 (D7): the spend BUCKET this hold belongs to. A devnet
   * registration passes the exact devnet network id — its hold and its daily
   * read live in the devnet bucket (`net:<id>` scope / the devnet daily map
   * key) and never touch the mainnet 'global' bucket or total. Absent (every
   * mainnet leg and all pre-#59 callers) → exactly today's 'global' rule. */
  networkBucket?: string;
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
  // Dedupe while keeping order; the DAILY bucket scope participates: 'global'
  // for mainnet legs (issue #59/D7: a devnet hold carries the devnet bucket
  // scope ONLY — it must never reserve against the mainnet total).
  const dailyScope = input.networkBucket ? `net:${input.networkBucket}` : "global";
  const seen = new Set<string>([dailyScope]);
  const scopes: string[] = [dailyScope];
  for (const s of input.scopes ?? []) {
    if (!seen.has(s)) {
      seen.add(s);
      scopes.push(s);
    }
  }
  const reservedGlobal = reservedUsd(dailyScope);
  const maxDaily = getMaxDailySpend();
  // Issue #59 (D7): a DEVNET reservation reads the devnet daily bucket's
  // total against the same MAX_DAILY_SPEND cap; a mainnet reservation reads
  // today's mainnet total (the devnet bucket is excluded from it).
  const spent = input.networkBucket ? getDevnetDailySpent() : getDailySpent();
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

// ---------------------------------------------------------------------------
// Issue #65 (req 4) — the OPTIONAL cross-chain ceiling.
//
// MAX_DAILY_SPEND_TOTAL_USD is an operator-configured daily total across
// every registered rail, converted through each rail's explicitly configured
// USD rate (there is NO built-in rate and NO default ceiling: unset = today's
// behaviour, byte-identical). The state/verdict helpers below are the ONE
// accounting path for the ceiling — the reservation registry evaluates it in
// the same synchronous check+insert as the daily scope (issue #65 req 5), and
// any rail without a configured rate is DISABLED while a ceiling is set
// (RAIL_DISABLED_NO_RATE). The state helpers are read-only; the registry's
// rails expose their own spend.
// ---------------------------------------------------------------------------

/** The environment variable of the cross-chain ceiling (no default). */
export const CEILING_VAR = "MAX_DAILY_SPEND_TOTAL_USD";

/** The reservation scope EVERY hold carries while a ceiling is active so
 * concurrent calls cannot overshoot the total (one extra scope, same
 * check+insert as the daily scope — issue #65 req 5). */
export const TOTAL_USD_SCOPE = "total-usd";

/** The configured ceiling in USD as a number, or undefined when unset (the
 * opt-in boundary: unset behaviour is byte-identical to pre-#65). A present
 * value parses with readCapUsd's fail-closed discipline: a garbage value
 * reads 0 — every reservation is then refused until the operator fixes the
 * env, never widened. */
export function dailyTotalCeilingUsd(): number | undefined {
  if (process.env[CEILING_VAR] === undefined) return undefined;
  return readCapUsd(CEILING_VAR, 0);
}

/** Today's cross-rail spend in USD: every registered rail's spend converted
 * by its configured rate (railSpendUsd — native USD for the USD rail, exact
 * atomic × rate for priced rails; an unpriced rail contributes nothing and
 * is disabled while a ceiling is active, so nothing can accrue there). */
export function railSpendTotalUsd(): number {
  let total = 0;
  for (const rail of getBudgets()) {
    const value = railSpendUsd(rail);
    if (value !== null) total += value;
  }
  return total;
}

/** The ceiling's snapshot for the free visibility tools (x402_status and
 * x402_check_payment): the stable code set, the totals and which rails the
 * ceiling disables. Read-only — no reserves, no writes.
 *
 * A rail is DISABLED while a ceiling is active whenever the ceiling cannot
 * price it with certainty: no configured rate, or a configured rate whose
 * spend conversion is outside the USD conversion domain (e.g. a >18-decimal
 * unit) — an unpriceable spend could hide under the total, so such a rail is
 * refused outright (RAIL_DISABLED_NO_RATE is the one stable refusal code). */
export interface CeilingState {
  active: boolean;
  max_usd?: number;
  spent_total_usd?: number;
  reserved_total_usd?: number;
  disabled_rails?: Array<{ rail: string; unit: string; code: typeof RAIL_DISABLED_NO_RATE }>;
}

/** True when the ceiling cannot price this rail's spend (so the rail must be
 * refused while a ceiling is active). Priced rails with a native USD spend or
 * a convertible atomic spend price fine; a configured rate with an
 * unconvertible spend does not count as pricing. */
function ceilingCannotPrice(rail: BudgetRail): boolean {
  if (rail.usdRate() === null) return true;
  return railSpendUsd(rail) === null;
}

export function ceilingState(): CeilingState {
  const maxUsd = dailyTotalCeilingUsd();
  if (maxUsd === undefined) return { active: false };
  return {
    active: true,
    max_usd: maxUsd,
    spent_total_usd: railSpendTotalUsd(),
    reserved_total_usd: reservedUsd(TOTAL_USD_SCOPE),
    disabled_rails: getBudgets()
      .filter(ceilingCannotPrice)
      .map((rail) => ({ rail: rail.id, unit: rail.unit, code: RAIL_DISABLED_NO_RATE })),
  };
}

/** Test hook: clear every hold (fresh state between scenarios). Not part of
 * the runtime surface — tests call it in afterEach. */
export function _resetReservationsForTests(): void {
  active.clear();
  counter = 0;
}