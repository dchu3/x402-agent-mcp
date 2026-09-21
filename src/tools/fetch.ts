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

      if (!useChain || useChain === CASPER_CHAIN) {
        try {
          const probeResp = await fetch(url, {
            method,
            signal: AbortSignal.timeout(30000),
            redirect: "error",
            headers: args.body ? { "Content-Type": "application/json" } : {},
            body: args.body || undefined,
          });

          if (probeResp.status !== 402) {
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

          const encoded = probeResp.headers.get("payment-required");
          if (encoded && encoded.length > 65536) throw new Error("Payment header exceeds size limit");
          const paymentInfo = JSON.parse(encoded ? Buffer.from(encoded, "base64").toString("utf8") : await boundedText(probeResp));
          const accepts = paymentInfo.accepts || paymentInfo.accept || [];
          const firstAccept = Array.isArray(accepts) ? accepts[0] : accepts;
          const network = firstAccept?.network || "";

          // Capture amount for spending limit check
          if (firstAccept?.amount) {
            probedAmountUsdc = Number(firstAccept.amount) / 1e6;
          }

          if (useChain === CASPER_CHAIN) {
            // Forced Casper still probes and validates a real offer below.
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
            // POLICY GATE (issue #19): evaluate() BEFORE the internal Casper
            // budget check; casper/budget.ts stays untouched inside the
            // payment layer. Casper amounts have no USD price at this layer,
            // so amount 0 — mote budgets remain the spend control, and the
            // engine enforces chain/token/service rules + global kill switch.
            const casperPolicy = getPolicyEngine().evaluate(
              buildPolicyContext(url, CASPER_CHAIN, "wCSPR", 0),
              { dailySpentUsd: getDailySpent(), perServiceSpentUsd: getPerServiceSpent(serviceHost) },
            );
            if (casperPolicy.decision !== "ALLOW") {
              return policyRefusal(casperPolicy, url, CASPER_CHAIN, 0);
            }
            const casperAccept = selectCasperAccept(paymentInfo, casperNetwork);
            if (!casperAccept) throw new Error("No matching exact Casper payment offer");
            if (casperAccept) {
              casperNetwork = toCasperCaip2(casperAccept.network);
              try {
                assertPayableCasperAccept(casperAccept);
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
        } catch (err: any) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: `Failed to probe endpoint: ${String(err.message).slice(0, 1000)}` }),
            }],
          };
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
        return fetchCasper(url, method, args.body, casperKey!, casperNetwork);
      }

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
        // preserved so callers see why).
        const amountUsdc = probedAmountUsdc || 0.01; // use probed amount or default estimate

        const policyResult = getPolicyEngine().evaluate(
          buildPolicyContext(url, useChain, "USDC", amountUsdc),
          { dailySpentUsd: getDailySpent(), perServiceSpentUsd: getPerServiceSpent(serviceHost) },
        );
        if (policyResult.decision !== "ALLOW") {
          return policyRefusal(policyResult, url, useChain, amountUsdc);
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

        // Step 4: Make the paid request
        const paidFetch = wrapFetchWithPayment(fetch, client);
        const resp = await paidFetch(url, {
          method,
          headers: args.body ? { "Content-Type": "application/json" } : {},
          body: args.body || undefined,
        });

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