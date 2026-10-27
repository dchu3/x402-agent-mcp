import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { PolicyEngine } from './engine.js';
import type { PolicyBudgetState, PolicyConfig, PolicyContext } from './types.js';

// ---------------------------------------------------------------------------
// Tolerance and message rounding on the daily-cap rules (7 global, 8
// per-service). The engine compares money as IEEE-754 floats; sums of
// 1e-2-scale USD values carry representation noise (0.1 + 0.2 !== 0.3) far
// below any real amount (a ledger-recorded precision quantum is 1e-6 USD,
// one atomic USDC unit at 6 decimals — a genuine semantic overshoot is
// ≥ 5e-7). The cap rules must therefore tolerate a fixed 1e-9 USD slack —
// the SAME epsilon the reservation registry compares with — so a payment
// that lands exactly on the cap is never refused because of float noise,
// while refusal messages print the operator's money, never the artefact
// digits. Boundary semantics are unchanged: reaching the cap exactly is
// allowed, exceeding it (beyond the epsilon) is refused, and the reason
// codes/order/device of the rules keep their documented shape.
//
// The shared constants live in the pure money module (money.ts — one
// definition, imported by the engine and the reservation registry alike).
// The module import is deliberately dynamic-by-variable so this file still
// compiles and runs while the module does not exist yet (the assertions
// below are the failing RED step; the compile never breaks).
// ---------------------------------------------------------------------------

const MONEY_PATH = '../money.js';
const moneyRaw = await import(MONEY_PATH).catch(() => undefined) as any;
function requireMoney(): any {
  assert.ok(
    moneyRaw && typeof moneyRaw.formatUsd === 'function' && typeof moneyRaw.FLOAT_EPSILON_USD === 'number',
    'src/money.ts must exist and export FLOAT_EPSILON_USD + formatUsd (the shared money seam)',
  );
  return moneyRaw;
}

function cfg(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    services: {
      unknown: { action: 'deny' },
      discovered: { action: 'allow' },
      verified: { action: 'allow' },
      trusted: { action: 'allow' },
      blocked: { action: 'deny' },
    },
    networks: { allowed: ['base', 'solana', 'casper'] },
    tokens: { allowed: ['USDC', 'wCSPR'] },
    assets: { extensions: [] },
    recipients: { mode: 'change-detect', allowed: [], perService: {}, known: {} },
    anomaly: { enabled: false, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0 },
    evm: { facilitatorNetworks: ['eip155:8453', 'eip155:137', 'eip155:42161'] },
    liveness: { require_fresh_402: true, max_age_seconds: 3600 },
    ...overrides,
  };
}

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    service: 'example.com',
    chain: 'base',
    token: 'USDC',
    amount: 0.1,
    trustLevel: 'DISCOVERED',
    ...overrides,
  };
}

function codes(result: { reasons: Array<{ code: string }> }): string[] {
  return result.reasons.map((r) => r.code);
}

function dailyEngine(maxDaily: number): PolicyEngine {
  return new PolicyEngine({ config: cfg({ payments: { enabled: true, maxPerRequest: 0.5, maxDaily } }), configErrors: [] });
}

function perServiceEngine(svcMaxDaily: number): PolicyEngine {
  return new PolicyEngine({
    config: cfg({ services: {
      unknown: { action: 'deny' },
      discovered: { action: 'allow', maxDaily: svcMaxDaily },
      verified: { action: 'allow' },
      trusted: { action: 'allow' },
      blocked: { action: 'deny' },
    } }),
    configErrors: [],
  });
}

// ---------------------------------------------------------------------------
// Rule 7 — the global daily cap
// ---------------------------------------------------------------------------

const NOISE_SPENT = 0.1 + 0.2; // = 0.30000000000000004, never 0.3

it('rule 7 allows a payment whose float-noise sum lands microscopically above the cap', () => {
  // 0.30000000000000004 + 0.05 = 0.35000000000000003 > 0.35 by ~3e-17 — pure
  // representation noise (a real overshoot is ≥ 5e-7): the payment is AT the
  // cap and must be allowed, exactly as 0.30 + 0.05 would be.
  const engine = dailyEngine(0.35);
  const result = engine.evaluate(ctx({ amount: 0.05 }), { dailySpentUsd: NOISE_SPENT } as PolicyBudgetState);
  assert.equal(result.decision, 'ALLOW');
  assert.deepEqual(result.reasons, []);
});

it('rule 7 keeps refusing a genuine overshoot beyond the tolerance', () => {
  const engine = dailyEngine(0.35);
  const result = engine.evaluate(ctx({ amount: 0.06 }), { dailySpentUsd: NOISE_SPENT });
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(codes(result), ['DAILY_LIMIT_EXCEEDED']);
});

it('rule 7 refuses an overshoot that exceeds the tolerance by more than noise', () => {
  // 0.30000000000000004 + 0.05000001 lands 1e-8 above the cap — four orders
  // of magnitude beyond the 1e-9 epsilon: a real overshoot, refused.
  const engine = dailyEngine(0.35);
  const result = engine.evaluate(ctx({ amount: 0.05000001 }), { dailySpentUsd: NOISE_SPENT });
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(codes(result), ['DAILY_LIMIT_EXCEEDED']);
});

it('rule 7 keeps the exact-cap boundary allowed (semantics unchanged)', () => {
  const engine = dailyEngine(0.35);
  const result = engine.evaluate(ctx({ amount: 0.1 }), { dailySpentUsd: 0.25 });
  assert.equal(result.decision, 'ALLOW');
});

it('rule 7 refusal messages print rounded money, never float artefacts', () => {
  const engine = dailyEngine(0.35);
  const result = engine.evaluate(ctx({ amount: 0.06 }), { dailySpentUsd: NOISE_SPENT });
  const message = result.reasons[0]!.message;
  assert.ok(message.includes('would exceed the daily cap $0.35'), `message must name the cap in rounded money: ${message}`);
  assert.ok(message.includes('($0.3 spent today)'), `message must round the spent figure (artifact seen: ${message})`);
  assert.equal(message.includes('30000000000000004'), false, `no artefact digits in the refusal: ${message}`);
});

// ---------------------------------------------------------------------------
// Rule 8 — the per-service daily cap
// ---------------------------------------------------------------------------

it('rule 8 allows a payment whose float-noise sum lands microscopically above the cap', () => {
  const engine = perServiceEngine(0.35);
  const result = engine.evaluate(ctx({ amount: 0.05 }), { perServiceSpentUsd: NOISE_SPENT, dailySpentUsd: 0 });
  assert.equal(result.decision, 'ALLOW');
  assert.deepEqual(result.reasons, []);
});

it('rule 8 keeps refusing a genuine overshoot beyond the tolerance', () => {
  const engine = perServiceEngine(0.35);
  const result = engine.evaluate(ctx({ amount: 0.11 }), { perServiceSpentUsd: 0.25, dailySpentUsd: 0.25 });
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(codes(result), ['SERVICE_LIMIT_EXCEEDED']);
});

it('rule 8 keeps the exact-cap boundary allowed (semantics unchanged)', () => {
  const atCap = perServiceEngine(0.35).evaluate(ctx({ amount: 0.1 }), { perServiceSpentUsd: 0.25, dailySpentUsd: 0 });
  assert.equal(atCap.decision, 'ALLOW');
});

it('rule 8 refusal messages print rounded money, never float artefacts', () => {
  const engine = perServiceEngine(0.35);
  const result = engine.evaluate(ctx({ amount: 0.11 }), { perServiceSpentUsd: 0.25, dailySpentUsd: 0.25 });
  const message = result.reasons[0]!.message;
  assert.ok(message.includes('daily limit is $0.35'), `message must name the per-service cap in rounded money: ${message}`);
  assert.ok(message.includes('$0.1 remains'), `message must round the remains figure (artifact seen: ${message})`);
  assert.equal(message.includes('09999999'), false, `no artefact digits in the refusal: ${message}`);
});

// ---------------------------------------------------------------------------
// The shared money module contract (money.ts): one epsilon for the whole
// spend path, and a formatter that rounds to the ledger's recording scale
// (6 decimals), never emits exponent or artefact digits, and strips the
// negative zero.
// ---------------------------------------------------------------------------

it('the money module pins the ONE epsilon the cap layers share', () => {
  const money = requireMoney();
  assert.equal(money.FLOAT_EPSILON_USD, 1e-9);
});

it('formatUsd rounds to 6 decimals with no exponent and no artefact digits', () => {
  const money = requireMoney();
  const table: Array<[number, string]> = [
    [0, '$0'],
    [-0, '$0'],
    [1, '$1'],
    [0.05, '$0.05'],
    [10, '$10'],
    [0.1 + 0.2, '$0.3'],
    [0.00000000000000004, '$0'],
    [0.000001, '$0.000001'],
    [0.0000004, '$0'],
    [1234.567891, '$1234.567891'],
    [10000, '$10000'],
  ];
  for (const [value, expected] of table) {
    assert.equal(money.formatUsd(value), expected, `formatUsd(${value})`);
  }
  // The noise sums the engine actually sees format back to operator money.
  assert.equal(money.formatUsd(NOISE_SPENT), '$0.3');
  assert.equal(money.formatUsd(0.35 - 0.25), '$0.1');
});