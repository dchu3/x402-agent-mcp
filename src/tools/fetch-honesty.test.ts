import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// End-to-end ledger honesty for the sent-and-unknown outcome, through the
// REAL x402_fetch flow (the hermetic fetch-accounting.test.ts pattern: mock
// seller on globalThis.fetch, throwaway runtime key, fully local signing,
// no network, no RPC, no scratch state outside a temp dir):
//
//   - a non-200 answer WITH a decodable success receipt (a transaction
//     hash) writes `settled_unserved` — the only permanent-count path for a
//     sent payment; the receipt is the sole settlement evidence;
//   - a non-200 answer with NO receipt writes `authorized_unserved`:
//     counted NOW, carrying NEITHER `expires_at` NOR `signature` — the
//     outcome is unknown, so the fail-closed bound is the UTC day rollover
//     and no signature is ever invented from the request payload;
//   - a fresh process over the same ledger (a restart, simulated by a
//     cache-busted module instance) rehydrates EXACTLY the same daily total
//     — in-process counting and restart counting can never drift apart.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-fetch-honesty-'));
const LEDGER_PATH = join(dir, 'ledger.jsonl');
const DIRECTORY = join(dir, 'endpoints.json');
writeFileSync(DIRECTORY, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-27' }), 'utf8');
process.env.X402_NETWORK_MODE = 'mainnet';
process.env.PAYMENT_LOG_PATH = LEDGER_PATH;
process.env.X402_DIRECTORY_PATH = DIRECTORY;
process.env.X402_STATE_DIR = join(dir, 'state');
process.env.MAX_PAYMENT_PER_CALL = '50';
process.env.MAX_DAILY_SPEND = '50';
process.env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`;

const PM = (await import('../payment-utils.js')) as typeof import('../payment-utils.js');
const { registerFetchTool } = await import('./fetch.js');

const BASE_CAIP2 = 'eip155:8453';
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_PAYTO = '0x2222222222222222222222222222222222222222';
const SUCCESS_RECEIPT_B64 = Buffer.from(JSON.stringify({ success: true, transaction: 'ab'.repeat(32) })).toString('base64');

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env, PAYMENT_LOG_PATH: LEDGER_PATH, X402_DIRECTORY_PATH: DIRECTORY };
  globalThis.fetch = realFetch;
});
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

const realFetch = globalThis.fetch.bind(globalThis);

function handler() {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

function ledgerRows(): any[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function challenge402(requestUrl: string): Response {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{ scheme: 'exact', network: BASE_CAIP2, asset: BASE_USDC_ADDRESS, amount: '10000', payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': Buffer.from(payload).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') } });
}

function noSignatureHeader(input: unknown, init: unknown): boolean {
  const headers = new Headers(input instanceof Request ? input.headers : (init as any)?.headers);
  return !headers.has('payment-signature') && !headers.has('x-payment');
}

/** Mock seller: the unpaid leg gets the challenge; the signed leg gets
 * `onPaid`. */
function seller(url: string, onPaid: () => Response): void {
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const u = input instanceof Request ? input.url : String(input);
    assert.equal(u, url, 'no other endpoint call may happen');
    if (noSignatureHeader(input, init)) return challenge402(url);
    return onPaid();
  }) as typeof fetch;
}

const tool = handler();

it('ledger honesty end-to-end: a settled receipt settles permanently, a receiptless send counts fail-closed with no expiry, and a restart rehydrates the same total', async () => {
  // 1. Non-200 WITH a success receipt → settled_unserved (permanent count).
  const settledUrl = 'https://honesty-settled.invalid/api';
  seller(settledUrl, () => new Response('{"error":"downstream"}', { status: 502, headers: { 'PAYMENT-RESPONSE': SUCCESS_RECEIPT_B64 } }));
  const dailyStart = PM.getDailySpent();
  const settledResult = JSON.parse((await tool({ url: settledUrl })).content[0].text);
  assert.equal(settledResult.paid, true, `settlement evidence counts: ${JSON.stringify(settledResult)}`);
  assert.equal(settledResult.served, false, 'the request itself was not served');
  const settledRow = ledgerRows().find((r) => r.url === settledUrl);
  assert.equal(settledRow?.status, 'settled_unserved', 'the receipt is the settlement evidence');
  assert.equal(settledRow?.tx_hash, 'ab'.repeat(32));
  assert.equal(settledRow?.amount_usdc, 0.01);
  assert.ok(!('expires_at' in settledRow), 'settled spend never releases — no expiry field');
  assert.equal(settledRow?.signature, undefined, 'no signature is ever taken from the request payload');

  // 2. Non-200 with NO receipt → authorized_unserved: unknown outcome,
  // counted fail-closed, no expiry, no signature.
  const unknownUrl = 'https://honesty-unknown.invalid/api';
  seller(unknownUrl, () => new Response('{"error":"gateway downstream failure"}', { status: 500 }));
  const unknownResult = JSON.parse((await tool({ url: unknownUrl })).content[0].text);
  assert.equal(unknownResult.paid, 'unknown', 'a send without evidence is an unknown outcome, never paid: false');
  assert.equal(unknownResult.served, false);
  assert.equal(unknownResult.cost_usdc, 0.01, 'the counted amount is the signed amount');
  assert.match(String(unknownResult.note ?? ''), /do not retry blindly/i);
  const unknownRow = ledgerRows().find((r) => r.url === unknownUrl);
  assert.equal(unknownRow?.status, 'authorized_unserved');
  assert.equal(unknownRow?.amount_usdc, 0.01, 'the unknown outcome counts (fail closed)');
  assert.ok(!('expires_at' in unknownRow), 'no expiry — the count ends only at the UTC day rollover');
  assert.equal(unknownRow?.signature, undefined, 'the client cannot know the on-chain signature at payload time');
  assert.equal(PM.isCountedSpend(unknownRow, Date.now()), true, 'counted now');
  assert.equal(PM.isCountedSpend(unknownRow, Date.now() + 400_000), true, 'no ~150 s release exists — an unknown outcome keeps counting');

  // 3. In-process total and restart parity over the SAME ledger.
  const inProcess = PM.getDailySpent();
  assert.ok(Math.abs(inProcess - dailyStart - 0.02) < 1e-9, 'both sends count: the settled and the unknown alike');
  const restarted = (await import(`../payment-utils.js?honesty=${Date.now()}`)) as typeof import('../payment-utils.js');
  assert.ok(Math.abs(restarted.getDailySpent() - inProcess) < 1e-9, 'a restart rehydrates EXACTLY the same daily total');
});
