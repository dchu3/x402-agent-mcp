import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate ledger + directory BEFORE importing the tool (env pattern from
// fetch.test.ts / payment-utils.rehydrate.test.ts).
const dir = mkdtempSync(join(tmpdir(), 'x402-check-payment-'));
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
// Issue #34 fixture edit (L4, permitted class — assertions unchanged): the
// default liveness gate is ON in seed-pinned mode, so a directory row a test
// expects to ALLOW through the gate must be pinned (source: 'seed') and carry
// a FRESH live_402 probe record. Entries without ALLOW assertions (SolPay)
// gain the provenance field only.
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({
  endpoints: [
    { name: 'Analyzer', description: '', base_url: 'https://analyzer.example', chain: 'base', category: 'ai', tags: [], endpoints: [{ path: '/score', method: 'POST', price_usdc: '0.05', description: '' }], source: 'seed', liveness: { probed_at: new Date().toISOString(), status: 'live_402', latency_ms: 12, probe_url: 'https://analyzer.example' } },
    { name: 'SolPay', description: '', base_url: 'https://solpay.example', chain: 'solana', category: 'multi', tags: [], endpoints: [], source: 'seed' },
  ],
  categories: [], last_updated: '2026-09-21',
}), 'utf8');

const { registerCheckPaymentTool } = await import('./check-payment.js');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_DIRECTORY_PATH: join(dir, 'endpoints.json') };
});
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

function handler() {
  let callback: any;
  registerCheckPaymentTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

// Payment-layer tripwire: ANY network/payment activity during the tool call is
// a test failure. x402_check_payment must never pay.
function payingFetchMock() {
  let calls = 0;
  globalThis.fetch = (async (..._a: unknown[]) => { calls++; throw new Error('payment layer must never be reached'); }) as any;
  return { get calls() { return calls; } };
}

function ledgerLines(): string[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '');
}

it('returns ALLOW for a prospective in-policy payment and NEVER touches the payment layer', async () => {
  const payment = payingFetchMock();
  const result = await handler()({ url: 'https://analyzer.example/score', amount: 0.05, chain: 'base', token: 'USDC' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.decision, 'ALLOW');
  assert.equal(parsed.service, 'analyzer.example');
  assert.equal(parsed.amount, '0.05');
  assert.equal(parsed.currency, 'USDC');
  assert.equal(parsed.chain, 'base');
  assert.deepEqual(parsed.reasons, []);
  assert.equal(parsed.trust_level, 'DISCOVERED');
  assert.equal(payment.calls, 0, 'x402_check_payment must make ZERO payment-layer calls');
  assert.deepEqual(ledgerLines(), [], 'no payment may be logged by the inspection tool');
});

it('returns a structured DENY with machine-readable reason codes and never pays', async () => {
  const payment = payingFetchMock();
  const result = await handler()({ url: 'https://analyzer.example/score', amount: 5.0, chain: 'base', token: 'USDC' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.decision, 'DENY');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'REQUEST_LIMIT_EXCEEDED'));
  assert.ok(parsed.reasons.every((r: any) => typeof r.code === 'string' && typeof r.message === 'string'));
  assert.equal(payment.calls, 0);
  assert.deepEqual(ledgerLines(), []);
});

it('surfaces fail-closed config states instead of a permissive answer', async () => {
  const payment = payingFetchMock();
  process.env.X402_POLICY_PAYMENTS_ENABLED = 'not-a-boolean';
  const result = await handler()({ url: 'https://analyzer.example/score', amount: 0.05, chain: 'base', token: 'USDC' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.decision, 'DENY');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'CONFIG_INVALID'));
  assert.ok(parsed.reasons.some((r: any) => r.code === 'PAYMENTS_DISABLED'));
  assert.equal(payment.calls, 0);
});

it('defaults the chain from the directory entry and the amount from the matching endpoint price', async () => {
  payingFetchMock();
  // No chain/amount given: directory says SolPay is solana; /score on
  // analyzer.example is priced 0.05.
  const sol = await handler()({ url: 'https://solpay.example/api' });
  assert.equal(JSON.parse(sol.content[0].text).chain, 'solana');
  const analyzer = await handler()({ url: 'https://analyzer.example/score' });
  const parsed = JSON.parse(analyzer.content[0].text);
  assert.equal(parsed.chain, 'base');
  assert.equal(parsed.amount, '0.05');
});

it('reflects the operator trust levels: BLOCKED env host is refused, unknown host follows the compat default', async () => {
  payingFetchMock();
  process.env.POLICY_BLOCKED_HOSTS = 'analyzer.example';
  const blocked = await handler()({ url: 'https://analyzer.example/score', amount: 0.05, chain: 'base', token: 'USDC' });
  const parsed = JSON.parse(blocked.content[0].text);
  assert.equal(parsed.decision, 'DENY');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'SERVICE_BLOCKED'));
  delete process.env.POLICY_BLOCKED_HOSTS;

  // Compat default: a non-directory host is payable at the global caps.
  const stranger = await handler()({ url: 'https://stranger.example/api', amount: 0.05, chain: 'base', token: 'USDC' });
  const strangerParsed = JSON.parse(stranger.content[0].text);
  assert.equal(strangerParsed.decision, 'ALLOW');
  assert.equal(strangerParsed.trust_level, 'UNKNOWN');
});

it('APPROVAL_REQUIRED surfaces as its own decision (engine-level; fetch refuses it in Phase 1)', async () => {
  payingFetchMock();
  process.env.X402_POLICY_SERVICE_DISCOVERED = 'approval';
  const result = await handler()({ url: 'https://analyzer.example/score', amount: 0.05, chain: 'base', token: 'USDC' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.decision, 'APPROVAL_REQUIRED');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'APPROVAL_REQUIRED'));
});
// ---------------------------------------------------------------------------
// Issue #26 — x402_check_payment parity: the inspection tool accepts an
// optional `recipient` argument so an agent can check the recipient gate
// BEFORE x402_fetch. The tool never pays (tripwire asserted per test).
// ---------------------------------------------------------------------------

const RCPT_POLICY_DIR = mkdtempSync(join(tmpdir(), 'x402-check-payment-rcpt-'));
process.env.X402_POLICY_RECIPIENTS_FIXTURE = RCPT_POLICY_DIR; // keep a handle; individual tests set POLICY_CONFIG_PATH

function recipientsConfigFile(content: Record<string, unknown>): string {
  const p = join(RCPT_POLICY_DIR, `policy-${Object.keys(content).length}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(content), 'utf8');
  return p;
}

it('recipient argument: the matching recipient (different formatting, same canonical form) is ALLOWed and echoed', async () => {
  const payment = payingFetchMock();
  process.env.POLICY_CONFIG_PATH = recipientsConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    recipients: { mode: 'allowlist', allowed: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'], perService: {}, known: {} },
  });
  const result = await handler()({ url: 'https://analyzer.example/score', amount: 0.05, chain: 'base', token: 'USDC', recipient: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.decision, 'ALLOW');
  assert.equal(parsed.recipient, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'the probed recipient is echoed verbatim');
  assert.equal(parsed.recipient_normalized, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'the normalized form is echoed');
  assert.equal(payment.calls, 0);
});

it('recipient argument: a recipient outside the allowlist is refused with RECIPIENT_NOT_ALLOWED', async () => {
  const payment = payingFetchMock();
  process.env.POLICY_CONFIG_PATH = recipientsConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    recipients: { mode: 'allowlist', allowed: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], perService: {}, known: {} },
  });
  const result = await handler()({ url: 'https://analyzer.example/score', amount: 0.05, chain: 'base', token: 'USDC', recipient: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.decision, 'DENY');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'RECIPIENT_NOT_ALLOWED'));
  assert.equal(payment.calls, 0);
});

it('recipient argument: omitting the recipient in allowlist mode is refused (the tool states the requirement)', async () => {
  const payment = payingFetchMock();
  process.env.POLICY_CONFIG_PATH = recipientsConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    recipients: { mode: 'allowlist', allowed: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], perService: {}, known: {} },
  });
  const result = await handler()({ url: 'https://analyzer.example/score', amount: 0.05, chain: 'base', token: 'USDC' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.decision, 'DENY');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'RECIPIENT_NOT_ALLOWED'));
  assert.equal(payment.calls, 0);
});

it('recipient argument: change-detect parity — a probed recipient differing from the baseline is refused', async () => {
  const payment = payingFetchMock();
  process.env.POLICY_CONFIG_PATH = recipientsConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    recipients: { mode: 'change-detect', allowed: [], perService: {}, known: { 'analyzer.example': '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  });
  const result = await handler()({ url: 'https://analyzer.example/score', amount: 0.05, chain: 'base', token: 'USDC', recipient: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.decision, 'DENY');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'RECIPIENT_NOT_ALLOWED'));
  assert.equal(payment.calls, 0);
});

it('recipient argument: the compat default (change-detect, no baselines) ignores the recipient entirely', async () => {
  const payment = payingFetchMock();
  const result = await handler()({ url: 'https://analyzer.example/score', amount: 0.05, chain: 'base', token: 'USDC', recipient: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.decision, 'ALLOW', 'no baseline for the host ⇒ the recipient gate is inactive');
  assert.equal(parsed.recipient, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(parsed.recipient_normalized, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(payment.calls, 0);
});

// ---------------------------------------------------------------------------
// Issue #30 — price anomaly detection in x402_check_payment: the inspection
// tool passes the per-service settled-amount baseline into the gate (rule 4.6)
// and echoes the optional reason detail payload. It never records baselines
// (it never pays) — the ledger must stay byte-identical through every check.
// ---------------------------------------------------------------------------

import { appendFileSync } from 'node:fs';

const ANOMALY_ENABLED = {
  enabled: true, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0,
};

function jsonlLines(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

/** The settled baseline the store rehydrates on its first anomaly-enabled read
 * (written BEFORE that first read — rehydration is one-shot per instance):
 * $0.01 ×4 then $0.02 ⇒ mean 0.012, stdev 0.004, 5 samples. */
const BASELINE_ENTRIES = [
  { timestamp: new Date().toISOString(), url: 'https://priced.example/api', method: 'GET', chain: 'base', amount_usdc: 0.01, status: 'success' },
  { timestamp: new Date().toISOString(), url: 'https://priced.example/api', method: 'GET', chain: 'base', amount_usdc: 0.01, status: 'success' },
  { timestamp: new Date().toISOString(), url: 'https://priced.example/api', method: 'GET', chain: 'base', amount_usdc: 0.01, status: 'success' },
  { timestamp: new Date().toISOString(), url: 'https://priced.example/api', method: 'GET', chain: 'base', amount_usdc: 0.01, status: 'success' },
  { timestamp: new Date().toISOString(), url: 'https://priced.example/api', method: 'GET', chain: 'base', amount_usdc: 0.02, status: 'success' },
];

it('price anomaly: a severe spike against the settled baseline is DENIED with the z-score detail echoed', async () => {
  const payment = payingFetchMock();
  // Pre-write the baseline BEFORE the first anomaly-enabled read triggers the
  // one-shot ledger rehydration for this module instance.
  appendFileSync(process.env.PAYMENT_LOG_PATH!, jsonlLines(...BASELINE_ENTRIES) + '\n', 'utf8');
  process.env.POLICY_CONFIG_PATH = recipientsConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    anomaly: ANOMALY_ENABLED,
  });
  const result = await handler()({ url: 'https://priced.example/api', amount: 0.05, chain: 'base', token: 'USDC' }); // z ≈ 9.5
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.decision, 'DENY');
  const reason = parsed.reasons.find((r: any) => r.code === 'PRICE_ANOMALY');
  assert.ok(reason, 'the PRICE_ANOMALY code must be echoed');
  assert.ok(Math.abs(reason.detail.zScore - 9.5) < 1e-6, `z should be ~9.5, got ${reason.detail.zScore}`);
  assert.equal(reason.detail.band, 'deny');
  assert.equal(reason.detail.samples, 5);
  assert.equal(reason.detail.window, 20);
  assert.equal(reason.detail.amount, 0.05);
  assert.equal(reason.detail.host, 'priced.example');
  assert.equal(payment.calls, 0, 'x402_check_payment must make ZERO payment-layer calls');
  assert.deepEqual(ledgerLines(), BASELINE_ENTRIES.map((e) => JSON.stringify(e)), 'inspection must not write to the ledger');
});

it('price anomaly: a mild spike lands in the approval band with detail (middle band, never a hard deny here)', async () => {
  const payment = payingFetchMock();
  process.env.POLICY_CONFIG_PATH = recipientsConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    anomaly: ANOMALY_ENABLED,
  });
  const result = await handler()({ url: 'https://priced.example/api', amount: 0.022, chain: 'base', token: 'USDC' }); // z ≈ 2.5
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.decision, 'APPROVAL_REQUIRED');
  assert.deepEqual(parsed.reasons.map((r: any) => r.code), ['PRICE_ANOMALY', 'APPROVAL_REQUIRED']);
  const detail = parsed.reasons[0].detail;
  assert.ok(Math.abs(detail.zScore - 2.5) < 1e-6);
  assert.equal(detail.band, 'approval');
  assert.equal(payment.calls, 0);
});

it('price anomaly: the compat default (no anomaly block) leaves the inspection unchanged', async () => {
  const payment = payingFetchMock();
  process.env.POLICY_CONFIG_PATH = recipientsConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
  });
  const result = await handler()({ url: 'https://priced.example/api', amount: 0.05, chain: 'base', token: 'USDC' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.decision, 'ALLOW', 'anomaly disabled ⇒ no PRICE_ANOMALY, decisions unchanged');
  assert.deepEqual(parsed.reasons, []);
  assert.equal(parsed.reasons.every((r: any) => r.detail === undefined), true);
  assert.equal(payment.calls, 0);
});

it('price anomaly: the directory price seeds the FIRST call — soft approval band only, never a hard deny (conflict D)', async () => {
  const payment = payingFetchMock();
  process.env.POLICY_CONFIG_PATH = recipientsConfigFile({
    payments: { enabled: true, maxPerRequest: 50, maxDaily: 100 },
    anomaly: ANOMALY_ENABLED,
  });
  // analyzer.example/score is priced 0.05 in the directory and has NO settled
  // baseline — the first check is softly compared against the advertised price.
  const atPrice = await handler()({ url: 'https://analyzer.example/score', amount: 0.05, chain: 'base', token: 'USDC' });
  const atPriceParsed = JSON.parse(atPrice.content[0].text);
  assert.equal(atPriceParsed.decision, 'ALLOW', 'a payment at the advertised price annotates nothing');
  assert.deepEqual(atPriceParsed.reasons, []);

  const above = await handler()({ url: 'https://analyzer.example/score', amount: 0.2, chain: 'base', token: 'USDC' }); // 4× the price
  const aboveParsed = JSON.parse(above.content[0].text);
  assert.equal(aboveParsed.decision, 'APPROVAL_REQUIRED');
  const reason = aboveParsed.reasons.find((r: any) => r.code === 'PRICE_ANOMALY');
  assert.ok(reason);
  assert.equal(reason.detail.band, 'approval');
  assert.ok(Math.abs(reason.detail.ratio - 4) < 1e-9, 'the seed path carries the ratio, not a z-score');
  // Even an absurd amount stays in the approval band — a stub baseline is not
  // evidence for a hard deny (statistics are).
  const huge = await handler()({ url: 'https://analyzer.example/score', amount: 5.0, chain: 'base', token: 'USDC' });
  assert.equal(JSON.parse(huge.content[0].text).decision, 'APPROVAL_REQUIRED');
  assert.equal(JSON.parse(huge.content[0].text).reasons.find((r: any) => r.code === 'PRICE_ANOMALY').detail.band, 'approval');
  assert.equal(payment.calls, 0);
  assert.deepEqual(ledgerLines(), BASELINE_ENTRIES.map((e) => JSON.stringify(e)), 'seeding is a pure derivation — nothing stored, nothing written');
});

it('price anomaly: a Casper inspection stays inert on rule 4.6 (amount 0 by design — conflict A)', async () => {
  const payment = payingFetchMock();
  process.env.POLICY_CONFIG_PATH = recipientsConfigFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    anomaly: ANOMALY_ENABLED,
  });
  const result = await handler()({ url: 'https://casper-stranger.example/api', chain: 'casper', token: 'wCSPR' }); // amount omitted ⇒ 0
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.decision, 'ALLOW', 'the mote-denominated leg must not hit the price gate');
  assert.ok(!parsed.reasons.some((r: any) => r.code === 'PRICE_ANOMALY'));
  assert.equal(parsed.amount, '0.00');
  assert.equal(payment.calls, 0);
  assert.deepEqual(ledgerLines(), BASELINE_ENTRIES.map((e) => JSON.stringify(e)), 'inspection must not write to the ledger');
});
