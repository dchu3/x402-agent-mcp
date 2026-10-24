import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PaymentLogEntry } from './payment-utils.js';

// ---------------------------------------------------------------------------
// Issue #54 — one ledger path resolver. The ledger path must resolve to an
// ABSOLUTE location in a per-user state directory (not the current working
// directory), a legacy working-directory ledger must be read ONCE read-only
// so an upgrade never resets today's spend to 0, and an explicit
// PAYMENT_LOG_PATH must keep winning (that is also what keeps every existing
// test hermetic — they all set PAYMENT_LOG_PATH).
// ---------------------------------------------------------------------------

const baseEnv = { ...process.env };
const dirs: string[] = [];
let bust = 0;
afterEach(() => { process.env = baseEnv; });
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

// The specifier is a variable on purpose: this file must COMPILE and RUN at
// the RED step (before src/ledger-path.ts exists), so the missing module
// surfaces as failing assertions, not as a compile error.
const RESOLVER_PATH = './ledger-path.js';
const ledgerPath = await import(RESOLVER_PATH).catch(() => undefined) as any;

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}


function resolveLedger(): { primary: string; legacyReadOnly?: string } {
  assert.ok(ledgerPath && typeof ledgerPath.resolveLedger === 'function',
    'src/ledger-path.ts must exist and export resolveLedger (issue #54 RED step)');
  return ledgerPath.resolveLedger();
}

function entry(changes: Partial<PaymentLogEntry> = {}): PaymentLogEntry {
  return { timestamp: new Date().toISOString(), url: 'https://example.invalid/api', method: 'GET', chain: 'base', amount_usdc: 0, status: 'success', ...changes };
}

it('an explicit PAYMENT_LOG_PATH wins and resolves to an absolute path', () => {
  const d = tempDir('x402-lp-explicit-');
  process.env.PAYMENT_LOG_PATH = join(d, 'ledger.jsonl');
  const { primary, legacyReadOnly } = resolveLedger();
  assert.equal(primary, resolve(join(d, 'ledger.jsonl')), 'the primary path is absolute');
  assert.equal(legacyReadOnly, undefined, 'no legacy read when PAYMENT_LOG_PATH is set');
});

it('an unset PAYMENT_LOG_PATH resolves under the state directory (X402_STATE_DIR, default ~/.x402-agent-mcp)', () => {
  delete process.env.PAYMENT_LOG_PATH;
  const state = tempDir('x402-lp-state-');
  process.env.X402_STATE_DIR = state;
  const { primary } = resolveLedger();
  assert.equal(primary, join(resolve(state), 'x402-payments.jsonl'));
  assert.equal(resolve(primary), primary, 'the resolution is absolute');
});

it('the default state directory is ~/.x402-agent-mcp when X402_STATE_DIR is unset', () => {
  delete process.env.PAYMENT_LOG_PATH;
  delete process.env.X402_STATE_DIR;
  // Some checkouts carry a dev ledger in the runner's working directory — the
  // cwd must be free of anything the legacy probe could see for this scenario
  // to be about the DEFAULT state dir only (hermetic cwd).
  const cwd = tempDir('x402-lp-default-');
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    const { primary, legacyReadOnly } = resolveLedger();
    assert.equal(primary, join(homedir(), '.x402-agent-mcp', 'x402-payments.jsonl'));
    // No legacy ledger exists in this (empty temp) cwd — nothing to read.
    assert.equal(legacyReadOnly, undefined);
  } finally {
    process.chdir(originalCwd);
  }
});

it('the legacy working-directory ledger is counted but never written (unset path, X402_STATE_DIR set)', async () => {
  const originalCwd = process.cwd();
  const cwd = tempDir('x402-lp-cwd-');
  const state = tempDir('x402-lp-state2-');
  // A legacy ledger sitting in the process working directory, pre-upgrade.
  const legacy = join(cwd, 'x402-payments.jsonl');
  writeFileSync(legacy, JSON.stringify(entry({ chain: 'base', amount_usdc: 0.30 })) + '\n', 'utf8');

  delete process.env.PAYMENT_LOG_PATH;
  process.env.X402_STATE_DIR = state;
  process.chdir(cwd);
  try {
    const { primary, legacyReadOnly } = resolveLedger();
    assert.equal(primary, join(resolve(state), 'x402-payments.jsonl'));
    assert.equal(legacyReadOnly, resolve(legacy), 'the legacy working-directory file is picked up read-only');

    const { getDailySpent, logPayment } = await import(`./payment-utils.js?lp-legacy=${++bust}`) as typeof import('./payment-utils.js');
    assert.ok(Math.abs(getDailySpent() - 0.30) < 1e-9, "an upgrade must not reset today's spend to 0 (that would be silent cap widening)");

    // New writes go to the state-dir ledger; the legacy file is never touched.
    logPayment(entry({ chain: 'base', amount_usdc: 0.10 }));
    assert.equal(readFileSync(legacy, 'utf8').split('\n').filter((l) => l.trim() !== '').length, 1, 'the legacy ledger stays byte-identical');
    const primaryLines = readFileSync(primary, 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert.equal(primaryLines.length, 1, 'appends land in the state-dir ledger');
    assert.ok(existsSync(primary), 'the state directory is created for appends');
    // A restart rehydrates the legacy + primary totals together.
    const restarted = await import(`./payment-utils.js?lp-legacy2=${++bust}`) as typeof import('./payment-utils.js');
    assert.ok(Math.abs(restarted.getDailySpent() - 0.40) < 1e-9, 'restart rehydrates legacy + primary totals');
  } finally {
    process.chdir(originalCwd);
  }
});

it('a simulated restart rehydrates identical totals from the state-dir ledger', async () => {
  delete process.env.PAYMENT_LOG_PATH;
  const state = tempDir('x402-lp-restart-');
  process.env.X402_STATE_DIR = state;
  // Hermetic cwd: no legacy ledger in the working directory may leak into
  // these exact totals (some checkouts carry a dev ledger at the repo root).
  const cwd = tempDir('x402-lp-restart-cwd-');
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    const first = await import(`./payment-utils.js?lp-restart=${++bust}`) as typeof import('./payment-utils.js');
    first.logPayment(entry({ chain: 'base', amount_usdc: 0.30 }));
    first.logPayment(entry({ chain: 'solana', amount_usdc: 0.20 }));
    assert.ok(Math.abs(first.getDailySpent() - 0.50) < 1e-9);
    const restarted = await import(`./payment-utils.js?lp-restart2=${++bust}`) as typeof import('./payment-utils.js');
    assert.ok(Math.abs(restarted.getDailySpent() - 0.50) < 1e-9, 'a restart rehydrates identical totals');
    assert.ok(Math.abs(restarted.getDailySpent('solana') - 0.20) < 1e-9);
    assert.ok(existsSync(join(state, 'x402-payments.jsonl')));
  } finally {
    process.chdir(originalCwd);
  }
});