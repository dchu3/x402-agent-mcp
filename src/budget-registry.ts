// Issue #65 — ONE budget registry with per-rail caps, spend and persistence.
//
// Every spending rail registers through it as an ADAPTER over its EXISTING
// accounting module — the USD rail over src/payment-utils.ts, the Casper rail
// over src/casper/budget.ts — so there is no duplicated accounting anywhere
// (the registry owns no counters, no ledger, no caps; it only LISTENS to the
// rails the accounting modules already enforce). A future rail registers with
// registerBudget at its own module load and every consumer (x402_status and
// the cross-chain ceiling) lists it without touching any output code — that
// is #65 acceptance test 5.
//
// Purity contract: no env reads at import, no I/O. The adapters read their
// caps/rates LIVE per call (exactly like checkSpendingLimit), so an operator's
// env change is never silently cached. USD rates resolve through ONE function
// in this module: the operator's X402_RATE_<ASSET>_USD first, validated
// positive-finite, else the asset-table entry's rate (a USD-pegged asset is
// the peg, exactly 1). There is NO built-in rate ever — an unpriced rail is
// reported with null and (while the opt-in cross-chain
// MAX_DAILY_SPEND_TOTAL_USD ceiling is set) that rail is DISABLED, with the
// stable code RAIL_DISABLED_NO_RATE.

import { usdFromAtomic } from "./tools/accounting.js";

/** How a rail's spend persists across a restart: "ledger-rehydrated" counters
 * rebuild from today's ledger rows; "memory" counters are process-local.
 * Issue #54 (req 6): BOTH shipped rails rehydrate from the same ledger — a
 * restart is not a reset on either rail. */
export type PersistenceMode = "ledger-rehydrated" | "memory";

/** An exact integer atomic amount: the decimal digit string plus the unit's
 * integer decimals (usdFromAtomic's domain). Money is never a float here. */
export interface AtomicAmount {
  atomic: string;
  decimals: number;
}

/** Stable refusal code for a rail the ceiling cannot price (issue #65 req 4). */
export const RAIL_DISABLED_NO_RATE = "RAIL_DISABLED_NO_RATE";

/** One registered budget rail: a read-only adapter over an existing
 * accounting module. Cap/spend methods return EXACT atomic amounts (or null
 * where the module reports none — an unset Casper budget is no cap); nothing
 * here mutates spend state. */
export interface BudgetRail {
  /** Stable rail id — one registration per id (a duplicate is a loud
   * programming error, never a silent double-rail). */
  id: string;
  /** The unit the rail settles in, in the policy's token vocabulary. */
  unit: string;
  /** Integer decimals of the unit's atomic amount. */
  decimals: number;
  /** The per-call cap in exact atomic units, or null when unconfigured. */
  perCallCap(): AtomicAmount | null;
  /** The daily cap in exact atomic units, or null when unconfigured. */
  dailyCap(): AtomicAmount | null;
  /** Today's settled spend in exact atomic units (never a float). */
  spentToday(): AtomicAmount;
  /** The rail's spend today as a USD number when it prices natively (the USD
   * rail's ledger float — the number its own caps compare). Rails that price
   * only through a configured rate omit this and the registry converts their
   * atomic spend for them. */
  spentUsdToday?(): number;
  /** Outstanding reservation holds in exact atomic units, or null when the
   * rail holds nothing (the Casper rail debits synchronously — its holds ARE
   * its spentToday). */
  reservedToday?(): AtomicAmount | null;
  persistence: PersistenceMode;
  /** The accounting ledger location when a ledger is the counter's source of
   * truth (the USD rail's resolveLedger().primary); undefined otherwise. */
  ledgerPath?: string;
  /** USD per WHOLE unit when priced: the operator's env rate or the asset
   * table's entry/peg. null = no configured rate, never an assumed value. */
  usdRate(): number | null;
}

const rails = new Map<string, BudgetRail>();

/** Register one budget rail (issue #65). Re-registration of the SAME rail
 * object is a no-op; a DIFFERENT adapter claiming the same id replaces the
 * old one with one loud stderr line — this repo's restart-parity tests
 * re-import the rails' modules under fresh query-string specifiers, and a
 * fresh process instance of a rail must win over its stale ghost, never
 * silently double-register (two listed rails with one id would double-count
 * every listing). Registration performs no I/O and reads no env: the
 * adapter's closures read everything live per call. */
export function registerBudget(rail: BudgetRail): void {
  if (typeof rail?.id !== "string" || rail.id === "") {
    throw new TypeError("registerBudget: a rail needs a non-empty id");
  }
  const existing = rails.get(rail.id);
  if (existing === rail) return;
  if (existing !== undefined) {
    console.error(
      `[x402] budget rail "${rail.id}" re-registered by a fresh module instance — the latest adapter wins (one listed rail per id, never a double)` ,
    );
  }
  rails.set(rail.id, rail);
}

/** Every registered budget rail, in registration order. */
export function getBudgets(): readonly BudgetRail[] {
  return [...rails.values()];
}

/** Test hook: clear every registered rail (fresh registry between scenarios).
 * Not part of the runtime surface — tests call it explicitly. */
export function _resetBudgetRegistryForTests(): void {
  rails.clear();
}

/** The env variable name for a rail's operator-configured USD rate
 * (issue #65 req 4): X402_RATE_<ASSET>_USD with the asset symbol upper-cased
 * (wCSPR → X402_RATE_WCSPR_USD). No built-in default exists for any asset. */
export function railUsdRateVar(symbol: string): string {
  return `X402_RATE_${symbol.toUpperCase()}_USD`;
}

/** Issue #65 req 4: resolve ONE rail's USD rate — the operator's env var
 * FIRST (validated positive-finite; a garbage/non-positive value logs one
 * stderr line and is NOT a rate — fail closed, never assumed), else the
 * caller-supplied asset-table value (a USD-pegged asset passes its peg,
 * exactly 1; a listed non-pegged entry passes its configured usdRate; an
 * unpriced entry passes undefined). Returns null when nothing configures a
 * real rate: the rail prices nothing, and while MAX_DAILY_SPEND_TOTAL_USD is
 * set that rail is DISABLED (RAIL_DISABLED_NO_RATE). */
export function resolveRailUsdRate(symbol: string, tableRate: number | undefined | null): number | null {
  const raw = process.env[railUsdRateVar(symbol)];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    console.error(
      `[x402] ${railUsdRateVar(symbol)}="${raw}" is not a positive finite number — failing closed: ` +
      `the rail prices nothing until the environment is fixed (no built-in default exists)`,
    );
    return null;
  }
  if (typeof tableRate === "number" && Number.isFinite(tableRate) && tableRate > 0) return tableRate;
  return null;
}

/** The USD value of an exact atomic amount at a positive rate — delegated to
 * the accounting module's BigInt-integer converter (usdFromAtomic), then one
 * narrowing multiply, exactly like priceAtomicAsUsd. Returns undefined for
 * malformed amounts (no price — never a made-up value). */
export function usdValueOf(amountAtomic: string, decimals: number, rate: number): number | undefined {
  const whole = usdFromAtomic(amountAtomic, decimals);
  if (whole === undefined) return undefined;
  const value = whole * rate;
  return Number.isFinite(value) ? value : undefined;
}

/** One rail's spend today as a USD number — its native float when it prices
 * itself, otherwise its exact atomic spend converted through its configured
 * rate. null when the rail prices nothing (never an assumed value): the
 * cross-chain ceiling skips unpriceable spend, and a rail without a rate is
 * DISABLED for paid calls while the ceiling is set, so nothing can accrue
 * there anyway (the Casper counter is process-local: any pre-rate spend stays
 * invisible to the total — that is exactly the honesty #65 req 4 demands,
 * and why an unpriced rail refuses rather than slips through unaudited). */
export function railSpendUsd(rail: BudgetRail): number | null {
  if (typeof rail.spentUsdToday === "function") {
    const value = rail.spentUsdToday();
    return Number.isFinite(value) ? value : null;
  }
  const rate = rail.usdRate();
  if (rate === null) return null;
  const spent = rail.spentToday();
  return usdValueOf(spent.atomic, spent.decimals, rate) ?? null;
}