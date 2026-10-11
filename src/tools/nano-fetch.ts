import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { registerNanoScheme, type NanoSender } from '../nano/client.js';
import { nanoBudget, guardNanoPayments } from '../nano/budget.js';
import { rawToXno } from '../nano/networks.js';
import { logPayment } from '../payment-utils.js';
import { blockingEnforcement, intentEnforcement } from '../payment-intent/executor.js';
import { intentManager } from '../payment-intent/manager.js';
import type { IntentRejectCode, PaymentIntent } from '../payment-intent/types.js';
import { boundedText } from './casper-fetch.js';

/** Reporting only: a ledger read failure here must not turn a completed send into an error. */
function dailyAuthorizedRaw(): string | undefined {
  try { return nanoBudget.getDailySpent().toString(); } catch { return undefined; }
}

export async function fetchNano(
  url: string,
  method: string,
  body: string | undefined,
  sender: NanoSender,
  network: string,
  intent?: PaymentIntent | null,
  blockedCode?: IntentRejectCode,
) {
  let authorized = () => 0n;
  let published: string | undefined;
  let confirmed: string | undefined;
  let httpStatus: number | undefined;
  let error: string | undefined;
  try {
    const client = new x402Client();
    // XNO is not an SDK default asset and USD-denominated SDK caps cannot
    // price raw, so the SDK spend controls are off here (the Casper rationale);
    // guardNanoPayments below is the authoritative gate — network pin, XNO
    // asset, checksummed payee, raw-exact per-call/daily budgets, one send
    // per call.
    client.setSpendControls(false);
    // The payment-intent boundary runs BEFORE the Nano budget guard, exactly
    // as on the Casper leg: intent validation precedes budget reserve().
    client.onBeforePaymentCreation(
      intent
        ? intentEnforcement({ intent, manager: intentManager, executorLabel: 'x402_fetch/nano' })
        : blockingEnforcement({ code: blockedCode ?? 'MALFORMED', executorLabel: 'x402_fetch/nano' }),
    );
    registerNanoScheme(client, sender, network, (hash) => { published = hash; }, (hash) => { confirmed = hash; });
    authorized = guardNanoPayments(client, network);
    const transport: typeof fetch = async (input, init) => {
      const response = await fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000) });
      for (const name of ['payment-required', 'payment-response', 'x-payment-response']) {
        if ((response.headers.get(name)?.length ?? 0) > 65536) throw new Error('Payment header exceeds size limit');
      }
      const text = await boundedText(response);
      return new Response([204, 205, 304].includes(response.status) ? null : text, { status: response.status, headers: response.headers });
    };
    const response = await wrapFetchWithPayment(transport, client)(url, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body,
    });
    httpStatus = response.status;
    const text = await boundedText(response);
    let result: unknown;
    try { result = JSON.parse(text); } catch { result = text.slice(0, 5000); }
    const receipt = response.headers.get('payment-response') ?? response.headers.get('x-payment-response');
    if (confirmed && response.status !== 200) error = `HTTP ${response.status} after a confirmed Nano send`;
    return { content: [{ type: 'text' as const, text: JSON.stringify({
      status: response.status, url, chain: 'nano',
      // A confirmed send block is final on Nano: the XNO has left the account
      // whether or not the server then serves the resource.
      paid: confirmed !== undefined, accepted: confirmed !== undefined && response.status === 200,
      block_hash: confirmed, authorized_raw: authorized().toString(), authorized_xno: rawToXno(authorized()),
      daily_authorized_raw: dailyAuthorizedRaw(), payment_receipt: receipt, body: result,
    }) }] };
  } catch {
    // Never echo SDK/RPC errors: the node URL or wallet id may appear in them.
    error = published
      ? `Nano send ${published} was published but the paid request did not complete; the budget stays reserved`
      : 'Nano payment failed validation, sending or transport; authorization budget remains reserved if a send was attempted';
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error, url, chain: 'nano', block_hash: published }) }] };
  } finally {
    logPayment({ timestamp: new Date().toISOString(), url, method, chain: 'nano',
      currency: 'XNO', amount_raw: authorized().toString(), tx_hash: confirmed ?? published,
      status: confirmed ? 'success' : 'failed', ...(httpStatus !== undefined ? { http_status: httpStatus } : {}), error });
  }
}
