import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Settlement reconciliation for sent-but-unproven payments: an
// authorized_unserved row that carries its on-chain signature is reconciled
// against the chain once its validity expires (or is about to):
//   - the chain confirms the payment → the row is rewritten to
//     settled_unserved: it counts PERMANENTLY — the settled amount never
//     drops out of a cap, not even after a restart;
//   - the chain does not know the signature and the row's expiry has passed
//     → the row releases (it can no longer settle) — the ledger keeps it
//     untouched and it stops counting;
//   - the lookup errors (RPC error / 429 / timeout / unknown) → the row's
//     expiry is EXTENDED by a bounded retry span (the fail-closed direction:
//     a possibly-settled payment keeps counting) with a retry counter in the
//     row; past the bound the row expires like any other (no forever-holds);
//   - rows without a signature and non-Solana rows are never reconciled
//     (an EVM row simply counts to expiry) and no RPC is consulted for them.
//
// The reconciliation is rate-limited inside the module (the rehydration hook
// and the reserve call site share it) and its lookups are INJECTED: every
// test runs against a mock lookup, a temp ledger and a fixed clock reference
// (NOW = the module-load instant; every expiry/offset is relative to it, so
// the suite is hermetic and deterministic).
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-reconcile-'));
const LEDGER_PATH = join(dir, 'reconcile.jsonl'); // payment-utils captures the path at load — one fixed file, rewritten per scenario
const baseEnv = { ...process.env };
// The ledger path must be in place BEFORE the first payment-utils load — the
// reconciler module imports payment-utils transitively, so this import runs
// last (its load order also drives the cycle, hoisted functions only).
process.env.PAYMENT_LOG_PATH = LEDGER_PATH;

const RECONCILE_PATH = './settlement-reconcile.js';
const reconcileRaw = await import(RECONCILE_PATH).catch(() => undefined) as any;
function requireReconcile(): any {
  assert.ok(
    reconcileRaw && typeof reconcileRaw.reconcileAuthorizedUnserved === 'function' &&
    typeof reconcileRaw.maybeReconcileAuthorizedUnserved === 'function' &&
    typeof reconcileRaw.setSignatureStatusLookup === 'function',
    'src/settlement-reconcile.ts must exist and export reconcileAuthorizedUnserved, maybeReconcileAuthorizedUnserved and setSignatureStatusLookup',
  );
  return reconcileRaw;
}

const PM = (await import('./payment-utils.js')) as typeof import('./payment-utils.js');

const NOW = Date.now(); // the fake clock reference — all offsets are relative
const iso = (ms: number) => new Date(ms).toISOString();
const SAME_DAY = iso(NOW).slice(0, 10); // the recount counts THIS day's rows
// The rows carry the public DEVNET CAIP-2 — their spend bucket is the network
// id itself (issue #59); this is the total every scenario's assertions read.
const SOLANA_DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
/** A "fresh process" read: every call imports a cache-busted payment-utils
 * instance (the rehydrate suite's idiom) whose FIRST counted read rehydrates
 * from the CURRENT ledger — exactly what a restart would see. */
let pmBust = 0;
async function countedTotal(): Promise<number> {
  const fresh = (await import(`./payment-utils.js?reconcile=${++pmBust}`)) as typeof import('./payment-utils.js');
  return fresh.getDailySpent(SOLANA_DEVNET_CAIP2);
}

let lookupCalls = 0;
let lookupResults: Array<Record<string, unknown>> = [];
function mockLookup(): void {
  const r = requireReconcile();
  r.setSignatureStatusLookup(async (signature: string, rpcUrl: string) => {
    lookupCalls++;
    void signature; void rpcUrl;
    const next = lookupResults.shift();
    // Exhausted queue = benign not-found (never rewrites a row) so a module's
    // own spurious rehydration run (each fresh-instance read fires the
    // rate-limited hook) cannot corrupt a scenario's ledger state.
    return (next ?? { found: false }) as never;
  });
}

/** A signature-shaped token generated at runtime from throwaway bytes
 * (no real signature material anywhere in this suite). */
function runtimeSignature(): string {
  const bytes = Buffer.alloc(64, 0xa5);
  bytes.writeUIntLE(Math.floor(Math.random() * 1e9), 0, 4); // vary per row
  return bs58.encode(bytes);
}

function useLedger(contents: string): void {
  writeFileSync(LEDGER_PATH, contents, 'utf8');
  PM._resetForTests(); // fresh daily map — the next read rebuilds from THIS file
}

function rows(): any[] {
  return readFileSync(LEDGER_PATH, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

/** A sent-but-unproven SOLANA row that carries its signature. */
function solanaRow(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: iso(NOW - 5 * 60_000), // same-day as the clock reference
    url: 'https://reconcile-solana.invalid/api',
    method: 'GET',
    chain: 'solana',
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', // the public devnet CAIP-2
    amount_usdc: 0.05,
    amount_atomic: '50000',
    decimals: 6,
    asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    status: 'authorized_unserved',
    expires_at: iso(NOW + 60_000),
    signature: runtimeSignature(),
    ...overrides,
  }) + '\n';
}

afterEach(() => {
  process.env = { ...baseEnv, PAYMENT_LOG_PATH: LEDGER_PATH };
  lookupCalls = 0;
  lookupResults = [];
  if (reconcileRaw?.setSignatureStatusLookup) reconcileRaw.setSignatureStatusLookup(undefined);
  PM._resetForTests();
  if (reconcileRaw?._resetReconcileForTests) reconcileRaw._resetReconcileForTests();
});
after(() => { process.env = baseEnv; rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Restart parity first (the case the reconciler exists for): a ledger row
// whose validity passed while this process was away, whose chain status is
// now confirmed — the next process's rehydration must still count the
// settled amount, and the row must read settled_unserved.
// ---------------------------------------------------------------------------
it('restart parity: an expired sent payment confirmed by the chain counts after rehydration (case 5)', async () => {
  const r = requireReconcile();
  mockLookup();
  lookupResults = [{ found: true, confirmationStatus: 'confirmed' }];
  useLedger(solanaRow({ expires_at: iso(NOW - 30_000) })); // expired 30 s ago
  PM.getDailySpent(); // the module's FIRST counted read rehydrates — and fires the reconcile hook
  // Give the rehydration's fire-and-forget reconcile a bounded window.
  await r._reconcileNowForTests(NOW);
  assert.equal(lookupCalls, 1, 'exactly one lookup happened (the rehydration fired it)');
  const row = rows().find((e) => e.status !== undefined);
  assert.ok(row, 'the row is still in the ledger');
  assert.equal(row.status, 'settled_unserved', 'the confirmed row is rewritten to a permanent count');
  assert.equal(row.expires_at, undefined, 'a settled row no longer carries a validity bound');
  assert.ok(Math.abs(PM.getDailySpent(SOLANA_DEVNET_CAIP2) - 0.05) < 1e-9, 'the confirmed settlement counts after the rewrite');
  assert.ok(Math.abs(await countedTotal() - 0.05) < 1e-9, 'a fresh restart over the same ledger counts it identically');
});

it('a confirmed lookup rewrites the row to settled_unserved and the settled amount never un-counts', async () => {
  const r = requireReconcile();
  mockLookup();
  lookupResults = [{ found: true, confirmationStatus: 'finalized' }];
  useLedger(solanaRow({ expires_at: iso(NOW - 10_000) }));
  await r.reconcileAuthorizedUnserved(NOW);
  const row = rows().find((e) => e.status !== undefined);
  assert.equal(row.status, 'settled_unserved');
  PM._resetForTests();
  assert.ok(Math.abs(await countedTotal() - 0.05) < 1e-9, 'the settled amount counts after a restart-like rebuild (same day)');
});

it('a chain error (RPC 429 / timeout / unknown) extends the expiry by the retry span and keeps counting', async () => {
  const r = requireReconcile();
  for (const failing of [{ error: 'HTTP 429' }, { error: 'timeout' }]) {
    mockLookup();
    lookupResults = [failing];
    useLedger(solanaRow({ expires_at: iso(NOW - 10_000), reconcile_retries: 0 }));
    await r.reconcileAuthorizedUnserved(NOW);
    const row = rows().find((e) => e.status !== undefined);
    assert.equal(row.status, 'authorized_unserved', `${JSON.stringify(failing)}: the row keeps its sent status`);
    assert.equal(Date.parse(row.expires_at), NOW + r.RECONCILE_RETRY_MS, `${JSON.stringify(failing)}: expiry extends by the retry span from now`);
    assert.equal(row.reconcile_retries, 1, `${JSON.stringify(failing)}: the retry count is bounded in the row`);
    assert.ok(Math.abs(await countedTotal() - 0.05) < 1e-9, `${JSON.stringify(failing)}: the possibly-settled payment keeps counting`);
  }
});

it('extensions are bounded: past the retry bound the row expires like any other and releases', async () => {
  const r = requireReconcile();
  mockLookup();
  lookupResults = [{ error: 'HTTP 429' }];
  useLedger(solanaRow({ expires_at: iso(NOW - 10_000), reconcile_retries: r.MAX_RECONCILE_RETRIES }));
  await r.reconcileAuthorizedUnserved(NOW);
  const row = rows().find((e) => e.status !== undefined);
  assert.equal(Date.parse(row.expires_at), NOW - 10_000, 'no further extension past the bound');
  assert.equal(row.reconcile_retries, r.MAX_RECONCILE_RETRIES, 'the counter does not grow past the bound');
  assert.ok(Math.abs(await countedTotal()) < 1e-9, 'the bounded row has expired and no longer counts');
});

it('a not-found signature past expiry releases the row (untouched ledger, no longer counted)', async () => {
  const r = requireReconcile();
  mockLookup();
  lookupResults = [{ found: false }];
  useLedger(solanaRow({ expires_at: iso(NOW - 10_000) }));
  await r.reconcileAuthorizedUnserved(NOW);
  assert.equal(lookupCalls, 1, 'the expired signature was looked up');
  assert.ok(Math.abs(await countedTotal()) < 1e-9, 'the long-gone authorization no longer counts');
  const row = rows().find((e) => e.status !== undefined);
  assert.equal(row.status, 'authorized_unserved', 'the row itself is left untouched (history, not spend)');
  assert.equal(Date.parse(row.expires_at), NOW - 10_000, 'its expiry is not resurrected');
});

it('a row far from its expiry is outside the reconciliation window: no lookup, keeps counting', async () => {
  const r = requireReconcile();
  mockLookup();
  lookupResults = [];
  useLedger(solanaRow({ expires_at: iso(NOW + 400_000) }));
  await r.reconcileAuthorizedUnserved(NOW);
  assert.equal(lookupCalls, 0, 'a row far from expiry is not reconciled');
  assert.ok(Math.abs(await countedTotal() - 0.05) < 1e-9, 'it keeps counting');
});

it('a not-found row inside the reconciliation window (about to expire) is looked up but left counting', async () => {
  const r = requireReconcile();
  mockLookup();
  lookupResults = [{ found: false }];
  useLedger(solanaRow({ expires_at: iso(NOW + 30_000) })); // inside the window
  await r.reconcileAuthorizedUnserved(NOW);
  assert.equal(lookupCalls, 1, 'the almost-expired signature WAS looked up');
  const row = rows().find((e) => e.status !== undefined);
  assert.equal(row.status, 'authorized_unserved', 'not found + still valid: unchanged');
  assert.ok(Math.abs(await countedTotal() - 0.05) < 1e-9, 'still counted until its own expiry');
});

it('rows without a signature and non-Solana rows are never reconciled — no RPC is consulted for them', async () => {
  const r = requireReconcile();
  mockLookup();
  lookupResults = [];
  const evmRow = JSON.stringify({
    timestamp: iso(NOW - 5 * 60_000), url: 'https://reconcile-evm.invalid/api', method: 'GET',
    chain: 'base', amount_usdc: 0.02, currency: 'USDC', status: 'authorized_unserved', expires_at: iso(NOW - 5_000),
    signature: '0x' + 'd'.repeat(130), // a captured EVM signature — still NOT chain-reconciled (no EVM status path)
  }) + '\n';
  const unsignedSolana = solanaRow({ expires_at: iso(NOW - 5_000), signature: undefined });
  useLedger(evmRow + unsignedSolana);
  await r.reconcileAuthorizedUnserved(NOW);
  assert.equal(lookupCalls, 0, 'neither row earns an RPC call');
  assert.equal(rows()[0].status, 'authorized_unserved', 'the EVM row counts to expiry, fail closed');
  assert.equal(rows()[1].status, 'authorized_unserved', 'the unsigned solana row likewise stays as written');
});

// ---------------------------------------------------------------------------
// Rate limit + wiring surfaces
// ---------------------------------------------------------------------------

it('maybeReconcileAuthorizedUnserved runs at most once per interval window (fake clock)', async () => {
  const r = requireReconcile();
  mockLookup();
  lookupResults = [{ found: false }, { found: false }];
  useLedger(solanaRow({}));
  await r.maybeReconcileAuthorizedUnserved(NOW);
  assert.equal(lookupCalls, 1);
  await r.maybeReconcileAuthorizedUnserved(NOW + 29_000); // inside the window → skipped
  assert.equal(lookupCalls, 1, 'a run inside the interval reuses the window');
  await r.maybeReconcileAuthorizedUnserved(NOW + 31_000); // past the window → runs again
  assert.equal(lookupCalls, 2, 'a run past the interval executes again');
  assert.ok(Math.abs(await countedTotal() - 0.05) < 1e-9, 'a not-found row keeps counting throughout (its expiry governs)');
});