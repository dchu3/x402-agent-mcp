/**
 * Nano network identifiers and XNO amount math.
 *
 * Nano uses a CAIP-2 style network id in x402 payment requirements:
 *   nano:mainnet — the live Nano network
 *
 * Nano is feeless and settles in the native currency, XNO. The base unit is
 * the "raw" (1 XNO = 10^30 raw), and every balance on the ledger is a 128-bit
 * unsigned integer of raw — far beyond Number.MAX_SAFE_INTEGER, so all amount
 * math here is BigInt and never touches floating point.
 */

export const NANO_MAINNET_CAIP2 = "nano:mainnet";
export const NANO_NETWORKS = [NANO_MAINNET_CAIP2] as const;
export type NanoNetwork = (typeof NANO_NETWORKS)[number];

/** XNO has 30 decimals — 1 XNO = 1e30 raw. */
export const XNO_DECIMALS = 30;
export const RAW_PER_XNO = 10n ** 30n;
/** Ledger balances are uint128 — no valid amount can exceed this. */
export const MAX_RAW = (1n << 128n) - 1n;

/** Chain slug used by the `chain` parameter of x402_fetch and the directory. */
export const NANO_CHAIN = "nano";

/**
 * True if a 402 `accepts[].network` value refers to the Nano network.
 * Matches the CAIP-2 id and the bare `nano` name.
 */
export function isNanoNetwork(network: string): boolean {
  if (typeof network !== "string" || !network) return false;
  const n = network.toLowerCase().trim();
  return n === NANO_CHAIN || n === NANO_MAINNET_CAIP2;
}

/** Normalise any Nano network spelling to its CAIP-2 id. */
export function toNanoCaip2(network: string): NanoNetwork {
  if (isNanoNetwork(network)) return NANO_MAINNET_CAIP2;
  throw new Error(`Unknown Nano network: ${network}`);
}

/**
 * Convert a decimal XNO amount to exact integer raw.
 *
 * Throws on sub-raw precision instead of silently truncating, and never goes
 * through a JS number for string input.
 */
export function xnoToRaw(amount: string | number): bigint {
  const raw = typeof amount === "number" ? formatNumber(amount) : String(amount).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid XNO amount: ${amount}`);
  }
  if (raw.startsWith("-")) {
    throw new Error(`XNO amount cannot be negative: ${amount}`);
  }
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > XNO_DECIMALS && /[^0]/.test(fraction.slice(XNO_DECIMALS))) {
    throw new Error(
      `XNO amount ${amount} has sub-raw precision (more than ${XNO_DECIMALS} decimals) — refusing to round`,
    );
  }
  const padded = (fraction + "0".repeat(XNO_DECIMALS)).slice(0, XNO_DECIMALS);
  const value = BigInt(whole) * RAW_PER_XNO + BigInt(padded || "0");
  if (value > MAX_RAW) throw new Error(`XNO amount ${amount} exceeds the 128-bit ledger maximum`);
  return value;
}

/** Convert integer raw back to a decimal XNO string (no precision loss). */
export function rawToXno(raw: bigint | string): string {
  const value = typeof raw === "bigint" ? raw : BigInt(String(raw).trim());
  if (value < 0n) throw new Error(`Raw cannot be negative: ${raw}`);
  const whole = value / RAW_PER_XNO;
  const fraction = (value % RAW_PER_XNO).toString().padStart(XNO_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function formatNumber(amount: number): string {
  if (!Number.isFinite(amount)) throw new Error(`Invalid XNO amount: ${amount}`);
  // Avoid exponent notation for small amounts (e.g. 1e-7).
  return amount.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}
