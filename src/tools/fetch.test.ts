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
