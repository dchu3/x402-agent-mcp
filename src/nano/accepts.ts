import { isNanoNetwork, MAX_RAW, NANO_MAINNET_CAIP2, toNanoCaip2 } from "./networks.js";
import { isValidNanoAddress } from "./address.js";

/**
 * Parsing helpers for the `accepts[]` array of an x402 v2 402 response,
 * scoped to Nano payment requirements.
 */

export interface NanoAccept {
  scheme: string;
  network: string;
  /** Native-currency marker — Nano has no token contracts. Must be "XNO". */
  asset?: string;
  /** Checksummed nano_ address that receives the send block. */
  payTo?: string;
  /** Integer raw — XNO has 30 decimals. */
  maxAmountRequired?: string;
  /** Canonical x402 v2 amount. */
  amount?: string;
  resource?: string;
  description?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, any>;
}

/** The only asset a Nano offer can name: the native currency. */
export const XNO_ASSET = "XNO";

/** Pull every Nano entry out of a 402 body, in the order the server listed them. */
export function findNanoAccepts(paymentInfo: any): NanoAccept[] {
  const accepts = paymentInfo?.accepts ?? paymentInfo?.accept ?? [];
  const list = Array.isArray(accepts) ? accepts : [accepts];
  return list.filter((a: any) => a && isNanoNetwork(a.network || "") && a.scheme === "exact");
}

/**
 * Select the Nano requirement to pay. Honours an explicit network hint and
 * never falls back across it.
 */
export function selectNanoAccept(paymentInfo: any, networkHint?: string): NanoAccept | undefined {
  const candidates = findNanoAccepts(paymentInfo);
  if (candidates.length === 0) return undefined;
  if (networkHint) {
    let wanted: string;
    try { wanted = toNanoCaip2(networkHint); } catch { return undefined; }
    return candidates.find((a) => toNanoCaip2(a.network) === wanted);
  }
  return candidates.find((a) => toNanoCaip2(a.network) === NANO_MAINNET_CAIP2) ?? candidates[0];
}

/** Validate the fields we need before attempting a payment. */
export function assertPayableNanoAccept(accept: NanoAccept): void {
  toNanoCaip2(accept.network);
  if (accept.scheme !== "exact") throw new Error("Nano requires scheme exact");
  if (typeof accept.payTo !== "string" || !isValidNanoAddress(accept.payTo)) {
    throw new Error("Nano payTo must be a checksum-valid nano_ address");
  }
  if (accept.asset !== XNO_ASSET) throw new Error(`Nano requires asset "${XNO_ASSET}" (the native currency)`);
  nanoAmountRaw(accept);
}

export function nanoAmountRaw(accept: NanoAccept): bigint {
  const value = accept.amount ?? accept.maxAmountRequired;
  if (typeof value !== "string" || !/^\d{1,39}$/.test(value) || BigInt(value) <= 0n || BigInt(value) > MAX_RAW) {
    throw new Error("Nano amount/maxAmountRequired must be a positive integer raw string within uint128");
  }
  if (accept.amount !== undefined && accept.maxAmountRequired !== undefined && accept.amount !== accept.maxAmountRequired) {
    throw new Error("Conflicting Nano amount fields");
  }
  return BigInt(value);
}
