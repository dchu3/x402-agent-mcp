import { strict as assert } from 'node:assert';
import { afterEach, after, it } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaymentLogEntry } from '../payment-utils.js';
import { clearDirectoryCache } from '../directory.js';
import type { AnomalyConfig } from './types.js';

// anomaly-store.ts captures PAYMENT_LOG_PATH at module load (same convention
// as budget-store.ts / payment-utils.ts), so every case uses a fresh
// query-busted module instance with its own temp ledger — no parallel state
// file: the payment ledger is the single source of the per-service baselines.
const baseEnv = { ...process.env };
const dirs: string[] = [];
let bust = 0;
afterEach(() => { process.env = { ...baseEnv }; clearDirectoryCache(); });
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function anomaly(overrides: Partial<AnomalyConfig> = {}): Record<string, unknown> {
  return { enabled: true, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0, ...overrides };
}

async function freshStore(ledger?: string, policy?: Record<string, unknown>, directory?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'x402-anomaly-store-'));
  dirs.push(dir);
  process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
  if (ledger !== undefined) writeFileSync(process.env.PAYMENT_LOG_PATH, ledger, 'utf8');
  if (policy) {
    process.env.POLICY_CONFIG_PATH = join(dir, 'policy.json');
    writeFileSync(process.env.POLICY_CONFIG_PATH, JSON.stringify(policy), 'utf8');
  }
  if (directory) {
    process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
    writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify(directory), 'utf8');
  }
  return (await import(`./anomaly-store.js?store=${++bust}`)) as typeof import('./anomaly-store.js');
}

function entry(changes: Partial<PaymentLogEntry> = {}): PaymentLogEntry {
  return { timestamp: new Date().toISOString(), url: 'https://example.invalid/api', method: 'GET', chain: 'base', amount_usdc: 0, status: 'success', ...changes };
}
const jsonl = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n');

const ANOMALY_ON: Record<string, unknown> = {
  payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
  anomaly: { enabled: true, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0 },
};
const ANOMALY_OFF: Record<string, unknown> = {
  payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
};

it('rehydrates the last-N settled amounts per host from the ledger, in file order', async () => {
  const entries = Array.from({ length: 7 }, (_, k) => entry({ url: 'https://cap.example/api', amount_usdc: (k + 1) / 100 }));
  const { getBaseline } = await freshStore(jsonl(...entries), {
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    anomaly: { enabled: true, window: 4, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0 },
  });
  const b = getBaseline('cap.example')!;
  assert.deepEqual(b.samples, [0.04, 0.05, 0.06, 0.07], 'only the last window=4 amounts, oldest dropped');
  assert.equal(b.mean, 0.055);
  assert.ok(b.stdev > 0);
});

it('excludes casper, non-success and non-positive amounts, corrupt lines and unparseable URLs', async () => {
  const { getBaseline } = await freshStore(jsonl(
    '{not json',
    entry({ url: 'not-a-url', amount_usdc: 0.4 }),
    entry({ url: 'https://good.example/api', amount_usdc: 0.05 }),
    entry({ url: 'https://good.example/api', amount_usdc: 0.30, status: 'failed' }),   // failed excluded
    entry({ url: 'https://casper.example/api', chain: 'casper', amount_usdc: 5.0 }),   // casper excluded (same scope rule as the USD stores)
    entry({ url: 'https://good.example/api', amount_usdc: 0 }),                        // ≤ 0 excluded (parity with the writer)
    entry({ url: 'https://good.example/api', amount_usdc: -0.01 }),                    // negative excluded
    '',
  ) + '\n{trailing garbage', ANOMALY_ON);
  const b = getBaseline('good.example');
  assert.ok(b, 'the host with one valid settled amount has a baseline');
  assert.deepEqual(b!.samples, [0.05], 'only the single valid success entry feeds the baseline');
  assert.equal(b!.mean, 0.05);
});

it('recordSettledAmount is the only writer: it accumulates in memory and a restart rehydrates identical values (parity)', async () => {
  const first = await freshStore(undefined, ANOMALY_ON);
  first.recordSettledAmount('https://alpha.example/api', 0.30);
  first.recordSettledAmount('https://alpha.example/api', 0.10);
  first.recordSettledAmount('https://alpha.example/api', 0);        // ignored (≤ 0)
  first.recordSettledAmount('https://alpha.example/api', -1);       // ignored (negative)
  first.recordSettledAmount('https://alpha.example/api', Number.NaN); // ignored (non-finite)
  first.recordSettledAmount('not-a-url', 0.5);                      // ignored (no host)
  assert.deepEqual(first.getBaseline('alpha.example')!.samples, [0.3, 0.1]);

  // "Restart": a fresh module instance reads the same ledger. The ledger
  // lines come from the caller's logPayment — here we write the equivalent
  // entries (exactly what the guard in fetch.ts produces).
  const restarted = await freshStore(jsonl(
    entry({ url: 'https://alpha.example/api', amount_usdc: 0.30 }),
    entry({ url: 'https://alpha.example/api', amount_usdc: 0.10 }),
  ), ANOMALY_ON);
  const b = restarted.getBaseline('alpha.example')!;
  assert.deepEqual(b.samples, [0.3, 0.1]);
  assert.equal(b.mean, 0.2);
  // Hostnames are case-insensitive (URL hostnames are case-insensitive).
  assert.deepEqual(restarted.getBaseline('ALPHA.example')!.samples, [0.3, 0.1]);
  assert.equal(restarted.getBaseline('stranger.example'), undefined);
});

it('the write path is ungated by anomaly.enabled, so a later opt-in rehydrates the full history', async () => {
  // Disabled config: reads return {} but a settlement still lands in memory
  // (the ledger already carries the entry — the ledger is the source of truth).
  const disabled = await freshStore(undefined, ANOMALY_OFF);
  assert.deepEqual(disabled.getAnomalyInputs('https://later.example/api'), {});
  disabled.recordSettledAmount('https://later.example/api', 0.25);
  assert.deepEqual(disabled.getBaseline('later.example')!.samples, [0.25]);

  // A "restart" with the gate enabled rehydrates that settled amount.
  const enabled = await freshStore(jsonl(
    entry({ url: 'https://later.example/api', amount_usdc: 0.25 }),
  ), ANOMALY_ON);
  assert.deepEqual(enabled.getBaseline('later.example')!.samples, [0.25]);
});

it('getAnomalyInputs returns {} when disabled and the ledger baseline when enabled', async () => {
  const ledger = jsonl(
    entry({ url: 'https://priced.example/api', amount_usdc: 0.01 }),
    entry({ url: 'https://priced.example/api', amount_usdc: 0.02 }),
  );
  const disabled = await freshStore(ledger, ANOMALY_OFF);
  assert.deepEqual(disabled.getAnomalyInputs('https://priced.example/api'), {}, 'disabled ⇒ no baseline work at all');

  const enabled = await freshStore(ledger, ANOMALY_ON);
  const inputs = enabled.getAnomalyInputs('https://priced.example/api');
  assert.deepEqual(inputs.baseline!.samples, [0.01, 0.02]);
  assert.equal(inputs.directoryPriceUsd, undefined, 'no directory price here — the ledger baseline stands on its own');
});

it('seeds a NOT-STORED one-sample baseline from the advertised directory price when enabled and empty', async () => {
  const directory = {
    endpoints: [{
      name: 'Priced', description: '', base_url: 'https://priced.example', chain: 'base', category: 'ai', tags: [],
      endpoints: [{ path: '/score', method: 'POST', price_usdc: '0.05', description: '' }],
    }],
    categories: [], last_updated: '2026-09-21',
  };
  const store = await freshStore(undefined, ANOMALY_ON, directory);
  const inputs = store.getAnomalyInputs('https://priced.example/score');
  assert.deepEqual(inputs.baseline, { samples: [0.05], mean: 0.05, stdev: 0 }, 'the first call is softly protected by the advertised price');
  assert.equal(inputs.directoryPriceUsd, 0.05);
  // The seed is derived per call and never stored — rehydration parity stays
  // exact (a restart rebuilds from the ledger alone; the seed re-derives).
  assert.equal(store.getBaseline('priced.example'), undefined);

  // seedFromDirectory off ⇒ no seed, an empty baseline is returned instead.
  const noSeed = await freshStore(undefined, { ...ANOMALY_ON, anomaly: { enabled: true, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: false, defaultTolerance: 2.0 } }, directory);
  assert.deepEqual(noSeed.getAnomalyInputs('https://priced.example/score'), { baseline: { samples: [], mean: 0, stdev: 0 } });

  // No matching directory price ⇒ empty baseline returned (the rule's seed band).
  const noMatch = await freshStore(undefined, ANOMALY_ON, directory);
  assert.deepEqual(noMatch.getAnomalyInputs('https://stranger.example/api'), { baseline: { samples: [], mean: 0, stdev: 0 } });

  // A real settled baseline outranks the seed — no directory work needed.
  const settled = await freshStore(jsonl(entry({ url: 'https://priced.example/score', amount_usdc: 0.09 })), ANOMALY_ON, directory);
  const settledInputs = settled.getAnomalyInputs('https://priced.example/score');
  assert.deepEqual(settledInputs.baseline!.samples, [0.09]);
  assert.equal(settledInputs.directoryPriceUsd, undefined);
});