// Issue #67 — the offer-evaluation seam, extracted so it stays ONE wiring.
//
// x402_fetch (the paid flow) and x402_inspect (the free inspector, issue #67)
// MUST evaluate offers identically: the same per-network asset-table pricer
// (issue #62), the same per-candidate policy gate with per-candidate spend
// buckets (issues #62/#59/D7), the same refusal vocabulary. Until now that
// wiring existed only inlined in the fetch seam — an inspector would have
// had to re-type it and drift the moment either side changed. This module is
// the single wiring: the fetch seam and the inspector both call these
// factories (the flow injects its own url/service-host/keys; everything
// dynamic — ledger reads, reservations, anomaly inputs, config — is read
// LIVE per candidate, exactly the same way for both).
//
// Pure wiring only: no network, no reservation, no signature ever. The
// policy evaluate() call is a read-only verdict; getDailySpent /
// getPerServiceSpent / reservedUsd are counters' reads.

import { priceAtomicAsUsd } from "../assets.js";
import { getDailySpent, spendBucketForNetwork } from "../payment-utils.js";
import { reservedUsd } from "../reservations.js";
import { getPolicyEngine, buildPolicyContext } from "../policy/config.js";
import { getPerServiceSpent } from "../policy/budget-store.js";
import { getAnomalyInputs } from "../policy/anomaly-store.js";
import type { OperatorAssetEntry } from "../policy/types.js";
import type { OfferCandidate, UsdOf } from "./offer-selection.js";

/** The asset-table pricer exactly as the x402_fetch seam builds it: resolve
 * the offer's (network, asset, atomic amount) through the shipped table plus
 * the operator's assets.extensions; the refusal side carries the table's
 * stable lowercase tokens. Injected per call so the wiring cannot cache a
 * stale table across a long session. */
export function seamUsdOf(assetExtensions: readonly OperatorAssetEntry[]): UsdOf {
  return (assetId, networkCaip2, atomicAmount) => {
    const priced = priceAtomicAsUsd(networkCaip2, assetId, atomicAmount, assetExtensions);
    if (priced.ok === true) return priced;
    return priced.code === "ASSET_NOT_LISTED"
      ? { ok: false, code: "asset_not_listed" }
      : { ok: false, code: "asset_no_usd_rate" };
  };
}

/** The per-candidate policy gate exactly as the x402_fetch seam builds it:
 * the TABLE's symbol and priced USD in the context (issue #62), each
 * candidate evaluated against its OWN spend bucket (issue #59/D7 — a devnet
 * candidate reads the devnet daily total and devnet-prefixed per-service
 * reservations; every other candidate the mainnet totals, so the selection
 * verdict and the Step 3.5 verdict agree for the same offer), and the
 * anomaly inputs for the same url. `url` and `serviceHost` come from the
 * caller — the paid flow binds the probed url, the inspector the inspected
 * one; nothing is captured. */
export function seamPolicyFor(url: string, serviceHost: string): (candidate: OfferCandidate) => "ALLOW" | "REFUSE" {
  return (c) => {
    const candidateBucket = spendBucketForNetwork(c.network);
    const candidateServiceScope = candidateBucket
      ? `net:${candidateBucket}:service:${serviceHost}`
      : `service:${serviceHost}`;
    const evaluation = getPolicyEngine().evaluate(
      buildPolicyContext(url, c.chain, c.symbol, c.usd, { recipient: c.payTo }),
      { dailySpentUsd: getDailySpent(candidateBucket), perServiceSpentUsd: getPerServiceSpent(serviceHost) + reservedUsd(candidateServiceScope) },
      getAnomalyInputs(url),
    );
    return evaluation.decision === "ALLOW" ? "ALLOW" : "REFUSE";
  };
}