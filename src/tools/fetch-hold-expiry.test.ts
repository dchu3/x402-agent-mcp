import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// The hold's lifetime follows the SENT PAYLOAD's own validity, not the
// 60-second intent TTL: an authorized_unserved row's expires_at is the MAX of
// the intent's expiry (createdAt + TTL), the challenge's own validity span
// (createdAt + maxTimeoutSeconds*1000 — the seller keeps the authorization
// submittable that long), and for a Solana leg a conservative blockhash
// bound (createdAt + SOLANA_TX_VALIDITY_MS = 150 s). A sent payment that can
// still settle must keep counting its cap for as long as settlement is
// possible — never less.
//
// The rows:
//   - a non-200 paid response without a receipt records an
//     authorized_unserved row (nothing settled, a send happened) whose
//     expires_at follows the payload validity;
//   - a throw AFTER the signed request left the client records the same row
//     on the catch path; the row carries NO captured signature (the client
//     cannot know the on-chain signature at payload time — settle evidence
//     comes only from the response receipt);
//   - the payload-validity expiry helper itself is pure and pinned directly.
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

// Lazy-by-variables at the use sites (the helper export arrives with the feat
// commit); the flow tests below fail on their row pins while it is absent.
const FETCH_MODULE_PATH = './fetch.js';
const fetchModRaw = await import(FETCH_MODULE_PATH).catch(() => undefined) as any;

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
  if (typeof fetchModRaw?.registerFetchTool !== 'function') {
    return () => { throw new Error('src/tools/fetch.ts must export registerFetchTool'); };
  }
  fetchModRaw.registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

function ledgerRows(): any[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function requiresentPayloadExpiryIso(): (intent: { createdAt: string; expiresAt: string; validitySeconds: number }, isSolanaLeg: boolean) => string {
  assert.ok(
    fetchModRaw && typeof fetchModRaw.sentPayloadExpiryIso === 'function',
    'src/tools/fetch.ts must export sentPayloadExpiryIso (the payload-validity expiry seam)',
  );
  return fetchModRaw.sentPayloadExpiryIso;
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

// ---------------------------------------------------------------------------
// Row expiry — served-path row (non-200, no receipt → authorized_unserved).
// The challenge grants 90 s validity; the intent TTL is 60 s; the row's
// expires_at must follow the LONGER payload validity (≥ 85 s after the row
// was written — the old row expired ≈ 60 s after intent creation).
// ---------------------------------------------------------------------------
it('a settled-unreached (non-200, no receipt) row counts until the payload validity, not the intent TTL', async () => {
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

  const row = ledgerRows().find((r) => r.url === url && r.status === 'authorized_unserved');
  assert.ok(row, 'the sent payment is recorded as authorized_unserved');
  const holdSeconds = (Date.parse(row.expires_at) - Date.parse(row.timestamp)) / 1000;
  assert.ok(holdSeconds >= 85, `the hold must span the challenge's 90 s validity (got ${holdSeconds.toFixed(1)} s)`);
  assert.ok(holdSeconds <= 95, `the hold must not run far past it (got ${holdSeconds.toFixed(1)} s)`);
  assert.ok(Math.abs(PM.getDailySpent() - dailyBefore - 0.01) < 1e-9, 'the sent payment counts while its payload is valid');
});

// ---------------------------------------------------------------------------
// Row expiry — the throw-after-send catch-path row. The row carries no
// signature: the sent request's envelope cannot spell the on-chain
// signature (on Solana the first wire-transaction signature slot is the
// facilitator fee payer's; on EVM the payload signature is the
// authorization, not the settlement tx).
// ---------------------------------------------------------------------------
it('a throw after the signed request left records the same validity-based expiry and no signature', async () => {
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
  const holdSeconds = (Date.parse(row.expires_at) - Date.parse(row.timestamp)) / 1000;
  assert.ok(holdSeconds >= 85, `the catch-path hold must span the 90 s validity (got ${holdSeconds.toFixed(1)} s)`);
  assert.ok(holdSeconds <= 95, `the catch-path hold must not run far past it (got ${holdSeconds.toFixed(1)} s)`);
  assert.equal(row.signature, undefined, 'the client cannot know the on-chain signature at payload time — the row carries none');
  assert.ok(Math.abs(PM.getDailySpent() - dailyBefore - 0.01) < 1e-9, 'the sent payment counts while its payload is valid');
});

// ---------------------------------------------------------------------------
// The helper itself: max(intent TTL expiry, challenge validity span, Solana
// blockhash bound) — pure, ISO out, all three sources.
// ---------------------------------------------------------------------------
it('sentPayloadExpiryIso is the max of the three validity sources per leg', () => {
  const sentPayloadExpiryIso = requiresentPayloadExpiryIso();
  const T0 = '2026-10-27T12:00:00.000Z';
  const iso = (ms: number) => new Date(ms).toISOString();
  const t0 = Date.parse(T0);
  const mk = (validitySeconds: number) => ({ createdAt: T0, expiresAt: iso(t0 + 60_000), validitySeconds });

  assert.equal(sentPayloadExpiryIso(mk(90), false), iso(t0 + 90_000), 'a longer challenge validity beats the 60 s intent TTL');
  assert.equal(sentPayloadExpiryIso(mk(30), false), iso(t0 + 60_000), 'the intent TTL beats a shorter validity');
  assert.equal(sentPayloadExpiryIso(mk(200), false), iso(t0 + 200_000));
  assert.equal(sentPayloadExpiryIso(mk(0), false), iso(t0 + 60_000), 'an absent/zero validity is skipped');
  assert.equal(sentPayloadExpiryIso(mk(90), true), iso(t0 + 150_000), 'a Solana leg counts until the blockhash bound at minimum');
  assert.equal(sentPayloadExpiryIso(mk(200), true), iso(t0 + 200_000), 'a longer challenge validity beats the blockhash bound');
  assert.equal(sentPayloadExpiryIso(mk(0), true), iso(t0 + 150_000));
});