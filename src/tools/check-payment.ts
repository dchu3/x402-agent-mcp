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
import { getPolicyEngine, buildPolicyContext } from "../policy/config.js";
import { normalizeRecipient } from "../policy/recipient.js";
import { getDailySpent } from "../payment-utils.js";
import { getPerServiceSpent } from "../policy/budget-store.js";
import { getAnomalyInputs } from "../policy/anomaly-store.js";

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

export function registerCheckPaymentTool(server: McpServer): void {
  server.tool(
    "x402_check_payment",
    "Evaluate a prospective x402 payment against the payment policy WITHOUT paying. Returns ALLOW / DENY / APPROVAL_REQUIRED with stable machine-readable reason codes. Use it before x402_fetch to understand the policy boundary. In recipient allowlist mode the recipient argument is REQUIRED (pass the payTo address from the 402 challenge); in change-detect mode it is compared against the recorded baseline. This tool never performs a payment.",
    {
      url: z.string().describe("Full URL of the x402 endpoint you intend to pay (e.g. https://example.com/api)"),
      amount: z.number().optional().describe("Prospective payment amount in USD (e.g. from the 402 challenge). Omit to check chain/token/service rules with the directory price when known."),
      chain: z.string().optional().describe("Payment chain: 'base', 'solana' or 'casper'. Defaults to the directory entry's chain, else 'base'."),
      token: z.string().optional().describe("Payment token, e.g. 'USDC' or 'wCSPR'. Defaults to 'USDC'."),
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
      const chain = (args.chain || (entry && entry.chain && entry.chain !== "unknown" ? entry.chain : "") || "base").toLowerCase();
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

      const output = {
        decision: result.decision,
        service: ctx.service,
        amount: amountUsd.toFixed(2),
        currency: token,
        chain,
        ...recipientEcho,
        trust_level: result.limits.trustLevel,
        // Reasons carry their optional detail payload (issue #30) verbatim.
        reasons: result.reasons.map((r) => ({ code: r.code, message: r.message, ...(r.detail !== undefined ? { detail: r.detail } : {}) })),
        limits: result.limits,
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