import { strict as assert } from 'node:assert';
import { afterEach, it } from 'node:test';
import { x402Client } from '@x402/fetch';
import { CasperBudget, guardCasperPayments } from './budget.js';
import { WCSPR_ASSETS, assertPayableCasperAccept } from './accepts.js';
import { csprToMotes } from './networks.js';
const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });
function configure(call = '1', daily = '2') {
  process.env.CASPER_MAX_PAYMENT_PER_CALL = call;
  process.env.CASPER_MAX_DAILY_SPEND = daily;
}
const offer = { scheme: 'exact', network: 'casper:casper' as const, asset: WCSPR_ASSETS['casper:casper'], payTo: '00' + 'ab'.repeat(32), amount: '1000000000', maxTimeoutSeconds: 60, extra: {} };
function clientFor(budget: CasperBudget) {
  let signed = 0;
  const client = new x402Client();
  client.register('casper:casper', { scheme: 'exact', createPaymentPayload: async () => { signed++; return { x402Version: 2, payload: {} }; } });
  guardCasperPayments(client, 'casper:casper', budget);
  return { client, signed: () => signed };
}
function requirements(changes = {}) { return { x402Version: 2, accepts: [{ ...offer, ...changes }], resource: { url: 'https://example.invalid', description: '', mimeType: 'text/plain' } }; }
it('unset either Casper budget disables signing', async () => {
  for (const missing of ['CASPER_MAX_PAYMENT_PER_CALL', 'CASPER_MAX_DAILY_SPEND']) {
    configure(); delete process.env[missing];
    const { client, signed } = clientFor(new CasperBudget());
    await assert.rejects(client.createPaymentPayload(requirements()), /disabled/);
    assert.equal(signed(), 0);
  }
});
it('sub-mote configured budget rejects rather than rounding', () => {
  configure('0.0000000001');
  assert.throws(() => new CasperBudget().reserve(1n), /sub-mote/);
  assert.throws(() => csprToMotes('1.0000000001'), /sub-mote/);
});
it('invalid, zero and negative budgets disable payment', () => {
  for (const value of ['0', '-1', 'NaN', '1e9', 'garbage']) {
    configure(value); assert.throws(() => new CasperBudget().reserve(1n));
  }
});
it('compares above Number.MAX_SAFE_INTEGER exactly', () => {
  configure('9007199.254740993', '9007199.254740993');
  const budget = new CasperBudget();
  assert.throws(() => budget.reserve(9007199254740994n), /per-call/);
  budget.reserve(9007199254740993n);
  assert.equal(budget.getDailySpent(), 9007199254740993n);
});
it('daily reservations prevent concurrent callers overspending', async () => {
  configure('1', '1'); const budget = new CasperBudget();
  const a = clientFor(budget), b = clientFor(budget);
  const outcomes = await Promise.allSettled([a.client.createPaymentPayload(requirements()), b.client.createPaymentPayload(requirements())]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(a.signed() + b.signed(), 1);
});
it('checks changed requirements at signing and blocks retries', async () => {
  configure(); const { client, signed } = clientFor(new CasperBudget());
  await assert.rejects(client.createPaymentPayload(requirements({ amount: '1000000001' })), /per-call/);
  assert.equal(signed(), 0);
  await client.createPaymentPayload(requirements());
  await assert.rejects(client.createPaymentPayload(requirements()), /already authorized/);
  assert.equal(signed(), 1);
});
it('rejects arbitrary and wrong-network assets before signing', async () => {
  configure();
  for (const asset of ['ff'.repeat(32), WCSPR_ASSETS['casper:casper-test']]) {
    const { client, signed } = clientFor(new CasperBudget());
    await assert.rejects(client.createPaymentPayload(requirements({asset})), /wCSPR/);
    assert.equal(signed(), 0);
  }
});
it('validates both canonical network assets', () => {
  for (const [network, asset] of Object.entries(WCSPR_ASSETS)) assert.doesNotThrow(() => assertPayableCasperAccept({...offer, network, asset}));
});
it('rejects malformed payees, fractional motes and conflicting amounts', () => {
  for (const changes of [{payTo: 'bad'}, {amount: '0.1'}, {amount: 1}, {amount:'0'}, {maxAmountRequired:'2'}]) {
    assert.throws(() => assertPayableCasperAccept({...offer, ...changes} as any));
  }
});
it('rolls only the Casper counter at UTC day change', () => {
  configure(); let day = '2026-01-01'; const budget = new CasperBudget(() => day);
  budget.reserve(1000000000n); assert.equal(budget.getDailySpent(),1000000000n);
  day='2026-01-02'; assert.equal(budget.getDailySpent(),0n);
});
