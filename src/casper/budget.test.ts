import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { x402Client } from '@x402/fetch';
import { WCSPR_ASSETS, assertPayableCasperAccept } from './accepts.js';
import { csprToMotes } from './networks.js';

// Issue #54 (req 6): the singleton rehydrates today's Casper daily spend from
// the ledger — so THIS module must capture a hermetic ledger path. Set the env
// BEFORE importing budget.js (capture-at-load convention, mirroring
// casper-fetch.test.ts / payment-utils.rehydrate.test.ts).
const dir = mkdtempSync(join(tmpdir(), 'x402-casper-budget-'));
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_STATE_DIR = join(dir, 'state');
mkdirSync(process.env.X402_STATE_DIR, { recursive: true });
const env = { ...process.env };
const { CasperBudget, guardCasperPayments, casperBudget } = await import('./budget.js');
type CasperBudgetInstance = InstanceType<typeof CasperBudget>;

afterEach(() => { process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_STATE_DIR: join(dir, 'state') }; });
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });
function configure(call = '1', daily = '2') {
  process.env.CASPER_MAX_PAYMENT_PER_CALL = call;
  process.env.CASPER_MAX_DAILY_SPEND = daily;
}
const offer = { scheme: 'exact', network: 'casper:casper' as const, asset: WCSPR_ASSETS['casper:casper'], payTo: '00' + 'ab'.repeat(32), amount: '1000000000', maxTimeoutSeconds: 60, extra: {} };
function clientFor(budget: CasperBudgetInstance) {
  let signed = 0;
  const client = new x402Client();
  // @x402/core >= 2.25 spendControls default to SDK-recognized assets only and
  // run before payment-creation hooks; these tests exercise THIS repo's guard
  // (the production casper-fetch path disables SDK controls the same way).
  client.setSpendControls(false);
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

// ---------------------------------------------------------------------------
// Issue #54 (req 6): the Casper daily budget must STOP RESETTING across a
// restart — the singleton rehydrates today's mote total from the SAME ledger
// rows every other counter reads, through the SAME counted-spend predicate
// (a verified success counts; a signed-but-unverified authorization counts
// until the sent payload's own expires_at; failed never counts). Amounts are
// the rows' exact amount_motes — never a USD conversion, never an invented
// price (the unset-rate path keeps refusing, RAIL_DISABLED_NO_RATE).
// ---------------------------------------------------------------------------

let bust = 0;
const rows = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n');
const TODAY = new Date().toISOString();
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString();
const casperRow = (changes: Record<string, unknown> = {}) => ({
  timestamp: TODAY, url: 'https://casper-svc.invalid/api', method: 'GET', chain: 'casper',
  currency: 'wCSPR', amount_motes: '0', status: 'success', tx_hash: 'ab'.repeat(32), ...changes,
});
/** A temp ledger holding CASPER daily spend of exactly 3 + 2 = 5 CSPR today
 * (one success, one unexpired sent authorization) amid rows that must NOT
 * count (yesterday's spend, a failed row, an expired authorization). */
function writeLedger(): void {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(process.env.PAYMENT_LOG_PATH!, rows(
    casperRow({ amount_motes: '3000000000' }),
    casperRow({ amount_motes: '2000000000', status: 'authorized_unserved', expires_at: future, tx_hash: undefined }),
    casperRow({ amount_motes: '7000000000', timestamp: YESTERDAY }),
    casperRow({ amount_motes: '8000000000', status: 'failed', tx_hash: undefined }),
    casperRow({ amount_motes: '4000000000', status: 'authorized_unserved', expires_at: past, tx_hash: undefined }),
    casperRow({ amount_motes: 'not-motes' }),
    '{corrupted line',
  ) + '\n', 'utf8');
}

it('rehydrates today’s Casper daily total from the ledger (a restart is not a reset)', async () => {
  writeLedger();
  configure('100', '100');
  const fresh = await import(`./budget.js?casper54=${++bust}`) as typeof import('./budget.js');
  assert.equal(fresh.casperBudget.getDailySpent(), 5000000000n, 'today’s CSPR settle + sent authorization rehydrate as exact motes');
  // In-process on top: a new debit lands on the rehydrated total.
  fresh.casperBudget.reserve(1000000000n);
  assert.equal(fresh.casperBudget.getDailySpent(), 6000000000n, 'a post-restart debit adds to the rehydrated total, never to zero');
  // A fresh INSTANCE created by a caller stays process-local (no rehydration
  // side effects on throwaway budgets — the guard’s own check is unaffected).
  const local = new fresh.CasperBudget();
  assert.equal(local.getDailySpent(), 0n, 'plain CasperBudget instances are not rehydrated');
});

it('a different working directory does not reset the rehydrated total (the ledger location is absolute)', async () => {
  writeLedger();
  const other = mkdtempSync(join(tmpdir(), 'x402-casper-cwd-'));
  const saved = process.cwd();
  let spent: bigint;
  try {
    process.chdir(other);
    const fresh = await import(`./budget.js?casper54=${++bust}`) as typeof import('./budget.js');
    spent = fresh.casperBudget.getDailySpent();
  } finally {
    process.chdir(saved);
    rmSync(other, { recursive: true, force: true });
  }
  assert.equal(spent, 5000000000n, 'the SAME absolute ledger rehydrates the same total from any cwd (issue #54 req 7’s resolver)');
});

it('the unset-rate path still refuses rather than pricing an unknown rail — rehydration is motes, never a USD conversion', async () => {
  writeLedger();
  process.env.MAX_DAILY_SPEND_TOTAL_USD = '10.00';
  delete process.env.X402_RATE_WCSPR_USD;
  const fresh = await import(`./budget.js?casper54=${++bust}`) as typeof import('./budget.js');
  assert.equal(fresh.casperBudget.getDailySpent(), 5000000000n, 'the rehydrated total is exact motes — never a priced conversion');
  assert.throws(() => fresh.casperBudget.check(1000000000n), /RAIL_DISABLED_NO_RATE/, 'the cross-chain ceiling refuses an unpriced rail, rehydrated or not');
});
