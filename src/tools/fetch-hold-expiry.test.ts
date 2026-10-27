import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// A sent-but-unproven payment is spend with an UNKNOWN outcome — it may have
// settled, so the fail-closed direction is over-count: the
// authorized_unserved row is written with NO expires_at and counts until the
// UTC day rollover (the per-day counter's own reset ends the count). Nothing
// else may release it: not the intent TTL, not the challenge's validity
// span, not a Solana blockhash bound — a release at ~150 s would silently
// un-count a payment that may already have settled on chain. The row also
// carries NO signature: the client cannot know the on-chain signature at
// payload time (on Solana the first wire-transaction signature slot is the
// facilitator fee payer's and the client only partially signs), so settle
// evidence comes only from the response receipt.
//
// The rows:
//   - a non-200 paid response without a receipt records an
//     authorized_unserved row (nothing settled, a send happened) with no
//     expiry and no signature;
//   - a throw AFTER the signed request left the client records the same row
//     on the catch path;
//   - both rows count immediately and a fresh process over the same ledger
//     rehydrates the same total (restart parity).
//
// Drive the REAL x402_fetch flow against a loopback mock seller (the
// hermetic fetch-accounting.test.ts pattern: boundable Base offer, throwaway
// runtime key, fully local signing, no live network, no RPC).
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-hold-expiry-'));
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
const PRICE_ATOMIC = '10000'; // $0.01

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

function challenge402(requestUrl: string, maxTimeoutSeconds: number): Response {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{ scheme: 'exact', network: BASE_CAIP2, asset: BASE_USDC_ADDRESS, amount: PRICE_ATOMIC, payTo: BASE_PAYTO, maxTimeoutSeconds, extra: { name: 'USD Coin', version: '2' } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': Buffer.from(payload).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') } });
}

function noSignatureHeader(input: unknown, init: unknown): boolean {
  const headers = new Headers(input instanceof Request ? input.headers : (init as any)?.headers);
  return !headers.has('payment-signature') && !headers.has('x-payment');
}

const tool = handler();

let bust = 0;
/** A "fresh process" read: a cache-busted instance whose FIRST counted read
 * rehydrates from the CURRENT ledger — exactly what a restart would see. */
async function restartedTotal(): Promise<number> {
  const fresh = (await import(`../payment-utils.js?holdexpiry=${++bust}`)) as typeof import('../payment-utils.js');
  return fresh.getDailySpent();
}

// ---------------------------------------------------------------------------
// Served-path row (non-200, no receipt → authorized_unserved). The outcome
// is unknown — the row carries no expiry and counts for the rest of the day.
// ---------------------------------------------------------------------------
it('a settled-unreached (non-200, no receipt) row counts fail-closed: no expires_at, no signature, to the UTC day rollover', async () => {
  const url = 'https://hold-expiry-500.invalid/api';
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const u = input instanceof Request ? input.url : String(input);
    assert.equal(u, url, 'no other endpoint call may happen');
    if (noSignatureHeader(input, init)) return challenge402(url, 90);
    return new Response('{"error":"gateway downstream failure"}', { status: 500 });
  }) as typeof fetch;
  const dailyBefore = PM.getDailySpent();
  const result = await tool({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.paid, 'unknown', 'the sent payment without evidence is an unknown outcome');
  assert.match(String(parsed.note ?? ''), /UTC day rollover/i, 'the operator-facing note names the fail-closed bound');

  const row = ledgerRows().find((r) => r.url === url && r.status === 'authorized_unserved');
  assert.ok(row, 'the sent payment is recorded as authorized_unserved');
  assert.ok(!('expires_at' in row), 'the row carries no expiry — nothing under the day rollover releases it');
  assert.equal(row.signature, undefined, 'the client cannot know the on-chain signature at payload time — the row carries none');
  assert.equal(PM.isCountedSpend(row, Date.now()), true, 'the row counts now');
  assert.equal(PM.isCountedSpend(row, Date.now() + 150_000), true, 'no ~150 s release exists — the outcome is still unknown');
  assert.equal(PM.isCountedSpend(row, Date.now() + 20 * 3_600_000), true, 'the row still counts twenty hours on (the UTC day rollover is the bound)');
  assert.ok(Math.abs(PM.getDailySpent() - dailyBefore - 0.01) < 1e-9, 'the sent payment counts while its outcome is unknown');
  assert.ok(Math.abs((await restartedTotal()) - PM.getDailySpent()) < 1e-9, 'a restarted process rehydrates the identical total');
});

// ---------------------------------------------------------------------------
// The throw-after-send catch-path row: the same fail-closed shape.
// ---------------------------------------------------------------------------
it('a throw after the signed request left records the same no-expiry, no-signature counted row', async () => {
  const url = 'https://hold-expiry-throw.invalid/api';
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const u = input instanceof Request ? input.url : String(input);
    assert.equal(u, url, 'no other endpoint call may happen');
    if (noSignatureHeader(input, init)) return challenge402(url, 90);
    // Simulate a transport failure after the signed request left: the
    // response stream is destroyed before any bytes are read.
    return new Response(new ReadableStream({ start(c) { c.error(new Error('connection reset')); } }));
  }) as typeof fetch;
  const dailyBefore = PM.getDailySpent();
  const result = await tool({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.paid, 'unknown', 'the throw after the send is an unknown outcome');

  const row = ledgerRows().find((r) => r.url === url && r.status === 'authorized_unserved');
  assert.ok(row, 'the throw after send records an authorized_unserved row');
  assert.ok(!('expires_at' in row), 'the catch-path row carries no expiry either');
  assert.equal(row.signature, undefined, 'no signature is fabricated from the payload envelope');
  assert.equal(PM.isCountedSpend(row, Date.now()), true, 'the row counts immediately');
  assert.ok(Math.abs(PM.getDailySpent() - dailyBefore - 0.01) < 1e-9, 'the sent payment counts while its outcome is unknown');
  assert.ok(Math.abs((await restartedTotal()) - PM.getDailySpent()) < 1e-9, 'restart parity on the catch-path row too');
});

// ---------------------------------------------------------------------------
// Legacy-read semantics: a row written BEFORE the fail-closed change still
// carries its old expires_at — the read path honours it (a past expiry still
// releases; the ledger is never rewritten).
// ---------------------------------------------------------------------------
it('a legacy authorized_unserved row with a past expires_at still releases (backward-compatible read)', () => {
  const legacy = {
    timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
    url: 'https://legacy-expired.invalid/api',
    method: 'GET',
    chain: 'base',
    amount_usdc: 0.05,
    status: 'authorized_unserved',
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  };
  assert.equal(PM.isCountedSpend(legacy, Date.now()), false, 'a legacy row past its expiry releases exactly as before');
  assert.equal(
    PM.isCountedSpend({ ...legacy, expires_at: new Date(Date.now() + 60_000).toISOString() }, Date.now()),
    true,
    'a legacy row inside its expiry still counts',
  );
});
