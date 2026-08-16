import { CASPER_MAINNET_CAIP2, CASPER_TESTNET_CAIP2, isCasperNetwork, toCasperCaip2 } from "./networks.js";

/**
 * Parsing helpers for the `accepts[]` array of an x402 v2 402 response,
 * scoped to Casper payment requirements.
 */

export interface CasperAccept {
  scheme: string;
  network: string;
  /** wCSPR CEP-18 contract package hash. */
  asset?: string;
  payTo?: string;
  /** Integer motes — wCSPR has 9 decimals. */
  maxAmountRequired?: string;
  resource?: string;
  description?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, any>;
}

/** Pull every Casper entry out of a 402 body, in the order the server listed them. */
export function findCasperAccepts(paymentInfo: any): CasperAccept[] {
  const accepts = paymentInfo?.accepts ?? paymentInfo?.accept ?? [];
  const list = Array.isArray(accepts) ? accepts : [accepts];
  return list.filter((a: any) => a && isCasperNetwork(a.network || "") && (!a.scheme || a.scheme === "exact"));
}

/**
 * Select the Casper requirement to pay.
 *
 * Prefers mainnet over testnet when a server offers both, and honours an
 * explicit network hint (`casper:casper-test`, `casper-test`, ...).
 */
export function selectCasperAccept(paymentInfo: any, networkHint?: string): CasperAccept | undefined {
  const candidates = findCasperAccepts(paymentInfo);
  if (candidates.length === 0) return undefined;

  if (networkHint && isCasperNetwork(networkHint)) {
    const wanted = toCasperCaip2(networkHint);
    const match = candidates.find((a) => toCasperCaip2(a.network) === wanted);
    if (match) return match;
  }

  return (
    candidates.find((a) => toCasperCaip2(a.network) === CASPER_MAINNET_CAIP2) ??
    candidates.find((a) => toCasperCaip2(a.network) === CASPER_TESTNET_CAIP2) ??
    candidates[0]
  );
}

/** Validate the fields we need before attempting a payment. */
export function assertPayableCasperAccept(accept: CasperAccept): void {
  if (!accept.payTo) {
    throw new Error("Casper payment requirements are missing payTo");
  }
  if (!accept.asset) {
    throw new Error("Casper payment requirements are missing the wCSPR asset contract hash");
  }
  if (!accept.maxAmountRequired) {
    throw new Error("Casper payment requirements are missing maxAmountRequired");
  }
}
