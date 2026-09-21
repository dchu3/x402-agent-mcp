import { strict as assert } from 'node:assert';
import { it, describe } from 'node:test';
import { PolicyEngine } from './engine.js';
import type { PolicyBudgetState, PolicyConfig, PolicyContext } from './types.js';

// Issue #19 Phase 7 unit list, evaluated against the pure core. The engine is
// a pure function of (engine state, context, budget state) — no clocks, no
// I/O, no env reads. Day-rollover and ledger rehydration live in the callers.

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

const allow = () => ({});

function codes(result: { reasons: Array<{ code: string }> }): string[] {
  return result.reasons.map((r) => r.code);
}

it('allows a payment that violates no rule', () => {
  const engine = new PolicyEngine({ config: cfg(), configErrors: [] });
  const result = engine.evaluate(ctx({ service: 'payable.example', trustLevel: 'DISCOVERED' }));
  assert.equal(result.decision, 'ALLOW');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.limits.trustLevel, 'DISCOVERED');
  assert.equal(result.limits.maxPerRequest, 0.5);
  assert.equal(result.limits.maxDaily, 10);
});

it('denies when payments are globally disabled', () => {
  const engine = new PolicyEngine({ config: cfg({ payments: { enabled: false, maxPerRequest: 0.5, maxDaily: 10 } }), configErrors: [] });
  const result = engine.evaluate(ctx());
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(codes(result), ['PAYMENTS_DISABLED']);
});

it('denies a payment above the per-request cap', () => {
  const engine = new PolicyEngine({ config: cfg(), configErrors: [] });
  const result = engine.evaluate(ctx({ amount: 0.51 }));
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(codes(result), ['REQUEST_LIMIT_EXCEEDED']);
});

it('allows a payment exactly at the per-request cap (matches payment-utils semantics)', () => {
  const engine = new PolicyEngine({ config: cfg(), configErrors: [] });
  const result = engine.evaluate(ctx({ amount: 0.5 }));
  assert.equal(result.decision, 'ALLOW');
});

it('denies when the payment would exceed the daily cap', () => {
  const engine = new PolicyEngine({ config: cfg(), configErrors: [] });
  const budget: PolicyBudgetState = { dailySpentUsd: 9.95 };
  const result = engine.evaluate(ctx({ amount: 0.1 }), budget); // 9.95 + 0.10 > 10
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(codes(result), ['DAILY_LIMIT_EXCEEDED']);
});

it('allows a payment that exactly reaches the daily cap (matches payment-utils semantics)', () => {
  const engine = new PolicyEngine({ config: cfg(), configErrors: [] });
  const result = engine.evaluate(ctx({ amount: 0.1 }), { dailySpentUsd: 9.9 });
  assert.equal(result.decision, 'ALLOW');
});

it('denies when the payment would exceed the per-service daily cap while the global cap stays intact', () => {
  const engine = new PolicyEngine({
    config: cfg({ services: {
      unknown: { action: 'deny' },
      discovered: { action: 'allow', maxDaily: 1.0 },
      verified: { action: 'allow' },
      trusted: { action: 'allow' },
      blocked: { action: 'deny' },
    } }),
    configErrors: [],
  });
  const denied = engine.evaluate(ctx({ service: 'spent.example' }), { perServiceSpentUsd: 0.95, dailySpentUsd: 0.95 });
  assert.equal(denied.decision, 'DENY');
  assert.deepEqual(codes(denied), ['SERVICE_LIMIT_EXCEEDED']);
  assert.equal(denied.limits.perServiceDaily, 1.0);
  // Reaching the per-service cap exactly is allowed (same boundary semantics
  // as the global caps — payment-utils compatibility).
  const boundary = engine.evaluate(ctx({ service: 'spent.example' }), { perServiceSpentUsd: 0.9, dailySpentUsd: 0.9 });
  assert.equal(boundary.decision, 'ALLOW');
  // A different service with the same global spend is still allowed — the
  // per-service cap, not the global cap, is what fired.
  const other = engine.evaluate(ctx({ service: 'fresh.example' }), { perServiceSpentUsd: 0, dailySpentUsd: 0.73 });
  assert.equal(other.decision, 'ALLOW');
});

it('denies an unknown service when services.unknown is configured to deny', () => {
  const engine = new PolicyEngine({ config: cfg(), configErrors: [] });
  const result = engine.evaluate(ctx({ service: 'stranger.example', trustLevel: 'UNKNOWN' }));
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(codes(result), ['UNKNOWN_SERVICE']);
});

it('allows an unknown service when services.unknown is configured to allow (compat default)', () => {
  const engine = new PolicyEngine({
    config: cfg({ services: {
      unknown: { action: 'allow' },
      discovered: { action: 'allow' },
      verified: { action: 'allow' },
      trusted: { action: 'allow' },
      blocked: { action: 'deny' },
    } }),
    configErrors: [],
  });
  const result = engine.evaluate(ctx({ service: 'stranger.example', trustLevel: 'UNKNOWN' }));
  assert.equal(result.decision, 'ALLOW');
});

it('denies a blocked service', () => {
  const engine = new PolicyEngine({ config: cfg(), configErrors: [] });
  const result = engine.evaluate(ctx({ service: 'blocked.example', trustLevel: 'BLOCKED' }));
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(codes(result), ['SERVICE_BLOCKED']);
});

it('enforces trust-level-specific per-request limits in both directions', () => {
  const engine = new PolicyEngine({
    config: cfg({ services: {
      unknown: { action: 'deny' },
      discovered: { action: 'allow', maxPerRequest: 0.25 },
      verified: { action: 'allow' },
      trusted: { action: 'allow', maxPerRequest: 5.0 },
      blocked: { action: 'deny' },
    } }),
    configErrors: [],
  });
  // DISCOVERED level tightens below the global cap.
  const tight = engine.evaluate(ctx({ amount: 0.3, trustLevel: 'DISCOVERED' }));
  assert.equal(tight.decision, 'DENY');
  assert.deepEqual(codes(tight), ['REQUEST_LIMIT_EXCEEDED']);
  assert.equal(tight.limits.maxPerRequest, 0.25);
  // TRUSTED level raises above the global cap (level override).
  const loose = engine.evaluate(ctx({ amount: 2.0, trustLevel: 'TRUSTED' }));
  assert.equal(loose.decision, 'ALLOW');
  assert.equal(loose.limits.maxPerRequest, 5.0);
});

it('denies a disallowed chain', () => {
  const engine = new PolicyEngine({ config: cfg({ networks: { allowed: ['base'] } }), configErrors: [] });
  const result = engine.evaluate(ctx({ chain: 'solana' }));
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(codes(result), ['CHAIN_NOT_ALLOWED']);
});

it('denies a disallowed token', () => {
  const engine = new PolicyEngine({ config: cfg({ tokens: { allowed: ['USDC'] } }), configErrors: [] });
  const result = engine.evaluate(ctx({ token: 'wCSPR', chain: 'casper' }));
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(codes(result), ['TOKEN_NOT_ALLOWED']);
});

it('accumulates every triggered reason, not just the first', () => {
  const engine = new PolicyEngine({
    config: cfg({ payments: { enabled: false, maxPerRequest: 0.05, maxDaily: 10 }, networks: { allowed: ['base'] } }),
    configErrors: [],
  });
  // Payments disabled + over per-request + disallowed chain — all three fire.
  const result = engine.evaluate(ctx({ amount: 0.5, chain: 'solana' }));
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(codes(result), ['PAYMENTS_DISABLED', 'CHAIN_NOT_ALLOWED', 'REQUEST_LIMIT_EXCEEDED']);
});

it('DENY outranks APPROVAL_REQUIRED when both would fire', () => {
  const engine = new PolicyEngine({
    config: cfg({ services: {
      unknown: { action: 'deny' },
      discovered: { action: 'approval' },
      verified: { action: 'allow' },
      trusted: { action: 'allow' },
      blocked: { action: 'deny' },
    } }),
    configErrors: [],
  });
  const denied = engine.evaluate(ctx({ trustLevel: 'DISCOVERED', amount: 5.0 }));
  assert.equal(denied.decision, 'DENY');
  assert.deepEqual(codes(denied), ['REQUEST_LIMIT_EXCEEDED', 'APPROVAL_REQUIRED']);
});

it('returns APPROVAL_REQUIRED when only the trust-level approval rule fires', () => {
  const engine = new PolicyEngine({
    config: cfg({ services: {
      unknown: { action: 'deny' },
      discovered: { action: 'approval' },
      verified: { action: 'allow' },
      trusted: { action: 'allow' },
      blocked: { action: 'deny' },
    } }),
    configErrors: [],
  });
  const result = engine.evaluate(ctx({ trustLevel: 'DISCOVERED' }));
  assert.equal(result.decision, 'APPROVAL_REQUIRED');
  assert.deepEqual(codes(result), ['APPROVAL_REQUIRED']);
});

it('fails closed with CONFIG_INVALID + PAYMENTS_DISABLED when the engine state carries config errors', () => {
  const engine = new PolicyEngine({ config: cfg(), configErrors: ['payments.maxPerRequest must be a finite non-negative number'] });
  const result = engine.evaluate(ctx());
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(codes(result), ['CONFIG_INVALID', 'PAYMENTS_DISABLED']);
});

it('fails closed on a non-finite or negative amount', () => {
  const engine = new PolicyEngine({ config: cfg(), configErrors: [] });
  for (const amount of [Number.NaN, -0.01, Number.POSITIVE_INFINITY]) {
    const result = engine.evaluate(ctx({ amount }));
    assert.equal(result.decision, 'DENY', `amount ${amount} must not be authorised`);
    assert.deepEqual(codes(result), ['REQUEST_LIMIT_EXCEEDED']);
  }
});

it('fails closed when the service policy for the context trust level is missing', () => {
  const partial = cfg();
  delete (partial.services as Record<string, unknown>).discovered;
  const engine = new PolicyEngine({ config: partial, configErrors: [] });
  const result = engine.evaluate(ctx({ trustLevel: 'DISCOVERED' }));
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(codes(result), ['CONFIG_INVALID']);
});

it('is deterministic: same input three times → identical output', () => {
  const engine = new PolicyEngine({
    config: cfg({ services: {
      unknown: { action: 'deny' },
      discovered: { action: 'allow', maxDaily: 1.0 },
      verified: { action: 'allow' },
      trusted: { action: 'allow' },
      blocked: { action: 'deny' },
    } }),
    configErrors: [],
  });
  const context = ctx({ amount: 0.4, service: 'det.example' });
  const budget: PolicyBudgetState = { dailySpentUsd: 0.9, perServiceSpentUsd: 0.65 };
  const runs = [engine.evaluate(context, budget), engine.evaluate(context, budget), engine.evaluate(context, budget)];
  assert.deepEqual(runs[0], runs[1]);
  assert.deepEqual(runs[1], runs[2]);
  assert.equal(runs[0].decision, 'DENY'); // 0.65 + 0.4 > 1.0 per-service cap
});