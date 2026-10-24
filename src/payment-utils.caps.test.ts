import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Issue #54 (cap-parsing hardening) — spend caps must fail CLOSED. Today
// parseFloat turns "abc" into NaN, and `amount > NaN` is false, so a garbage
// MAX_PAYMENT_PER_CALL / MAX_DAILY_SPEND silently allows every payment. The
// hardened reader accepts only plain decimal strings; anything else denies
// all payments with cap = 0 (never NaN). Absent vars keep the documented
// fallbacks so ordinary operators see zero behavior change.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-caps-'));
const baseEnv = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');

const { checkSpendingLimit, getMaxPerCall, getMaxDailySpend } = await import('./payment-utils.js') as typeof import('./payment-utils.js');

afterEach(() => { process.env = { ...baseEnv, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl') }; });
after(() => { process.env = baseEnv; rmSync(dir, { recursive: true, force: true }); });

it('a non-numeric MAX_PAYMENT_PER_CALL fails closed (cap 0 → every payment denied, never NaN)', () => {
  for (const bad of ['abc', '-1', '1e3', '']) {
    process.env.MAX_PAYMENT_PER_CALL = bad;
    assert.equal(getMaxPerCall(), 0, `"${bad}" must read as the fail-closed cap 0`);
    assert.equal(checkSpendingLimit(0.01).allowed, false, `a garbage per-call cap ("${bad}") must deny`);
  }
});

it('a non-numeric MAX_DAILY_SPEND fails closed (cap 0 → every payment denied, never NaN)', () => {
  for (const bad of ['abc', '-1', '1e3', '']) {
    process.env.MAX_DAILY_SPEND = bad;
    assert.equal(getMaxDailySpend(), 0, `"${bad}" must read as the fail-closed cap 0`);
    assert.equal(checkSpendingLimit(0.01).allowed, false, `a garbage daily cap ("${bad}") must deny`);
  }
});

it('absent caps keep the documented fallbacks and ordinary payments pass', () => {
  delete process.env.MAX_PAYMENT_PER_CALL;
  delete process.env.MAX_DAILY_SPEND;
  assert.equal(getMaxPerCall(), 0.50);
  assert.equal(getMaxDailySpend(), 10.00);
  assert.equal(checkSpendingLimit(0.10).allowed, true, 'the fallback still admits an ordinary payment');
});

it('plain decimal caps parse exactly as before (no operator-visible change)', () => {
  process.env.MAX_PAYMENT_PER_CALL = '0.50';
  process.env.MAX_DAILY_SPEND = '0.40';
  assert.equal(getMaxPerCall(), 0.50);
  assert.equal(checkSpendingLimit(0.20).allowed, true);
  assert.equal(checkSpendingLimit(0.41).allowed, false, 'the daily cap still binds above its value');
});