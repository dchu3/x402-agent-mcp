import { strict as assert } from 'node:assert';
import { after, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Issue #65 (plan C2) — ONE budget registry. Every spending rail registers
// through it as an ADAPTER over its existing accounting module — no duplicated
// accounting — and a future rail registers WITHOUT touching any output code
// (that is the #65 acceptance test 5: the test-double rail below appears in
// the registry solely through registerBudget).
//
// Hermetic: temp ledger set BEFORE importing payment-utils (its module scope
// captures the ledger resolution), so the USD rail's rehydrated accounting
// reads only this suite's rows. No network.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-budget-registry-'));
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.MAX_PAYMENT_PER_CALL = '0.50';
process.env.MAX_DAILY_SPEND = '10.00';
env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');

const registry = await import('./budget-registry.js') as typeof import('./budget-registry.js');
// Adapter registration is self-registration at module load of the rails.
await import('./payment-utils.js');
await import('./casper/budget.js');

const { registerBudget, getBudgets, railUsdRateVar, resolveRailUsdRate, _resetBudgetRegistryForTests } = registry;

after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

function rail(id: string) {
  const rail = getBudgets().find((r) => r.id === id);
  assert.ok(rail, `the "${id}" rail must be registered (adapters self-register at module load)`);
  return rail!;
}

it('the registry lists the USD rail and the Casper rail as adapters over the existing modules', () => {
  assert.deepEqual(getBudgets().map((r) => r.id).sort(), ['casper', 'usd']);
});

it('the USD rail adapter reads its caps and spend through the existing payment-utils accounting', async () => {
  const usd = rail('usd');
  assert.equal(usd.unit, 'USDC');
  assert.equal(usd.decimals, 6);
  assert.deepEqual(usd.perCallCap(), { atomic: '500000', decimals: 6 }, 'MAX_PAYMENT_PER_CALL 0.50 at 6 decimals');
  assert.deepEqual(usd.dailyCap(), { atomic: '10000000', decimals: 6 }, 'MAX_DAILY_SPEND 10.00 at 6 decimals');
  assert.equal(usd.persistence, 'ledger-rehydrated', 'the USD counters rehydrate from the ledger');
  assert.equal(usd.ledgerPath, process.env.PAYMENT_LOG_PATH, 'the effective ledger path is the USD rail’s accounting location');
  assert.equal(usd.usdRate(), 1, 'the USD rail is pegged — 1 USD per whole unit (no built-in override beyond the peg)');

  // Spend reads the EXISTING counter through logPayment — BigInt/string only,
  // never a duplicated tracker.
  const { logPayment } = await import('./payment-utils.js') as typeof import('./payment-utils.js');
  logPayment({ timestamp: new Date().toISOString(), url: 'https://registry.example/api', method: 'GET', chain: 'base', amount_usdc: 0.003, status: 'success' });
  assert.deepEqual(usd.spentToday(), { atomic: '3000', decimals: 6 }, '0.003 USDC settled spend = 3000 atomic');
});

it('the USD rail reports today’s USD spend (the number its own caps compare) and outstanding holds', () => {
  const usd = rail('usd');
  assert.ok(typeof usd.spentUsdToday === 'function');
  assert.ok(Math.abs((usd.spentUsdToday?.() ?? -1) - 0.003) < 1e-9);
  assert.equal(usd.reservedToday?.(), null, 'nothing is outstanding in a fresh process');
});

it('the Casper rail adapter prices nothing by default (NO built-in rate, ever) and stays memory-backed', () => {
  const casper = rail('casper');
  assert.equal(casper.unit, 'wCSPR');
  assert.equal(casper.decimals, 9);
  assert.equal(casper.persistence, 'memory', 'the Casper counter is memory-only — the honest value to print (#65 req 2)');
  assert.equal(casper.ledgerPath, undefined, 'no ledger is the source of truth for the Casper counter');
  assert.equal(casper.usdRate(), null, 'no X402_RATE_WCSPR_USD configured → no rate, no ship-by-default');
});

it('the Casper rail adapter reads its mote budgets through the existing csprToMotes math', () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL = '1';
  process.env.CASPER_MAX_DAILY_SPEND = '2';
  const casper = rail('casper');
  assert.deepEqual(casper.perCallCap(), { atomic: '1000000000', decimals: 9 }, '1 CSPR = 10^9 motes');
  assert.deepEqual(casper.dailyCap(), { atomic: '2000000000', decimals: 9 });
  delete process.env.CASPER_MAX_PAYMENT_PER_CALL;
  assert.equal(rail('casper').perCallCap(), null, 'an unset budget is no cap (and the rail refuses paid calls on its own)');
});

it('a configured X402_RATE_WCSPR_USD is the Casper rail’s rate (env first, then the asset table)', () => {
  process.env.X402_RATE_WCSPR_USD = '0.25';
  assert.equal(rail('casper').usdRate(), 0.25);
  delete process.env.X402_RATE_WCSPR_USD;
  assert.equal(rail('casper').usdRate(), null, 'unpriced again once the operator config is gone');
});

it('rail USD rates resolve through ONE function: env var first, else the given table rate/peg', () => {
  assert.equal(railUsdRateVar('wCSPR'), 'X402_RATE_WCSPR_USD');
  assert.equal(railUsdRateVar('usdc'), 'X402_RATE_USDC_USD');
  process.env.X402_RATE_USDC_USD = '2';
  assert.equal(resolveRailUsdRate('USDC', 1), 2, 'the env var wins over the peg');
  delete process.env.X402_RATE_USDC_USD;
  assert.equal(resolveRailUsdRate('USDC', 1), 1, 'a pegged table entry prices at exactly 1');
  assert.equal(resolveRailUsdRate('wCSPR', undefined), null, 'no env and no table rate → never an assumed rate');
  assert.equal(resolveRailUsdRate('wCSPR', 0.03), 0.03, 'a positive table rate is a real rate');
  // Fail closed on garbage and non-positive values:
  process.env.X402_RATE_WCSPR_USD = 'abc';
  assert.equal(resolveRailUsdRate('wCSPR', 0.03), null, 'a garbage env rate is NOT a rate (fail closed)');
  process.env.X402_RATE_WCSPR_USD = '0';
  assert.equal(resolveRailUsdRate('wCSPR', 0.03), null, 'a zero rate prices nothing');
  process.env.X402_RATE_WCSPR_USD = '-1';
  assert.equal(resolveRailUsdRate('wCSPR', 0.03), null, 'a negative rate prices nothing');
  delete process.env.X402_RATE_WCSPR_USD;
});

it('a future rail registers without touching any output code (#65 acceptance test 5)', () => {
  const before = getBudgets().length;
  registerBudget({
    id: 'nano-test-double',
    unit: 'XNO',
    decimals: 30,
    perCallCap: () => ({ atomic: '1', decimals: 30 }),
    dailyCap: () => ({ atomic: '2', decimals: 30 }),
    spentToday: () => ({ atomic: '0', decimals: 30 }),
    persistence: 'memory',
    usdRate: () => null,
  });
  const doubled = getBudgets().find((r) => r.id === 'nano-test-double');
  assert.ok(doubled, 'the test-double rail is listed');
  assert.equal(getBudgets().length, before + 1);
  assert.deepEqual(doubled!.spentToday(), { atomic: '0', decimals: 30 }, 'the adapter’s own closures decide its shape');
});

it('re-registering a rail id is loud and never doubles the list (fresh-process instances win)', () => {
  const casper = rail('casper');
  const before = getBudgets().length;
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  try { registerBudget({ ...casper }); } finally { console.error = original; }
  assert.ok(errors.some((e) => e.includes('re-registered')), 'the replacement must be loud on stderr');
  assert.equal(getBudgets().length, before, 'one listed rail per id, never a double');
  assert.equal(getBudgets().filter((r) => r.id === 'casper').length, 1);
});

it('the registry exposes every rail’s USD-valued spend through one conversion', async () => {
  const { railSpendUsd } = registry;
  const usd = rail('usd');
  const casper = rail('casper');
  assert.ok(Math.abs((railSpendUsd(usd) ?? -1) - 0.003) < 1e-9, 'the USD rail prices natively (its ledger float)');
  assert.equal(railSpendUsd(casper), null, 'no configured rate → the spend is unpriced, never an assumed value');
  process.env.X402_RATE_WCSPR_USD = '0.25';
  // Spend 1.5 CSPR (1_500_000_000 motes) in the singleton, then price it.
  // The mote budgets gate reserve() first — this scenario is about pricing,
  // so give the rail its configured budgets.
  process.env.CASPER_MAX_PAYMENT_PER_CALL = '10';
  process.env.CASPER_MAX_DAILY_SPEND = '10';
  const { casperBudget, _resetCasperBudgetForTests } = await import('./casper/budget.js') as typeof import('./casper/budget.js');
  casperBudget.reserve(1_500_000_000n);
  assert.ok(Math.abs((railSpendUsd(rail('casper')) ?? -1) - 0.375) < 1e-9, '1.5 CSPR at $0.25/CSPR = $0.375 (exact integer path)');
  _resetCasperBudgetForTests();
  delete process.env.X402_RATE_WCSPR_USD;
});