import { strict as assert } from 'node:assert';
import { afterEach, after, it } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaymentLogEntry } from '../payment-utils.js';

// budget-store.ts captures PAYMENT_LOG_PATH at module load (same convention as
// payment-utils.ts, PR #21 rehydration pattern), so every case uses a fresh
// query-busted module instance with its own temp ledger — no parallel state
// file: the payment ledger is the single source of per-service spend.
const baseEnv = { ...process.env };
const dirs: string[] = [];
let bust = 0;
afterEach(() => { process.env = { ...baseEnv }; });
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

async function freshStore(ledger?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'x402-budget-store-'));
  dirs.push(dir);
  process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
  if (ledger !== undefined) writeFileSync(process.env.PAYMENT_LOG_PATH, ledger, 'utf8');
  return (await import(`./budget-store.js?store=${++bust}`)) as typeof import('./budget-store.js');
}

function entry(changes: Partial<PaymentLogEntry> = {}): PaymentLogEntry {
  return { timestamp: new Date().toISOString(), url: 'https://example.invalid/api', method: 'GET', chain: 'base', amount_usdc: 0, status: 'success', ...changes };
}
const yesterday = new Date(Date.now() - 86_400_000).toISOString();
const jsonl = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n');

it('rehydrates today\'s per-service spend from the ledger, grouped by URL hostname', async () => {
  const { getPerServiceSpent } = await freshStore(jsonl(
    entry({ url: 'https://alpha.example/api', amount_usdc: 0.30 }),
    entry({ url: 'https://alpha.example/other', amount_usdc: 0.20 }),   // same host accumulates
    entry({ url: 'https://beta.example/api', amount_usdc: 0.40 }),
    entry({ url: 'https://alpha.example/api', amount_usdc: 0.50, status: 'failed' }), // failed excluded
    entry({ url: 'https://alpha.example/api', amount_usdc: 0.90, timestamp: yesterday }), // other day excluded
    entry({ url: 'https://casper.example/api', chain: 'casper', currency: 'wCSPR', amount_usdc: 5.0 }), // casper excluded (same rule as the USD ledger)
  ));
  assert.equal(getPerServiceSpent('alpha.example'), 0.5);
  assert.equal(getPerServiceSpent('beta.example'), 0.4);
  assert.equal(getPerServiceSpent('stranger.example'), 0);
  // Hostnames are case-insensitive (URL hostnames are case-insensitive).
  assert.equal(getPerServiceSpent('ALPHA.example'), 0.5);
});

it('recordServicePayment accumulates in-memory and survives a restart via ledger rehydration (no parallel state)', async () => {
  const first = await freshStore();
  first.recordServicePayment('https://alpha.example/api', 0.30);
  first.recordServicePayment('https://alpha.example/api', 0.10);
  first.recordServicePayment('https://beta.example/api', 0.25);
  assert.equal(first.getPerServiceSpent('alpha.example'), 0.4);

  // "Restart": a fresh module instance reads the same ledger. The ledger lines
  // come from the caller's logPayment — here we write the equivalent entries.
  const restarted = await freshStore(jsonl(
    entry({ url: 'https://alpha.example/api', amount_usdc: 0.30 }),
    entry({ url: 'https://alpha.example/api', amount_usdc: 0.10 }),
    entry({ url: 'https://beta.example/api', amount_usdc: 0.25 }),
  ));
  assert.equal(restarted.getPerServiceSpent('alpha.example'), 0.40);
  assert.equal(restarted.getPerServiceSpent('beta.example'), 0.25);
});

it('unparseable ledger URLs and corrupt lines are skipped without crashing', async () => {
  const { getPerServiceSpent } = await freshStore(jsonl(
    '{not json',
    entry({ url: 'not-a-url', amount_usdc: 0.4 }),
    entry({ url: 'https://good.example/api', amount_usdc: 0.25 }),
    '',
  ) + '\n{trailing garbage');
  assert.equal(getPerServiceSpent('good.example'), 0.25, 'the unparseable-URL 0.4 entry is skipped; good.example keeps only its own 0.25');
  assert.equal(getPerServiceSpent(''), 0);
});

it('cap enforcement per service while global cap intact (engine + store together)', async () => {
  const { getPerServiceSpent } = await freshStore(jsonl(
    entry({ url: 'https://busy.example/api', amount_usdc: 0.6 }),
    entry({ url: 'https://busy.example/api', amount_usdc: 0.3 }),
    entry({ url: 'https://other.example/api', amount_usdc: 0.2 }),
  ));
  const { PolicyEngine } = await import('./engine.js?storeeng=' + bust);
  const { getDailySpent } = await import('../payment-utils.js?storepay=' + bust);
  // Operator config: global $10 daily (intact), DISCOVERED per-service daily $1.00.
  const engine = new PolicyEngine({
    config: {
      payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
      services: {
        unknown: { action: 'allow' },
        discovered: { action: 'allow', maxDaily: 1.0 },
        verified: { action: 'allow' },
        trusted: { action: 'allow' },
        blocked: { action: 'deny' },
      },
      networks: { allowed: ['base', 'solana', 'casper'] },
      tokens: { allowed: ['USDC', 'wCSPR'] },
      recipients: { mode: 'change-detect', allowed: [], perService: {}, known: {} },
      // Issue #30 compat default: the anomaly gate ships disabled.
      anomaly: { enabled: false, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0 },
      // Issue #32: the facilitator settle-list.
      evm: { facilitatorNetworks: ['eip155:8453', 'eip155:137', 'eip155:42161'] },
    },
    configErrors: [],
  });
  const ctx = { service: 'busy.example', chain: 'base', token: 'USDC', amount: 0.2, trustLevel: 'DISCOVERED' as const };
  // Ledger rehydrated busy.example at 0.9 today; +0.2 would pass the GLOBAL cap
  // (0.8 global spend + 0.2 < 10) but breach the per-service cap.
  const result = engine.evaluate(ctx, { dailySpentUsd: 0.8, perServiceSpentUsd: getPerServiceSpent('busy.example') });
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(result.reasons.map((r) => r.code), ['SERVICE_LIMIT_EXCEEDED']);
  // A different service with identical global spend is allowed — per-service
  // enforcement, not global.
  const other = engine.evaluate({ ...ctx, service: 'other.example' }, { dailySpentUsd: 0.8, perServiceSpentUsd: getPerServiceSpent('other.example') });
  assert.equal(other.decision, 'ALLOW');
});