import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme, toClientSvmSigner, SOLANA_MAINNET_CAIP2 } from "@x402/svm";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
import { fetchCasper, boundedText } from "./casper-fetch.js";
import { casperBudget } from "../casper/budget.js";
import { selectCasperAccept, assertPayableCasperAccept, casperAmountMotes } from "../casper/accepts.js";
import { CASPER_CHAIN, isCasperNetwork, toCasperCaip2 } from "../casper/networks.js";
import { checkSpendingLimit, logPayment, getDailySpent, getMaxPerCall, getMaxDailySpend } from "../payment-utils.js";
import { getPolicyEngine, buildPolicyContext } from "../policy/config.js";
import { getPerServiceSpent, recordServicePayment } from "../policy/budget-store.js";
import { extractSettlementReceipt, RECEIPT_VERIFIED, RECEIPT_NOTE } from "./receipt-utils.js";
import { createFromOffer, intentManager } from "../payment-intent/manager.js";
import { executeGuarded } from "../payment-intent/executor.js";
import type { IntentRejectCode, PaymentIntent } from "../payment-intent/types.js";

/** Structured policy refusal — keeps the pre-policy error shape keys verbatim
 * (error, url, chain, estimated_cost_usdc, daily_spent_usdc, max_per_call,
 * max_daily) and adds policy_decision + reasons[{code, message}] (issue #19
 * Phase 6: machine-readable codes, never message-only). */
function policyRefusal(
  result: ReturnType<ReturnType<typeof getPolicyEngine>["evaluate"]>,
  url: string,
  chain: string,
  amountUsdc: number,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: `Payment refused by policy (${result.reasons.map((r) => r.code).join(", ")})`,
        url,
        chain,
        estimated_cost_usdc: amountUsdc,
        daily_spent_usdc: getDailySpent(),
        max_per_call: getMaxPerCall(),
        max_daily: getMaxDailySpend(),
        policy_decision: result.decision,
        reasons: result.reasons,
      }),
    }],
  };
}

/** Structured intent refusal (issue #25) — the same refusal shape keys as
 * policyRefusal (error, url, chain, estimated_cost_usdc, daily_spent_usdc,
 * max_per_call, max_daily, policy_decision, reasons), with policy_decision +
 * machine-readable reasons. Only an ALLOWed request can reach the payment
 * layer, so policy_decision is ALLOW here by construction. */
function intentRefusal(
  url: string,
  chain: string,
  amountUsdc: number,
  reasons: Array<{ code: string; message: string }>,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: `Payment refused by the payment-intent boundary (${reasons.map((r) => r.code).join(", ")})`,
        url,
        chain,
        estimated_cost_usdc: amountUsdc,
        daily_spent_usdc: getDailySpent(),
        max_per_call: getMaxPerCall(),
        max_daily: getMaxDailySpend(),
        policy_decision: "ALLOW",
        reasons,
      }),
    }],
  };
}

/** Parse an SDK abort marker out of a payment failure (`Failed to create
 * payment payload: Payment creation aborted: INTENT_<CODE>[:<field>]`). The
 * raw SDK string is never returned as the whole message — it is attached as a
 * prefixed detail after the intent code (issue #25 refusal contract). */
function intentAbortReasons(message: string): Array<{ code: string; message: string }> | undefined {
  const m = /Payment creation aborted: INTENT_([A-Z_]+)(?::([A-Za-z_]+))?/.exec(message);
  if (!m) return undefined;
  const head = m[1];
  const sub = m[2];
  const specific = head === "UNAUTHORISED" ? (sub ?? "MALFORMED") : head;
  const fieldNote = head !== "UNAUTHORISED" && sub ? ` on field "${sub}"` : "";
  return [
    { code: "INTENT_UNAUTHORISED", message: `payment-intent boundary aborted payload creation before signing (${specific}${fieldNote})` },
    { code: specific, message: `${specific}${fieldNote} — no signature was created; sdk detail: ${message.slice(0, 300)}` },
  ];
}

export function registerFetchTool(server: McpServer): void {
  server.tool(
    "x402_fetch",
    "Fetch any x402-paid endpoint — handles 402 payment challenge automatically on Base, Solana or Casper. The agent never sees wallets or payment details. Just provide a URL and optional body.",
    {
      url: z.string().describe("Full URL of the x402 endpoint (e.g. https://svm402.com/analyze)"),
      method: z.string().optional().describe("HTTP method: GET or POST (default: GET)"),
      body: z.string().optional().describe("JSON body for POST requests (as string)"),
      chain: z.string().optional().describe("Force chain: 'solana', 'base' or 'casper'. Auto-detected if omitted."),
    },
    async (args) => {
      const url = args.url;
      const method = (args.method || "GET").toUpperCase();

      // Policy context host (issue #19): derived once, used for per-service
      // budget state at both gate points (Casper + Step 3.5).
      let serviceHost = "";
      try { serviceHost = new URL(url).hostname.toLowerCase(); } catch { serviceHost = ""; }

      const solanaKey = process.env.SOLANA_PRIVATE_KEY;
      const evmKey = process.env.EVM_PRIVATE_KEY || process.env.BASE_PRIVATE_KEY;
      const casperKey = process.env.CASPER_PRIVATE_KEY;
      const solanaRpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
      const baseRpc = process.env.BASE_RPC_URL || "https://mainnet.base.org";

      // Step 1: Probe to detect chain from 402 response
      let useChain = (args.chain || "").toLowerCase();
      let probedAmountUsdc = 0; // captured from 402 response
      let casperNetwork = process.env.CASPER_NETWORK || "";
      // Issue #25: the concrete probe offer, retained so the payment intent
      // can bind exactly what policy evaluated (the USD estimate alone is not
      // an authorisation). Undefined only when the probe cannot yield an
      // offer: an unrecognised forced chain still skips the probe, and a
      // forced-chain probe may legitimately yield none (amendment 1).
      let probedOffer: { scheme?: string; network?: string; asset?: string; amount?: string; payTo?: string } | undefined;
      let casperIntent: PaymentIntent | null = null;
      let casperBlockedCode: IntentRejectCode | undefined;

      // Forced-chain fix (#25): a forced base/solana chain must still OBSERVE
      // the offer so the payment intent can bind it — via the same single
      // free 402 probe the auto-detect path performs (a 402 response, no
      // payment; no second network call is added). For forced base/solana the
      // probe only observes: it never replaces the caller's chain and never
      // refuses the HTTP request — a probe that yields no offer leaves
      // probedOffer undefined and the guarded paid fetch below decides at
      // signing time (blocking hook), preserving the pre-#25 pass-through for
      // endpoints that do not actually charge. Forced Casper semantics and
      // auto-detect behaviour are unchanged.
      const forcedChain = useChain === "solana" || useChain === "base";

      if (!useChain || useChain === CASPER_CHAIN || forcedChain) {
        try {
          const probeResp = await fetch(url, {
            method,
            signal: AbortSignal.timeout(30000),
            redirect: "error",
            headers: args.body ? { "Content-Type": "application/json" } : {},
            body: args.body || undefined,
          });

          if (probeResp.status !== 402 && !forcedChain) {
            const text = await boundedText(probeResp);
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  status: probeResp.status,
                  url,
                  note: "Endpoint did not return 402 — may be free or not an x402 endpoint",
                  body: text.substring(0, 5000),
                }),
              }],
            };
          }

          if (probeResp.status === 402) {
            const encoded = probeResp.headers.get("payment-required");
            if (encoded && encoded.length > 65536) throw new Error("Payment header exceeds size limit");
            const paymentInfo = JSON.parse(encoded ? Buffer.from(encoded, "base64").toString("utf8") : await boundedText(probeResp));
            const accepts = paymentInfo.accepts || paymentInfo.accept || [];
            const firstAccept = Array.isArray(accepts) ? accepts[0] : accepts;
            const network = firstAccept?.network || "";

            // Issue #25: retain the concrete offer (chain detection + USD
            // estimate are derived from the same single probe — no new calls).
            probedOffer = {
              scheme: firstAccept?.scheme,
              network: firstAccept?.network,
              asset: firstAccept?.asset,
              amount: firstAccept?.amount,
              payTo: firstAccept?.payTo,
            };

            // Capture amount for spending limit check
            if (firstAccept?.amount) {
              probedAmountUsdc = Number(firstAccept.amount) / 1e6;
            }

            if (useChain === CASPER_CHAIN || forcedChain) {
              // Forced Casper still probes and validates a real offer below;
              // forced base/solana keep the caller's chain — the probe only
              // observed the offer above (never re-detects, never refutes it).
            } else if (network.includes("solana") || network.includes("5eykt4")) {
              useChain = "solana";
            } else if (network.includes("eip155") || network.includes("8453")) {
              useChain = "base";
            } else if (isCasperNetwork(network)) {
              useChain = CASPER_CHAIN;
            } else {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({
                    error: "Could not auto-detect chain from 402 response",
                    payment_info: JSON.stringify(paymentInfo).slice(0, 1000),
                    hint: "Specify chain parameter: 'solana', 'base' or 'casper'",
                  }),
                }],
              };
            }

            // Casper settles in wCSPR motes (9 decimals), not 6-decimal USDC.
            if (useChain === CASPER_CHAIN) {
              // Issue #26: the Casper recipient is only knowable after accept
              // selection, and selectCasperAccept is pure and non-throwing —
              // so it is evaluated ABOVE the gate (same call, same arguments,
              // semantics unchanged) and its payTo feeds the gate. The throw
              // below keeps its exact position: refusal order for a 402
              // without a Casper accept stays gate-refusal (if any) first, then
              // the throw.
              const casperAccept = selectCasperAccept(paymentInfo, casperNetwork);
              // POLICY GATE (issue #19): evaluate() BEFORE the internal Casper
              // budget check; casper/budget.ts stays untouched inside the
              // payment layer. Casper amounts have no USD price at this layer,
              // so amount 0 — mote budgets remain the spend control, and the
              // engine enforces chain/token/service/recipient rules + global kill switch.
              const casperPolicy = getPolicyEngine().evaluate(
                buildPolicyContext(url, CASPER_CHAIN, "wCSPR", 0, { recipient: casperAccept?.payTo }),
                { dailySpentUsd: getDailySpent(), perServiceSpentUsd: getPerServiceSpent(serviceHost) },
              );
              if (casperPolicy.decision !== "ALLOW") {
                return policyRefusal(casperPolicy, url, CASPER_CHAIN, 0);
              }
              if (!casperAccept) throw new Error("No matching exact Casper payment offer");
              if (casperAccept) {
                casperNetwork = toCasperCaip2(casperAccept.network);
                try {
                  assertPayableCasperAccept(casperAccept);
                  // Issue #25: bind the validated offer to a payment intent now
                  // (gate order unchanged: evaluate → intent → budget check).
                  // If it cannot be bound, the flow still continues — with a
                  // blocking hook instead of an executable intent.
                  const casperIntentResult = createFromOffer({
                    decision: casperPolicy,
                    url,
                    chain: CASPER_CHAIN,
                    token: "wCSPR",
                    asset: casperAccept.asset,
                    amountAtomic: casperAmountMotes(casperAccept).toString(),
                    decimals: 9,
                    recipient: casperAccept.payTo,
                    network: casperNetwork,
                    scheme: casperAccept.scheme,
                    amountUsdEstimate: 0,
                  });
                  if (casperIntentResult.ok === true) casperIntent = casperIntentResult.intent;
                  else casperBlockedCode = casperIntentResult.code;
                  casperBudget.check(casperAmountMotes(casperAccept));
                } catch (err: any) {
                  return {
                    content: [{
                      type: "text" as const,
                      text: JSON.stringify({ error: err.message, url, chain: CASPER_CHAIN, payment_info: JSON.stringify(paymentInfo).slice(0, 1000) }),
                    }],
                  };
                }
              }
            }
          }
        } catch (err: any) {
          // A forced base/solana probe failure must not refuse a request the
          // pre-#25 forced flow never probed: no offer is bound, and any
          // actual charge below still aborts at the signing boundary (the
          // blocking hook), exactly as amendment 1 specifies.
          if (!forcedChain) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({ error: `Failed to probe endpoint: ${String(err.message).slice(0, 1000)}` }),
              }],
            };
          }
        }
      }

      // Step 2: Check we have the right key
      if (useChain === "solana" && !solanaKey) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: "SOLANA_PRIVATE_KEY not set. Cannot pay on Solana." }),
          }],
        };
      }
      if (useChain === "base" && !evmKey) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: "EVM_PRIVATE_KEY or BASE_PRIVATE_KEY not set. Cannot pay on Base." }),
          }],
        };
      }
      if (useChain === CASPER_CHAIN && !casperKey) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: "CASPER_PRIVATE_KEY not set. Cannot pay on Casper." }),
          }],
        };
      }

      if (useChain === CASPER_CHAIN) {
        return fetchCasper(url, method, args.body, casperKey!, casperNetwork, casperIntent, casperBlockedCode);
      }

      // USD estimate for policy evaluation (informational — the intent binds
      // the atomic amount, never this estimate). Hoisted so the catch block
      // can render intent refusals with the same estimated_cost_usdc key.
      const amountUsdc = probedAmountUsdc || 0.01;

      // Step 3: Create x402 client with the right scheme
      try {
        const client = new x402Client();

        if (useChain === "solana") {
          const secretKeyBytes = bs58.decode(solanaKey!);
          const keypairSigner = await createKeyPairSignerFromBytes(secretKeyBytes);
          const svmSigner = toClientSvmSigner(keypairSigner);
          const scheme = new ExactSvmScheme(svmSigner, { rpcUrl: solanaRpc });
          client.register(SOLANA_MAINNET_CAIP2 as `${string}:${string}`, scheme);

        } else {
          const account = privateKeyToAccount(evmKey! as `0x${string}`);
          const evmSigner = toClientEvmSigner(account as any);
          const scheme = new ExactEvmScheme(evmSigner, { rpcUrl: baseRpc });
          client.register("eip155:8453" as `${string}:${string}`, scheme);
        }

        // Step 3.5: POLICY GATE (issue #19) — the outer gate every payment
        // must pass before payment code runs. APPROVAL_REQUIRED is refused
        // here too (stdio MCP has no human-approval channel in Phase 1 — the
        // issue's fail-closed principle; the APPROVAL_REQUIRED reason code is
        // preserved so callers see why). Issue #26: the probed payTo enters
        // the gate as the recipient (rule 4.5) — the same single probe value
        // the intent binds below, so policy validates exactly what is signed.
        const policyResult = getPolicyEngine().evaluate(
          buildPolicyContext(url, useChain, "USDC", amountUsdc, { recipient: probedOffer?.payTo }),
          { dailySpentUsd: getDailySpent(), perServiceSpentUsd: getPerServiceSpent(serviceHost) },
        );
        if (policyResult.decision !== "ALLOW") {
          return policyRefusal(policyResult, url, useChain, amountUsdc);
        }

        // Issue #25: bind exactly what policy evaluated to a payment intent.
        // An offer that cannot be bound can never be PAID: the paid fetch
        // continues with a blocking hook (INTENT_UNAUTHORISED) so endpoints
        // that do not actually charge pass through unchanged, while any
        // payment-payload creation aborts before signing (amendment 1).
        let intent: PaymentIntent | null = null;
        let blockedCode: IntentRejectCode | undefined;
        if (probedOffer) {
          const intentResult = createFromOffer({
            decision: policyResult,
            url,
            chain: useChain,
            token: "USDC",
            asset: probedOffer.asset ?? "",
            amountAtomic: probedOffer.amount ?? "",
            decimals: 6,
            recipient: probedOffer.payTo ?? "",
            network: probedOffer.network ?? "",
            scheme: probedOffer.scheme ?? "",
            amountUsdEstimate: amountUsdc,
          });
          if (intentResult.ok === true) intent = intentResult.intent;
          else blockedCode = intentResult.code;
        } else {
          // No offer could be observed (an unrecognised forced chain still
          // skips the probe; a forced-chain probe may legitimately yield
          // none) — there is nothing to bind, so any payment aborts at the
          // signing boundary with INTENT_UNAUTHORISED (amendment 1).
          blockedCode = "MALFORMED";
        }

        // Belt-and-braces INSIDE the payment layer (operator decision #5):
        // payment-utils.checkSpendingLimit stays in place — the policy engine
        // is the outer gate, not a replacement.
        const limitCheck = checkSpendingLimit(amountUsdc);
        if (!limitCheck.allowed) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: `Spending limit exceeded: ${limitCheck.reason}`,
                url,
                chain: useChain,
                estimated_cost_usdc: amountUsdc,
                daily_spent_usdc: getDailySpent(),
                max_per_call: getMaxPerCall(),
                max_daily: getMaxDailySpend(),
              }),
            }],
          };
        }

        // Step 4: Make the paid request — only through the guarded executor,
        // which validates/begins the intent and registers the enforcement (or
        // blocking) hook on the client before any payload can be signed.
        const guarded = await executeGuarded({
          intent,
          blockedCode,
          manager: intentManager,
          client,
          label: "x402_fetch",
          run: async () => {
            const paidFetch = wrapFetchWithPayment(fetch, client);
            return paidFetch(url, {
              method,
              headers: args.body ? { "Content-Type": "application/json" } : {},
              body: args.body || undefined,
            });
          },
        });
        if (guarded.ok === false) {
          // validate/beginAttempt failed — the payment layer never ran.
          return intentRefusal(url, useChain, amountUsdc, [
            { code: "INTENT_UNAUTHORISED", message: `payment-intent boundary refused execution (${guarded.code})` },
            { code: guarded.code, message: `${guarded.code}: ${guarded.message}` },
          ]);
        }
        const resp = guarded.result;

        const text = await resp.text();
        let bodyResult: unknown;
        try {
          bodyResult = JSON.parse(text);
        } catch {
          bodyResult = text.substring(0, 5000);
        }

        const { receipt: paymentReceipt, txHash } = extractSettlementReceipt(resp.headers);

        // The exact accounting rule payment-utils.logPayment counts by (and
        // ledger rehydration filters by): only a 200 counts as spend.
        const isSuccessfulPayment = resp.status === 200;

        // Extract actual cost from response body if available
        let actualCost = amountUsdc;
        if (bodyResult && typeof bodyResult === "object") {
          const meta = (bodyResult as any).meta;
          if (meta?.cost?.usd) actualCost = meta.cost.usd;
        }

        logPayment({
          timestamp: new Date().toISOString(),
          url,
          method,
          chain: useChain,
          amount_usdc: actualCost,
          tx_hash: txHash,
          status: isSuccessfulPayment ? "success" : "failed",
        });

        // Issue #19: per-service budget accounting — recorded right next to
        // logPayment for USD-settled successes (same rules as the global
        // tracker; rehydration rebuilds identical values after a restart).
        // Post-#23 parity fix: the guard MUST be the same one logPayment
        // counts by (resp.status === 200). Rehydration filters ledger entries
        // by status === "success", so recording a non-200 settled response
        // here (e.g. 500-after-settlement) would count it in-process while
        // the ledger drops it — per-service caps would silently loosen after
        // a restart (in-process vs post-restart spend divergence).
        if (isSuccessfulPayment) {
          recordServicePayment(url, actualCost);
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: resp.status,
              url,
              chain: useChain,
              paid: resp.status === 200,
              cost_usdc: actualCost,
              daily_spent_usdc: parseFloat(getDailySpent().toFixed(4)),
              payment_receipt: paymentReceipt,
              receipt_verified: RECEIPT_VERIFIED,
              receipt_note: RECEIPT_NOTE,
              body: bodyResult,
            }),
          }],
        };
      } catch (err: any) {
        // Log failed payment attempt
        logPayment({
          timestamp: new Date().toISOString(),
          url,
          method,
          chain: useChain,
          amount_usdc: 0,
          status: "failed",
          error: err.message,
        });

        // Issue #25: an intent-boundary abort means signing was refused before
        // any payload existed — surface the structured refusal, never the raw
        // SDK error string as the message.
        const abortReasons = intentAbortReasons(String(err?.message ?? err));
        if (abortReasons) {
          return intentRefusal(url, useChain, amountUsdc, abortReasons);
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `x402 payment failed: ${err.message}`,
              chain: useChain,
              url,
            }),
          }],
        };
      }
    }
  );
}