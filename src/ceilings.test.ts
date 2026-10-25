import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Issue #65 (req 4, plan C4) — the OPTIONAL cross-chain spending ceiling.
//
// MAX_DAILY_SPEND_TOTAL_USD is a total across every registered rail, counted
// through the budget registry with each rail's explicitly configured USD
// rate. Unset = today's behaviour, byte-identical. A garbage value fails
// closed (readCapUsd discipline). Enforcement runs inside the SAME
// synchronous check+insert as the USD rail's own daily cap (issue #65 req 5)
// via an extra `total-usd` scope on every outstanding hold while the ceiling
// is active. A rail without a usable USD rate is DISABLED while a ceiling is
// active (RAIL_DISABLED_NO_RATE) — an unpriced rail can never be priced by
// assumption into the total.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-ceilings-'));
process.env.X402_NETWORK_MODE = 'devnet'; // issue #59: name the mode explicitly.
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'payments', 'ledger.jsonl');
process.env.X402_STATE_DIR = join(dir, 'state');

const reservationModule = await import('./reservations.js') as typeof import('./reservations.js');
const budgetRegistry = await import('./budget-registry.js') as typeof import('./budget-registry.js');
const paymentUtils = await import('./payment-utils.js') as typeof import('./payment-utils.js');
const { logPayment } = paymentUtils;
const casperModule = await import('./casper/budget.js') as typeof import('./casper/budget.js');

const originalConsoleError = console.error;
afterEach(() => {
  console.error = originalConsoleError;
  reservationModule._resetReservationsForTests();
  casperModule._resetCasperBudgetForTests();
  paymentUtils._resetForTests();
  process.env = {
    ...env,
    X402_NETWORK_MODE: 'devnet',
    PAYMENT_LOG_PATH: join(dir, 'payments', 'ledger.jsonl'),
    X402_STATE_DIR: join(dir, 'state'),
  };
  delete process.env.MAX_DAILY_SPEND_TOTAL_USD;
});
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

function refuse(result: ReturnType<typeof reservationModule.reserveSpend>, pattern: RegExp): void {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match((result as { ok: false; reason: string }).reason, pattern);
}

it('unset ceiling = today’s behaviour byte-identically', () => {
  delete process.env.MAX_DAILY_SPEND_TOTAL_USD;
  // Settle 5.00 across rails (per-chain daily caps unaffected, ceiling unset).
  logPayment({ timestamp: new Date().toISOString(), url: 'https://ceiling.example/api', method: 'GET', chain: 'base', amount_usdc: 5, status: 'success' });
  const result = reservationModule.reserveSpend({ amountUsd: 0.01 });
  assert.ok(result.ok, JSON.stringify(result));
  reservationModule.releaseReservation((result as { ok: true; id: string }).id);
});

it('an unpriced Casper rail is refused with RAIL_DISABLED_NO_RATE while a ceiling is active (check+reserve)', () => {
  process.env.MAX_DAILY_SPEND_TOTAL_USD = '10.00';
  // One line, loud, at the exact refusal point (the rail's own budget check).
  let lines = 0;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes('RAIL_DISABLED_NO_RATE')) lines++;
  };
  // No rate configured for wCSPR → the rail cannot be priced into the total.
  assert.throws(() => casperModule.casperBudget.check(1_000_000_000n), /RAIL_DISABLED_NO_RATE/);
  assert.throws(() => casperModule.casperBudget.reserve(1_000_000_000n), /RAIL_DISABLED_NO_RATE/);
  assert.equal(lines, 2, 'one stderr line per refusal, never a flood within a refusal');
  assert.equal(casperModule.casperBudget.getDailySpent(), 0n, 'nothing was debited');
});

it('a priced wCSPR rate lifts RAIL_DISABLED_NO_RATE and prices into the ceiling by rate', () => {
  process.env.MAX_DAILY_SPEND_TOTAL_USD = '10.00';
  process.env.X402_RATE_WCSPR_USD = '0.25';
  process.env.CASPER_MAX_PAYMENT_PER_CALL = '10';
  process.env.CASPER_MAX_DAILY_SPEND = '10';
  assert.doesNotThrow(() => casperModule.casperBudget.reserve(1_500_000_000n)); // 1.5 CSPR = $0.375
  const state = reservationModule.ceilingState();
  assert.ok(Math.abs((state.spent_total_usd ?? -1) - 0.375) < 1e-9, 'the Casper rail’s settle counts by its configured rate');
});

it('the ceiling covers settled + held spend across rails in the same check+insert (settled base wins)', () => {
  process.env.MAX_DAILY_SPEND_TOTAL_USD = '10.00';
  // The per-rail daily cap must NOT bind before the ceiling here — raise it
  // so the refusal below is provably the cross-chain ceiling's.
  process.env.MAX_DAILY_SPEND = '12.00';
  // NO wCSPR rate configured here: the Casper rail cannot be priced into the
  // total, so it contributes nothing AND appears in the disabled list.
  // Settle 8.50 USD-worth and hold 0.60 USD-worth concurrently.
  logPayment({ timestamp: new Date().toISOString(), url: 'https://ceiling.example/api', method: 'GET', chain: 'base', amount_usdc: 8.5, status: 'success' });
  process.env.MAX_PAYMENT_PER_CALL = '2.00';
  process.env.CASPER_MAX_PAYMENT_PER_CALL = '10';
  process.env.CASPER_MAX_DAILY_SPEND = '10';
  // The USD rail's hold counts; the Casper rail contributes nothing (unpriced).
  const held = reservationModule.reserveSpend({ amountUsd: 0.6 });
  assert.ok(held.ok, JSON.stringify(held));
  const holdId = (held as { ok: true; id: string }).id;
  const state = reservationModule.ceilingState();
  assert.equal(state.active, true);
  assert.ok(Math.abs((state.spent_total_usd ?? -1) - 8.5) < 1e-9);
  assert.ok(Math.abs((state.reserved_total_usd ?? -1) - 0.6) < 1e-9);
  assert.deepEqual((state.disabled_rails ?? []).map((d) => d.rail).sort(), ['casper'], 'every rail the ceiling cannot price is listed with the stable refusal code');
  assert.equal((state.disabled_rails ?? [])[0]?.code, 'RAIL_DISABLED_NO_RATE');
  // Remaining ceiling room: 10.00 − 8.50 − 0.60 = 0.90 — a 1.00 request is refused.
  refuse(reservationModule.reserveSpend({ amountUsd: 1.0 }), /cross-chain/);
  // 0.50 fits: allowed.
  const ok = reservationModule.reserveSpend({ amountUsd: 0.5 });
  assert.ok(ok.ok, JSON.stringify(ok));
  reservationModule.releaseReservation((ok as { ok: true; id: string }).id);
  reservationModule.releaseReservation(holdId);
});

it('concurrency: parallel holds against the ceiling insert exactly one (check+insert race-safe)', async () => {
  process.env.MAX_DAILY_SPEND_TOTAL_USD = '2.00';
  process.env.MAX_PAYMENT_PER_CALL = '2.00';
  const results = await Promise.all([
    reservationModule.reserveSpend({ amountUsd: 1.5 }),
    reservationModule.reserveSpend({ amountUsd: 1.5 }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one hold may be inserted against a 2.00 ceiling');
  for (const r of results.filter((r) => !r.ok)) {
    assert.match((r as { ok: false; reason: string }).reason, /cross-chain/);
  }
});

it('a garbage ceiling value fails closed (refuse every reservation, never widen)', () => {
  process.env.MAX_DAILY_SPEND_TOTAL_USD = 'not-a-number';
  let lines = 0;
  console.error = () => { lines++; };
  refuse(reservationModule.reserveSpend({ amountUsd: 0.01 }), /cross-chain/);
  assert.ok(lines > 0, 'the garbage value was logged, not silently ignored');
  assert.equal(reservationModule.dailyTotalCeilingUsd(), 0, 'fail closed: the ceiling reads 0');
});

it('a nano-shaped test-double prices via its native USD spend (spentUsdToday overrides conversion)', () => {
  process.env.MAX_DAILY_SPEND_TOTAL_USD = '10.00';
  // A rail whose native spentUsdToday is a float prices even at 30 decimals.
  budgetRegistry.registerBudget({
    id: 'nano-ceiling-double',
    unit: 'XNO',
    decimals: 30,
    perCallCap: () => ({ atomic: '1000000', decimals: 30 }),
    dailyCap: () => ({ atomic: '2000000', decimals: 30 }),
    spentToday: () => ({ atomic: '1', decimals: 30 }),
    spentUsdToday: () => 0.25,
    persistence: 'memory',
    usdRate: () => 2,
  });
  const state = reservationModule.ceilingState();
  assert.ok(!state.disabled_rails!.some((d) => d.rail === 'nano-ceiling-double'), 'a native-USD rail prices without conversion');
  assert.ok(Math.abs((state.spent_total_usd ?? 0) - 0.25) < 1e-12);
  budgetRegistry._resetBudgetRegistryForTests();
});