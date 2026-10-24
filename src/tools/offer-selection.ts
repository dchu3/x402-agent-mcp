// Issue #61 — deterministic offer selection.
//
// A 402 challenge can advertise MANY payment offers (different chains,
// different prices). Until now the agent paid accepts[0] — whatever the
// seller listed first — with the SDK's own selection free to drift between
// the probe and the paid leg. This module makes the choice deterministic:
// the cheapest payable offer by integer atomic ranking (6-decimal USDC —
// the money path; never a float decision), ties broken by a configured
// chain order, otherwise by the seller's list order.
//
// "Payable" means, per offer, in this order:
//   1. malformed  — bindable shape only: exact scheme + network + asset +
//                   payTo + positive integer atomic amount (no offer is
//                   "repaired" to be selectable),
//   2. no_key     — the agent must hold a signer for the offer's chain,
//   3. network_not_allowed — the policy config's network allowlist,
//   4. asset_not_allowed   — the SDK's own default-asset universe (the same
//                            spend-controls gate enforces it at signing too),
//   5. policy_refused      — the same policy gate the flow enforces at
//                            Step 3.5, evaluated per candidate here.
// Every losing offer reports a FIXED rejection token; no seller text ever
// leaves this module (raw networks/ids surface only through the caller's
// untrusted-transport rendering).
//
// Pure module: no fetch, no ledger, no env, no clock. The policy verdict is
// injected (policyFor) so the ranking is testable in isolation while the
// real policy wiring stays at the fetch seam.

import { parseChainFromNetwork } from "./probe-utils.js";
import { isEvmNetwork } from "../evm/networks.js";

export type RejectToken =
  | "malformed"
  | "no_key"
  | "network_not_allowed"
  | "asset_not_allowed"
  | "policy_refused";

export interface OfferCandidate {
  /** Position in the seller's accepts[] (the list-order tie-breaker). */
  index: number;
  /** parseChainFromNetwork(network): policy vocabulary or verbatim CAIP-2. */
  chain: string;
  network: string;
  asset: string;
  amountAtomic: string;
  payTo: string;
  scheme: string;
  /** Number(amountAtomic) / 1e6 — 6-decimal USDC display/ranking input
   * only. The DECISION compares integer atomic amounts; this value is never
   * the money binding (the intent binds amountAtomic). */
  usd: number;
}

export interface RejectedOffer {
  index: number;
  chain: string;
  reject: RejectToken;
}

export interface SelectOfferArgs {
  /** The challenge's accepts value (array expected; anything else selects
   * nothing — NO_PAYABLE_OFFER, never a default). */
  accepts: unknown;
  /** Which chains the agent can actually sign for (keys loaded this run). */
  keysLoaded: { solana: boolean; evm: boolean };
  /** The policy config's network allowlist (the same one the gate uses). */
  allowedNetworks: readonly string[];
  /** The SDK's default-asset universe (spend controls enforce it too). */
  allowedAssets: readonly string[];
  /** The flow's policy gate, evaluated per candidate (injected). */
  policyFor: (candidate: OfferCandidate) => "ALLOW" | "REFUSE";
  /** Chain tie-break order (cheapest-equal offers). */
  chainOrder: readonly string[];
}

export type SelectOfferResult =
  | { ok: true; chosen: OfferCandidate; rejected: RejectedOffer[] }
  | { ok: false; code: "NO_PAYABLE_OFFER"; rejected: RejectedOffer[] };

/** Shipped tie-break order: Solana, then base, polygon, arbitrum (the
 * policy vocabulary's USD chains, in a fixed deterministic order). */
export const DEFAULT_CHAIN_ORDER: readonly string[] = ["solana", "base", "polygon", "arbitrum"];

const chainOrderIndex = (chain: string, chainOrder: readonly string[]): number => {
  const i = chainOrder.indexOf(chain);
  return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
};

function candidateFor(
  accept: unknown,
  index: number,
  args: SelectOfferArgs,
): { kind: "reject"; rejected: RejectedOffer } | { kind: "candidate"; candidate: OfferCandidate } {
  const reject = (rejectToken: RejectToken): { kind: "reject"; rejected: RejectedOffer } => ({
    kind: "reject",
    rejected: { index, chain: chain ? stripChainText(chain) : "", reject: rejectToken },
  });
  const isObj = accept !== null && typeof accept === "object" && !Array.isArray(accept);
  const o = (isObj ? accept : {}) as Record<string, unknown>;
  const network = typeof o.network === "string" ? o.network : "";
  const chain = network === "" ? "" : parseChainFromNetwork(network);
  const asset = typeof o.asset === "string" ? o.asset : "";
  const amountRaw = o.amount;
  const bindableAmount =
    typeof amountRaw === "string" && /^[0-9]+$/.test(amountRaw) && amountRaw !== "" && BigInt(amountRaw) > 0n;
  const amountAtomic = bindableAmount ? amountRaw as string : "";
  const payTo = typeof o.payTo === "string" ? o.payTo : "";
  const scheme = o.scheme === "exact" ? o.scheme : "";

  // 1. Bindable shape (fail closed — never repaired, never defaulted).
  if (scheme === "" || network === "" || asset === "" || payTo === "" || amountAtomic === "") {
    return reject("malformed");
  }
  // 2. A signer for the offer's chain must be loaded this run.
  const canSign = chain === "solana" ? args.keysLoaded.solana : isEvmNetwork(chain) ? args.keysLoaded.evm : false;
  if (!canSign) return reject("no_key");
  // 3./4. The flow's policy allowlists (networks from config, assets from
  // the SDK's own default-asset table — spend controls enforce it too).
  if (!args.allowedNetworks.includes(chain)) return reject("network_not_allowed");
  if (!args.allowedAssets.includes(asset)) return reject("asset_not_allowed");
  // 5. The same policy gate the flow enforces at the intent binding.
  const candidate: OfferCandidate = {
    index, chain, network, asset, amountAtomic, payTo, scheme: "exact",
    usd: Number(amountAtomic) / 1e6,
  };
  if (args.policyFor(candidate) !== "ALLOW") return reject("policy_refused");
  return { kind: "candidate", candidate };
}

/** Rejection records carry our tokens plus a chain label only — network
 * strings can be arbitrary seller text, so anything beyond the policy
 * vocabulary never leaves the selector as a "chain". */
function stripChainText(chain: string): string {
  return ["solana", "base", "polygon", "arbitrum", "casper", "ethereum"].includes(chain)
    ? chain
    : chain.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 64);
}

/** Deterministically select which offer to pay (issue #61). Cheapest wins
 * by INTEGER atomic comparison (6-decimal USDC); a tie breaks by the
 * configured chain order, then by the seller's list order. Returns a
 * NO_PAYABLE_OFFER result object when nothing is selectable — the caller
 * handles its own fallback, exactly as the pre-#61 flow did with
 * accepts[0]; the selection never clamps and never defaults. */
export function selectOffer(args: SelectOfferArgs): SelectOfferResult {
  const list = Array.isArray(args.accepts) ? args.accepts : [];
  const rejected: RejectedOffer[] = [];
  const candidates: OfferCandidate[] = [];
  for (let index = 0; index < list.length; index++) {
    const verdict = candidateFor(list[index], index, args);
    if (verdict.kind === "reject") rejected.push(verdict.rejected);
    else candidates.push(verdict.candidate);
  }
  let best: OfferCandidate | undefined;
  for (const candidate of candidates) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    const aAtomic = BigInt(candidate.amountAtomic);
    const bAtomic = BigInt(best.amountAtomic);
    if (aAtomic !== bAtomic) {
      if (aAtomic < bAtomic) best = candidate;
      continue;
    }
    const aOrd = chainOrderIndex(candidate.chain, args.chainOrder);
    const bOrd = chainOrderIndex(best.chain, args.chainOrder);
    if (aOrd < bOrd) best = candidate;
  }
  if (best === undefined) return { ok: false, code: "NO_PAYABLE_OFFER", rejected };
  return { ok: true, chosen: best, rejected };
}