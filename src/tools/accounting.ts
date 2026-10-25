// Issue #53 — accounting helpers for x402_fetch.
//
// The recorded spend of a paid call must be derived ONLY from validated,
// signed data: the payment intent's atomic amount converted with the asset's
// decimals — never from anything in the seller's response body, and never via
// a float round trip. Issue #65/#67 (plan C1) adds the display counterpart:
// every PRINTED amount is the exact decimal string of an integer atomic
// amount (formatAtomic) — a small value is never rounded to zero (a $0.001
// check printed "0.00" through toFixed(2)). These helpers are pure and
// exported for tests; fetch.ts is the only production caller of the #53
// halves, and the budget-registry adapters (#65) consume the #65 ones.

/** Maximum number of characters a seller-reported cost string may have before
 * it is dropped (issue #53 req 3: type-checked and length-limited). */
export const MAX_SELLER_COST_LENGTH = 32;

/** Render an integer atomic amount as its EXACT decimal string (issues #65/#67,
 * plan C1). BigInt arithmetic end to end — never a float round trip — with the
 * fraction zero-padded to exactly `decimals` digits (the mirror image of
 * usdFromAtomic's internal decimal string). A small value is therefore never
 * rounded to zero: 1 atomic unit at 6 decimals is "0.000001", the measured
 * $0.001 devnet ping is "0.001000". `decimals` must be an integer in 0..30 —
 * the display/conversion domain of every unit the rails may settle in (USDC
 * 6, wCSPR 9, Nano 30) — anything else is a programmer error and fails loud
 * rather than mis-rendering money. Negative amounts carry a minus sign.
 * (The USD-facing converters keep their tighter 0..18 float-narrowing domain;
 * this renderer is pure string math and stays exact at any width.) */
export function formatAtomic(atomic: bigint, decimals: number): string {
  if (typeof atomic !== "bigint" || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new TypeError(`formatAtomic needs a bigint amount and an integer decimals in 0..30 (got ${String(decimals)})`);
  }
  const negative = atomic < 0n;
  const value = negative ? -atomic : atomic;
  if (decimals === 0) return `${negative ? "-" : ""}${value.toString()}`;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  return `${negative ? "-" : ""}${whole}.${(base + frac).toString().slice(1)}`;
}

/** Exact string → integer atomic string (issues #65, plan C1): a plain
 * decimal USD/unit string (digits with an optional fraction — the shape
 * capUsdExactString and readCapUsd accept) converted with BigInt/string
 * arithmetic only, mirroring usdFromAtomic's domain math. A fraction longer
 * than `decimals` FLOORS (only integer atomic amounts exist); a malformed
 * string throws — silently reading a garbage budget as 0 would hide a
 * fail-closed condition at formatting time. */
export function atomicStringFromUsdString(usd: string, decimals: number): string {
  if (typeof usd !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(usd)) {
    throw new TypeError(`atomicStringFromUsdString needs a plain non-negative decimal string, got: ${String(usd).slice(0, 32)}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new TypeError(`atomicStringFromUsdString needs an integer decimals in 0..30 (got ${String(decimals)})`);
  }
  const [whole, frac = ""] = usd.split(".");
  const atomicFraction = BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return (BigInt(whole) * 10n ** BigInt(decimals) + atomicFraction).toString();
}

/** Exact printed string for a USD float (issues #65/#67, plan C1): the float
 * is converted ONCE at the display boundary via toFixed(decimals) — the same
 * single rounding the ledger's own reason strings have always implied — and
 * the decimal string then renders through formatAtomic (integer math only;
 * never a float multiply). Non-finite input fails closed to the zero string
 * instead of printing "NaN". This is the DISPLAY path for amounts that begin
 * as USD numbers (x402_check_payment's prospective amount, the registry's
 * ledger-backed totals); money that is already atomic never passes through a
 * float at all. */
export function exactUsdString(usd: number, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new TypeError(`exactUsdString needs an integer decimals in 0..18 (got ${String(decimals)})`);
  }
  if (!Number.isFinite(usd)) {
    const zero = formatAtomic(0n, decimals);
    return usd < 0 ? `-${zero}` : zero;
  }
  const fixed = usd.toFixed(decimals);
  const negative = fixed.startsWith("-");
  const unsigned = negative ? fixed.slice(1) : fixed;
  const atomic = BigInt(atomicStringFromUsdString(unsigned, decimals));
  return formatAtomic(negative ? -atomic : atomic, decimals);
}

/** Convert an integer atomic amount + decimals into USD as a number, using
 * integer/BigInt arithmetic only until the single narrowing to `number` at the
 * ledger boundary. Returns `undefined` on malformed input (the caller fails
 * closed to amount 0 with the raw atomic fields on the row for audit — never a
 * made-up value). */
export function usdFromAtomic(amountAtomic: string, decimals: number): number | undefined {
  if (typeof amountAtomic !== "string" || !/^[0-9]+$/.test(amountAtomic)) return undefined;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return undefined;
  const atomic = BigInt(amountAtomic);
  if (decimals === 0) {
    const n = Number(atomic.toString());
    return Number.isFinite(n) ? n : undefined;
  }
  const base = 10n ** BigInt(decimals);
  const whole = atomic / base;
  const frac = atomic % base;
  const decimalString = `${whole}.${(base + frac).toString().slice(1)}`; // exactly `decimals` fraction digits
  const n = Number(decimalString);
  return Number.isFinite(n) ? n : undefined; // non-finite narrowing fails closed
}

/** Extract the seller-reported cost from a parsed response body as an
 * information-only value. Returned only when the body carries `meta.cost.usd`
 * as a finite non-negative number or a /\\d+(\\.\\d+)?/ decimal string of at
 * most MAX_SELLER_COST_LENGTH characters; anything else — including a
 * throwing property accessor — yields `undefined` and never throws (#53 req 4:
 * body inspection must not enter the payment-failure path). The value is
 * EXPOSER-ONLY: it must never reach an accounting or decision call — that
 * invariant is enforced by src/tools/accounting-guard.test.ts. */
export function sellerReportedCostUsd(bodyResult: unknown): number | string | undefined {
  try {
    if (bodyResult === null || typeof bodyResult !== "object") return undefined;
    const meta = (bodyResult as Record<string, unknown>).meta;
    if (meta === null || typeof meta !== "object") return undefined;
    const cost = (meta as Record<string, unknown>).cost;
    if (cost === null || typeof cost !== "object") return undefined;
    const usd = (cost as Record<string, unknown>).usd;
    if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0) return usd;
    if (typeof usd === "string" && usd.length <= MAX_SELLER_COST_LENGTH && /^\d+(\.\d+)?$/.test(usd)) return usd;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Parse a paid response body for the tool's `body` echo field. JSON is
 * returned as-is; anything unparseable falls back to a bounded text excerpt —
 * parsing never throws into the payment-failure path (#53 req 4). */
export function parseBoundedBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.substring(0, 5000);
  }
}