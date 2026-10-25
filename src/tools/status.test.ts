import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Issue #65 (plan C3) — x402_status, the free status tool: one entry per
// registered budget rail — unit, per-call cap, daily cap, spent today,
// remaining, outstanding holds, persistence mode, effective ledger path, and
// the USD rate when one is configured. NEVER signs, never writes the ledger,
// never reserves budget, never makes any network call.
//
// Hermetic: temp ledger + directory BEFORE importing status.js. The network
// tripwire throws if anything is ever fetched.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-status-'));
process.env.X402_NETWORK_MODE = 'devnet'; // issue #59: name the mode explicitly; free tools report it
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-24' }), 'utf8');

const { registerStatusTool } = await import('./status.js') as typeof import('./status.js');
const { resolveLedger } = await import('../ledger-path.js') as typeof import('../ledger-path.js');
const registerBudgetModule = await import('../budget-registry.js') as typeof import('../budget-registry.js');

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async (..._a: unknown[]) => { fetchCalls++; throw new Error('x402_status must make ZERO network calls'); }) as any;

const originalConsoleError = console.error;
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  process.env = {
    ...env,
    X402_NETWORK_MODE: 'devnet',
    PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'),
    X402_DIRECTORY_PATH: join(dir, 'endpoints.json'),
  };
});
after(() => { process.env = env; globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });

function handler() {
  let callback: any;
  registerStatusTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

function outputText(result: any): string {
  return result.content[0].text;
}

it('registerStatusTool registers the x402_status tool with a fixed, non-seller description', () => {
  const captured: { name: string; description: string; schema: any } = { name: '', description: '', schema: null };
  registerStatusTool({ tool: (name: unknown, description: unknown, schema: unknown) => {
    captured.name = name as string;
    captured.description = description as string;
    captured.schema = schema as any;
  } } as any);
  assert.equal(captured.name, 'x402_status');
  assert.ok(/never signs|never pays/i.test(captured.description));
  assert.ok(/remaining/i.test(captured.description), 'the description names what the listing shows');
});

it('lists every registered rail with exact atomic amounts, persistence and the ledger path', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '0.50';
  process.env.MAX_DAILY_SPEND = '10.00';
  process.env.CASPER_MAX_PAYMENT_PER_CALL = '1';
  process.env.CASPER_MAX_DAILY_SPEND = '2';
  const result = await handler()({});
  const parsed = JSON.parse(outputText(result));

  assert.deepEqual(parsed.cross_chain_ceiling, { active: false }, 'the ceiling is opt-in; unset means inactive');
  assert.equal(parsed.network_mode, 'devnet', 'the run’s explicit mode is reported (issue #59)');
  assert.deepEqual(parsed.ledger, { primary: resolveLedger().primary }, 'the effective ledger location');

  const usd = parsed.rails.find((r: any) => r.rail === 'usd');
  assert.ok(usd, 'the USD rail is listed');
  assert.equal(usd.unit, 'USDC');
  assert.equal(usd.decimals, 6);
  assert.equal(usd.per_call_cap, '0.500000', 'cap printed through the exact atomic formatter');
  assert.equal(usd.daily_cap, '10.000000');
  assert.equal(usd.spent_today, '0.000000', 'a fresh process has spent nothing — exact, never 0.00');
  assert.equal(usd.remaining_today, '10.000000');
  assert.equal(usd.reserved_today, null);
  assert.equal(usd.persistence, 'ledger-rehydrated');
  assert.equal(usd.ledger_path, resolveLedger().primary);
  assert.equal(usd.usd_rate, 1, 'the pegged rate prints');

  const casper = parsed.rails.find((r: any) => r.rail === 'casper');
  assert.ok(casper, 'the Casper rail is listed');
  assert.equal(casper.unit, 'wCSPR');
  assert.equal(casper.decimals, 9);
  assert.equal(casper.per_call_cap, '1.000000000', '1 CSPR = 10^9 motes, exact');
  assert.equal(casper.daily_cap, '2.000000000');
  assert.equal(casper.spent_today, '0.000000000');
  assert.equal(casper.persistence, 'memory', 'the honest persistence value (#65 req 2)');
  assert.equal(casper.usd_rate, null, 'no configured rate — never an assumed one');
});

it('an unset Casper budget lists null caps, not invented ones', async () => {
  delete process.env.CASPER_MAX_PAYMENT_PER_CALL;
  const parsed = JSON.parse(outputText(await handler()({})));
  const casper = parsed.rails.find((r: any) => r.rail === 'casper');
  assert.equal(casper.per_call_cap, null);
  assert.equal(casper.daily_cap, null);
});

it('spent today reflects the ledger-backed counters through the exact formatter, never toFixed(2)', async () => {
  const { logPayment } = await import('../payment-utils.js') as typeof import('../payment-utils.js');
  logPayment({ timestamp: new Date().toISOString(), url: 'https://status.example/api', method: 'GET', chain: 'base', amount_usdc: 0.001, status: 'success' });
  const parsed = JSON.parse(outputText(await handler()({})));
  const usd = parsed.rails.find((r: any) => r.rail === 'usd');
  assert.equal(usd.spent_today, '0.001000', 'a $0.001 spend is NOT rounded to zero (#65 req 3)');
  assert.equal(usd.remaining_today, '9.999000');
});

it('a future rail registers without touching any output code and appears in the listing (#65 acceptance test 5)', async () => {
  // A priced double (rate 2) so the ceiling-disabled listing below stays
  // unambiguous; the double rides along for the rest of this suite.
  registerBudgetModule.registerBudget({
    id: 'nano-status-double',
    unit: 'XNO',
    decimals: 30,
    perCallCap: () => ({ atomic: '1000000000000000000000000000000', decimals: 30 }),
    dailyCap: () => ({ atomic: '2000000000000000000000000000000', decimals: 30 }),
    spentToday: () => ({ atomic: '1', decimals: 30 }),
    spentUsdToday: () => 2 ** -30,
    persistence: 'memory',
    usdRate: () => 2,
  });
  const parsed = JSON.parse(outputText(await handler()({})));
  const nano = parsed.rails.find((r: any) => r.rail === 'nano-status-double');
  assert.ok(nano, 'the test-double rail is listed without any status-code change');
  assert.equal(nano.unit, 'XNO');
  assert.equal(nano.per_call_cap, '1.000000000000000000000000000000', 'exact 30-decimal rendering');
  assert.equal(nano.spent_today, '0.000000000000000000000000000001', 'a single atomic unit refuses to vanish');
  assert.deepEqual(parsed.rails.map((r: any) => r.rail), ['usd', 'casper', 'nano-status-double'], 'the production rails stay listed alongside it');
});

it('flags a rail disabled by the ceiling with RAIL_DISABLED_NO_RATE when one is set and the rail has no rate', async () => {
  process.env.MAX_DAILY_SPEND_TOTAL_USD = '10.00';
  const parsed = JSON.parse(outputText(await handler()({})));
  const ceiling = parsed.cross_chain_ceiling;
  assert.equal(ceiling.active, true);
  assert.equal(ceiling.max_daily_total_usd, '10.000000');
  assert.equal(ceiling.disabled_rails.length, 1, 'the USD rail always prices; unpriced rails list');
  assert.equal(ceiling.disabled_rails[0].rail, 'casper');
  assert.equal(ceiling.disabled_rails[0].code, 'RAIL_DISABLED_NO_RATE');
  const casper = parsed.rails.find((r: any) => r.rail === 'casper');
  assert.equal(casper.disabled, true);
  assert.equal(casper.disabled_code, 'RAIL_DISABLED_NO_RATE');
  const usd = parsed.rails.find((r: any) => r.rail === 'usd');
  assert.equal(usd.disabled, false);
  delete process.env.MAX_DAILY_SPEND_TOTAL_USD;
});

it('never signs, never reserves, never writes the ledger — and makes zero network calls', async () => {
  const before = existsSync(process.env.PAYMENT_LOG_PATH!) ? readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8') : null;
  const callsBefore = fetchCalls;
  await handler()({});
  assert.equal(fetchCalls, callsBefore, 'x402_status must make ZERO network calls');
  const afterText = existsSync(process.env.PAYMENT_LOG_PATH!) ? readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8') : null;
  assert.equal(afterText, before, 'the ledger file is byte-identical after the call');
});