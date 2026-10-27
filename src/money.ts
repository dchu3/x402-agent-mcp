// One pure money seam for the spend-accounting path: the single float
// tolerance the cap comparisons share, and the one formatter that turns a
// USD number into the rounded operator-facing string used by refusal
// messages.
//
// Purity contract (same as the policy engine): no clock, no env, no I/O,
// no randomness — same input ⇒ same output, always. Both helpers are pure
// functions of number → value.

/** Float64 addition-noise allowance for cap comparisons: sums of
 * 1e-2-scale USD values land within ~1e-15 relative error, so
 * `0.01 + 0.01 + 0.01` exceeds the literal `0.03` cap by 2 ULP
 * (~5.6e-18) — a float representation artefact, not a larger amount. An
 * epsilon of 1e-9 USD (a hundred-millionth of a cent) absorbs
 * representation noise only; it can never admit a genuinely larger
 * amount, because a semantic overshoot is ≥ 1e-6-scale money (the
 * ledger's recorded precision — one atomic USDC unit at 6 decimals is
 * 1e-6, and assets with more decimals price to a finer USDC quantum than
 * that). Every USD-cap comparison on the spend path uses this ONE value:
 * the policy engine's daily-cap rules and the reservation registry.
 * Comparisons take the form `spent + amount > cap + FLOAT_EPSILON_USD`
 * (tolerant) rather than `amount > cap + FLOAT_EPSILON_USD` (which
 * would loosen the boundary itself); reaching the cap exactly stays
 * allowed. */
export const FLOAT_EPSILON_USD = 1e-9;

/** The rounding scale: the ledger records USD at 6 decimals (the finest
 * atomic unit the accounting narrows to), so refusal messages round to
 * the same scale instead of printing float artefact digits. */
const USD_DECIMALS = 6;
const MICRO = 1_000_000;

/** Render an exact decimal string from an integer count of micro-USD
 * (no float division, no exponent form, no stray "-0"). */
function decimalFromMicro(micro: number): string {
  const negative = micro < 0;
  const abs = Math.abs(micro);
  const whole = Math.floor(abs / MICRO); // integer division — exact
  const frac = abs - whole * MICRO; // integer remainder 0..999999 — exact
  let text = `${String(whole)}.${String(frac).padStart(USD_DECIMALS, "0")}`;
  text = text.replace(/0+$/, "").replace(/\.$/, "");
  if (text === "" || text === "-") text = "0";
  return (negative && text !== "0" ? "-" : "") + text;
}

/** Format a USD amount the way refusal messages and operator-facing
 * money figures show it: `$`-prefixed, rounded to the ledger's 6-decimal
 * scale, trailing zeros stripped, never an exponent form, and the
 * negative zero collapsed to `$0`.
 *
 * Examples: formatUsd(1) === "$1"; formatUsd(0.05) === "$0.05";
 * formatUsd(0) === "$0"; formatUsd(-0) === "$0";
 * formatUsd(0.04999999999999999) === "$0.05";
 * formatUsd(0.30000000000000004) === "$0.3".
 *
 * Rounding is round-half-away-from-zero on the micro-USD integer (the
 * half case is unreachable for money that arrived via the ledger's own
 * rounding). Non-finite values pass through verbatim after the `$` — a
 * refusal that carries `NaN`/`±Infinity` must stay visibly broken, never
 * silently become a plausible amount. Magnitudes beyond the safe-integer
 * micro scale (≥ ~9e9 USD) fall back to the shortest number form: this
 * seam never formats such a cap, and inventing further digits would be
 * the artefact the formatter exists to prevent. */
export function formatUsd(n: number): string {
  if (n === 0) return "$0"; // covers -0 — Object.is(-0, 0)
  if (!Number.isFinite(n)) return `$${String(n)}`;
  const micro = Math.round(n * MICRO);
  if (!Number.isSafeInteger(micro)) return `$${String(n)}`;
  return `$${decimalFromMicro(micro)}`;
}