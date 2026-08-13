import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme, toClientSvmSigner, SOLANA_MAINNET_CAIP2 } from "@x402/svm";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
import { checkSpendingLimit, logPayment, getDailySpent, getMaxPerCall, getMaxDailySpend } from "../payment-utils.js";

export function registerFetchTool(server: McpServer): void {
  server.tool(
    "x402_fetch",
    "Fetch any x402-paid endpoint — handles 402 payment challenge automatically on Base or Solana. The agent never sees wallets or payment details. Just provide a URL and optional body.",
    {
      url: z.string().describe("Full URL of the x402 endpoint (e.g. https://svm402.com/analyze)"),
      method: z.string().optional().describe("HTTP method: GET or POST (default: GET)"),
      body: z.string().optional().describe("JSON body for POST requests (as string)"),
      chain: z.string().optional().describe("Force chain: 'solana' or 'base'. Auto-detected if omitted."),
    },
    async (args) => {
      const url = args.url;
      const method = (args.method || "GET").toUpperCase();

      const solanaKey = process.env.SOLANA_PRIVATE_KEY;
      const evmKey = process.env.EVM_PRIVATE_KEY || process.env.BASE_PRIVATE_KEY;
      const solanaRpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
      const baseRpc = process.env.BASE_RPC_URL || "https://mainnet.base.org";

      // Step 1: Probe to detect chain from 402 response
      let useChain = (args.chain || "").toLowerCase();
      let probedAmountUsdc = 0; // captured from 402 response

      if (!useChain) {
        try {
          const probeResp = await fetch(url, {
            method,
            headers: args.body ? { "Content-Type": "application/json" } : {},
            body: args.body || undefined,
          });

          if (probeResp.status !== 402) {
            const text = await probeResp.text();
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

          const paymentInfo = await probeResp.json();
          const accepts = paymentInfo.accepts || paymentInfo.accept || [];
          const firstAccept = Array.isArray(accepts) ? accepts[0] : accepts;
          const network = firstAccept?.network || "";

          // Capture amount for spending limit check
          if (firstAccept?.amount) {
            probedAmountUsdc = Number(firstAccept.amount) / 1e6;
          }

          if (network.includes("solana") || network.includes("5eykt4")) {
            useChain = "solana";
          } else if (network.includes("eip155") || network.includes("8453")) {
            useChain = "base";
          } else {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: "Could not auto-detect chain from 402 response",
                  payment_info: paymentInfo,
                  hint: "Specify chain parameter: 'solana' or 'base'",
                }),
              }],
            };
          }
        } catch (err: any) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: `Failed to probe endpoint: ${err.message}` }),
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

        // Step 3.5: Check spending limits before paying
        const amountUsdc = probedAmountUsdc || 0.01; // use probed amount or default estimate

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

        const paymentResponse = resp.headers.get("x-payment-response");

        // Log the payment
        let txHash: string | undefined;
        if (paymentResponse) {
          try {
            const receipt = JSON.parse(Buffer.from(paymentResponse, "base64").toString());
            txHash = receipt.settlement?.txHash || receipt.transactionHash || receipt.txHash;
          } catch {}
        }

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
          status: resp.status === 200 ? "success" : "failed",
        });

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
              payment_receipt: paymentResponse || null,
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