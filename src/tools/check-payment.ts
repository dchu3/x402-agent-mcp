// Issue #19 Phase 5 — x402_check_payment: policy inspection WITHOUT payment.
//
// This tool evaluates a prospective payment through the PolicyEngine and
// returns the structured decision. It NEVER performs a payment: it imports no
// wallet/payment-execution code, makes no network calls, and writes nothing to
// the payment ledger. Its only ledger interaction is reading today's spend
// (payment-utils.getDailySpent / budget-store.getPerServiceSpent) and the
// per-service price baseline (anomaly-store.getAnomalyInputs — read-only) so
// the verdict reflects real budget/baseline state, deterministically.
//
// Output follows the issue's response shape: { decision, service, amount,
// currency, chain, reasons: [{code, message, detail?}] } plus trust_level and
// limits for explainability. Machine-readable reason codes are the contract —
// never rely on the human-readable message (issue Phase 6); reasons carry
// their optional detail payload verbatim (issue #30: PRICE_ANOMALY carries
// z-score/baseline stats there).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { advertisedPriceUsd, loadDirectory } from "../directory.js";
import { getPolicyEngine, buildPolicyContext, loadPolicyConfig } from "../policy/config.js";
import { normalizeRecipient } from "../policy/recipient.js";
import { getDailySpent } from "../payment-utils.js";
import { getPerServiceSpent } from "../policy/budget-store.js";
import { getAnomalyInputs } from "../policy/anomaly-store.js";
// FIX 3 — issue #67 (req 1/5): the EXISTING CAIP-2 → chain-name vocabulary
// (no second table) — the check maps an exact network id to the chain name.
import { parseChainFromNetwork } from "./probe-utils.js";
// Issue #59/#62 (C9 visibility): the run's explicit mode + the asset table.
import { modeAllowsNetwork, resolveNetworkMode } from "../networks.js";
import { assetTableSummary } from "../assets.js";
// Issue #66 (stage A, req 1): the active policy profile is reported beside
// trust_level. DEFAULT_POLICY_PROFILE is the fallback for hand-built states
// that carry no profile (loadPolicyConfig always sets one).
import { DEFAULT_POLICY_PROFILE } from "../policy/profile.js";
// Issue #65/#67 (plan C1): amounts print through the exact atomic formatter —
// a small value is never rounded to zero (a $0.001 check printed "0.00"
// through toFixed(2)). Issue #67 (plan C6): the check output additionally
// carries the budget headroom (the shared free-tools snapshot) and a plain
// verdict_summary so an agent can parse the outcome without re-reading the
// reasons array.
import { exactUsdString } from "./accounting.js";
import { budgetSnapshotOutput } from "./status.js";

/** Directory entry for a hostname, or null. Case-insensitive hostname match —
 * the same rule resolveTrustLevel uses for DISCOVERED classification. */
function findDirectoryEntry(host: string) {
  if (!host) return undefined;
  try {
    return loadDirectory().endpoints.find((e) => {
      try {
        return new URL(e.base_url).hostname.toLowerCase() === host.toLowerCase();
      } catch {
        return false;
      }
    });
  } catch {
    return undefined; // directory unavailable — the trust derivation already treats this as UNKNOWN
  }
}

/** #67 (plan C6): a plain-language one-liner beside the machine verdict —
 * the reason codes stay the contract, this is only the reading aid. */
function verdictSummary(decision: string, amountUsd: number, token: string, service: string, chain: string, reasons: Array<{ code: string }>): string {
  const amount = exactUsdString(amountUsd, 6);
  const codes = reasons.map((r) => r.code);
  if (decision === "ALLOW" && codes.length === 0) {
    return `ALLOW: a ${amount} ${token} payment for ${service} on ${chain} passes the policy rules (0 reasons).`;
  }
  if (decision === "ALLOW") {
    return `ALLOW (with warnings): a ${amount} ${token} payment for ${service} on ${chain} would proceed, with ${codes.length} warning(s): ${codes.join(', ')}.`;
  }
  if (decision === "APPROVAL_REQUIRED") {
    return `APPROVAL_REQUIRED: a ${amount} ${token} payment for ${service} on ${chain} needs approval first — ${codes.length} reason(s): ${codes.join(', ')}.`;
  }
  return `DENY: a ${amount} ${token} payment for ${service} on ${chain} was refused by ${codes.length} reason(s): ${codes.join(', ')}.`;
}

export function registerCheckPaymentTool(server: McpServer): void {
  server.tool(
    "x402_check_payment",
    "Evaluate a prospective x402 payment against the payment policy WITHOUT paying. Returns ALLOW / DENY / APPROVAL_REQUIRED with stable machine-readable reason codes. Use it before x402_fetch to understand the policy boundary. In recipient allowlist mode the recipient argument is REQUIRED (pass the payTo address from the 402 challenge); in change-detect mode it is compared against the recorded baseline. This tool never performs a payment.",
    {
      url: z.string().describe("Full URL of the x402 endpoint you intend to pay (e.g. https://example.com/api)"),
      amount: z.number().optional().describe("Prospective payment amount in USD (e.g. from the 402 challenge). Omit to check chain/token/service rules with the directory price when known."),
      chain: z.enum(["base", "solana", "casper", "polygon", "arbitrum"]).optional().describe("Payment chain: 'base', 'polygon', 'arbitrum', 'solana' or 'casper'. Defaults to the directory entry's chain, else 'base'."),
      token: z.string().optional().describe("Payment token, e.g. 'USDC' or 'wCSPR'. Defaults to 'USDC'."),
      network: z.string().optional().describe("The EXACT CAIP-2 network id of the prospective offer (e.g. 'eip155:8453', 'solana:5eykt4Us...') — checked against the run's X402_NETWORK_MODE (issue #59); omitted = no mode/network check."),
      recipient: z.string().optional().describe("The recipient address that would be paid (payTo from the 402 challenge). Required to evaluate recipient allowlist mode; compared against the recorded baseline in change-detect mode."),
    },
    async (args) => {
      let host = "";
      try {
        host = new URL(args.url).hostname.toLowerCase();
      } catch {
        host = "";
      }

      const entry = findDirectoryEntry(host);
      // Issue #67 (req 1/5, FIX 3): NEVER invent a chain. Precedence:
      //   args.chain → args.network (the exact CAIP-2 mapped to the project
      //   chain name through the EXISTING vocabulary — parseChainFromNetwork,
      //   the same mapper every probe surface shares; no second table) →
      //   directory entry → 'base' as the last resort for the POLICY
      //   evaluation only. The output names its source, so an assumption is
      //   visible instead of silent: a devnet Solana seller is never again
      //   reported as "base" when the caller passed the exact network id.
      // A CAIP-2 that maps OUTSIDE the project's chain set (an unmapped id)
      // never claims a chain — it falls through, and the network itself stays
      // echoed verbatim with its mode-match result.
      const PROJECT_CHAINS = new Set(["base", "polygon", "arbitrum", "solana", "casper"]);
      const directoryChain = entry && entry.chain && entry.chain !== "unknown" && PROJECT_CHAINS.has(entry.chain.toLowerCase()) ? entry.chain.toLowerCase() : "";
      const networkChain = args.network !== undefined ? parseChainFromNetwork(args.network) : "";
      let chain: string;
      let chainSource: "argument" | "network" | "directory" | "assumed_default";
      if (args.chain !== undefined) {
        chain = args.chain.toLowerCase();
        chainSource = "argument";
      } else if (PROJECT_CHAINS.has(networkChain)) {
        chain = networkChain;
        chainSource = "network";
      } else if (directoryChain !== "") {
        chain = directoryChain;
        chainSource = "directory";
      } else {
        chain = "base";
        chainSource = "assumed_default";
      }
      // Token passes through verbatim: the engine's allowlist match is exact
      // and the default list contains mixed-case entries ("wCSPR"). Case
      // normalization here would turn a valid wCSPR check into a false
      // TOKEN_NOT_ALLOWED deny — fail-closed direction, but a wrong answer.
      const token = args.token || "USDC";

      // Amount: explicit argument wins; otherwise the advertised directory
      // price for the matching path (advertisedPriceUsd — the shared helper
      // the rule 4.6 seed uses, replacing this tool's former inline duplicate);
      // otherwise 0 (chain/token/service rules still evaluated).
      let amount = args.amount;
      if (amount === undefined) {
        const price = advertisedPriceUsd(args.url);
        if (price !== undefined) amount = price;
      }
      const amountUsd = amount ?? 0;

      const ctx = buildPolicyContext(args.url, chain, token, amountUsd, { recipient: args.recipient });
      // Issue #30: the price-anomaly inputs (per-service settled-amount
      // baseline + advertised directory price) enter the evaluation as a
      // third argument. Read-only: this tool never records baselines (it
      // never pays); Casper checks stay inert on rule 4.6 by engine design.
      const result = getPolicyEngine().evaluate(ctx, {
        dailySpentUsd: getDailySpent(),
        perServiceSpentUsd: getPerServiceSpent(host),
      }, getAnomalyInputs(args.url));

      // Issue #26: echo the probed recipient verbatim plus its normalized
      // (canonical) form — the exact value rule 4.5 compared. null when no
      // recipient was supplied or it is not a valid address for the chain.
      const recipientEcho = args.recipient !== undefined
        ? { recipient: args.recipient, recipient_normalized: normalizeRecipient(chain, args.recipient) ?? null }
        : {};

      // Issue #62/#59 (C9): the run's EXPLICIT network mode — when it is
      // unset over a loaded key the paid tool refuses, so this tool surfaces
      // the same condition with the stable code's message.
      const modeState = resolveNetworkMode();
      const modeStateError = modeState.error;

      // Issue #66 (stage A): loadPolicyConfig re-reads env/the file on every
      // call (deliberately not memoised) — capture the state ONCE so the
      // asset-table summary and the profile report below see the same load.
      const policyState = loadPolicyConfig();

      const output = {
        decision: result.decision,
        service: ctx.service,
        amount: exactUsdString(amountUsd, 6),
        currency: token,
        chain,
        // Issue #67 (req 1/5, FIX 3): the chain's PROVENANCE — an agent can
        // see whether the chain was named (argument/network), derived from
        // the directory, or assumed ('base' for the policy evaluation only).
        chain_source: chainSource,
        // Issue #59 (C9 visibility): the run's EXPLICIT network mode — when it
        // is unset over a loaded key the paid tool refuses, so this tool
        // surfaces the same condition with the stable code's message.
        network_mode: modeState.mode ?? null,
        ...(modeStateError ? { network_mode_error: modeStateError } : {}),
        // Issue #62/#59 (C9): the asset table's summary — what IS listed (the
        // shipped entries + the operator's assets.extensions), so an agent
        // can see which assets may pay before probing any seller.
        asset_table: {
          ...assetTableSummary(),
          operator_extensions: policyState.config.assets.extensions.length,
        },
        ...(args.network !== undefined ? {
          network: args.network,
          ...(modeState.mode !== undefined
            ? { network_mode_match: modeAllowsNetwork(modeState.mode, args.network) }
            : {}),
        } : {}),
        ...recipientEcho,
        trust_level: result.limits.trustLevel,
        // Issue #66 (stage A, req 1): the active policy profile beside
        // trust_level — reported from the loaded state (no second env read
        // at this call site). With X402_POLICY_PROFILE unset this is the
        // stage-A default "permissive"; post-merge review (#86): a value that
        // failed resolution is reported as "invalid" (+ policy_profile_error,
        // the resolver message) — never as the fail-closed fallback "strict",
        // which an operator cannot tell apart from a deliberate choice.
        policy_profile: policyState.profileError !== undefined
          ? "invalid"
          : (policyState.profile ?? DEFAULT_POLICY_PROFILE),
        ...(policyState.profileError !== undefined ? { policy_profile_error: policyState.profileError } : {}),
        // Issue #34: echo the endpoint liveness verdict the gate saw (rule
        // 4.7) — computed in buildPolicyContext from the directory row +
        // liveness config — so an agent can inspect pin/probe state BEFORE
        // calling x402_fetch. Read-only: this tool never probes and never pays.
        ...(ctx.endpointLiveness !== undefined ? { endpoint_liveness: ctx.endpointLiveness } : {}),
        // Reasons carry their optional detail payload (issue #30) verbatim.
        reasons: result.reasons.map((r) => ({ code: r.code, message: r.message, ...(r.detail !== undefined ? { detail: r.detail } : {}) })),
        limits: result.limits,
        // Issue #67 (plan C6): a plain-language reading aid next to the
        // machine verdict (reasons stay the contract — codes verbatim).
        verdict_summary: verdictSummary(result.decision, amountUsd, token, ctx.service, chain, result.reasons),
        // Issue #65/#67 (plan C6): the budget headroom beside the verdict —
        // the shared free-tools snapshot (caps, spent, remaining, the
        // optional cross-chain ceiling). Read-only, exact strings.
        budget: budgetSnapshotOutput(),
        note: "Inspection only — no payment was attempted. Resolve DENY reasons before calling x402_fetch.",
      };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(output, null, 2),
        }],
      };
    }
  );
}