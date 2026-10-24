// Issue #53 — accounting helpers for x402_fetch.
//
// The recorded spend of a paid call must be derived ONLY from validated,
// signed data: the payment intent's atomic amount converted with the asset's
// decimals — never from anything in the seller's response body, and never via
// a float round trip. These helpers are pure and exported for tests; fetch.ts
// is the only production caller.

/** Maximum number of characters a seller-reported cost string may have before
 * it is dropped (issue #53 req 3: type-checked and length-limited). */
export const MAX_SELLER_COST_LENGTH = 32;

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