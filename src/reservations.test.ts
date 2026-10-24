import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Issue #54 (req 1) — the reserve-before-sign registry: a synchronously
// checked+inserted reservation of USD spend per scope ('global' plus
// 'service:<host>') so overlapping tool calls cannot each pass the same
// remaining budget. The registry is exercised directly here; the fetch.ts
// wiring is covered by the fetch-level tests (see fetch-accounting.test.ts).
//
// Hermetic: temp ledger, no network. Caps come from MAX_DAILY_SPEND /
// MAX_PAYMENT_PER_CALL read live per call, so each scenario pins its own env.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-reserv-'));
const baseEnv = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.MAX_DAILY_SPEND = '50';
process.env.MAX_PAYMENT_PER_CALL = '50';

// The specifier is a variable on purpose: this file must COMPILE and RUN at
// the RED step (before src/reservations.ts exists), so the missing module
// surfaces as failing assertions, not as a compile error.
const RESERVATIONS_PATH = './reservations.js';
const reservationsRaw = await import(RESERVATIONS_PATH).catch(() => undefined) as any;
function requireReservations(): any {
  assert.ok(reservationsRaw && typeof reservationsRaw.reserveSpend === 'function',
    'src/reservations.ts must exist and export reserveSpend (issue #54 RED step)');
  return reservationsRaw;
}
const { reserveSpend, settleReservation, releaseReservation, reservedUsd, _resetReservationsForTests } = {
  reserveSpend: (...a: unknown[]) => requireReservations().reserveSpend(...a),
  settleReservation: (...a: unknown[]) => requireReservations().settleReservation(...a),
  releaseReservation: (...a: unknown[]) => requireReservations().releaseReservation(...a),
  reservedUsd: (...a: unknown[]) => requireReservations().reservedUsd(...a),
  _resetReservationsForTests: () => { if (reservationsRaw?._resetReservationsForTests) reservationsRaw._resetReservationsForTests(); },
};

const PRICE = 0.01;
const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  process.env = { ...baseEnv, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), MAX_DAILY_SPEND: '50', MAX_PAYMENT_PER_CALL: '50' };
  _resetReservationsForTests();
});
after(() => { process.env = baseEnv; rmSync(dir, { recursive: true, force: true }); });

it('N interleaved reservations against a cap of k×price → exactly k are granted', async () => {
  process.env.MAX_DAILY_SPEND = '0.03'; // budget for exactly k = 3 prices
  process.env.MAX_PAYMENT_PER_CALL = '0.50';
  const granted: string[] = [];
  const refused: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = reserveSpend({ amountUsd: PRICE });
    if (r.ok) granted.push(r.id);
    else refused.push(r.reason);
    await settle(); // yield between calls exactly as overlapping tool calls do
  }
  assert.equal(granted.length, 3, 'exactly k = 3 reservations may hold at once');
  assert.equal(refused.length, 3, 'the rest are refused');
  assert.ok(refused.every((reason) => reason.includes('MAX_DAILY_SPEND')), 'the refusal names the daily cap');
  assert.ok(Math.abs(reservedUsd('global') - 3 * PRICE) < 1e-9, 'outstanding reservations expose the reserved amount');
});

it('release-on-no-sign frees the budget for the next caller', () => {
  process.env.MAX_DAILY_SPEND = '0.01'; // one price of budget
  process.env.MAX_PAYMENT_PER_CALL = '0.50';
  const first = reserveSpend({ amountUsd: PRICE });
  assert.ok(first.ok);
  releaseReservation(first.id);
  assert.equal(reservedUsd('global'), 0, 'a released reservation leaves nothing outstanding');
  const second = reserveSpend({ amountUsd: PRICE });
  assert.ok(second.ok, 'after release the budget is available again');
  assert.notEqual(second.id, first.id);
});

it('settle-on-sign clears the reservation once the amount is accounted elsewhere', () => {
  process.env.MAX_DAILY_SPEND = '0.02';
  process.env.MAX_PAYMENT_PER_CALL = '0.50';
  const first = reserveSpend({ amountUsd: PRICE });
  assert.ok(first.ok);
  settleReservation(first.id);
  assert.equal(reservedUsd('global'), 0, 'a settled reservation no longer holds budget');
  const second = reserveSpend({ amountUsd: PRICE });
  assert.ok(second.ok);
});

it('a path that throws between reserve and release leaks nothing (the try/finally contract)', async () => {
  process.env.MAX_DAILY_SPEND = '50';
  process.env.MAX_PAYMENT_PER_CALL = '50';
  const first = reserveSpend({ amountUsd: PRICE });
  assert.ok(first.ok);
  await assert.rejects(
    async () => {
      try { throw new Error('boom — nothing was signed'); } finally { releaseReservation(first.id); }
    },
  );
  assert.equal(reservedUsd('global'), 0, 'no leaked reservation after a throw');
  const again = reserveSpend({ amountUsd: PRICE });
  assert.ok(again.ok, 'the freed budget is usable again');
});

it('reservations scope per service alongside the global budget', () => {
  process.env.MAX_DAILY_SPEND = '50';
  process.env.MAX_PAYMENT_PER_CALL = '50';
  const r = reserveSpend({ amountUsd: PRICE, scopes: ['service:hosta.invalid'] });
  assert.ok(r.ok);
  assert.ok(Math.abs(reservedUsd('service:hosta.invalid') - PRICE) < 1e-9);
  assert.ok(Math.abs(reservedUsd('global') - PRICE) < 1e-9, 'the global scope always participates');
  // A second caller against the SAME service is visible through the scope…
  const r2 = reserveSpend({ amountUsd: PRICE, scopes: ['service:hosta.invalid'] });
  assert.ok(r2.ok);
  assert.ok(Math.abs(reservedUsd('service:hosta.invalid') - 2 * PRICE) < 1e-9);
  settleReservation(r.id);
  releaseReservation(r2.id);
  assert.equal(reservedUsd('service:hosta.invalid'), 0);
  assert.equal(reservedUsd('global'), 0);
});

it('refuses amounts that are non-finite, negative, or above the per-call cap', () => {
  process.env.MAX_PAYMENT_PER_CALL = '0.005';
  process.env.MAX_DAILY_SPEND = '50';
  assert.equal(reserveSpend({ amountUsd: PRICE }).ok, false, 'above MAX_PAYMENT_PER_CALL');
  assert.equal(reserveSpend({ amountUsd: Infinity }).ok, false, 'non-finite');
  assert.equal(reserveSpend({ amountUsd: -1 }).ok, false, 'negative');
  assert.equal(reservedUsd('global'), 0, 'refusals hold nothing');
});

it('refusals never insert a reservation (check + insert are one atomic step)', async () => {
  process.env.MAX_DAILY_SPEND = '0.01';
  process.env.MAX_PAYMENT_PER_CALL = '0.50';
  const r = reserveSpend({ amountUsd: PRICE });
  assert.ok(r.ok);
  await settle();
  const over = reserveSpend({ amountUsd: PRICE });
  assert.equal(over.ok, false);
  assert.equal(reservedUsd('global'), PRICE, 'the refused call changed nothing');
  releaseReservation(r.id);
});