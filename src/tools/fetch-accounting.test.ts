import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Issue #53 — spend accounting must be derived ONLY from the signed payment
// (the payment intent's atomic amount), never from data in the seller's
// response body. These tests drive the real x402_fetch flow through a mocked
// transport (same hermetic pattern as src/tools/fetch.test.ts): a boundable
// Base offer is observed on the 402 probe, the paid leg signs it (EIP-3009,
// fully local, throwaway key), and the seller's 200 body then lies about the
// cost in every shape the issue lists. The ledger row, the daily total, the
// per-service total and the price-anomaly baseline must all move by exactly
// the SIGNED amount, identically for every body shape.
// ---------------------------------------------------------------------------

// Isolate the payment ledger BEFORE importing fetch.js (PAYMENT_LOG_PATH
// pattern from fetch.test.ts / payment-utils.rehydrate.test.ts).
const dir = mkdtempSync(join(tmpdir(), 'x402-fetch-acc-'));
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
// Hermetic directory keeps trust = UNKNOWN deterministically (same as fetch.test.ts).
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-09-21' }), 'utf8');

const { registerFetchTool } = await import('./fetch.js');
// Same module instances fetch.js records into.
const { getDailySpent } = await import('../payment-utils.js') as typeof import('../payment-utils.js');
const budgetStore = await import('../policy/budget-store.js') as typeof import('../policy/budget-store.js');
const anomalyStore = await import('../policy/anomaly-store.js') as typeof import('../policy/anomaly-store.js');
// Issue #53 helpers (accounting.ts) — typed import now that the module
// exists; the variable specifier was only needed at the RED step.
const ACCOUNTING_PATH = './accounting.js';
const accounting = await import(ACCOUNTING_PATH) as typeof import('./accounting.js');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_DIRECTORY_PATH: join(dir, 'endpoints.json') }; });
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

function ledgerLines(): string[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '');
}

function handler() {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

// Throwaway key generated at runtime — EIP-3009 signing is fully local.
process.env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`; // survive the afterEach env restore

// Well-known public protocol identifiers (same convention as fetch.test.ts):
// the Base mainnet USDC contract and CAIP-2 — asset ids, not secrets.
const BASE_CAIP2 = 'eip155:8453';
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_PAYTO = '0x2222222222222222222222222222222222222222';

/** v2 challenge the EVM scheme signs fully locally (EIP-712 signTypedData). */
function chargeableBaseChallenge(requestUrl: string, amount = '10000') {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{ scheme: 'exact', network: BASE_CAIP2, asset: BASE_USDC_ADDRESS, amount, payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': Buffer.from(payload).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') } });
}

function noSignatureHeader(input: unknown, init: unknown): boolean {
  const headers = new Headers(input instanceof Request ? input.headers : (init as any)?.headers);
  return !headers.has('payment-signature');
}

/** Drive the real signed flow: probe (402 challenge) → paid attempt (402
 * challenge) → signed retry (the seller's response). Returns the parsed tool
 * output and the mock's request counters. */
async function runSignedFlow(url: string, sellerBody: string, sellerStatus = 200) {
  let probes = 0, paidAttempts = 0, signedRetries = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const u = input instanceof Request ? input.url : String(input);
    assert.equal(u, url, 'no other endpoint call may happen');
    if (noSignatureHeader(input, init)) {
      if (probes === 0) { probes++; return chargeableBaseChallenge(url); }
      paidAttempts++;
      return chargeableBaseChallenge(url);
    }
    signedRetries++;
    return new Response(sellerBody, { status: sellerStatus });
  }) as any;
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  return { parsed, probes, paidAttempts, signedRetries };
}

// ---------------------------------------------------------------------------
// The body-shape matrix (#53 acceptance 1/2/4/5). Every shape is served on the
// SIGNED 200; the recorded amounts must all equal the signed $0.01 and the
// tool outputs must be shape-invariant.
// ---------------------------------------------------------------------------

type Shape = { name: string; body: string; expectedSellerReported: number | string | undefined };

const SHAPES: Shape[] = [
  { name: 'cost field missing', body: '{"result":"ok"}', expectedSellerReported: undefined },
  { name: 'meta null', body: '{"meta":null}', expectedSellerReported: undefined },
  { name: 'cost zero', body: '{"meta":{"cost":{"usd":0}}}', expectedSellerReported: 0 },
  { name: 'below the signed amount', body: '{"meta":{"cost":{"usd":0.001}}}', expectedSellerReported: 0.001 },
  { name: 'above the signed amount', body: '{"meta":{"cost":{"usd":999}}}', expectedSellerReported: 999 },
  { name: 'non-finite', body: '{"meta":{"cost":{"usd":1e999}}}', expectedSellerReported: undefined },
  { name: 'string', body: '{"meta":{"cost":{"usd":"999.5"}}}', expectedSellerReported: '999.5' },
  { name: 'object', body: '{"meta":{"cost":{"usd":{"v":"999"}}}}', expectedSellerReported: undefined },
  { name: 'array', body: '{"meta":{"cost":{"usd":[999]}}}', expectedSellerReported: undefined },
];

const SIGNED_USD = 0.01;
const SIGNED_ATOMIC = '10000';

for (const shape of SHAPES) {
  it(`accounting is invariant to the seller body shape: ${shape.name}`, async () => {
    process.env.MAX_PAYMENT_PER_CALL = '50';
    process.env.MAX_DAILY_SPEND = '50';
    const host = `acc-${shape.name.replace(/[^a-z0-9]+/gi, '-')}-test.invalid`.toLowerCase();
    const url = `https://${host}/api`;
    const dailyBefore = getDailySpent();
    const perServiceBefore = budgetStore.getPerServiceSpent(host);
    const ledgerBefore = ledgerLines().length;

    const { parsed, probes, paidAttempts, signedRetries } = await runSignedFlow(url, shape.body);

    // Exactly one paid request reaches the mock: one probe, one paid attempt,
    // one signed retry — no accounting-driven retry.
    assert.equal(probes, 1);
    assert.equal(paidAttempts, 1);
    assert.equal(signedRetries, 1, 'exactly one paid (signed) request per tool call');

    assert.equal(parsed.status, 200);
    assert.equal(parsed.paid, true);
    assert.equal(parsed.cost_usdc, SIGNED_USD, 'cost_usdc equals the signed amount for every body shape');

    // seller_reported_cost is information only: well-formed seller values are
    // surfaced as-is, everything hostile is omitted — and NEVER becomes the
    // recorded cost.
    if (shape.expectedSellerReported === undefined) {
      assert.ok(!('seller_reported_cost' in parsed), `a hostile ${shape.name} body must not surface a seller cost`);
    } else {
      assert.equal(parsed.seller_reported_cost, shape.expectedSellerReported);
    }

    const rows = ledgerLines().slice(ledgerBefore).map((l) => JSON.parse(l));
    const row = rows.find((r: any) => r.url === url && r.status === 'success');
    assert.ok(row, 'the settled payment is recorded');
    assert.equal(row.amount_usdc, SIGNED_USD, 'ledger amount_usdc equals the SIGNED amount for every body shape');
    assert.equal(row.amount_atomic, SIGNED_ATOMIC, 'the row carries the exact signed atomic amount as the audit trail');
    assert.equal(row.decimals, 6);
    assert.equal(row.asset, BASE_USDC_ADDRESS);

    // The daily total rises by exactly the signed amount — even when the
    // seller reported 999 or a non-numeric value.
    assert.ok(Math.abs((getDailySpent() - dailyBefore) - SIGNED_USD) < 1e-9,
      `daily spend must rise by exactly the signed amount (rose by ${getDailySpent() - dailyBefore})`);
    assert.ok(Math.abs((budgetStore.getPerServiceSpent(host) - perServiceBefore) - SIGNED_USD) < 1e-9,
      'per-service spend must rise by exactly the signed amount');
    // #53 acceptance 4: the anomaly baseline holds the signed amount.
    assert.deepEqual(anomalyStore.getBaseline(host)!.samples, [SIGNED_USD]);
  });
}

// ---------------------------------------------------------------------------
// #53 acceptance 3: after a simulated restart (fresh module instances reading
// the same ledger) the rehydrated daily and per-service totals equal the
// in-process totals the flows produced.
// ---------------------------------------------------------------------------

it('restart parity: rehydrated daily and per-service totals equal the in-process totals', async () => {
  const bust = Date.now();
  const { getDailySpent: dailyAfterRestart } = await import(`../payment-utils.js?acct-restart=${bust}`) as typeof import('../payment-utils.js');
  const storeAfterRestart = await import(`../policy/budget-store.js?acct-restart=${bust}`) as typeof import('../policy/budget-store.js');
  for (const row of ledgerLines().map((l) => JSON.parse(l))) {
    const host = new URL(row.url).hostname.toLowerCase();
    const before = budgetStore.getPerServiceSpent(host);
    const after = storeAfterRestart.getPerServiceSpent(host);
    assert.ok(Math.abs(before - after) < 1e-9, `per-service spend for ${host}: in-process ${before} must equal rehydrated ${after}`);
  }
  assert.ok(Math.abs(getDailySpent() - dailyAfterRestart()) < 1e-9,
    `daily spend: in-process ${getDailySpent()} must equal rehydrated ${dailyAfterRestart()}`);
});

// ---------------------------------------------------------------------------
// The #53 extraction/derivation helpers, unit-level (the fetch-flow matrix
// above pins their wiring; these pin their contracts).
//
// Note on the "throwing getter" body shape: a value parsed from a response
// body cannot carry getters (JSON.parse builds plain objects), so the shape
// cannot reach the flow through a mocked Response. It IS reachable for any
// future caller of the helpers, so the helper must be hostile-object-safe:
// a throwing accessor must surface as "no seller cost", never as a throw
// that could land in the payment-failure path (#53 req 4).
// ---------------------------------------------------------------------------

it('usdFromAtomic: integer arithmetic from the atomic amount, fail-closed on malformed input', () => {
  assert.ok(accounting && typeof accounting.usdFromAtomic === 'function', 'src/tools/accounting.ts must exist and export usdFromAtomic (issue #53 RED step)');
  assert.equal(accounting.usdFromAtomic('10000', 6), 0.01);
  assert.equal(accounting.usdFromAtomic('1', 6), 0.000001);
  assert.equal(accounting.usdFromAtomic('20000', 6), 0.02);
  assert.equal(accounting.usdFromAtomic('1000000000', 9), 1);
  assert.equal(accounting.usdFromAtomic('123', 0), 123);
  assert.equal(accounting.usdFromAtomic('20', 6), 0.00002);
  // malformed → undefined (caller fails closed; never a made-up value)
  assert.equal(accounting.usdFromAtomic('', 6), undefined);
  assert.equal(accounting.usdFromAtomic('-1', 6), undefined);
  assert.equal(accounting.usdFromAtomic('1.5', 6), undefined);
  assert.equal(accounting.usdFromAtomic('0x10', 6), undefined);
  assert.equal(accounting.usdFromAtomic('10000', -1), undefined);
  assert.equal(accounting.usdFromAtomic('10000', 19), undefined);
  assert.equal(accounting.usdFromAtomic(10000 as unknown as string, 6), undefined);
  // one float narrowing at the boundary: large-but-finite values survive
  assert.ok(Number.isFinite(accounting.usdFromAtomic('999999999999999999999999', 6)!));
  // a value too large for a finite double fails closed instead of reporting Infinity
  assert.equal(accounting.usdFromAtomic('1'.repeat(320), 6), undefined);
});

it('seller-report extraction is information-only and cannot throw on hostile property access', () => {
  assert.ok(accounting && typeof accounting.sellerReportedCostUsd === 'function', 'src/tools/accounting.ts must exist and export sellerReportedCostUsd (issue #53 RED step)');
  const throwingGetter = { get meta() { throw new Error('boom from a hostile accessor'); } };
  assert.doesNotThrow(() => accounting.sellerReportedCostUsd(throwingGetter), 'a throwing accessor must never escape the extraction');
  assert.equal(accounting.sellerReportedCostUsd(throwingGetter), undefined);

  assert.equal(accounting.sellerReportedCostUsd(null), undefined);
  assert.equal(accounting.sellerReportedCostUsd('plain text'), undefined);
  assert.equal(accounting.sellerReportedCostUsd({ meta: null }), undefined);
  assert.equal(accounting.sellerReportedCostUsd({ meta: { cost: null } }), undefined);
  // accepted: finite non-negative number, or a bounded decimal string
  assert.equal(accounting.sellerReportedCostUsd({ meta: { cost: { usd: 12.5 } } }), 12.5);
  assert.equal(accounting.sellerReportedCostUsd({ meta: { cost: { usd: 0 } } }), 0);
  assert.equal(accounting.sellerReportedCostUsd({ meta: { cost: { usd: '12.5' } } }), '12.5');
  // rejected shapes
  assert.equal(accounting.sellerReportedCostUsd({ meta: { cost: { usd: -5 } } }), undefined);
  assert.equal(accounting.sellerReportedCostUsd({ meta: { cost: { usd: Infinity } } }), undefined);
  assert.equal(accounting.sellerReportedCostUsd({ meta: { cost: { usd: 'NaN' } } }), undefined);
  assert.equal(accounting.sellerReportedCostUsd({ meta: { cost: { usd: '1e3' } } }), undefined);
  assert.equal(accounting.sellerReportedCostUsd({ meta: { cost: { usd: '0x10' } } }), undefined);
  assert.equal(accounting.sellerReportedCostUsd({ meta: { cost: { usd: '-1' } } }), undefined);
  assert.equal(accounting.sellerReportedCostUsd({ meta: { cost: { usd: '9'.repeat(33) } } }), undefined, 'values longer than 32 chars are omitted');
  assert.equal(accounting.sellerReportedCostUsd({ meta: { cost: { usd: [999] } } }), undefined);
  assert.equal(accounting.sellerReportedCostUsd({ meta: { cost: { usd: { v: 999 } } } }), undefined);
});

it('parseBoundedBody stays bounded and never throws into the payment-failure path', () => {
  assert.ok(accounting && typeof accounting.parseBoundedBody === 'function', 'src/tools/accounting.ts must exist and export parseBoundedBody (issue #53 RED step)');
  assert.deepEqual(accounting.parseBoundedBody('{"a":1}'), { a: 1 });
  assert.equal(accounting.parseBoundedBody('not json at all'), 'not json at all');
  assert.equal((accounting.parseBoundedBody('x'.repeat(6000)) as string).length, 5000, 'a non-JSON body is truncated, not unbounded');
});