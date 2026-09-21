import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';

// Isolate the payment ledger BEFORE importing fetch.js (PAYMENT_LOG_PATH
// pattern from casper-fetch.test.ts / payment-utils.rehydrate.test.ts).
const dir = mkdtempSync(join(tmpdir(), 'x402-fetch-test-'));
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
// Hermetic directory for trust derivation (#19): an empty temp directory keeps
// the tests off the repo-root template-copy path (which would otherwise create
// endpoints.json as a side effect) and pins trust = UNKNOWN deterministically.
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-09-21' }), 'utf8');

const { registerFetchTool } = await import('./fetch.js');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_DIRECTORY_PATH: join(dir, 'endpoints.json') }; });
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

function ledgerLines(): string[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '');
}

let bust = 0;
const extraDirs: string[] = [];
after(() => { for (const d of extraDirs) rmSync(d, { recursive: true, force: true }); });

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
// ---------------------------------------------------------------------------
// Issue #19 — the pre-payment policy boundary in x402_fetch.
// ---------------------------------------------------------------------------

// 402 probe answer advertising a Casper exact offer (1 CSPR = 1e9 motes).
// The wCSPR asset hash comes from the repo's own public constants (casper/
// accepts.ts) rather than a literal — it is an asset ID, not a secret.
const { WCSPR_ASSETS } = await import('../casper/accepts.js') as any;
function casperChallengeFixed() {
  const WCSPR_MAINNET = WCSPR_ASSETS['casper:casper'];
  const payload = JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: 'exact', network: 'casper:casper', amount: '1000000000', payTo: '00' + 'ab'.repeat(32), asset: WCSPR_MAINNET, extra: { name: 'wCSPR' } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
}

it('policy DENY: refused BEFORE the payment layer — only the 402 probe runs', async () => {
  process.env.X402_POLICY_PAYMENTS_ENABLED = 'false';
  const ledgerSnapshot = ledgerLines();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return probeChallengeFixed(); }) as any;
  const result = await handler()({ url: 'https://deny-test.invalid/api' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 1, 'only the 402 probe may hit the network — the paid fetch must never run');
  assert.equal(parsed.policy_decision, 'DENY');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'PAYMENTS_DISABLED'), 'the payment-disabled code must reach the caller');
  assert.ok(parsed.reasons.every((r: any) => typeof r.code === 'string' && typeof r.message === 'string'));
  // Structured refusal keeps the existing error shape keys verbatim...
  for (const key of ['error', 'url', 'chain', 'estimated_cost_usdc', 'daily_spent_usdc', 'max_per_call', 'max_daily']) {
    assert.ok(key in parsed, `refusal must keep existing key ${key}`);
  }
  // ...and nothing may have been logged as a payment attempt.
  assert.deepEqual(ledgerLines(), ledgerSnapshot, 'DENY must not write to the payment ledger');
});

it('default policy: the paid flow completes exactly as before (compat proof through the gate)', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return probeChallengeFixed();
    return new Response('{"result":"ok"}', { status: 200 });
  }) as any;
  const result = await handler()({ url: 'https://compat-test.invalid/api' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 200, 'default policy must not refuse an ordinary payable request');
  assert.equal(parsed.paid, true);
  assert.equal(parsed.cost_usdc, 0.01);
  assert.equal(parsed.policy_decision, undefined, 'ALLOW adds no policy keys to the success output');
});

it('casper gate DENY: policy refuses before the Casper budget machinery', async () => {
  process.env.X402_POLICY_NETWORKS = 'base,solana'; // casper not allowed
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return casperChallengeFixed(); }) as any;
  const result = await handler()({ url: 'https://casper-deny-test.invalid/api', chain: 'casper' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 1, 'only the probe may run — no Casper payment machinery');
  assert.equal(parsed.policy_decision, 'DENY');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'CHAIN_NOT_ALLOWED'));
  assert.equal(parsed.chain, 'casper');
  for (const key of ['error', 'url', 'chain', 'estimated_cost_usdc', 'daily_spent_usdc', 'max_per_call', 'max_daily']) {
    assert.ok(key in parsed, `refusal must keep existing key ${key}`);
  }
});

it('casper default policy: gate passes and the pre-existing budget check still governs (zero behavior change)', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return casperChallengeFixed(); }) as any;
  const result = await handler()({ url: 'https://casper-compat-test.invalid/api', chain: 'casper' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 1);
  assert.ok(
    (parsed.error || '').includes('Paid Casper requests disabled'),
    'the flow must reach casperBudget.check (its fail-closed disabled-by-default error), proving the policy gate allowed it',
  );
  assert.equal(parsed.policy_decision, undefined);
});

it('concurrent budget consumption through the policy engine: 5 parallel requests against 2-worth of budget → exactly 2 allowed', async () => {
  // Mirrors the #18.4 concurrency argument, one layer up: the fetch.ts span
  // around a paid call is evaluate() → logPayment + recordServicePayment, all
  // synchronous, so per-request admission is atomic and exactly 2 of 5 pass.
  const dir2 = mkdtempSync(join(tmpdir(), 'x402-fetch-conc-'));
  extraDirs.push(dir2);
  process.env.PAYMENT_LOG_PATH = join(dir2, 'ledger.jsonl');
  process.env.MAX_DAILY_SPEND = '0.40';
  process.env.MAX_PAYMENT_PER_CALL = '0.20';
  const b = ++bust;
  const { getPolicyEngine, buildPolicyContext } = await import(`../policy/config.js?conc=${b}`) as any;
  const { logPayment, getDailySpent } = await import(`../payment-utils.js?conc=${b}`) as any;
  const { getPerServiceSpent, recordServicePayment } = await import(`../policy/budget-store.js?conc=${b}`) as any;
  const engine = getPolicyEngine();
  const decisions = await Promise.all(
    Array.from({ length: 5 }, async () => {
      const ctx = buildPolicyContext('https://conc.example/api', 'base', 'USDC', 0.20);
      const result = engine.evaluate(ctx, { dailySpentUsd: getDailySpent(), perServiceSpentUsd: getPerServiceSpent('conc.example') });
      if (result.decision === 'ALLOW') {
        // The exact span fetch.ts runs around a paid call (synchronous).
        logPayment({ timestamp: new Date().toISOString(), url: 'https://conc.example/api', method: 'GET', chain: 'base', amount_usdc: 0.20, tx_hash: 'ab'.repeat(32), status: 'success' });
        recordServicePayment('https://conc.example/api', 0.20);
      }
      return result.decision;
    }),
  );
  assert.equal(decisions.filter((d: string) => d === 'ALLOW').length, 2, 'exactly 2 of 5 may consume the 0.40 budget');
  assert.equal(decisions.filter((d: string) => d === 'DENY').length, 3, 'the rest must be denied');
  assert.equal(getDailySpent(), 0.40);
  assert.equal(getPerServiceSpent('conc.example'), 0.40, 'per-service store tracks the same consumption');
});
