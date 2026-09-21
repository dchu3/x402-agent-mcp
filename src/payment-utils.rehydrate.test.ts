import { strict as assert } from 'node:assert';
import { afterEach, after, it } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaymentLogEntry } from './payment-utils.js';

// LOG_PATH and dailyDate are captured at module load, so every case needs a
// fresh module instance with its own PAYMENT_LOG_PATH: set env, write the
// temp ledger, then dynamic-import payment-utils with a query-busted
// specifier (same pattern as casper-fetch.test.ts, plus the query for reuse).
const baseEnv = { ...process.env };
const dirs: string[] = [];
let bust = 0;
afterEach(() => { process.env = baseEnv; });
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

async function freshModule(ledger?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'x402-rehydrate-'));
  dirs.push(dir);
  process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
  if (ledger !== undefined) writeFileSync(process.env.PAYMENT_LOG_PATH, ledger, 'utf8');
  return (await import(`./payment-utils.js?rehydrate=${++bust}`)) as typeof import('./payment-utils.js');
}

function entry(changes: Partial<PaymentLogEntry> = {}): PaymentLogEntry {
  return { timestamp: new Date().toISOString(), url: 'https://example.invalid', method: 'GET', chain: 'base', amount_usdc: 0, status: 'success', ...changes };
}
const yesterday = new Date(Date.now() - 86_400_000).toISOString();
const jsonl = (...entries: unknown[]) => entries.map(e => JSON.stringify(e)).join('\n');

it('rehydrates today\'s spend from the ledger on restart', async () => {
  const { getDailySpent } = await freshModule(jsonl(
    entry({ chain: 'base', amount_usdc: 0.30 }),
    entry({ chain: 'solana', amount_usdc: 0.20 }),
    entry({ chain: 'base', amount_usdc: 0.40, status: 'failed' }),
    entry({ chain: 'base', amount_usdc: 1.00, timestamp: yesterday }),
  ));
  assert.equal(getDailySpent(), 0.50);
  assert.equal(getDailySpent('base'), 0.30);
  assert.equal(getDailySpent('solana'), 0.20);
});

it('enforces MAX_DAILY_SPEND after a restart (rehydration is idempotent)', async () => {
  process.env.MAX_DAILY_SPEND = '10.00';
  process.env.MAX_PAYMENT_PER_CALL = '0.50';
  const { checkSpendingLimit } = await freshModule(jsonl(
    entry({ chain: 'base', amount_usdc: 5.00 }),
    entry({ chain: 'solana', amount_usdc: 4.90 }),
  ));
  assert.equal(checkSpendingLimit(0.20).allowed, false); // 9.90 + 0.20 > 10
  assert.equal(checkSpendingLimit(0.05).allowed, true); // second call must not double-read
});

it('corrupted ledger lines are skipped without crashing', async () => {
  const { getDailySpent } = await freshModule(jsonl(
    '{not json',
    entry({ chain: 'base', amount_usdc: 0.40 }),
    '',
    entry({ chain: 'base', amount_usdc: 9.99, timestamp: yesterday }),
  ) + '\n{trailing garbage');
  assert.equal(getDailySpent(), 0.40);
});

it('missing ledger file rehydrates to zero spend', async () => {
  const { getDailySpent } = await freshModule();
  assert.equal(getDailySpent(), 0);
});

it('casper entries are excluded from rehydrated spend (same rule as logPayment)', async () => {
  const { getDailySpent } = await freshModule(jsonl(
    entry({ chain: 'casper', currency: 'wCSPR', amount_usdc: 5.0 }),
    entry({ chain: 'base', amount_usdc: 0.25 }),
  ));
  assert.equal(getDailySpent(), 0.25);
  assert.equal(getDailySpent('casper'), 0);
});

it('concurrent consumption: 5 parallel per-call requests against budget for exactly 2 → exactly 2 allowed', async () => {
  // #18.4: budget for exactly two per-call requests (2 × MAX_PAYMENT_PER_CALL);
  // five requests fire via Promise.all. JS is single-threaded, so the guard's
  // synchronous span — checkSpendingLimit followed immediately by the settlement
  // logPayment, the exact span fetch.ts uses around a paid call — runs atomically
  // per request and the daily cap admits exactly two. (Interleaving between the
  // check and the log — the await points inside wrapFetchWithPayment — is the
  // documented overshoot limitation; see README Limitations.)
  process.env.MAX_DAILY_SPEND = '0.40';
  process.env.MAX_PAYMENT_PER_CALL = '0.20';
  const { checkSpendingLimit, logPayment, getDailySpent } = await freshModule();
  const allowed = await Promise.all(
    Array.from({ length: 5 }, async () => {
      const check = checkSpendingLimit(0.20);
      if (check.allowed) logPayment(entry({ chain: 'base', amount_usdc: 0.20 }));
      return check.allowed;
    }),
  );
  assert.equal(allowed.filter(Boolean).length, 2, 'exactly 2 of 5 may consume the 0.40 budget');
  assert.equal(allowed.filter((a) => !a).length, 3, 'the rest must be denied');
  assert.equal(getDailySpent(), 0.40);
});