import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';

// Isolate the payment ledger BEFORE importing fetch.js (PAYMENT_LOG_PATH
// pattern from casper-fetch.test.ts / payment-utils.rehydrate.test.ts).
const dir = mkdtempSync(join(tmpdir(), 'x402-fetch-test-'));
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');

const { registerFetchTool } = await import('./fetch.js');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl') }; });
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

function handler() {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

// Real (throwaway) ed25519 keypair so the Solana scheme constructs locally —
// no network, and payment is never attempted because the probe is answered
// with a plain 200.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = Buffer.from(publicKey.export({ type: 'spki', format: 'der' } as any).slice(-32) as unknown as Uint8Array);
const priv = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' } as any).slice(16) as unknown as Uint8Array); // 32-byte seed
const SOLANA_KEY_B58 = bs58.encode(Buffer.concat([priv, pub]));
process.env.SOLANA_PRIVATE_KEY = SOLANA_KEY_B58;
env.SOLANA_PRIVATE_KEY = SOLANA_KEY_B58; // survive the afterEach env restore

const b64url = (s: string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// 402 probe answer advertising a Solana exact offer (amount 10000 units → $0.01)
const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'; // canonical mainnet CAIP-2 (contains 'solana' for auto-detection)
function probeChallengeFixed() {
  const payload = JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: 'exact', network: SOLANA_CAIP2, amount: '10000', payTo: 'SoLWallet', extra: { name: 'USDC' } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
}

const receiptB64 = Buffer.from(JSON.stringify({ success: true, transaction: 'ab'.repeat(32) })).toString('base64');

it('paid fetch output marks the settlement receipt as server-provided, unverified', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return probeChallengeFixed(); // probe: 402 with Solana offer
    return new Response('{"result":"ok"}', { status: 200, headers: { 'PAYMENT-RESPONSE': receiptB64 } });
  }) as any;
  const result = await handler()({ url: 'https://receipt-test.invalid/api' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 200, 'flow must reach the paid-fetch output block');
  assert.equal(parsed.receipt_verified, false, '#18.5: output must state receipts are NOT independently verified');
  assert.equal(parsed.receipt_note, 'server-provided, not independently verified on-chain');
  assert.equal(parsed.payment_receipt, receiptB64, 'compat key payment_receipt is kept with the raw value');
});

it('paid fetch output is honest even when no receipt header is present', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return probeChallengeFixed();
    return new Response('{"result":"ok"}', { status: 200 });
  }) as any;
  const result = await handler()({ url: 'https://receipt-test.invalid/api' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.payment_receipt, null);
  assert.equal(parsed.receipt_verified, false, 'trust marking must not depend on a receipt being present');
  assert.equal(parsed.receipt_note, 'server-provided, not independently verified on-chain');
});