import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { registerCasperScheme } from '../casper/client.js';
import { casperBudget, guardCasperPayments } from '../casper/budget.js';
import { motesToCspr } from '../casper/networks.js';
import { logPayment } from '../payment-utils.js';
import { blockingEnforcement, intentEnforcement } from '../payment-intent/executor.js';
import { intentManager } from '../payment-intent/manager.js';
import type { IntentRejectCode, PaymentIntent } from '../payment-intent/types.js';

export async function boundedText(response: Response, limit = 65536, signal?: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Issue #80 (R1a): an optional caller signal bounds the read in TIME, not
  // just in bytes — a mid-body stall is the unbounded read the issue pins.
  // The read races the abort (one shared rejector per call); on abort the
  // signal's reason (the paid-leg deadline's TimeoutError) propagates.
  const aborted = signal === undefined
    ? undefined
    : new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  try {
    for (;;) {
      const { value, done } = aborted === undefined
        ? await reader.read()
        : await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Payment response exceeds size limit'); }
      chunks.push(value);
    }
  } catch (err) {
    // Best-effort stream hygiene (never masks the real error): free the
    // socket promptly when the read stopped early — an abort or the size cap.
    await reader.cancel().catch(() => undefined);
    if (aborted !== undefined && signal!.aborted) {
      // The abort stopped this read — the call surfaces the caller's reason
      // (the paid-leg deadline's TimeoutError), never a stream detail.
      throw signal!.reason;
    }
    throw err;
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
      status: response.status, url, chain: 'casper',
      // Issue #80: the tri-state paid flag (the same #54 rule the USD leg
      // follows) — true ONLY on a verified success receipt; "unknown" when a
      // nonzero authorization was sent but unverified (never paid:false after
      // a send); false when nothing was authorized (a free response is not a
      // payment).
      paid: authorized() > 0n ? (status === 'success' ? true : 'unknown') : false,
      authorized_motes: authorized().toString(), authorized_cspr: motesToCspr(authorized()),
      daily_authorized_motes: casperBudget.getDailySpent().toString(), payment_receipt: receipt, body: result,
    }) }] };
  } catch {
    // Never echo SDK/key-loading errors: they may contain secret key material.
    error = 'Casper payment failed validation, signing or transport; authorization budget remains reserved if signing was attempted';
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error, url, chain: 'casper' }) }] };
  } finally {
    // Issue #54 (req 6): the Casper row keeps the TRUE outcome too — a
    // verified success receipt settles; a nonzero authorization with no
    // verified receipt is a signed-and-debited attempt (ambiguous failures
    // retain the debit in the budget), so the ledger must count it exactly
    // the same across a restart: authorized_unserved, its validity the
    // intent's own expiry (none bound ⇒ no expiry field ⇒ the row counts —
    // the fail-closed over-count direction). Nothing authorized ⇒ failed/0,
    // exactly as before.
    // Issue #80: nothing authorized now writes NO payment row at all — a
    // Casper response with zero motes authorized is not a payment (never a
    // payment ledger entry, never a spend input).
    const authorizedMotes = authorized();
    if (authorizedMotes > 0n) {
      const unservedAuthorization = status !== 'success' && authorizedMotes > 0n;
      logPayment({
        timestamp: new Date().toISOString(),
        url,
        method,
        chain: 'casper',
        currency: 'wCSPR',
        amount_motes: authorizedMotes.toString(),
        ...(unservedAuthorization && intent != null ? { expires_at: intent.expiresAt } : {}),
        tx_hash: txHash,
        status: unservedAuthorization ? 'authorized_unserved' : status,
        error,
      });
    }
  }
}
