import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Issue #93 (A2) — the USD rail's x402_status / x402_check_payment caps report
// the numbers that actually GATE the next payment: the effective pair
// (min(MAX_PAYMENT_PER_CALL / MAX_DAILY_SPEND, the policy layer's
// payments.maxPerRequest / payments.maxDaily), fail closed to 0 on a broken
// configuration) — not the raw legacy env readings. The gates enforce the
// effective caps (reservations.effectiveDailyCapUsd on the daily side, the
// policy engine's rule-6/7 caps on the policy side); this pins the listing to
// the same numbers so an operator running a profile or a policy file sees the
// binding caps, and BOTH surfaces always agree (they render the same
// budgetSnapshotOutput by design — asserted).
//
// Hermetic per the status.test.ts pattern: temp ledger/directory paths, no
// policy file unless a scenario writes one, no network (the fetch tripwire
// throws), Casper budgets unset so only the USD rail is asserted.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-rail-caps-'));
const POLICY = join(dir, 'policy.json');
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-27' }), 'utf8');
process.env.X402_STATE_DIR = join(dir, 'state');
process.env.POLICY_CONFIG_PATH = POLICY; // scenarios write the file; a scenario can corrupt it
process.env.MAX_PAYMENT_PER_CALL = '0.50';
process.env.MAX_DAILY_SPEND = '10.00';
const env = { ...process.env }; // captured AFTER the isolation settings above

const { registerStatusTool } = await import('./tools/status.js') as typeof import('./tools/status.js');
const { registerCheckPaymentTool } = await import('./tools/check-payment.js') as typeof import('./tools/check-payment.js');

const realConsoleError = console.error;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (..._a: unknown[]) => { throw new Error('these tools must make ZERO network calls'); }) as any;

afterEach(() => {
  console.error = realConsoleError;
  process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_DIRECTORY_PATH: join(dir, 'endpoints.json'), X402_STATE_DIR: join(dir, 'state'), POLICY_CONFIG_PATH: POLICY };
});
after(() => { process.env = env; globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });

function statusHandler() {
  let callback: any;
  registerStatusTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}
function checkHandler() {
  let callback: any;
  registerCheckPaymentTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

function usdRailOf(json: string): any {
  const parsed = JSON.parse(json);
  const usd = (parsed.rails ?? parsed.budget?.rails).find((r: any) => r.rail === 'usd');
  assert.ok(usd, 'the USD rail must be listed');
  return usd;
}

function writePolicyFile(maxPerRequest: number, maxDaily: number): void {
  writeFileSync(POLICY, JSON.stringify({
    payments: { enabled: true, maxPerRequest, maxDaily },
    networks: { allowed: ['base'] },
    tokens: { allowed: ['USDC'] },
  }), 'utf8');
}

// ---------------------------------------------------------------------------
// No policy file: the behavior-compat default mirrors the legacy env knobs,
// so the listing is byte-identical to the pre-A2 rendering (the min of two
// equal values).
// ---------------------------------------------------------------------------
it('without a policy file the USD rail caps stay exactly the legacy env values (default policy mirrors them)', async () => {
  const usd = usdRailOf(await statusHandler()({}).then((r: any) => r.content[0].text));
  assert.equal(usd.per_call_cap, '0.500000');
  assert.equal(usd.daily_cap, '10.000000');
});

// ---------------------------------------------------------------------------
// A policy file with lower caps: the rail lists the EFFECTIVE (min) pair.
// ---------------------------------------------------------------------------
it('a policy file with lower caps tightens the USD rail listing to the effective pair', async () => {
  writePolicyFile(0.05, 5);
  const usd = usdRailOf(await statusHandler()({}).then((r: any) => r.content[0].text));
  assert.equal(usd.per_call_cap, '0.050000', 'payments.maxPerRequest 0.05 binds over the 0.50 env knob');
  assert.equal(usd.daily_cap, '5.000000', 'payments.maxDaily 5 binds over the 10.00 env knob');
});

it('a looser policy file never widens the listing past the env knobs (min discipline)', async () => {
  writePolicyFile(50, 50);
  const usd = usdRailOf(await statusHandler()({}).then((r: any) => r.content[0].text));
  assert.equal(usd.per_call_cap, '0.500000', 'the 0.50 env knob still binds');
  assert.equal(usd.daily_cap, '10.000000', 'the 10.00 env knob still binds');
});

it('a broken policy configuration fails the USD rail caps closed to 0', async () => {
  writePolicyFile(0.05, 5);
  process.env.X402_POLICY_MAX_PER_REQUEST = 'garbage';
  const result = await statusHandler()({});
  let json = '';
  try { json = result.content[0].text; } catch (e) { /* a throw is also a failure mode */ }
  const usd = usdRailOf(json);
  assert.equal(usd.per_call_cap, '0.000000');
  assert.equal(usd.daily_cap, '0.000000');
});

it('a strict profile over raised legacy env caps reports the profile line the gate binds', async () => {
  rmSync(POLICY, { force: true }); // absent file = the default policy (profile overlays it)
  process.env.MAX_PAYMENT_PER_CALL = '2.00';
  process.env.MAX_DAILY_SPEND = '20.00';
  process.env.X402_POLICY_PROFILE = 'strict';
  const usd = usdRailOf(await statusHandler()({}).then((r: any) => r.content[0].text));
  assert.equal(usd.per_call_cap, '0.500000', 'the strict overlay caps payments.maxPerRequest at the legacy default line (min of 2.00 env and 0.50 policy)');
  assert.equal(usd.daily_cap, '10.000000', 'the strict overlay caps payments.maxDaily at the legacy default line (min of 20.00 env and 10 policy)');
});

// ---------------------------------------------------------------------------
// The plan's acceptance: x402_status and x402_check_payment report the SAME
// numbers under a tightening policy file.
// ---------------------------------------------------------------------------
it('x402_status and x402_check_payment report the same effective caps', async () => {
  writePolicyFile(0.05, 5);
  const statusUsd = usdRailOf(await statusHandler()({}).then((r: any) => r.content[0].text));
  const checkResult = await checkHandler()({ url: 'https://analyzer.example/score', amount: 0.04, chain: 'base', token: 'USDC' });
  const checkUsd = usdRailOf(checkResult.content[0].text);
  assert.equal(checkUsd.per_call_cap, statusUsd.per_call_cap);
  assert.equal(checkUsd.daily_cap, statusUsd.daily_cap);
  assert.equal(checkUsd.per_call_cap, '0.050000', 'x402_check_payment shows the effective per-call cap, not the raw env value');
  assert.equal(checkUsd.daily_cap, '5.000000', 'x402_check_payment shows the effective daily cap, not the raw env value');
});