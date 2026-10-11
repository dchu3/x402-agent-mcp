import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { x402Client } from '@x402/fetch';
import { NanoBudget, guardNanoPayments, nanoSpentFromLedger } from './budget.js';

// Hermetic ledgers: every budget in this file reads its own temp ledger,
// never the operator's ./x402-payments.jsonl.
const tmp = mkdtempSync(join(tmpdir(), 'x402-nano-budget-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let ledgers = 0;
function ledger(...rows: unknown[]): string {
  const path = join(tmp, `ledger-${++ledgers}.jsonl`);
  writeFileSync(path, rows.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}
const empty = () => join(tmp, `missing-${++ledgers}.jsonl`);
const TODAY = '2026-01-01';
const HASH = 'C0FFEE'.repeat(10) + 'ABCD';
function row(changes: Record<string, unknown> = {}) {
  return { timestamp: `${TODAY}T12:00:00.000Z`, url: 'https://example.invalid', method: 'GET', chain: 'nano', currency: 'XNO', amount_raw: String(10n ** 27n), tx_hash: HASH, status: 'success', ...changes };
}
function budgetOver(path: string, day = () => TODAY) { return new NanoBudget(day, () => path); }

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });
function configure(call = '0.001', daily = '0.002') {
  process.env.NANO_MAX_PAYMENT_PER_CALL = call;
  process.env.NANO_MAX_DAILY_SPEND = daily;
}
const PAY_TO = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const offer = { scheme: 'exact', network: 'nano:mainnet' as const, asset: 'XNO', payTo: PAY_TO, amount: '1000000000000000000000000000', maxTimeoutSeconds: 60, extra: {} };
function clientFor(budget: NanoBudget) {
  let sent = 0;
  const client = new x402Client();
  client.setSpendControls(false);
  client.register('nano:mainnet', { scheme: 'exact', createPaymentPayload: async () => { sent++; return { x402Version: 2, payload: { blockHash: 'AB'.repeat(32) } }; } });
  guardNanoPayments(client, 'nano:mainnet', budget);
  return { client, sent: () => sent };
}
function requirements(changes = {}) { return { x402Version: 2, accepts: [{ ...offer, ...changes }], resource: { url: 'https://example.invalid', description: '', mimeType: 'text/plain' } }; }

it('unset either Nano budget disables sending', async () => {
  for (const missing of ['NANO_MAX_PAYMENT_PER_CALL', 'NANO_MAX_DAILY_SPEND']) {
    configure(); delete process.env[missing];
    const { client, sent } = clientFor(new NanoBudget(undefined, empty));
    await assert.rejects(client.createPaymentPayload(requirements()), /disabled/);
    assert.equal(sent(), 0);
  }
});
it('invalid, zero and negative budgets disable payment', () => {
  for (const value of ['0', '-1', 'NaN', '1e9', 'garbage']) {
    configure(value); assert.throws(() => new NanoBudget(undefined, empty).reserve(1n));
  }
});
it('budgets compare in exact raw far beyond Number precision', () => {
  configure('0.001', '0.001');
  const budget = new NanoBudget(undefined, empty);
  assert.throws(() => budget.reserve(10n ** 27n + 1n), /per-call/);
  budget.reserve(10n ** 27n);
  assert.throws(() => budget.reserve(1n), /daily/);
  assert.equal(budget.getDailySpent(), 10n ** 27n);
});
it('daily reservations prevent concurrent callers overspending', async () => {
  configure('0.001', '0.001'); const budget = new NanoBudget(undefined, empty);
  const a = clientFor(budget), b = clientFor(budget);
  const outcomes = await Promise.allSettled([a.client.createPaymentPayload(requirements()), b.client.createPaymentPayload(requirements())]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(a.sent() + b.sent(), 1);
});
it('checks changed requirements at send time and allows one send per call', async () => {
  configure(); const { client, sent } = clientFor(new NanoBudget(undefined, empty));
  await assert.rejects(client.createPaymentPayload(requirements({ amount: '1000000000000000000000000001' })), /per-call/);
  await assert.rejects(client.createPaymentPayload(requirements({ payTo: PAY_TO.slice(0, -1) + '4' })), /checksum-valid/);
  await assert.rejects(client.createPaymentPayload(requirements({ asset: 'USDC' })), /XNO/);
  assert.equal(sent(), 0);
  await client.createPaymentPayload(requirements());
  await assert.rejects(client.createPaymentPayload(requirements()), /already authorized/);
  assert.equal(sent(), 1);
});
it('rolls the Nano counter at UTC day change', () => {
  configure(); let day = '2026-01-01'; const budget = new NanoBudget(() => day, empty);
  budget.reserve(10n ** 27n); assert.equal(budget.getDailySpent(), 10n ** 27n);
  day = '2026-01-02'; assert.equal(budget.getDailySpent(), 0n);
});

it('restart rehydrates today\'s Nano spend from the ledger, so the daily cap still holds', () => {
  configure('0.001', '0.002');
  const path = ledger(row(), row());
  const restarted = budgetOver(path);
  assert.equal(restarted.getDailySpent(), 2n * 10n ** 27n);
  assert.throws(() => restarted.reserve(1n), /daily/);
  const { client, sent } = clientFor(restarted);
  return assert.rejects(client.createPaymentPayload(requirements()), /daily/).then(() => assert.equal(sent(), 0));
});
it('rows from other UTC days are ignored', () => {
  configure('0.001', '0.002');
  const path = ledger(row({ timestamp: '2025-12-31T23:59:59.999Z' }), row({ timestamp: '2026-01-02T00:00:00.000Z' }), row());
  const budget = budgetOver(path);
  assert.equal(budget.getDailySpent(), 10n ** 27n);
  budget.reserve(10n ** 27n);
  assert.throws(() => budget.reserve(1n), /daily/);
});
it('failed rows without a published block, other chains and malformed rows are ignored', () => {
  const path = ledger(
    row({ status: 'failed', tx_hash: undefined }),
    row({ status: 'failed', tx_hash: 'not-a-hash', amount_raw: '5' }),
    row({ chain: 'casper', amount_motes: '7', amount_raw: '7' }),
    row({ chain: 'base', amount_usdc: 0.5, amount_raw: '9' }),
    row({ amount_raw: '-1000' }), row({ amount_raw: '1.5' }), row({ amount_raw: 12 }), row({ amount_raw: '1e30' }),
    row({ amount_raw: String(1n << 128n) }), row({ amount_raw: '' }), row({ amount_raw: undefined }),
    row({ timestamp: 20260101 }), row({ status: 'pending' }),
    '{not json', 'null', '[]', '42',
    row({ amount_raw: '3' }),
  );
  assert.equal(nanoSpentFromLedger(path, TODAY), 3n);
});
it('a failed row that carries a published block hash stays counted (the send may still confirm)', () => {
  const path = ledger(row({ status: 'failed', amount_raw: '11' }), row({ amount_raw: '4' }));
  assert.equal(nanoSpentFromLedger(path, TODAY), 15n);
});
it('a missing ledger is zero spend; an unreadable ledger fails closed', () => {
  configure();
  assert.equal(budgetOver(empty()).getDailySpent(), 0n);
  const dirAsLedger = join(tmp, 'is-a-directory');
  mkdirSync(dirAsLedger);
  const budget = budgetOver(dirAsLedger);
  assert.throws(() => budget.getDailySpent(), /disabled.*ledger/);
  assert.throws(() => budget.reserve(1n), /disabled.*ledger/);
});
it('the ledger is re-read when the UTC day changes', () => {
  configure('0.001', '0.002');
  let day = '2025-12-31';
  const path = ledger(row({ timestamp: '2025-12-31T10:00:00.000Z' }), row());
  const budget = new NanoBudget(() => day, () => path);
  assert.equal(budget.getDailySpent(), 10n ** 27n);
  budget.reserve(10n ** 27n);
  assert.equal(budget.getDailySpent(), 2n * 10n ** 27n);
  day = TODAY;
  assert.equal(budget.getDailySpent(), 10n ** 27n);
});
