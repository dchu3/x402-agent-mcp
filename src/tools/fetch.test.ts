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

// ---------------------------------------------------------------------------
// Per-service ledger parity (post-#23 follow-up): the per-service in-memory
// store and the ledger must agree across a restart. Rehydration filters ledger
// entries by status === "success", so fetch.ts must apply the SAME accounting
// rule logPayment applies (resp.status === 200) when calling
// recordServicePayment — otherwise a non-200 settled response (e.g.
// 500-after-settlement) counts in-process but vanishes from the ledger,
// silently loosening the per-service cap across a restart.
// ---------------------------------------------------------------------------

it('per-service parity control: a 200 settled response still records and rehydrates identically after a restart', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const host = 'parity-200-test.invalid';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return probeChallengeFixed(); // probe: 402 with a $0.01 Solana offer
    return new Response('{"result":"ok"}', { status: 200 }); // settled 200
  }) as any;
  const result = await handler()({ url: `https://${host}/api` });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 200, 'the flow must reach the accounting block through a settled 200');

  const store = await import('../policy/budget-store.js') as typeof import('../policy/budget-store.js'); // same instance fetch.js records into
  const inProcess = store.getPerServiceSpent(host);
  const restarted = await import(`../policy/budget-store.js?parity200=${++bust}`) as typeof import('../policy/budget-store.js'); // "restart": fresh module against the same ledger
  const rehydrated = restarted.getPerServiceSpent(host);
  assert.equal(inProcess, 0.01, 'a 200 response must still be recorded in-process');
  assert.equal(rehydrated, 0.01, 'a 200 response must rehydrate from the ledger after a restart');
  assert.equal(inProcess, rehydrated, 'in-process and rehydrated per-service spend must be identical');
});

it('per-service parity: a non-200 settled response (500-after-settlement) must not loosen the cap across a restart', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const host = 'parity-non200-test.invalid';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return probeChallengeFixed(); // probe: 402 with a $0.01 Solana offer
    return new Response('server error', { status: 500 }); // settled, then the server failed
  }) as any;
  const result = await handler()({ url: `https://${host}/api` });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 500, 'the flow must reach the accounting block through a non-200 response');
  // The ledger DID capture the attempted settlement (logPayment always logs),
  // but as status "failed" — exactly the entries rehydration drops.
  const failedEntry = ledgerLines().map((l) => JSON.parse(l)).find((e: any) => e.url === `https://${host}/api`);
  assert.ok(failedEntry, 'the non-200 settlement attempt must appear in the ledger');
  assert.equal(failedEntry.status, 'failed');

  const store = await import('../policy/budget-store.js') as typeof import('../policy/budget-store.js'); // same instance fetch.js records into
  const inProcess = store.getPerServiceSpent(host);
  const restarted = await import(`../policy/budget-store.js?paritynon200=${++bust}`) as typeof import('../policy/budget-store.js'); // "restart": fresh module against the same ledger
  const rehydrated = restarted.getPerServiceSpent(host);
  assert.equal(inProcess, rehydrated, `PARITY: in-process spend (${inProcess}) must equal post-restart spend (${rehydrated}) for the same ledger`);
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

// ---------------------------------------------------------------------------
// Issue #25 — the payment-intent boundary in x402_fetch.
//
// The boundary is at signing/payload creation, never at the HTTP request
// (amendment 1): the retained probe offer is bound to a payment intent after
// the policy ALLOW; the x402 client's onBeforePaymentCreation hook aborts any
// payload whose selected requirements drift from the intent; an offer that
// cannot be bound registers a blocking hook so it can never be PAID, while
// unpaid/non-402 responses pass through unchanged.
// ---------------------------------------------------------------------------

// The SDK's spendControls reject non-default assets BEFORE hooks run, so the
// paid-leg challenge must advertise the SDK's own well-known USDC mint
// constant (a public protocol identifier, not a secret) — same convention as
// the WCSPR_ASSETS constants used by the Casper tests above.
const { USDC_MAINNET_ADDRESS } = await import('@x402/svm') as any;
const BINDABLE_SOLANA_ASSET: string = USDC_MAINNET_ADDRESS;

/** Full x402 v2 challenge the SDK can parse on the PAID leg. */
function bindableSolanaChallenge(amount: string, requestUrl: string) {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{ scheme: 'exact', network: SOLANA_CAIP2, asset: BINDABLE_SOLANA_ASSET, amount, payTo: 'SoLWallet', maxTimeoutSeconds: 60, extra: { name: 'USDC' } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
}

function noSignatureHeader(input: unknown, init: unknown): boolean {
  const headers = new Headers(input instanceof Request ? input.headers : (init as any)?.headers);
  return headers.has('payment-signature');
}

it('intent boundary: price raised between probe and paid challenge ⇒ abort before signing, structured refusal, no ledger success', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const url = 'https://price-raised-test.invalid/api';
  let calls = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    calls++;
    assert.equal(noSignatureHeader(input, init), false, 'a signature must never exist for a mismatched offer');
    if (calls === 1) return bindableSolanaChallenge('10000', url); // probe: $0.01 offer
    return bindableSolanaChallenge('20000', url);                  // paid leg: price doubled
  }) as any;
  const before = ledgerLines();
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 2, 'probe + one paid attempt — the abort happens before any signed retry');
  assert.equal(parsed.policy_decision, 'ALLOW', 'policy allowed; the intent boundary is what refused');
  assert.deepEqual(parsed.reasons.map((r: any) => r.code), ['INTENT_UNAUTHORISED', 'OFFER_MISMATCH']);
  assert.match(parsed.error, /payment-intent boundary/);
  assert.match(parsed.reasons[1].message, /amount/, 'the drifted field is named');
  for (const key of ['error', 'url', 'chain', 'estimated_cost_usdc', 'daily_spent_usdc', 'max_per_call', 'max_daily']) {
    assert.ok(key in parsed, `refusal keeps the #19 key ${key}`);
  }
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.ok(!entries.some((e: any) => e.url === url && e.status === 'success'), 'no ledger success for an aborted payment');
  assert.equal(entries.find((e: any) => e.url === url)?.status, 'failed', 'the aborted attempt is audited like any other failure');
});

it('intent boundary: an offer with an unbindable amount/asset can never be paid (INTENT_UNAUTHORISED — amendment 1)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const url = 'https://unbindable-test.invalid/api';
  function unbindableProbe() {
    // Malformed/legacy-shaped offer: no amount, no asset.
    const payload = JSON.stringify({
      x402Version: 2,
      accepts: [{ scheme: 'exact', network: SOLANA_CAIP2, payTo: 'SoLWallet', extra: { name: 'USDC' } }],
    });
    return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
  }
  let calls = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    calls++;
    assert.equal(noSignatureHeader(input, init), false, 'payment-payload creation must never happen');
    if (calls === 1) return unbindableProbe();
    return bindableSolanaChallenge('10000', url); // the paid leg WOULD charge — blocked at the hook
  }) as any;
  const before = ledgerLines();
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 2, 'the HTTP request is never refused — the paid fetch runs and signing is blocked');
  assert.equal(parsed.policy_decision, 'ALLOW');
  assert.deepEqual(parsed.reasons.map((r: any) => r.code), ['INTENT_UNAUTHORISED', 'AMOUNT_UNBINDABLE']);
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.ok(!entries.some((e: any) => e.url === url && e.status === 'success'), 'no ledger success');
});

it('intent boundary compat proof: an unpaid endpoint answers 200 directly — no payload creation occurred', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  let calls = 0;
  let signatureSeen = false;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    calls++;
    if (noSignatureHeader(input, init)) signatureSeen = true;
    if (calls === 1) return probeChallengeFixed(); // legacy-shaped offer (no asset) — intent binds asset ''
    return new Response('{"result":"ok"}', { status: 200 }); // call 2 answers 200 directly: the SDK never creates a payload
  }) as any;
  const result = await handler()({ url: 'https://intent-compat-test.invalid/api' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 2, 'the pass-through claim is proven: probe + direct 200');
  assert.equal(signatureSeen, false, 'no payment payload was ever created or attached');
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.cost_usdc, 0.01);
  assert.equal(parsed.policy_decision, undefined, 'ALLOW adds no policy keys to the success output');
});

it('intent boundary: Casper payTo swapped between probe and payment ⇒ aborted before budget reserve', async () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL = '1';
  process.env.CASPER_MAX_DAILY_SPEND = '10';
  process.env.CASPER_PRIVATE_KEY = '11'.repeat(32);
  const url = 'https://casper-swap-test.invalid/api';
  const originalPayTo = '00' + 'ab'.repeat(32);
  const swappedPayTo = '00' + 'cd'.repeat(32);
  function casperChallengeWith(payTo: string) {
    const payload = JSON.stringify({
      x402Version: 2,
      resource: { url, description: '', mimeType: 'text/plain' },
      accepts: [{ scheme: 'exact', network: 'casper:casper', asset: WCSPR_ASSETS['casper:casper'], payTo, amount: '1000000000', maxTimeoutSeconds: 60, extra: { name: 'wCSPR' } }],
    });
    return new Response(payload, { status: 402, headers: { 'payment-required': Buffer.from(payload).toString('base64') } });
  }
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return casperChallengeWith(calls === 1 ? originalPayTo : swappedPayTo);
  }) as any;
  const { casperBudget } = await import('../casper/budget.js');
  const before = casperBudget.getDailySpent();
  const result = await handler()({ url, chain: 'casper' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 2, 'probe + one paid attempt — signing aborts at the hook');
  assert.match(parsed.error, /failed/, 'a swapped offer must fail, never pay the stranger');
  assert.equal(casperBudget.getDailySpent(), before, 'the intent hook runs BEFORE guardCasperPayments: no budget reserve happened');
});

it('intent boundary integration: an intent that expires before payload creation is refused at signing (INTENT_EXPIRED)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.X402_INTENT_TTL_MS = '1'; // 1 ms TTL — deterministic expiry once the paid leg arrives later
  const url = 'https://intent-expiry-test.invalid/api';
  let calls = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    calls++;
    assert.equal(noSignatureHeader(input, init), false, 'an expired intent must never produce a signature');
    if (calls > 1) await new Promise((r) => setTimeout(r, 10)); // let the TTL elapse before the paid challenge arrives
    return bindableSolanaChallenge('10000', url);
  }) as any;
  const before = ledgerLines();
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 2, 'probe + one paid attempt — expiry aborts inside the SDK hook');
  assert.deepEqual(parsed.reasons.map((r: any) => r.code), ['INTENT_UNAUTHORISED', 'EXPIRED']);
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.ok(!entries.some((e: any) => e.url === url && e.status === 'success'), 'no ledger success for an expired intent');
});

// ---------------------------------------------------------------------------
// Issue #25 forced-chain fix — a forced base/solana chain must still observe
// the offer (the same single free 402 probe the auto-detect path performs) so
// the payment intent can bind it. The probe never replaces the caller's
// forced chain and never refuses the HTTP request (amendment 1: the boundary
// stays at signing). The first two tests would have caught the regression:
// before the fix a forced chain skipped the probe entirely, probedOffer
// stayed undefined, and every perfectly payable forced-chain request was
// refused INTENT_UNAUTHORISED:MALFORMED before signing.
// ---------------------------------------------------------------------------

// Well-known public protocol identifiers (same convention as the
// USDC_MAINNET_ADDRESS / WCSPR_ASSETS constants above): the SPL Token
// program id and the USDC contract on Base. Fake-but-well-formed wallets /
// blockhashes are 32 bytes base58 / 20 bytes hex — identifiers, not secrets.
const { TOKEN_PROGRAM_ADDRESS } = await import('@x402/svm') as any;
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_CAIP2 = 'eip155:8453';
const CHARGE_PAYTO_B58 = bs58.encode(Buffer.alloc(32, 0x07));
const CHARGE_FEE_PAYER_B58 = bs58.encode(Buffer.alloc(32, 0x09));
const CHARGE_BLOCKHASH_B58 = bs58.encode(Buffer.alloc(32, 0x05));
const BASE_PAYTO = '0x2222222222222222222222222222222222222222';

/** v2 challenge the SVM scheme can actually sign: feePayer is required by
 * the scheme, and extra.recentBlockhash avoids the getLatestBlockhash RPC
 * round-trip (the single mint-metadata fetch is answered by the simulated
 * RPC below). */
function chargeableSolanaChallenge(requestUrl: string) {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{ scheme: 'exact', network: SOLANA_CAIP2, asset: BINDABLE_SOLANA_ASSET, amount: '10000', payTo: CHARGE_PAYTO_B58, maxTimeoutSeconds: 60, extra: { name: 'USDC', feePayer: CHARGE_FEE_PAYER_B58, recentBlockhash: CHARGE_BLOCKHASH_B58 } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
}

/** v2 challenge the EVM scheme signs fully locally (EIP-3009 signTypedData)
 * — extra.name/version are the EIP-712 domain parameters the scheme requires. */
function chargeableBaseChallenge(requestUrl: string) {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{ scheme: 'exact', network: BASE_CAIP2, asset: BASE_USDC_ADDRESS, amount: '10000', payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
}

const RPC_SIM_URL = 'https://rpc-sim.invalid';

/** A valid 82-byte SPL mint account: owner = Token program, decimals 6,
 * initialized, COption<Pubkey> authorities as u32 0 + 32 zero bytes. */
const MINT_ACCOUNT_B64 = (() => {
  const mint = Buffer.alloc(82);
  mint.writeUInt8(6, 44); // decimals
  mint.writeUInt8(1, 45); // isInitialized
  return mint.toString('base64');
})();

function rpcSimResponse(rpcBody: string) {
  const { id, method } = JSON.parse(rpcBody);
  assert.equal(method, 'getAccountInfo', 'the only RPC touchpoint left is the mint-metadata fetch (recentBlockhash is bound in the offer)');
  return new Response(JSON.stringify({
    jsonrpc: '2.0', id,
    result: { context: { apiVersion: '2.2.0', slot: 1234 }, value: { data: [MINT_ACCOUNT_B64, 'base64'], executable: false, lamports: 1000000, owner: TOKEN_PROGRAM_ADDRESS, rentEpoch: 0, space: 82 } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function requestBodyText(input: unknown, init: unknown): Promise<string> {
  if (init && typeof (init as any).body === 'string') return (init as any).body;
  if (input instanceof Request) return await input.clone().text();
  return '';
}

it('forced chain solana: a well-formed bindable offer binds an intent and the paid flow completes (the regression test)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.SOLANA_RPC_URL = RPC_SIM_URL;
  const url = 'https://forced-solana-happy-test.invalid/api';
  let probes = 0, paidAttempts = 0, rpcCalls = 0, signedRetries = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const urlStr = input instanceof Request ? input.url : String(input);
    if (urlStr.startsWith(RPC_SIM_URL)) {
      rpcCalls++;
      return rpcSimResponse(await requestBodyText(input, init));
    }
    assert.equal(urlStr, url, 'no other endpoint call may happen');
    if (noSignatureHeader(input, init)) {
      signedRetries++;
      return new Response('{"result":"ok"}', { status: 200, headers: { 'PAYMENT-RESPONSE': receiptB64 } });
    }
    if (probes === 0) { probes++; return chargeableSolanaChallenge(url); } // the forced-chain probe (free: a 402, no payment)
    paidAttempts++;
    return chargeableSolanaChallenge(url); // the paid leg — binds, validates, signs, retries
  }) as any;
  const before = ledgerLines();
  const result = await handler()({ url, chain: 'solana' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(probes, 1, 'a forced base/solana chain must still run the single free probe to observe the offer');
  assert.equal(paidAttempts, 1);
  assert.equal(rpcCalls, 1, 'payload creation ran — the intent bound the offer instead of blocking it');
  assert.equal(signedRetries, 1, 'the payment was signed and retried — the regression refused exactly here');
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.chain, 'solana');
  assert.equal(parsed.cost_usdc, 0.01);
  assert.equal(parsed.payment_receipt, receiptB64);
  assert.equal(parsed.policy_decision, undefined, 'ALLOW adds no policy keys to the success output');
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.equal(entries.find((e: any) => e.url === url)?.status, 'success', 'a completed forced-chain payment is accounted as success');
});

it('forced chain base: a well-formed bindable EVM offer binds an intent and the paid flow completes', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`; // throwaway key — EIP-3009 signing is fully local
  const url = 'https://forced-base-happy-test.invalid/api';
  let probes = 0, paidAttempts = 0, signedRetries = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const urlStr = input instanceof Request ? input.url : String(input);
    assert.equal(urlStr, url, 'the EVM path must make no other network calls');
    if (noSignatureHeader(input, init)) {
      signedRetries++;
      return new Response('{"result":"ok"}', { status: 200, headers: { 'PAYMENT-RESPONSE': receiptB64 } });
    }
    if (probes === 0) { probes++; return chargeableBaseChallenge(url); } // the forced-chain probe
    paidAttempts++;
    return chargeableBaseChallenge(url); // the paid leg
  }) as any;
  const before = ledgerLines();
  const result = await handler()({ url, chain: 'base' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(probes, 1, 'forced base must observe the offer through the same single probe');
  assert.equal(paidAttempts, 1);
  assert.equal(signedRetries, 1, 'the payment was signed — the forced-chain boundary did not refuse it');
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.chain, 'base');
  assert.equal(parsed.cost_usdc, 0.01);
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.equal(entries.find((e: any) => e.url === url)?.status, 'success');
});

it('forced chain solana: an unbindable probed offer (no amount) is still refused before signing — the fix opens no hole', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const url = 'https://forced-unbindable-amount-test.invalid/api';
  function unbindableAmountChallenge() {
    // Malformed/legacy-shaped offer: no amount, no asset — money cannot be bound.
    const payload = JSON.stringify({
      x402Version: 2,
      accepts: [{ scheme: 'exact', network: SOLANA_CAIP2, payTo: CHARGE_PAYTO_B58, extra: { name: 'USDC' } }],
    });
    return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
  }
  let probes = 0, paidAttempts = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    assert.equal(noSignatureHeader(input, init), false, 'payment-payload creation must never happen');
    if (probes === 0) { probes++; return unbindableAmountChallenge(); } // probe: unbindable
    paidAttempts++;
    return chargeableSolanaChallenge(url); // the paid leg WOULD charge — blocked at the hook
  }) as any;
  const before = ledgerLines();
  const result = await handler()({ url, chain: 'solana' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(probes, 1);
  assert.equal(paidAttempts, 1, 'the HTTP request is never refused — the refusal lands at signing');
  assert.equal(parsed.policy_decision, 'ALLOW', 'policy allowed; the intent boundary is what refused');
  assert.deepEqual(parsed.reasons.map((r: any) => r.code), ['INTENT_UNAUTHORISED', 'AMOUNT_UNBINDABLE']);
  assert.match(parsed.error, /payment-intent boundary/);
  for (const key of ['error', 'url', 'chain', 'estimated_cost_usdc', 'daily_spent_usdc', 'max_per_call', 'max_daily']) {
    assert.ok(key in parsed, `refusal keeps the #19 key ${key}`);
  }
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.ok(!entries.some((e: any) => e.url === url && e.status === 'success'), 'no ledger success for a refused payment');
});

it('forced chain solana: a probed offer with no payTo cannot bind a recipient — refused before signing (MALFORMED)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const url = 'https://forced-no-payto-test.invalid/api';
  function noPayToChallenge() {
    const payload = JSON.stringify({
      x402Version: 2,
      accepts: [{ scheme: 'exact', network: SOLANA_CAIP2, asset: BINDABLE_SOLANA_ASSET, amount: '10000', extra: { name: 'USDC' } }], // no payTo
    });
    return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
  }
  let probes = 0, paidAttempts = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    assert.equal(noSignatureHeader(input, init), false, 'payment-payload creation must never happen');
    if (probes === 0) { probes++; return noPayToChallenge(); }
    paidAttempts++;
    return chargeableSolanaChallenge(url); // would charge — blocked at the hook
  }) as any;
  const before = ledgerLines();
  const result = await handler()({ url, chain: 'solana' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(probes, 1);
  assert.equal(paidAttempts, 1);
  assert.equal(parsed.policy_decision, 'ALLOW');
  assert.deepEqual(parsed.reasons.map((r: any) => r.code), ['INTENT_UNAUTHORISED', 'MALFORMED']);
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.ok(!entries.some((e: any) => e.url === url && e.status === 'success'), 'no ledger success for a refused payment');
});

it('auto-detect control: chain omitted still binds from the probe offer and completes the paid flow (auto-detect behaviour unchanged)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.SOLANA_RPC_URL = RPC_SIM_URL;
  const url = 'https://auto-detect-control-test.invalid/api';
  let probes = 0, paidAttempts = 0, rpcCalls = 0, signedRetries = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const urlStr = input instanceof Request ? input.url : String(input);
    if (urlStr.startsWith(RPC_SIM_URL)) {
      rpcCalls++;
      return rpcSimResponse(await requestBodyText(input, init));
    }
    assert.equal(urlStr, url, 'no other endpoint call may happen');
    if (noSignatureHeader(input, init)) {
      signedRetries++;
      return new Response('{"result":"ok"}', { status: 200 });
    }
    if (probes === 0) { probes++; return chargeableSolanaChallenge(url); }
    paidAttempts++;
    return chargeableSolanaChallenge(url);
  }) as any;
  const before = ledgerLines();
  const result = await handler()({ url }); // no chain — the auto-detect path drove this suite from the start
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(probes, 1);
  assert.equal(paidAttempts, 1);
  assert.equal(rpcCalls, 1);
  assert.equal(signedRetries, 1, 'auto-detect still signs and completes exactly as before');
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.chain, 'solana', 'chain is still detected from the probed offer');
  assert.equal(parsed.cost_usdc, 0.01);
  assert.equal(parsed.policy_decision, undefined);
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.equal(entries.find((e: any) => e.url === url)?.status, 'success');
});

it('forced chain solana: an endpoint that does not charge (probe answers 200) passes through unchanged — the probe never refuses the request', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const url = 'https://forced-passthrough-test.invalid/api';
  let calls = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    calls++;
    assert.equal(noSignatureHeader(input, init), false, 'no payment payload was ever created or attached');
    return new Response('{"result":"ok"}', { status: 200 });
  }) as any;
  const before = ledgerLines();
  const result = await handler()({ url, chain: 'solana' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 2, 'probe + paid fetch — a free endpoint under a forced chain is never refused');
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.policy_decision, undefined, 'ALLOW adds no policy keys to the success output');
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.equal(entries.find((e: any) => e.url === url)?.status, 'success');
});

// ---------------------------------------------------------------------------
// Issue #26 — the probe recipient enters the policy gate (rule 4.5).
// Base/Solana: the Step 3.5 gate evaluates the probed payTo. Casper: the pure
// selectCasperAccept is hoisted above the gate so the Casper leg can evaluate
// its recipient too — the throw/budget/intent order below the gate is
// untouched. Compat default (change-detect, no baselines) fires nothing.
// ---------------------------------------------------------------------------

function policyConfigFile(content: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), 'x402-fetch-rcpt-'));
  extraDirs.push(d);
  const p = join(d, 'policy.json');
  writeFileSync(p, JSON.stringify(content), 'utf8');
  return p;
}

it('recipient allowlist DENY: the wrong probed recipient is refused by policy before the payment layer', async () => {
  const strangerWallet = bs58.encode(Buffer.alloc(32, 0x0b));
  process.env.POLICY_CONFIG_PATH = policyConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    recipients: { mode: 'allowlist', allowed: [strangerWallet], perService: {}, known: {} },
  });
  const url = 'https://rcpt-deny-test.invalid/api';
  const before = ledgerLines();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return chargeableSolanaChallenge(url); }) as any;
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 1, 'only the 402 probe may hit the network — the paid fetch must never run');
  assert.equal(parsed.policy_decision, 'DENY');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'RECIPIENT_NOT_ALLOWED'), 'the recipient code must reach the caller');
  assert.match(
    parsed.reasons.find((r: any) => r.code === 'RECIPIENT_NOT_ALLOWED').message,
    /CHARGE_PAYTO_B58|not in the allowlist/,
    'the refusal must name the compared recipient (the probed payTo), not a vague generic message',
  );
  assert.deepEqual(ledgerLines(), before, 'DENY must not write to the payment ledger');
});

it('recipient allowlist: the matching probed recipient pays exactly as before (no false positives)', async () => {
  process.env.POLICY_CONFIG_PATH = policyConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    recipients: { mode: 'allowlist', allowed: [CHARGE_PAYTO_B58], perService: {}, known: {} },
  });
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.SOLANA_RPC_URL = RPC_SIM_URL;
  const url = 'https://rcpt-allow-test.invalid/api';
  let probes = 0, paidAttempts = 0, rpcCalls = 0, signedRetries = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const urlStr = input instanceof Request ? input.url : String(input);
    if (urlStr.startsWith(RPC_SIM_URL)) {
      rpcCalls++;
      return rpcSimResponse(await requestBodyText(input, init));
    }
    assert.equal(urlStr, url, 'no other endpoint call may happen');
    if (noSignatureHeader(input, init)) {
      signedRetries++;
      return new Response('{"result":"ok"}', { status: 200, headers: { 'PAYMENT-RESPONSE': receiptB64 } });
    }
    if (probes === 0) { probes++; return chargeableSolanaChallenge(url); }
    paidAttempts++;
    return chargeableSolanaChallenge(url);
  }) as any;
  const before = ledgerLines();
  const result = await handler()({ url, chain: 'solana' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(probes, 1);
  assert.equal(paidAttempts, 1);
  assert.equal(rpcCalls, 1);
  assert.equal(signedRetries, 1, 'the listed recipient must still be signed and paid');
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.cost_usdc, 0.01);
  assert.equal(parsed.policy_decision, undefined, 'ALLOW adds no policy keys to the success output');
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.equal(entries.find((e: any) => e.url === url)?.status, 'success');
});

it('recipient change-detect: a Casper payTo differing from the recorded baseline is refused at the gate before casperBudget/reserve', async () => {
  const url = 'https://casper-rcpt-mismatch-test.invalid/api';
  const roguePayTo = '00' + 'cd'.repeat(32); // NOT the payTo the probe advertises ('00' + 'ab'.repeat(32))
  process.env.POLICY_CONFIG_PATH = policyConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    recipients: { mode: 'change-detect', allowed: [], perService: {}, known: { 'casper-rcpt-mismatch-test.invalid': roguePayTo } },
  });
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return casperChallengeFixed(); }) as any;
  const { casperBudget } = await import('../casper/budget.js');
  const budgetBefore = casperBudget.getDailySpent();
  const result = await handler()({ url, chain: 'casper' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 1, 'only the probe may run — no Casper payment machinery');
  assert.equal(parsed.policy_decision, 'DENY');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'RECIPIENT_NOT_ALLOWED'));
  assert.match(
    parsed.reasons.find((r: any) => r.code === 'RECIPIENT_NOT_ALLOWED').message,
    /differs from the recorded baseline/,
    'the Casper gate must have compared the PROBED payTo against the baseline — not a missing-recipient fallback',
  );
  assert.equal(casperBudget.getDailySpent(), budgetBefore, 'the refusal must precede any casperBudget reserve');
});

// ---------------------------------------------------------------------------
// Issue #30 — price anomaly detection wired into x402_fetch: the Base/Solana
// gate passes the per-service settled-amount baseline into the engine (rule
// 4.6), and a successful settlement feeds the baseline (recordSettledAmount
// under the same resp.status === 200 guard as recordServicePayment) so a
// denied or failed payment can never poison it. Compat default (anomaly
// disabled): getAnomalyInputs returns {} and nothing changes.
// ---------------------------------------------------------------------------

/** 402 probe answer advertising a legacy-shaped Solana exact offer with a
 * parameterized amount (units → USDC at 6 decimals). No asset field: the SDK
 * passes the paid leg through without creating a payload (the #25 compat
 * path), so each settled payment is probe (402) + direct 200. */
function probeChallengeAmount(amountStr: string) {
  const payload = JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: 'exact', network: SOLANA_CAIP2, amount: amountStr, payTo: 'SoLWallet', extra: { name: 'USDC' } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
}

const ANOMALY_ENABLED = {
  enabled: true, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0,
};

/** Grow the host's in-process baseline through REAL settlements (probe 402 +
 * settled 200), so the baseline provably comes from the fetch.ts accounting
 * guard — no ledger pre-writing, no rehydration-timing dependence. */
async function growBaseline(url: string, probeAmounts: string[]) {
  let calls = 0;
  globalThis.fetch = (async (input: unknown) => {
    calls++;
    if (calls % 2 === 1) return probeChallengeAmount(probeAmounts[Math.floor(calls / 2)]);
    return new Response('{"result":"ok"}', { status: 200 }); // settled 200
  }) as any;
  for (let i = 0; i < probeAmounts.length; i++) {
    const r = await handler()({ url });
    assert.equal(JSON.parse(r.content[0].text).status, 200, `settlement ${i + 1} must complete through the real flow`);
  }
}

it('price anomaly: a successful settlement moves the baseline and a severe spike is hard-denied with z detail — and never moves it', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.POLICY_CONFIG_PATH = policyConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    anomaly: ANOMALY_ENABLED,
  });
  const store = await import('../policy/anomaly-store.js') as typeof import('../policy/anomaly-store.js'); // same instance fetch.js records into
  const host = 'anomaly-severe-test.invalid';
  const url = `https://${host}/api`;
  // Five real settlements: $0.01 ×4 then $0.02 ⇒ mean 0.012, stdev 0.004.
  await growBaseline(url, ['10000', '10000', '10000', '10000', '20000']);
  const baselineAfterGrowth = store.getBaseline(host);
  assert.deepEqual(baselineAfterGrowth!.samples, [0.01, 0.01, 0.01, 0.01, 0.02], 'a settled 200 moves the baseline, in settlement order');

  // Severe spike: $0.05 ⇒ z ≈ 9.5 ≥ denyZ 3 ⇒ hard deny BEFORE the payment layer.
  const before = ledgerLines();
  let spikeCalls = 0;
  globalThis.fetch = (async () => { spikeCalls++; return probeChallengeAmount('50000'); }) as any;
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(spikeCalls, 1, 'only the 402 probe may hit the network — the paid fetch must never run');
  assert.equal(parsed.policy_decision, 'DENY');
  const reason = parsed.reasons.find((r: any) => r.code === 'PRICE_ANOMALY');
  assert.ok(reason, 'the PRICE_ANOMALY code must reach the caller');
  const detail = reason.detail;
  assert.ok(detail, 'the refusal carries the detail payload for the audit log');
  assert.ok(Math.abs(detail.zScore - 9.5) < 1e-6, `z should be ~9.5, got ${detail.zScore}`);
  assert.equal(detail.band, 'deny');
  assert.equal(detail.samples, 5);
  assert.equal(detail.window, 20);
  assert.equal(detail.amount, 0.05);
  assert.equal(detail.host, host);
  assert.ok(Math.abs(detail.mean - 0.012) < 1e-9);
  assert.deepEqual(ledgerLines(), before, 'a policy DENY must not write to the payment ledger');
  assert.deepEqual(store.getBaseline(host)!.samples, [0.01, 0.01, 0.01, 0.01, 0.02], 'a denied payment must never move the baseline');
});

it('price anomaly: a mild spike lands in the approval band — refused with PRICE_ANOMALY + APPROVAL_REQUIRED and detail', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.POLICY_CONFIG_PATH = policyConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    anomaly: ANOMALY_ENABLED,
  });
  const host = 'anomaly-approval-test.invalid';
  const url = `https://${host}/api`;
  await growBaseline(url, ['10000', '10000', '10000', '10000', '20000']); // mean 0.012, stdev 0.004
  const beforeSpike = ledgerLines();
  globalThis.fetch = (async () => probeChallengeAmount('22000')) as any; // $0.022 ⇒ z ≈ 2.5
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.policy_decision, 'APPROVAL_REQUIRED');
  assert.deepEqual(parsed.reasons.map((r: any) => r.code), ['PRICE_ANOMALY', 'APPROVAL_REQUIRED']);
  const detail = parsed.reasons[0].detail;
  assert.ok(Math.abs(detail.zScore - 2.5) < 1e-6, `z should be ~2.5, got ${detail.zScore}`);
  assert.equal(detail.band, 'approval');
  assert.equal(parsed.reasons[0].message.includes('human confirmation'), true, 'the approval-band message asks for human confirmation');
  assert.deepEqual(ledgerLines(), beforeSpike, 'an approval-banded refusal must not write to the payment ledger');
});

it('price anomaly: a non-200 settled response never moves the baseline (same guard as logPayment/recordServicePayment)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.POLICY_CONFIG_PATH = policyConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    anomaly: ANOMALY_ENABLED,
  });
  const store = await import('../policy/anomaly-store.js') as typeof import('../policy/anomaly-store.js');
  const host = 'anomaly-non200-test.invalid';
  const url = `https://${host}/api`;
  await growBaseline(url, ['10000']); // one settled $0.01
  assert.deepEqual(store.getBaseline(host)!.samples, [0.01]);
  // Second attempt: probe 402, paid leg settles then the server fails with 500.
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return probeChallengeAmount('10000');
    return new Response('server error', { status: 500 });
  }) as any;
  const result = await handler()({ url });
  assert.equal(JSON.parse(result.content[0].text).status, 500, 'the flow must reach the accounting block through a non-200 response');
  const entries = ledgerLines().map((l) => JSON.parse(l)).filter((e: any) => e.url === url);
  assert.equal(entries[entries.length - 1].status, 'failed', 'the non-200 settlement is logged as failed');
  assert.deepEqual(store.getBaseline(host)!.samples, [0.01], 'a failed settlement must never move the baseline');
});

it('price anomaly: the compat default keeps the flow untouched — the spike pays as before (enabled false ⇒ no inputs, no refusal)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  // No POLICY_CONFIG_PATH ⇒ the behavior-compat default (anomaly disabled).
  const store = await import('../policy/anomaly-store.js') as typeof import('../policy/anomaly-store.js');
  const host = 'anomaly-compat-test.invalid';
  const url = `https://${host}/api`;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return probeChallengeAmount('50000'); // a $0.05 spike offer
    return new Response('{"result":"ok"}', { status: 200 });
  }) as any;
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.policy_decision, undefined, 'ALLOW adds no policy keys to the success output');
  // The settled amount still feeds the (ungated) baseline writer so a later
  // opt-in rehydrates the history — but reads stay gated on enabled.
  assert.deepEqual(store.getBaseline(host)!.samples, [0.05]);
});

// ---------------------------------------------------------------------------
// Issue #32 — multi-EVM CAIP-2 in x402_fetch: the offer's real CAIP-2 id
// decides the chain (never the eip155-substring collapse), the client
// registers exactly that CAIP-2, RPC options are per-chain (BASE_RPC_URL is
// scoped to 8453 only), and policy denies Polygon/Arbitrum by default
// (opt-in, R2). Fail-closed contract: a denied or undetermined chain never
// produces a signature.
// ---------------------------------------------------------------------------

const POLYGON_CAIP2 = 'eip155:137';
const ARBITRUM_CAIP2 = 'eip155:42161';
// Well-known public protocol identifiers (same convention as BASE_USDC_ADDRESS
// above): the native USDC contracts on Polygon / Arbitrum — asset ids, not secrets.
const POLYGON_USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const ARBITRUM_USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const POLYGON_PAYTO = '0x3333333333333333333333333333333333333333';

/** v2 challenge the EVM scheme signs fully locally (EIP-3009 signTypedData) —
 * extra.name/version are the EIP-712 domain parameters; parameterised by
 * network/asset so the SAME shape serves base, polygon or arbitrum. */
function chargeableEvmChallenge(requestUrl: string, network: string, asset: string) {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{ scheme: 'exact', network, asset, amount: '10000', payTo: POLYGON_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
}

function signatureHeaderNetwork(input: unknown, init: unknown): string | null {
  const headers = new Headers(input instanceof Request ? input.headers : (init as any)?.headers);
  const sig = headers.get('payment-signature');
  if (!sig) return null;
  try {
    const decoded = JSON.parse(Buffer.from(sig, 'base64').toString('utf-8'));
    return decoded?.accepted?.network ?? null;
  } catch {
    return null;
  }
}

it('multi-EVM: a eip155:137 challenge probes as chain polygon and the default policy refuses it BEFORE any payment attempt', async () => {
  process.env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
  const url = 'https://polygon-default-deny-test.invalid/api';
  const before = ledgerLines();
  let calls = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    calls++;
    assert.equal(noSignatureHeader(input, init), false, 'no signature may ever be created for a denied chain');
    return chargeableEvmChallenge(url, POLYGON_CAIP2, POLYGON_USDC_ADDRESS);
  }) as any;
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 1, 'only the 402 probe may run — no payment attempt for a refused chain');
  assert.equal(parsed.chain, 'polygon', 'the real CAIP-2 id decides the chain — never the old base collapse');
  assert.equal(parsed.policy_decision, 'DENY');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'CHAIN_NOT_ALLOWED'), 'polygon is opt-in (R2): the compat allowlist refuses it');
  assert.match(parsed.reasons.find((r: any) => r.code === 'CHAIN_NOT_ALLOWED').message, /not in the allowed networks/);
  assert.deepEqual(ledgerLines(), before, 'a policy DENY must not write to the payment ledger');
});

it('multi-EVM: opted-in polygon pays end-to-end — the registered scheme is eip155:137 exactly (no eip155:8453 registration)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
  process.env.POLICY_CONFIG_PATH = policyConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    networks: { allowed: ['base', 'solana', 'casper', 'polygon', 'arbitrum'] },
  });
  const url = 'https://polygon-happy-test.invalid/api';
  let probes = 0, paidAttempts = 0, signedRetries = 0;
  const signedNetworks: Array<string | null> = [];
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const urlStr = input instanceof Request ? input.url : String(input);
    assert.equal(urlStr, url, 'the EVM path must make no other network calls (eip155:137 gets NO RPC options)');
    if (noSignatureHeader(input, init)) {
      signedRetries++;
      signedNetworks.push(signatureHeaderNetwork(input, init));
      return new Response('{"result":"ok"}', { status: 200, headers: { 'PAYMENT-RESPONSE': receiptB64 } });
    }
    if (probes === 0) { probes++; return chargeableEvmChallenge(url, POLYGON_CAIP2, POLYGON_USDC_ADDRESS); }
    paidAttempts++;
    // The paid leg's ONLY accept is eip155:137 — a client that registered
    // eip155:8453 could never select it (SDK "no network/scheme registered"),
    // so reaching the signed retry proves the offer's own CAIP-2 was registered.
    return chargeableEvmChallenge(url, POLYGON_CAIP2, POLYGON_USDC_ADDRESS);
  }) as any;
  const before = ledgerLines();
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(probes, 1, 'auto-detect ran the single free probe');
  assert.equal(paidAttempts, 1);
  assert.equal(signedRetries, 1, 'the payment was signed on polygon and retried');
  assert.deepEqual(signedNetworks, [POLYGON_CAIP2], 'the SIGNED payload binds eip155:137 — not base');
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.chain, 'polygon');
  assert.equal(parsed.cost_usdc, 0.01);
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.equal(entries.find((e: any) => e.url === url)?.chain, 'polygon', 'the ledger records the real chain');
  assert.equal(entries.find((e: any) => e.url === url)?.status, 'success');
});

it('multi-EVM: forced chain polygon still probes-and-observes the offer (the #25 amendment-1 semantics cover the new aliases)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
  process.env.POLICY_CONFIG_PATH = policyConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    networks: { allowed: ['base', 'solana', 'casper', 'polygon'] },
  });
  const url = 'https://polygon-forced-happy-test.invalid/api';
  let probes = 0, paidAttempts = 0, signedRetries = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const urlStr = input instanceof Request ? input.url : String(input);
    assert.equal(urlStr, url, 'no other endpoint call may happen');
    if (noSignatureHeader(input, init)) {
      signedRetries++;
      assert.equal(signatureHeaderNetwork(input, init), POLYGON_CAIP2, 'the signed payload binds the offer the probe observed');
      return new Response('{"result":"ok"}', { status: 200 });
    }
    if (probes === 0) { probes++; return chargeableEvmChallenge(url, POLYGON_CAIP2, POLYGON_USDC_ADDRESS); }
    paidAttempts++;
    return chargeableEvmChallenge(url, POLYGON_CAIP2, POLYGON_USDC_ADDRESS);
  }) as any;
  const result = await handler()({ url, chain: 'polygon' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(probes, 1, 'a forced polygon chain must still run the single free probe');
  assert.equal(paidAttempts, 1);
  assert.equal(signedRetries, 1, 'the payment was signed and completed — the new aliases enjoy the same forced-chain semantics');
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.chain, 'polygon');
});

it('multi-EVM: a forced chain contradicting the offered network aborts BEFORE any signature (SDK no-registered-network, never a swap)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
  process.env.POLICY_CONFIG_PATH = policyConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    networks: { allowed: ['base', 'solana', 'casper', 'polygon'] },
  });
  const url = 'https://polygon-forced-contradict-test.invalid/api';
  let probes = 0, paidAttempts = 0, signedRetries = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    assert.equal(noSignatureHeader(input, init), false, 'no signature may ever exist for the contradicting (arbitrum) offer — it is not allowlisted');
    if (probes === 0) { probes++; return chargeableEvmChallenge(url, ARBITRUM_CAIP2, ARBITRUM_USDC_ADDRESS); }
    paidAttempts++;
    return chargeableEvmChallenge(url, ARBITRUM_CAIP2, ARBITRUM_USDC_ADDRESS);
  }) as any;
  const before = ledgerLines();
  // Forced polygon (allowlisted), but the probe observes an ARBITRUM offer
  // (not allowlisted): the client registers the APPROVED chain's CAIP-2
  // (eip155:137), the SDK cannot select the arbitrum requirement, and the
  // intent the probe bound (network eip155:42161) is never signed.
  const result = await handler()({ url, chain: 'polygon' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(probes, 1, 'the probe still observes the offer');
  assert.equal(paidAttempts, 1, 'the HTTP request itself is never refused (amendment 1) — the refusal lands before signing');
  assert.equal(signedRetries, 0, 'no signature for the contradicting chain');
  assert.match(parsed.error, /x402 payment failed/, 'the SDK refuses to select an unregistered network');
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.ok(!entries.some((e: any) => e.url === url && e.status === 'success'), 'no ledger success for the contradicted offer');
});

it('multi-EVM drift: the probe binds base but the paid leg serves a polygon-only challenge — aborted before any signature', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
  const url = 'https://multi-evm-drift-test.invalid/api';
  let calls = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    calls++;
    assert.equal(noSignatureHeader(input, init), false, 'a signature must never exist for the drifted offer');
    if (calls === 1) return chargeableEvmChallenge(url, BASE_CAIP2, BASE_USDC_ADDRESS); // probe binds eip155:8453
    return chargeableEvmChallenge(url, POLYGON_CAIP2, POLYGON_USDC_ADDRESS); // paid leg: eip155:137 only — no registered scheme matches
  }) as any;
  const before = ledgerLines();
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 2, 'probe + one paid attempt — the abort precedes any signed retry');
  assert.match(parsed.error, /x402 payment failed/, 'the SDK refuses to select an unregistered network');
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.ok(!entries.some((e: any) => e.url === url && e.status === 'success'), 'no ledger success for the drifted offer');
  assert.equal(entries.find((e: any) => e.url === url)?.status, 'failed', 'the aborted attempt is audited like any other failure');
});

// ---------------------------------------------------------------------------
// Issue #34 — the fail-closed endpoint liveness gate in x402_fetch (rule 4.7,
// ENDPOINT_NOT_LIVE) and the signing-time recheck (L9). These tests NEED real
// directory rows (the gate derives from the catalog claim, L3), so they write
// their own rows into the hermetic X402_DIRECTORY_PATH and restore the empty
// directory afterwards — every pre-#34 test above ran with an EMPTY directory
// (the L3 inert case) and is untouched.
// ---------------------------------------------------------------------------

const { clearDirectoryCache } = await import('../directory.js');

// Capture the hermetic path: the module-level `after` restores process.env
// before section `after` hooks run, so writeLivenessDirectory must not
// re-read the env var.
const LIVENESS_DIR_PATH = process.env.X402_DIRECTORY_PATH!;

function writeLivenessDirectory(endpoints: unknown[]): void {
  writeFileSync(LIVENESS_DIR_PATH, JSON.stringify({ endpoints, categories: [], last_updated: '2026-09-25' }), 'utf8');
  clearDirectoryCache();
}

function seedLiveEntry(baseUrl: string, probedAgoMs: number): Record<string, unknown> {
  return {
    name: 'LivenessRow', description: '', base_url: baseUrl, chain: 'solana', category: 'ai', tags: [],
    endpoints: [], source: 'seed',
    liveness: { probed_at: new Date(Date.now() - probedAgoMs).toISOString(), status: 'live_402', latency_ms: 31, probe_url: baseUrl },
  };
}

// These tests are appended LAST in the file and manage their own rows; the
// module-level after hook removes the whole temp dir at the end, so no
// restore hook is needed here.

it('liveness gate: an UNPINNED catalog row is DENIED ENDPOINT_NOT_LIVE before the payment layer (catalog membership is not proof of liveness)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const host = 'unpinned-catalog.invalid';
  writeLivenessDirectory([
    { name: 'UnpinnedRow', description: '', base_url: `https://${host}`, chain: 'solana', category: 'ai', tags: [], endpoints: [] }, // NO source ⇒ never pinned (seed mode)
  ]);
  const before = ledgerLines();
  let calls = 0;
  let signatureSeen = false;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    calls++;
    if (noSignatureHeader(input, init)) signatureSeen = true;
    return probeChallengeFixed();
  }) as any;
  const result = await handler()({ url: `https://${host}/api` });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 1, 'exactly ONE network call — the 402 probe; the paid fetch must never run');
  assert.equal(signatureSeen, false);
  assert.equal(parsed.policy_decision, 'DENY');
  assert.deepEqual(parsed.reasons.map((r: any) => r.code), ['ENDPOINT_NOT_LIVE']);
  assert.match(parsed.reasons[0].message, /not pinned|not in the liveness allowlist|catalog membership is not proof of liveness/);
  for (const key of ['error', 'url', 'chain', 'estimated_cost_usdc', 'daily_spent_usdc', 'max_per_call', 'max_daily']) {
    assert.ok(key in parsed, `refusal keeps the #19 key ${key}`);
  }
  assert.deepEqual(ledgerLines(), before, 'DENY must not write to the payment ledger');
});

it('liveness gate: a pinned row with a FRESH live_402 record pays end-to-end (gate + recheck both pass)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.SOLANA_RPC_URL = RPC_SIM_URL;
  const host = 'pinned-fresh.invalid';
  writeLivenessDirectory([seedLiveEntry(`https://${host}`, 60_000)]); // probed live 1 minute ago
  const url = `https://${host}/api`;
  let probes = 0, paidAttempts = 0, rpcCalls = 0, signedRetries = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const urlStr = input instanceof Request ? input.url : String(input);
    if (urlStr.startsWith(RPC_SIM_URL)) {
      rpcCalls++;
      return rpcSimResponse(await requestBodyText(input, init));
    }
    assert.equal(urlStr, url, 'no other endpoint call may happen');
    if (noSignatureHeader(input, init)) {
      signedRetries++;
      return new Response('{"result":"ok"}', { status: 200, headers: { 'PAYMENT-RESPONSE': receiptB64 } });
    }
    if (probes === 0) { probes++; return chargeableSolanaChallenge(url); }
    paidAttempts++;
    return chargeableSolanaChallenge(url);
  }) as any;
  const before = ledgerLines();
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(probes, 1);
  assert.equal(paidAttempts, 1);
  assert.equal(rpcCalls, 1, 'payload creation ran — the liveness recheck passed at signing time');
  assert.equal(signedRetries, 1, 'the payment was signed and settled');
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.chain, 'solana');
  assert.equal(parsed.policy_decision, undefined, 'ALLOW adds no policy keys to the success output');
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.equal(entries.find((e: any) => e.url === url)?.status, 'success');
});

it('liveness gate: a STALE probe record (older than max_age_seconds) is DENIED ENDPOINT_NOT_LIVE', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const host = 'stale-record.invalid';
  writeLivenessDirectory([seedLiveEntry(`https://${host}`, 7_200_000)]); // probed live 2h ago — stale under the 3600 s default
  const before = ledgerLines();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return probeChallengeFixed(); }) as any;
  const result = await handler()({ url: `https://${host}/api` });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 1, 'only the probe may run — staleness refuses before any payment attempt');
  assert.equal(parsed.policy_decision, 'DENY');
  assert.deepEqual(parsed.reasons.map((r: any) => r.code), ['ENDPOINT_NOT_LIVE']);
  assert.match(parsed.reasons[0].message, /max_age_seconds/, 'the refusal names the staleness bound');
  assert.deepEqual(ledgerLines(), before, 'DENY must not write to the payment ledger');
});

it('liveness gate: a never-probed pinned row and a no_402 record are both refused (missing/unsatisfying record ⇒ not live)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const neverHost = 'never-probed.invalid';
  const no402Host = 'no402-record.invalid';
  writeLivenessDirectory([
    { name: 'Never', description: '', base_url: `https://${neverHost}`, chain: 'solana', category: 'ai', tags: [], endpoints: [], source: 'seed' },
    { name: 'No402', description: '', base_url: `https://${no402Host}`, chain: 'solana', category: 'ai', tags: [], endpoints: [], source: 'seed', liveness: { probed_at: new Date().toISOString(), status: 'no_402', latency_ms: 20, probe_url: `https://${no402Host}` } },
  ]);
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return probeChallengeFixed(); }) as any;
  for (const host of [neverHost, no402Host]) {
    const before = ledgerLines();
    const result = await handler()({ url: `https://${host}/api` });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.policy_decision, 'DENY', `${host} must be refused`);
    assert.deepEqual(parsed.reasons.map((r: any) => r.code), ['ENDPOINT_NOT_LIVE']);
    assert.deepEqual(ledgerLines(), before, `${host}: DENY must not write to the ledger`);
  }
  assert.equal(calls, 2, 'one probe per request, nothing more');
});

it('liveness gate OFF (require_fresh_402: false): the flow is unchanged for a catalog row — unpinned and never-probed still pays', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.POLICY_CONFIG_PATH = policyConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    liveness: { require_fresh_402: false },
  });
  const host = 'gate-off.invalid';
  writeLivenessDirectory([
    { name: 'OffSwitchRow', description: '', base_url: `https://${host}`, chain: 'solana', category: 'ai', tags: [], endpoints: [] }, // unpinned + never probed
  ]);
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return probeChallengeFixed();
    return new Response('{"result":"ok"}', { status: 200 });
  }) as any;
  const result = await handler()({ url: `https://${host}/api` });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 200, 'with the gate off, today’s behaviour is unchanged (L3 / L10 escape hatch)');
  assert.equal(parsed.paid, true);
  assert.equal(parsed.policy_decision, undefined);
});

it('explicit allowlist: [] (strict mode) DENIES every off-list host with ENDPOINT_NOT_LIVE — even a non-catalog one', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.POLICY_CONFIG_PATH = policyConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    liveness: { allowlist: [] },
  });
  writeLivenessDirectory([]); // the host is deliberately NOT a catalog row
  const before = ledgerLines();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return probeChallengeFixed(); }) as any;
  const result = await handler()({ url: 'https://strict-offlist.invalid/api' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 1, 'the refusal precedes the payment layer');
  assert.equal(parsed.policy_decision, 'DENY');
  assert.deepEqual(parsed.reasons.map((r: any) => r.code), ['ENDPOINT_NOT_LIVE'], 'strict allowlist mode refuses with ONLY the liveness reason');
  assert.match(parsed.reasons[0].message, /not in the liveness allowlist/);
  assert.deepEqual(ledgerLines(), before);
});

it('signing-time recheck (L9): a record that goes stale between the gate and the signature aborts INTENT_ENDPOINT_NOT_LIVE — no signature exists', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  process.env.SOLANA_RPC_URL = RPC_SIM_URL;
  const host = 'recheck-stale.invalid';
  writeLivenessDirectory([seedLiveEntry(`https://${host}`, 60_000)]); // fresh at gate time
  const url = `https://${host}/api`;
  let calls = 0;
  let signatureSeen = false;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    calls++;
    const urlStr = input instanceof Request ? input.url : String(input);
    if (urlStr.startsWith(RPC_SIM_URL)) {
      rpcCallsMarker++; // must never happen: the abort precedes payload creation
      return rpcSimResponse(await requestBodyText(input, init));
    }
    if (noSignatureHeader(input, init)) signatureSeen = true;
    if (calls === 1) return chargeableSolanaChallenge(url); // probe — gate will ALLOW (fresh record)
    // Paid leg: the record ages out BETWEEN the gate and the signature.
    writeLivenessDirectory([seedLiveEntry(`https://${host}`, 7_200_000)]);
    return chargeableSolanaChallenge(url);
  }) as any;
  let rpcCallsMarker = 0;
  const before = ledgerLines();
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls, 2, 'probe + one paid attempt — the abort lands before any signed retry');
  assert.equal(signatureSeen, false, 'no signature was ever created');
  assert.equal(rpcCallsMarker, 0, 'payload creation (and its RPC touch) never ran');
  assert.equal(parsed.policy_decision, 'ALLOW', 'policy allowed at the gate — the RECHECK is what refused at signing');
  assert.deepEqual(parsed.reasons.map((r: any) => r.code), ['INTENT_UNAUTHORISED', 'ENDPOINT_NOT_LIVE']);
  assert.match(parsed.error, /payment-intent boundary/);
  for (const key of ['error', 'url', 'chain', 'estimated_cost_usdc', 'daily_spent_usdc', 'max_per_call', 'max_daily']) {
    assert.ok(key in parsed, `refusal keeps the #19 key ${key}`);
  }
  const entries = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.ok(!entries.some((e: any) => e.url === url && e.status === 'success'), 'no ledger success for an aborted payment');
  assert.equal(entries.find((e: any) => e.url === url)?.status, 'failed', 'the aborted attempt is audited like any other failure');
});
