/**
 * Post-settlement receipt parsing for x402 paid fetches.
 * v2 sellers send the canonical PAYMENT-RESPONSE header; older sellers send
 * X-PAYMENT-RESPONSE. Parsing is post-settlement only — no signing/payment logic here.
 *
 * Trust boundary (#18.5): extraction is NOT verification. A settlement receipt
 * is a server-provided attestation; this client never checks it against a chain
 * (independent on-chain verification needs per-chain clients — roadmap). Every
 * paid-fetch output therefore carries RECEIPT_VERIFIED/RECEIPT_NOTE, and tests
 * lock those fields in so the honesty cannot regress.
 */

export type HeaderGetter = (name: string) => string | null;

/** Trust-boundary constants (#18.5), locked by src/tools/fetch.test.ts: the
 * settlement receipt in tool output is a server-provided attestation, never
 * independently verified on-chain by this client. */
export const RECEIPT_VERIFIED = false;
export const RECEIPT_NOTE = "server-provided, not independently verified on-chain";

export interface SettlementReceipt {
  /** Raw base64 header value, or null when no receipt header is present. */
  receipt: string | null;
  /** Settlement transaction hash — only when the receipt decodes with success === true. */
  txHash?: string;
}

/** Extract the settlement receipt from response headers. Never throws on malformed input. */
export function extractSettlementReceipt(source: Headers | HeaderGetter): SettlementReceipt {  const get: HeaderGetter = typeof source === "function" ? source : (name) => source.get(name);
  const receipt = get("PAYMENT-RESPONSE") ?? get("X-PAYMENT-RESPONSE");
  if (receipt == null) return { receipt: null };

  let txHash: string | undefined;
  try {
    const decoded = JSON.parse(Buffer.from(receipt, "base64").toString("utf8"));
    if (decoded && typeof decoded === "object" && decoded.success === true) {
      // v2 settle schema uses "transaction"; keep legacy fallbacks for older sellers.
      const candidate = decoded.transaction ?? decoded.settlement?.txHash ?? decoded.transactionHash ?? decoded.txHash;
      if (typeof candidate === "string" && candidate.length > 0) txHash = candidate;
    }
  } catch {
    // Malformed base64/JSON receipt: surface the raw value, leave txHash undefined.
  }
  return txHash === undefined ? { receipt } : { receipt, txHash };
}
