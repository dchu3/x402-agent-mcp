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
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({
  endpoints: [
    { name: 'Analyzer', description: '', base_url: 'https://analyzer.example', chain: 'base', category: 'ai', tags: [], endpoints: [{ path: '/score', method: 'POST', price_usdc: '0.05', description: '' }] },
    { name: 'SolPay', description: '', base_url: 'https://solpay.example', chain: 'solana', category: 'multi', tags: [], endpoints: [] },
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