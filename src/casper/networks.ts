/**
 * Casper network identifiers and CSPR amount math.
 *
 * Casper uses CAIP-2 style network ids in x402 payment requirements:
 *   casper:casper      — mainnet
 *   casper:casper-test — testnet
 *
 * Settlement happens in wCSPR, a CEP-18 token with 9 decimals. The base unit
 * is the "mote" (1 CSPR = 1_000_000_000 motes).
 */

export const CASPER_MAINNET_CAIP2 = "casper:casper";
export const CASPER_TESTNET_CAIP2 = "casper:casper-test";

export const CASPER_NETWORKS = [CASPER_MAINNET_CAIP2, CASPER_TESTNET_CAIP2] as const;

export type CasperNetwork = (typeof CASPER_NETWORKS)[number];

/** wCSPR (CEP-18) has 9 decimals — 1 CSPR = 1e9 motes. */
export const MOTES_PER_CSPR = 1_000_000_000n;
export const CSPR_DECIMALS = 9;

/** Chain slug used by the `chain` parameter of x402_fetch and the directory. */
export const CASPER_CHAIN = "casper";

/**
 * True if a 402 `accepts[].network` value refers to a Casper network.
 * Matches both the CAIP-2 ids and bare `casper` / `casper-test` names that
 * some facilitators emit.
 */
export function isCasperNetwork(network: string): boolean {
  if (!network) return false;
  const n = network.toLowerCase().trim();
  return n === "casper" || n === "casper-test" || n.startsWith("casper:");
}

/** Normalise any Casper network spelling to its CAIP-2 id. */
export function toCasperCaip2(network: string): CasperNetwork {
  const n = (network || "").toLowerCase().trim();
  if (n === CASPER_TESTNET_CAIP2 || n === "casper-test" || n === "casper:testnet") {
    return CASPER_TESTNET_CAIP2;
  }
  if (n === CASPER_MAINNET_CAIP2 || n === "casper" || n === "casper:mainnet") {
    return CASPER_MAINNET_CAIP2;
  }
  throw new Error(`Unknown Casper network: ${network}`);
}

/** Casper node chain name (as used by the network itself) for a CAIP-2 id. */
export function casperChainName(network: string): string {
  return toCasperCaip2(network) === CASPER_TESTNET_CAIP2 ? "casper-test" : "casper";
}

/**
 * Convert a decimal CSPR amount to exact integer motes.
 *
 * Throws on sub-mote precision instead of silently truncating — a payment that
 * is off by even one mote is a payment the facilitator will reject, and
 * rounding user funds is never acceptable.
 */
export function csprToMotes(amount: string | number): bigint {
  const raw = typeof amount === "number" ? formatNumber(amount) : String(amount).trim();

  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid CSPR amount: ${amount}`);
  }
  if (raw.startsWith("-")) {
    throw new Error(`CSPR amount cannot be negative: ${amount}`);
  }

  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > CSPR_DECIMALS) {
    const extra = fraction.slice(CSPR_DECIMALS);
    if (/[^0]/.test(extra)) {
      throw new Error(
        `CSPR amount ${amount} has sub-mote precision (more than ${CSPR_DECIMALS} decimals) — refusing to round`,
      );
    }
  }

  const padded = (fraction + "0".repeat(CSPR_DECIMALS)).slice(0, CSPR_DECIMALS);
  return BigInt(whole) * MOTES_PER_CSPR + BigInt(padded || "0");
}

/** Convert integer motes back to a decimal CSPR string (no precision loss). */
export function motesToCspr(motes: bigint | string): string {
  const value = typeof motes === "bigint" ? motes : BigInt(String(motes).trim());
  if (value < 0n) throw new Error(`Motes cannot be negative: ${motes}`);

  const whole = value / MOTES_PER_CSPR;
  const fraction = (value % MOTES_PER_CSPR).toString().padStart(CSPR_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Parse a `maxAmountRequired` field (always integer motes in x402 v2). */
export function parseMaxAmountRequired(value: string | number | undefined): bigint {
  if (value === undefined || value === null || value === "") {
    throw new Error("maxAmountRequired is missing from the Casper payment requirements");
  }
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`maxAmountRequired must be an integer amount of motes, got: ${value}`);
  }
  return BigInt(raw);
}

function formatNumber(amount: number): string {
  if (!Number.isFinite(amount)) throw new Error(`Invalid CSPR amount: ${amount}`);
  // Avoid exponent notation for small amounts (e.g. 1e-7).
  return amount.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}
