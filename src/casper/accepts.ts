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
  /** Canonical x402 v2 amount. */
  amount?: string;
  resource?: string;
  description?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, any>;
}

/** Pull every Casper entry out of a 402 body, in the order the server listed them. */
export function findCasperAccepts(paymentInfo: any): CasperAccept[] {
  const accepts = paymentInfo?.accepts ?? paymentInfo?.accept ?? [];
  const list = Array.isArray(accepts) ? accepts : [accepts];
  return list.filter((a: any) => a && isCasperNetwork(a.network || "") && a.scheme === "exact");
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

  if (networkHint) {
    const wanted = toCasperCaip2(networkHint);
    const match = candidates.find((a) => toCasperCaip2(a.network) === wanted);
    return match;
  }

  return (
    candidates.find((a) => toCasperCaip2(a.network) === CASPER_MAINNET_CAIP2) ??
    candidates.find((a) => toCasperCaip2(a.network) === CASPER_TESTNET_CAIP2) ??
    candidates[0]
  );
}

/** Validate the fields we need before attempting a payment. */
export const WCSPR_ASSETS: Record<string, string> = {
  // WrappedCsprContractPackageHash in make-software/casper-wallet-core:
  // https://github.com/make-software/casper-wallet-core/blob/master/src/domain/constants/casperNetwork.ts
  "casper:casper": "8df5d26790e18cf0404502c62ce5dc9025800ad6975c97466e20506c39c505b6",
  "casper:casper-test": "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e",
};

export function assertPayableCasperAccept(accept: CasperAccept): void {
  const network = toCasperCaip2(accept.network);
  if (accept.scheme !== "exact") throw new Error("Casper requires scheme exact");
  if (typeof accept.payTo !== "string" || !/^00[0-9a-fA-F]{64}$/.test(accept.payTo)) {
    throw new Error("Casper payTo must be a 00-prefixed account hash");
  }
  if (typeof accept.asset !== "string" || accept.asset.toLowerCase() !== WCSPR_ASSETS[network]) {
    throw new Error("Casper requires the network's canonical wCSPR asset package hash");
  }
  casperAmountMotes(accept);
}

export function casperAmountMotes(accept: CasperAccept): bigint {
  const value = accept.amount ?? accept.maxAmountRequired;
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value) || BigInt(value) <= 0n) {
    throw new Error("Casper amount/maxAmountRequired must be a positive integer mote string");
  }
  if (accept.amount !== undefined && accept.maxAmountRequired !== undefined && accept.amount !== accept.maxAmountRequired) {
    throw new Error("Conflicting Casper amount fields");
  }
  return BigInt(value);
}
