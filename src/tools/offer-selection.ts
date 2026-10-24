// Issue #61 — deterministic offer selection.
//
// A 402 challenge can advertise MANY payment offers (different chains,
// different prices). Until now the agent paid accepts[0] — whatever the
// seller listed first — with the SDK's own selection free to drift between
// the probe and the paid leg. This module makes the choice deterministic:
// the cheapest payable offer, ties broken by a configured chain order,
// otherwise by the seller's list order.
//
// Issue #62 (C3): the ranking input became the per-network asset TABLE's
// priced USD value. Each offer's (network, asset, amount) is resolved through
// an INJECTED pricer (the asset table — see src/assets.ts); ranking compares
// the priced USD values, never the raw atomic string and never a fixed-6
// float: a 9-decimal amount whose raw atomic VALUE is numerically smaller
// than a 6-decimal one can be worth MORE in USD, and only the table's real
// decimals know that. Every non-priced (unlisted/unrated) offer is reported
// as its stable RejectionToken (asset_not_listed / asset_no_usd_rate) rather
// than silently skipped.
//
// "Payable" means, per offer, in this order:
//   1. malformed  — bindable shape only: exact scheme + network + asset +
//                   payTo + positive integer atomic amount (no offer is
//                   "repaired" to be selectable),
//   2. no_key     — the agent must hold a signer for the offer's chain,
//   3. network_not_allowed — the policy config's network allowlist and (from
//                            issue #59/C7) the injected network-mode
//                            predicate for networks the chain vocabulary
//                            cannot name (a devnet registration),
//   4. asset_not_listed / asset_no_usd_rate — the per-network asset table's
//                            injected pricer (issue #62). The legacy
//                            `allowedAssets` gate (the SDK's default-asset
//                            universe) remains only for callers that do not
//                            inject a table (pre-#62 callers; the table
//                            caller is the only production call).
//   5. policy_refused      — the same policy gate the flow enforces at
//                            Step 3.5, evaluated per candidate here.
// Every losing offer reports a FIXED rejection token; no seller text ever
// leaves this module (raw networks/ids surface only through the caller's
// untrusted-transport rendering).
//
// Pure module: no fetch, no ledger, no env, no clock. The policy verdict is
// injected (policyFor) and the asset pricer is injected (usdOf) so the
// ranking is testable in isolation (src/assets.test.ts ranks through the REAL
// table offline) while the real wiring stays at the fetch seam.

import { parseChainFromNetwork } from "./probe-utils.js";
import { isEvmNetwork } from "../evm/networks.js";

export type RejectToken =
  | "malformed"
  | "no_key"
  | "network_not_allowed"
  | "asset_not_allowed"
  // Issue #62: the per-network asset table's stable refusal tokens — an
  // unlisted asset (no entry for this network) or a listed asset the table
  // cannot price on the USD leg (no peg or rate; see src/assets.ts).
  | "asset_not_listed"
  | "asset_no_usd_rate"
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
  /** Issue #62 (C3): the TABLE's real symbol and decimals for the asset —
   * the policy gate's token vocabulary and the intent's decimals come from
   * here, never from the legacy literal. With the legacy path (no usdOf)
   * these stay the pre-#62 literals ('USDC' / 6) so the historical behavior
   * is byte-identical. */
  symbol: string;
  decimals: number;
}

export interface RejectedOffer {
  index: number;
  chain: string;
  reject: RejectToken;
}

/** Issue #62 (C3): the injected asset-table pricer — (asset, network, atomic
 * integer amount) resolved through the per-network table; the refusal side
 * carries the table's stable tokens (lowercase vocabulary, same family as
 * RejectToken). Injected so selectOffer stays pure and offline-testable. */
export type UsdOf = (
  asset: string,
  network: string,
  amountAtomic: string,
) => { ok: true; usd: number; symbol: string; decimals: number } | { ok: false; code: "asset_not_listed" | "asset_no_usd_rate" };

export interface SelectOfferArgs {
  /** The challenge's accepts value (array expected; anything else selects
   * nothing — NO_PAYABLE_OFFER, never a default). */
  accepts: unknown;
  /** Which chains the agent can actually sign for (keys loaded this run). */
  keysLoaded: { solana: boolean; evm: boolean };
  /** The policy config's network allowlist (the same one the gate uses). */
  allowedNetworks: readonly string[];
  /** Issue #59 (C7): an injected predicate for the network MODE — networks
   * the flow registered that the chain vocabulary cannot name (a devnet
   * registration). Absent on the legacy path: no mode predicate. */
  networkAllowed?: (network: string) => boolean;
  /** The SDK's default-asset universe (spend controls enforce it too);
   * the pre-#62 caller shape. When a table pricer is injected this gate is
   * NOT consulted — the table decides (issue #62). */
  allowedAssets?: readonly string[];
  /** Issue #62 (C3): the per-network asset table's pricer (injected; the
   * fetch seam passes priceAtomicAsUsd bound to the operator's
   * assets.extensions). */
  usdOf?: UsdOf;
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
  // 3./4. The flow's gate inputs: the policy allowlist for networks + the
  // injected network-mode predicate (issue #59), then the ASSET gate from the
  // per-network asset table's injected pricer (issue #62). With no table
  // injected (pre-#62 caller shape) the legacy SDK-universe gate applies.
  if (!args.allowedNetworks.includes(chain)) return reject("network_not_allowed");
  if (args.networkAllowed !== undefined && !args.networkAllowed(network)) return reject("network_not_allowed");
  let candidate: OfferCandidate;
  if (args.usdOf !== undefined) {
    // Issue #62: price through the table. Unlisted/unrated offers are
    // REPORTED refusals (never silently skipped, never assumed-pegged).
    const priced = args.usdOf(asset, network, amountAtomic);
    if (priced.ok === false) return reject(priced.code);
    candidate = {
      index, chain, network, asset, amountAtomic, payTo, scheme: "exact",
      usd: priced.usd, symbol: priced.symbol, decimals: priced.decimals,
    };
  } else {
    if (!args.allowedAssets?.includes(asset)) return reject("asset_not_allowed");
    candidate = {
      index, chain, network, asset, amountAtomic, payTo, scheme: "exact",
      usd: Number(amountAtomic) / 1e6, symbol: "USDC", decimals: 6,
    };
  }
  // 5. The same policy gate the flow enforces at the intent binding.
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

/** Deterministically select which offer to pay (issue #61). Cheapest wins —
 * by the TABLE-PRICED USD when a pricer is injected (issue #62: a float
 * comparison is fine as the RANKING input because the money binding is the
 * atomic amount and exact USD ties fall through to the deterministic chain
 * order, then the seller's list order; ranking NEVER runs on the raw atomic
 * string or a fixed-6 float — see the #62 review requirement), otherwise by
 * INTEGER atomic comparison (pre-#62 behavior). A tie breaks by the
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
    // Issue #62 (C3): with a table pricer, rank on the PRICED USD value (the
    // table's real decimals decide which atomic string is actually worth
    // less); without one, rank on the raw atomic amount (pre-#62). Ties fall
    // through to the chain order, then the seller's list order.
    const aBetter = args.usdOf !== undefined ? candidate.usd < best.usd : (() => {
      const aAtomic = BigInt(candidate.amountAtomic);
      const bAtomic = BigInt(best!.amountAtomic);
      return aAtomic < bAtomic;
    })();
    const tied = args.usdOf !== undefined
      ? candidate.usd === best.usd
      : BigInt(candidate.amountAtomic) === BigInt(best.amountAtomic);
    if (aBetter) {
      best = candidate;
      continue;
    }
    if (!tied) continue;
    const aOrd = chainOrderIndex(candidate.chain, args.chainOrder);
    const bOrd = chainOrderIndex(best.chain, args.chainOrder);
    if (aOrd < bOrd) best = candidate;
  }
  if (best === undefined) return { ok: false, code: "NO_PAYABLE_OFFER", rejected };
  return { ok: true, chosen: best, rejected };
}