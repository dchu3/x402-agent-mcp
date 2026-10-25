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

// ---------------------------------------------------------------------------
// Issue #54 (Option A): rehydration counts by the ONE isCountedSpend
// predicate — a restart must reproduce the SAME totals the in-process adds
// produced, for all four ledger statuses, in BOTH consumers (the daily
// tracker here and policy/budget-store.ts per-service): success and
// settled_unserved count permanently, authorized_unserved counts until the
// sent payload's own expires_at, failed never counts.
// ---------------------------------------------------------------------------

const future = new Date(Date.now() + 60_000).toISOString();
const past = new Date(Date.now() - 60_000).toISOString();

/** One counted row per STATUS, each carrying its own (binary-exact) amount
 * — the summed expectation is unambiguous per status. */
const fourStatusRows = () => [
  entry({ chain: 'base', amount_usdc: 0.125, status: 'success', url: 'https://svc-a.invalid/api' }),
  entry({ chain: 'solana', amount_usdc: 0.25, status: 'settled_unserved', tx_hash: 'ab'.repeat(32), url: 'https://svc-a.invalid/api' }),
  entry({ chain: 'base', amount_usdc: 0.5, status: 'authorized_unserved', expires_at: future, url: 'https://svc-b.invalid/api' }),
  entry({ chain: 'base', amount_usdc: 0.875, status: 'failed', url: 'https://svc-b.invalid/api' }),
];

it('#54: a ledger holding all four statuses rehydrates identical totals in a fresh module instance', async () => {
  // in-process adds first: every logPayment counts by the predicate.
  const first = await freshModule();
  for (const row of fourStatusRows()) first.logPayment(row);
  const inProcess = first.getDailySpent();
  assert.equal(inProcess, 0.875, 'success + settled_unserved + authorized_unserved count; failed never does');
  assert.equal(first.getDailySpent('base'), 0.625);
  assert.equal(first.getDailySpent('solana'), 0.25);
  // the restart: a fresh module over the SAME ledger must rehydrate exactly
  // the in-process totals — the per-status rule is one predicate, not two
  // writer/reader copies that could drift apart.
  const restarted = await import(`./payment-utils.js?rehydrate=${++bust}`) as typeof import('./payment-utils.js');
  assert.equal(restarted.getDailySpent(), inProcess, 'PARITY: post-restart totals equal the in-process totals');
  assert.equal(restarted.getDailySpent('base'), 0.625);
  assert.equal(restarted.getDailySpent('solana'), 0.25);
});

it('#54: an expired authorized_unserved row releases (the sent payload can no longer settle)', async () => {
  const { getDailySpent } = await freshModule(jsonl(
    entry({ chain: 'base', amount_usdc: 0.40, status: 'authorized_unserved', expires_at: past }),
    entry({ chain: 'base', amount_usdc: 0.10, status: 'success' }),
  ));
  assert.equal(getDailySpent(), 0.10, 'the expired authorization released its hold on the budget');
});

it('#54: an authorized_unserved row with no expires_at REHYDRATES as counted (fail-closed over-count direction)', async () => {
  const { getDailySpent } = await freshModule(jsonl(
    entry({ chain: 'base', amount_usdc: 0.40, status: 'authorized_unserved' }),
  ));
  assert.equal(getDailySpent(), 0.40, 'a missing expiry must never silently un-count a sent payment');
});

it('#54: per-service rehydration shares the counted-spend predicate — parity for each status', async () => {
  const { logPayment } = await freshModule();// in-process writes over a fresh ledger
  for (const row of fourStatusRows()) logPayment(row);
  logPayment(entry({ chain: 'base', amount_usdc: 0.75, status: 'authorized_unserved', expires_at: past, url: 'https://svc-a.invalid/api' }));
  const store = await import(`./policy/budget-store.js?rehydrate=${bust}`) as typeof import('./policy/budget-store.js');
  assert.equal(store.getPerServiceSpent('svc-a.invalid'), 0.375, 'success (0.125) + settled_unserved (0.25) count; the EXPIRED authorization (0.75) released');
  assert.equal(store.getPerServiceSpent('svc-b.invalid'), 0.5, 'the unexpired authorized_unserved (0.50) counts; failed (0.875) never does');
});

it('#54: per-service rehydration of an in-process write matches a restart (one predicate on both sides)', async () => {
  const first = await freshModule();
  const store = await import(`./policy/budget-store.js?rehydrate=${bust}`) as typeof import('./policy/budget-store.js');
  // The real flow rehydrates BEFORE the first in-memory add (the policy gate
  // reads per-service spend before any payment writes) — mirror that order:
  // a first read rehydrates the empty ledger, the write then lands on top.
  assert.equal(store.getPerServiceSpent('parity-svc.invalid'), 0);
  const row = entry({ chain: 'base', amount_usdc: 0.5, status: 'authorized_unserved', expires_at: future, url: 'https://parity-svc.invalid/api' });
  first.logPayment(row);
  store.recordServicePayment(row.url, row.amount_usdc ?? 0); // the fetch.ts call-site twin of the counted write
  const restartedStore = await import(`./policy/budget-store.js?rehydrate=${++bust}`) as typeof import('./policy/budget-store.js');
  assert.equal(store.getPerServiceSpent('parity-svc.invalid'), 0.5, 'the in-process per-service add counts the sent authorization');
  assert.equal(restartedStore.getPerServiceSpent('parity-svc.invalid'), 0.5, 'PARITY: the restart rehydrates the same per-service total');
});