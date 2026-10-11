import { strict as assert } from 'node:assert';
import { afterEach, it } from 'node:test';
import { x402Client } from '@x402/fetch';
import { NanoBudget, guardNanoPayments } from './budget.js';

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
    const { client, sent } = clientFor(new NanoBudget());
    await assert.rejects(client.createPaymentPayload(requirements()), /disabled/);
    assert.equal(sent(), 0);
  }
});
it('invalid, zero and negative budgets disable payment', () => {
  for (const value of ['0', '-1', 'NaN', '1e9', 'garbage']) {
    configure(value); assert.throws(() => new NanoBudget().reserve(1n));
  }
});
it('budgets compare in exact raw far beyond Number precision', () => {
  configure('0.001', '0.001');
  const budget = new NanoBudget();
  assert.throws(() => budget.reserve(10n ** 27n + 1n), /per-call/);
  budget.reserve(10n ** 27n);
  assert.throws(() => budget.reserve(1n), /daily/);
  assert.equal(budget.getDailySpent(), 10n ** 27n);
});
it('daily reservations prevent concurrent callers overspending', async () => {
  configure('0.001', '0.001'); const budget = new NanoBudget();
  const a = clientFor(budget), b = clientFor(budget);
  const outcomes = await Promise.allSettled([a.client.createPaymentPayload(requirements()), b.client.createPaymentPayload(requirements())]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(a.sent() + b.sent(), 1);
});
it('checks changed requirements at send time and allows one send per call', async () => {
  configure(); const { client, sent } = clientFor(new NanoBudget());
  await assert.rejects(client.createPaymentPayload(requirements({ amount: '1000000000000000000000000001' })), /per-call/);
  await assert.rejects(client.createPaymentPayload(requirements({ payTo: PAY_TO.slice(0, -1) + '4' })), /checksum-valid/);
  await assert.rejects(client.createPaymentPayload(requirements({ asset: 'USDC' })), /XNO/);
  assert.equal(sent(), 0);
  await client.createPaymentPayload(requirements());
  await assert.rejects(client.createPaymentPayload(requirements()), /already authorized/);
  assert.equal(sent(), 1);
});
it('rolls the Nano counter at UTC day change', () => {
  configure(); let day = '2026-01-01'; const budget = new NanoBudget(() => day);
  budget.reserve(10n ** 27n); assert.equal(budget.getDailySpent(), 10n ** 27n);
  day = '2026-01-02'; assert.equal(budget.getDailySpent(), 0n);
});
