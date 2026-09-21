import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { registerCasperScheme } from '../casper/client.js';
import { casperBudget, guardCasperPayments } from '../casper/budget.js';
import { motesToCspr } from '../casper/networks.js';
import { logPayment } from '../payment-utils.js';
import { blockingEnforcement, intentEnforcement } from '../payment-intent/executor.js';
import { intentManager } from '../payment-intent/manager.js';
import type { IntentRejectCode, PaymentIntent } from '../payment-intent/types.js';

export async function boundedText(response: Response, limit = 65536): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Payment response exceeds size limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchCasper(
  url: string,
  method: string,
  body: string | undefined,
  key: string,
  network: string,
  intent?: PaymentIntent | null,
  blockedCode?: IntentRejectCode,
) {
  let authorized = () => 0n;
  let status: 'success' | 'failed' = 'failed';
  let txHash: string | undefined;
  let error: string | undefined;
  try {
    const client = new x402Client();
    // @x402/core >= 2.25 enforces default-asset spendControls BEFORE payment
    // creation; wCSPR is not an SDK default asset, so Casper offers would be
    // rejected upstream of our own guard. Disable the SDK controls here: the
    // repo guard below (guardCasperPayments) is the authoritative gate for
    // Casper — network pin, wCSPR asset allowlist, mote-exact per-call/daily
    // budgets, one authorization per call. USD-denominated SDK caps cannot
    // price motes anyway.
    client.setSpendControls(false);
    // Issue #25: the payment-intent boundary runs BEFORE the Casper budget
    // guard — intent validation must precede budget reserve(). intent == null
    // registers a blocking hook instead: an unbindable offer can never be
    // paid, though an unpaid response still passes through (amendment 1).
    client.onBeforePaymentCreation(
      intent
        ? intentEnforcement({ intent, manager: intentManager, executorLabel: 'x402_fetch/casper' })
        : blockingEnforcement({ code: blockedCode ?? 'MALFORMED', executorLabel: 'x402_fetch/casper' }),
    );
    registerCasperScheme(client, key, network);
    authorized = guardCasperPayments(client, network);
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
    const text = await boundedText(response);
    let result: unknown;
    try { result = JSON.parse(text); } catch { result = text.slice(0, 5000); }
    const receipt = response.headers.get('payment-response') ?? response.headers.get('x-payment-response');
    if (receipt) {
      try {
        const decoded = JSON.parse(Buffer.from(receipt, 'base64').toString());
        if (decoded.success === true && typeof decoded.transaction === 'string' && /^[a-fA-F0-9]{64}$/.test(decoded.transaction) && decoded.network === network) {
          status = 'success'; txHash = decoded.transaction;
        }
      } catch { /* An untrusted/malformed receipt is not proof of payment. */ }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({
      status: response.status, url, chain: 'casper', paid: authorized() > 0n && status === 'success',
      authorized_motes: authorized().toString(), authorized_cspr: motesToCspr(authorized()),
      daily_authorized_motes: casperBudget.getDailySpent().toString(), payment_receipt: receipt, body: result,
    }) }] };
  } catch {
    // Never echo SDK/key-loading errors: they may contain secret key material.
    error = 'Casper payment failed validation, signing or transport; authorization budget remains reserved if signing was attempted';
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error, url, chain: 'casper' }) }] };
  } finally {
    logPayment({ timestamp: new Date().toISOString(), url, method, chain: 'casper',
      currency: 'wCSPR', amount_motes: authorized().toString(), tx_hash: txHash, status, error });
  }
}
