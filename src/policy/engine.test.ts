import { strict as assert } from 'node:assert';
import { it, describe } from 'node:test';
import bs58 from 'bs58';
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
    recipients: { mode: 'change-detect', allowed: [], perService: {}, known: {} },
    // Issue #30 compat default: the price anomaly gate ships DISABLED —
    // enabling it is an operator opt-in (conflict B), so existing decisions
    // are unchanged.
    anomaly: { enabled: false, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0 },
    // Issue #32: the facilitator settle-list (fail-closed rule-3 gate for
    // EVM chains that passed networks.allowed).
    evm: { facilitatorNetworks: ['eip155:8453', 'eip155:137', 'eip155:42161'] },
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

// ---------------------------------------------------------------------------
// Issue #32 — rule 3 extended: THREE fail-closed sub-checks in fixed
// precedence (L1 hard deny → networks.allowed membership → facilitator
// settle-gate), each emitting the SINGLE CHAIN_NOT_ALLOWED code so existing
// reason-count assertions stay intact. No new ReasonCode (fact 6).
// ---------------------------------------------------------------------------

describe('rule 3: multi-EVM network allowlist (issue #32)', () => {
  it('the Ethereum L1 is hard-denied ALWAYS — even when listed in networks.allowed (alias or CAIP-2 literal)', () => {
    const sloppy = cfg({ networks: { allowed: ['base', 'ethereum', 'eip155:1'] } });
    const engine = new PolicyEngine({ config: sloppy, configErrors: [] });
    for (const chain of ['ethereum', 'eip155:1']) {
      const result = engine.evaluate(ctx({ chain }));
      assert.equal(result.decision, 'DENY', `chain ${chain} must be refused despite the sloppy allowlist`);
      assert.deepEqual(codes(result), ['CHAIN_NOT_ALLOWED'], 'exactly ONE chain reason (single-code contract)');
      assert.match(result.reasons[0].message, /always refused/, 'the L1 hard-deny message explains the unconditional refusal');
    }
  });

  it('membership still fires unchanged for chains outside the allowlist', () => {
    const engine = new PolicyEngine({ config: cfg({ networks: { allowed: ['base'] } }), configErrors: [] });
    const result = engine.evaluate(ctx({ chain: 'polygon' }));
    assert.equal(result.decision, 'DENY');
    assert.deepEqual(codes(result), ['CHAIN_NOT_ALLOWED']);
    assert.match(result.reasons[0].message, /not in the allowed networks \[base\]/, 'the membership message keeps its pre-#32 shape');
  });

  it('facilitator gate: an allowed EVM chain the facilitator does not settle is denied (naming the facilitator list)', () => {
    const engine = new PolicyEngine({
      config: cfg({ networks: { allowed: ['base', 'polygon'] }, evm: { facilitatorNetworks: ['eip155:8453'] } }),
      configErrors: [],
    });
    const result = engine.evaluate(ctx({ chain: 'polygon' }));
    assert.equal(result.decision, 'DENY');
    assert.deepEqual(codes(result), ['CHAIN_NOT_ALLOWED'], 'exactly ONE chain reason — the facilitator gate emits the existing code');
    assert.match(result.reasons[0].message, /facilitator networks \[eip155:8453\]/);
    // Base is still fine — it is in both lists.
    const ok = engine.evaluate(ctx({ chain: 'base' }));
    assert.equal(ok.decision, 'ALLOW');
    assert.deepEqual(ok.reasons, []);
  });

  it('polygon/arbitrum ALLOW only when BOTH networks.allowed and the facilitator list admit them', () => {
    // Default facilitator list (all three EVM ids) + opted-in aliases ⇒ ALLOW.
    const optedIn = new PolicyEngine({
      config: cfg({ networks: { allowed: ['base', 'solana', 'casper', 'polygon', 'arbitrum'] } }),
      configErrors: [],
    });
    assert.equal(optedIn.evaluate(ctx({ chain: 'polygon' })).decision, 'ALLOW');
    assert.equal(optedIn.evaluate(ctx({ chain: 'arbitrum' })).decision, 'ALLOW');
    // Default facilitator list + compat allowlist (no polygon/arbitrum) ⇒ DENY by membership.
    const compat = new PolicyEngine({ config: cfg(), configErrors: [] });
    for (const chain of ['polygon', 'arbitrum']) {
      const denied = compat.evaluate(ctx({ chain }));
      assert.equal(denied.decision, 'DENY');
      assert.deepEqual(codes(denied), ['CHAIN_NOT_ALLOWED']);
    }
  });

  it('unknown EVM networks deny with the default facilitator list — verbatim CAIP-2, never aliased to base', () => {
    // eip155:10 (Optimism) under the compat allowlist: membership deny.
    const compat = new PolicyEngine({ config: cfg(), configErrors: [] });
    const membership = compat.evaluate(ctx({ chain: 'eip155:10' }));
    assert.equal(membership.decision, 'DENY');
    assert.deepEqual(codes(membership), ['CHAIN_NOT_ALLOWED']);
    // …and even when the operator allowlists the verbatim CAIP-2, the default
    // facilitator list does not settle it: the facilitator gate fires.
    const allowlisted = new PolicyEngine({
      config: cfg({ networks: { allowed: ['base', 'eip155:10'] } }),
      configErrors: [],
    });
    const gated = allowlisted.evaluate(ctx({ chain: 'eip155:10' }));
    assert.equal(gated.decision, 'DENY');
    assert.deepEqual(codes(gated), ['CHAIN_NOT_ALLOWED']);
    assert.match(gated.reasons[0].message, /facilitator networks/);
    // A non-EVM unrecognised chain ('optimism' is not in the vocabulary):
    // membership deny under the compat allowlist.
    const other = compat.evaluate(ctx({ chain: 'optimism' }));
    assert.equal(other.decision, 'DENY');
    assert.deepEqual(codes(other), ['CHAIN_NOT_ALLOWED']);
  });

  it('non-EVM chains skip the facilitator gate (solana/casper unaffected)', () => {
    const engine = new PolicyEngine({ config: cfg(), configErrors: [] });
    assert.equal(engine.evaluate(ctx({ chain: 'solana' })).decision, 'ALLOW');
    assert.equal(engine.evaluate(ctx({ chain: 'casper', token: 'wCSPR' })).decision, 'ALLOW');
  });

  it('at most one CHAIN_NOT_ALLOWED reason even when several sub-checks could fire', () => {
    const engine = new PolicyEngine({
      config: cfg({ networks: { allowed: ['base', 'ethereum'] }, evm: { facilitatorNetworks: [] } }),
      configErrors: [],
    });
    const result = engine.evaluate(ctx({ chain: 'ethereum' })); // L1 listed AND facilitator list empty
    assert.equal(result.decision, 'DENY');
    assert.deepEqual(codes(result), ['CHAIN_NOT_ALLOWED'], 'L1 hard deny short-circuits — never a second chain reason');
  });
});

// ---------------------------------------------------------------------------
// Issue #26 — rule 4.5: the recipient gate (RECIPIENT_NOT_ALLOWED). The gate
// sits between rule 4 (TOKEN_NOT_ALLOWED) and rule 5 (UNKNOWN_SERVICE) in the
// fixed rule order. Two modes:
//   allowlist    — ACTIVE always; fail-closed on an empty effective list and
//                  on a missing/unusable probed recipient.
//   change-detect— ACTIVE only for a host with a recorded baseline in `known`;
//                  no baseline ⇒ no reason at all (what keeps the compat
//                  default inert).
// perService REPLACES the global list for that host; host keys match
// lowercase; comparison happens on normalized (canonical) recipients.
// ---------------------------------------------------------------------------

const EVM_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EVM_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const EVM_CHECKSUMMED = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // same as EVM_A's lowercase
const SOL_A = bs58.encode(Buffer.alloc(32, 0x07));
const SOL_B = bs58.encode(Buffer.alloc(32, 0x08));
const CASPER_A = '00' + 'ab'.repeat(32);
const CASPER_B = '00' + 'cd'.repeat(32);
const CASPER_A_PREFIXED_UPPER = 'account-hash-' + '00' + 'AB'.repeat(32);

function rcpt(overrides: Partial<PolicyConfig['recipients']> = {}): PolicyConfig['recipients'] {
  return { mode: 'allowlist', allowed: [], perService: {}, known: {}, ...overrides };
}

function rcptCfg(recipients: PolicyConfig['recipients'], overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return cfg({ recipients, ...overrides });
}

describe('rule 4.5: allowlist mode', () => {
  it('allows a listed recipient and denies an unlisted one (RECIPIENT_NOT_ALLOWED alone ⇒ DENY)', () => {
    const engine = new PolicyEngine({ config: rcptCfg(rcpt({ allowed: [EVM_A] })), configErrors: [] });
    const allowed = engine.evaluate(ctx({ recipient: EVM_A }));
    assert.equal(allowed.decision, 'ALLOW');
    assert.deepEqual(allowed.reasons, []);
    const denied = engine.evaluate(ctx({ recipient: EVM_B }));
    assert.equal(denied.decision, 'DENY');
    assert.deepEqual(codes(denied), ['RECIPIENT_NOT_ALLOWED']);
  });

  it('denies when the effective list is empty — global empty AND per-service empty (fail-closed)', () => {
    const engine = new PolicyEngine({ config: rcptCfg(rcpt({ allowed: [] })), configErrors: [] });
    const globalEmpty = engine.evaluate(ctx({ recipient: EVM_A }));
    assert.equal(globalEmpty.decision, 'DENY');
    assert.deepEqual(codes(globalEmpty), ['RECIPIENT_NOT_ALLOWED']);
    const perServiceEmpty = new PolicyEngine({
      config: rcptCfg(rcpt({ allowed: [EVM_A], perService: { 'example.com': [] } })),
      configErrors: [],
    });
    const emptyOverride = perServiceEmpty.evaluate(ctx({ recipient: EVM_A }));
    assert.equal(emptyOverride.decision, 'DENY');
    assert.deepEqual(codes(emptyOverride), ['RECIPIENT_NOT_ALLOWED']);
  });

  it('denies when ctx.recipient is missing while the mode is active (membership cannot be proven)', () => {
    const engine = new PolicyEngine({ config: rcptCfg(rcpt({ allowed: [EVM_A] })), configErrors: [] });
    for (const recipient of [undefined, '']) {
      const result = engine.evaluate(ctx({ recipient }));
      assert.equal(result.decision, 'DENY');
      assert.deepEqual(codes(result), ['RECIPIENT_NOT_ALLOWED']);
    }
  });

  it('perService REPLACES the global list for that host (listed-globally ⇒ deny there, per-service-listed ⇒ allow)', () => {
    const engine = new PolicyEngine({
      config: rcptCfg(rcpt({ allowed: [EVM_A], perService: { 'example.com': [EVM_B] } })),
      configErrors: [],
    });
    // EVM_A is listed globally but NOT on example.com — the per-service list replaces it.
    const overridden = engine.evaluate(ctx({ recipient: EVM_A }));
    assert.equal(overridden.decision, 'DENY');
    assert.deepEqual(codes(overridden), ['RECIPIENT_NOT_ALLOWED']);
    // EVM_B is only on the per-service list — allowed for that host.
    assert.equal(engine.evaluate(ctx({ recipient: EVM_B })).decision, 'ALLOW');
    // A different host is still governed by the GLOBAL list.
    const otherAllowed = engine.evaluate(ctx({ service: 'other.example', recipient: EVM_A }));
    assert.equal(otherAllowed.decision, 'ALLOW');
    const otherDenied = engine.evaluate(ctx({ service: 'other.example', recipient: EVM_B }));
    assert.equal(otherDenied.decision, 'DENY');
  });

  it('host keys are matched lowercase (buildPolicyContext lowercases ctx.service)', () => {
    const engine = new PolicyEngine({
      config: rcptCfg(rcpt({ allowed: [EVM_A], perService: { 'example.com': [EVM_B] } })),
      configErrors: [],
    });
    // Uppercase ctx spelling still hits the lowercase per-service entry.
    assert.equal(engine.evaluate(ctx({ service: 'Example.COM', recipient: EVM_B })).decision, 'ALLOW');
  });

  it('formatting differences never bypass the gate — normalization makes them match (or fail closed)', () => {
    // EVM: entry checksummed, probed lowercase ⇒ match (and the reverse).
    const evm = new PolicyEngine({
      config: rcptCfg(rcpt({ allowed: [EVM_CHECKSUMMED] })),
      configErrors: [],
    });
    assert.equal(evm.evaluate(ctx({ recipient: EVM_CHECKSUMMED.toLowerCase() })).decision, 'ALLOW');
    const evmReverse = new PolicyEngine({
      config: rcptCfg(rcpt({ allowed: [EVM_CHECKSUMMED.toLowerCase()] })),
      configErrors: [],
    });
    assert.equal(evmReverse.evaluate(ctx({ recipient: EVM_CHECKSUMMED })).decision, 'ALLOW');
    // Solana: base58 wallets contain uppercase characters — an exact wallet matches.
    const sol = new PolicyEngine({ config: rcptCfg(rcpt({ allowed: [SOL_A] })), configErrors: [] });
    assert.equal(sol.evaluate(ctx({ chain: 'solana', recipient: SOL_A })).decision, 'ALLOW');
    assert.equal(sol.evaluate(ctx({ chain: 'solana', recipient: SOL_B })).decision, 'DENY');
    // Casper: case-differing + account-hash- prefixed entry matches the bare lowercase probed recipient.
    const casper = new PolicyEngine({ config: rcptCfg(rcpt({ allowed: [CASPER_A_PREFIXED_UPPER] })), configErrors: [] });
    assert.equal(casper.evaluate(ctx({ chain: 'casper', token: 'wCSPR', recipient: CASPER_A })).decision, 'ALLOW');
    assert.equal(casper.evaluate(ctx({ chain: 'casper', token: 'wCSPR', recipient: CASPER_B })).decision, 'DENY');
    // A probed recipient that cannot be normalized for the chain can never prove membership.
    const unnormalizable = evm.evaluate(ctx({ recipient: EVM_CHECKSUMMED.toUpperCase().replace('0X', '0x') }));
    assert.equal(unnormalizable.decision, 'DENY');
    assert.deepEqual(codes(unnormalizable), ['RECIPIENT_NOT_ALLOWED']);
  });

  it('an allowlist entry that cannot be normalized for the evaluated chain never matches (cross-chain confusion)', () => {
    const engine = new PolicyEngine({
      config: rcptCfg(rcpt({ allowed: [SOL_A, 'SoLWallet', EVM_A] })), // SOL entries are not EVM addresses
      configErrors: [],
    });
    const result = engine.evaluate(ctx({ chain: 'base', recipient: SOL_A })); // probed a Solana wallet on Base
    assert.equal(result.decision, 'DENY', 'a Solana address can never satisfy an EVM-context gate');
    assert.deepEqual(codes(result), ['RECIPIENT_NOT_ALLOWED']);
  });
});

describe('rule 4.5: change-detect mode', () => {
  it('no baseline for the host ⇒ no recipient reason at all (the compat proof)', () => {
    const engine = new PolicyEngine({
      config: rcptCfg({ mode: 'change-detect', allowed: [], perService: {}, known: {} }),
      configErrors: [],
    });
    for (const recipient of [undefined, EVM_A, EVM_B]) {
      const result = engine.evaluate(ctx({ recipient }));
      assert.equal(result.decision, 'ALLOW');
      assert.deepEqual(result.reasons, [], `recipient ${String(recipient)} must not trigger anything without a baseline`);
    }
  });

  it('a matching baseline allows (canonical equality, formatting-insensitive); a differing baseline denies', () => {
    const engine = new PolicyEngine({
      config: rcptCfg({ mode: 'change-detect', allowed: [], perService: {}, known: { 'example.com': CASPER_A_PREFIXED_UPPER } }),
      configErrors: [],
    });
    const match = engine.evaluate(ctx({ chain: 'casper', token: 'wCSPR', recipient: CASPER_A }));
    assert.equal(match.decision, 'ALLOW');
    assert.deepEqual(match.reasons, []);
    const differ = engine.evaluate(ctx({ chain: 'casper', token: 'wCSPR', recipient: CASPER_B }));
    assert.equal(differ.decision, 'DENY');
    assert.deepEqual(codes(differ), ['RECIPIENT_NOT_ALLOWED']);
  });

  it('an unnormalizable or missing probed recipient against a recorded baseline is denied', () => {
    const engine = new PolicyEngine({
      config: rcptCfg({ mode: 'change-detect', allowed: [], perService: {}, known: { 'example.com': EVM_A } }),
      configErrors: [],
    });
    const missing = engine.evaluate(ctx({}));
    assert.equal(missing.decision, 'DENY');
    assert.deepEqual(codes(missing), ['RECIPIENT_NOT_ALLOWED']);
    const unusable = engine.evaluate(ctx({ recipient: EVM_CHECKSUMMED.toUpperCase().replace('0X', '0x') }));
    assert.equal(unusable.decision, 'DENY');
    assert.deepEqual(codes(unusable), ['RECIPIENT_NOT_ALLOWED']);
    // A wrong-chain probed value cannot match either (normalization is chain-aware).
    const wrongChain = engine.evaluate(ctx({ recipient: SOL_A }));
    assert.equal(wrongChain.decision, 'DENY');
  });

  it('an unnormalizable baseline denies every probed recipient for that host (fail-closed, never open)', () => {
    const engine = new PolicyEngine({
      config: rcptCfg({ mode: 'change-detect', allowed: [], perService: {}, known: { 'example.com': 'SoLWallet' } }),
      configErrors: [],
    });
    for (const recipient of [EVM_A, SOL_A]) {
      const result = engine.evaluate(ctx({ recipient }));
      assert.equal(result.decision, 'DENY', `unusable baseline must deny even ${String(recipient)}`);
      assert.deepEqual(codes(result), ['RECIPIENT_NOT_ALLOWED']);
    }
  });
});

describe('rule 4.5: chain-scoped recipient entries (issue #32, R6)', () => {
  // ctx() defaults to chain 'base' / token 'USDC'; polygon chains need the
  // alias opted into networks.allowed (the default facilitator list already
  // settles eip155:137 / eip155:42161).
  const MULTI_EVM = ['base', 'polygon', 'arbitrum'];

  it('normalizeRecipient drives the gate on the new aliases: polygon/arbitrum canonicalise like base', () => {
    const engine = new PolicyEngine({ config: rcptCfg(rcpt({ allowed: ['polygon:' + EVM_A] }), { networks: { allowed: MULTI_EVM } }), configErrors: [] });
    const ok = engine.evaluate(ctx({ chain: 'polygon', recipient: EVM_A }));
    assert.equal(ok.decision, 'ALLOW');
  });

  it('a bare 0x entry means base: allowed on base, DENIED on polygon (the issue acceptance criterion)', () => {
    const engine = new PolicyEngine({ config: rcptCfg(rcpt({ allowed: [EVM_A] }), { networks: { allowed: MULTI_EVM } }), configErrors: [] });
    const onBase = engine.evaluate(ctx({ chain: 'base', recipient: EVM_A }));
    assert.equal(onBase.decision, 'ALLOW');
    const onPolygon = engine.evaluate(ctx({ chain: 'polygon', recipient: EVM_A }));
    assert.equal(onPolygon.decision, 'DENY', 'a bare Base approval must never widen onto Polygon');
    assert.deepEqual(codes(onPolygon), ['RECIPIENT_NOT_ALLOWED']);
  });

  it('polygon:0x is allowed on polygon and denied on base; arbitrum:0x likewise', () => {
    const engine = new PolicyEngine({
      config: rcptCfg(rcpt({ allowed: [`polygon:${EVM_A}`, `arbitrum:${EVM_B}`] }), { networks: { allowed: MULTI_EVM } }),
      configErrors: [],
    });
    assert.equal(engine.evaluate(ctx({ chain: 'polygon', recipient: EVM_A })).decision, 'ALLOW');
    assert.equal(engine.evaluate(ctx({ chain: 'arbitrum', recipient: EVM_B })).decision, 'ALLOW');
    const wrongChain = engine.evaluate(ctx({ chain: 'base', recipient: EVM_A }));
    assert.equal(wrongChain.decision, 'DENY', 'the polygon-scoped entry must not satisfy base');
    assert.deepEqual(codes(wrongChain), ['RECIPIENT_NOT_ALLOWED']);
    const crossEvm = engine.evaluate(ctx({ chain: 'polygon', recipient: EVM_B }));
    assert.equal(crossEvm.decision, 'DENY', 'the arbitrum-scoped entry must not satisfy polygon');
  });

  it('*:0x (any chain) is allowed on base, polygon and arbitrum alike', () => {
    const engine = new PolicyEngine({ config: rcptCfg(rcpt({ allowed: [`*:${EVM_A}`] }), { networks: { allowed: MULTI_EVM } }), configErrors: [] });
    for (const chain of MULTI_EVM) {
      const result = engine.evaluate(ctx({ chain, recipient: EVM_A }));
      assert.equal(result.decision, 'ALLOW', `*:${EVM_A} must satisfy ${chain}`);
    }
  });

  it('an entry with an unrecognised chain qualifier is unusable — it never matches on any chain', () => {
    const engine = new PolicyEngine({
      config: rcptCfg(rcpt({ allowed: [`optimism:${EVM_A}`, `eip155:137:${EVM_B}`] }), { networks: { allowed: [...MULTI_EVM, 'eip155:10'] } }),
      configErrors: [],
    });
    for (const [chain, recipient] of [['base', EVM_A], ['polygon', EVM_A], ['base', EVM_B], ['polygon', EVM_B]] as const) {
      const result = engine.evaluate(ctx({ chain, recipient }));
      assert.equal(result.decision, 'DENY', `unusable entry must never match (${chain} / ${recipient})`);
      assert.deepEqual(codes(result), ['RECIPIENT_NOT_ALLOWED']);
    }
  });

  it('the chain scope applies to perService lists exactly like the global list', () => {
    const engine = new PolicyEngine({
      config: rcptCfg(rcpt({ allowed: [EVM_A], perService: { 'example.com': [`polygon:${EVM_A}`] } }), { networks: { allowed: MULTI_EVM } }),
      configErrors: [],
    });
    assert.equal(engine.evaluate(ctx({ chain: 'polygon', recipient: EVM_A })).decision, 'ALLOW');
    const onBase = engine.evaluate(ctx({ chain: 'base', recipient: EVM_A }));
    assert.equal(onBase.decision, 'DENY', 'on example.com the per-service polygon-scoped list REPLACES the global bare entry');
  });

  it('change-detect baselines are chain-scoped the same way', () => {
    // polygon-scoped baseline: matches a polygon probed recipient, denies base.
    const engine = new PolicyEngine({
      config: rcptCfg({ mode: 'change-detect', allowed: [], perService: {}, known: { 'example.com': `polygon:${EVM_A}` } }, { networks: { allowed: MULTI_EVM } }),
      configErrors: [],
    });
    const match = engine.evaluate(ctx({ chain: 'polygon', recipient: EVM_A }));
    assert.equal(match.decision, 'ALLOW');
    assert.deepEqual(match.reasons, []);
    const outOfScope = engine.evaluate(ctx({ chain: 'base', recipient: EVM_A }));
    assert.equal(outOfScope.decision, 'DENY', 'a polygon-scoped baseline is unusable on base — fail closed');
    assert.deepEqual(codes(outOfScope), ['RECIPIENT_NOT_ALLOWED']);
    // Wildcard baseline accepts on either chain; a bare baseline (base-scoped)
    // DENIES on polygon — proven with the same host keyed separately.
    const wild = new PolicyEngine({
      config: rcptCfg({ mode: 'change-detect', allowed: [], perService: {}, known: { 'wild.example': `*:${EVM_A}`, 'legacy.example': EVM_A } }, { networks: { allowed: MULTI_EVM } }),
      configErrors: [],
    });
    assert.equal(wild.evaluate(ctx({ service: 'wild.example', chain: 'polygon', recipient: EVM_A })).decision, 'ALLOW');
    assert.equal(wild.evaluate(ctx({ service: 'wild.example', chain: 'base', recipient: EVM_A })).decision, 'ALLOW');
    const legacyOnPolygon = wild.evaluate(ctx({ service: 'legacy.example', chain: 'polygon', recipient: EVM_A }));
    assert.equal(legacyOnPolygon.decision, 'DENY', 'a bare baseline never widens onto polygon');
    assert.equal(wild.evaluate(ctx({ service: 'legacy.example', chain: 'base', recipient: EVM_A })).decision, 'ALLOW');
  });

  it('bare non-EVM entries keep their pre-#32 meaning (solana/casper assertions untouched by the scoping)', () => {
    const sol = new PolicyEngine({ config: rcptCfg(rcpt({ allowed: [SOL_A] })), configErrors: [] });
    assert.equal(sol.evaluate(ctx({ chain: 'solana', recipient: SOL_A })).decision, 'ALLOW', 'a bare Solana entry still governs solana');
    const casper = new PolicyEngine({ config: rcptCfg(rcpt({ allowed: [EVM_A] })), configErrors: [] });
    const cross = casper.evaluate(ctx({ chain: 'polygon', recipient: EVM_A }));
    assert.equal(cross.decision, 'DENY', 'a bare entry must not follow onto polygon even when it would normalise there');
  });
});

describe('rule 4.5: ordering and aggregation', () => {
  it('the recipient reason accumulates between TOKEN_NOT_ALLOWED and UNKNOWN_SERVICE (fixed rule order)', () => {
    const engine = new PolicyEngine({
      config: rcptCfg(rcpt({ allowed: [EVM_A] }), { tokens: { allowed: ['USDC'] } }),
      configErrors: [],
    });
    const result = engine.evaluate(ctx({ token: 'wCSPR', trustLevel: 'UNKNOWN', recipient: EVM_B }));
    assert.equal(result.decision, 'DENY');
    assert.deepEqual(codes(result), ['TOKEN_NOT_ALLOWED', 'RECIPIENT_NOT_ALLOWED', 'UNKNOWN_SERVICE']);
  });

  it('the decision stays DENY when the recipient reason is combined with cap reasons', () => {
    const engine = new PolicyEngine({ config: rcptCfg(rcpt({ allowed: [EVM_A] })), configErrors: [] });
    const result = engine.evaluate(ctx({ recipient: EVM_B, amount: 0.51 }));
    assert.equal(result.decision, 'DENY');
    assert.deepEqual(codes(result), ['RECIPIENT_NOT_ALLOWED', 'REQUEST_LIMIT_EXCEEDED']);
  });
});

// ---------------------------------------------------------------------------
// Issue #30 — rule 4.6: the price anomaly gate (PRICE_ANOMALY). Sits after
// rule 4.5 and before rule 5 (fixed rule order). The band decides routing:
// the approval band pushes PRICE_ANOMALY + APPROVAL_REQUIRED (the existing
// aggregation ranks it); the deny band sets a local hardDeny flag —
// PRICE_ANOMALY is deliberately NOT a DENY_CODES member (conflict C). Casper
// (amount 0 by design) is inert (conflict A); the compat default disables the
// rule entirely (conflict B).
// ---------------------------------------------------------------------------

import type { AnomalyConfig, PriceBaseline } from './types.js';

function anomalyCfg(overrides: Partial<AnomalyConfig> = {}): PolicyConfig {
  return cfg({
    anomaly: { enabled: true, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0, ...overrides },
  });
}

// Hand-set stats (baselines are inputs — the engine trusts them; updateBaseline's
// math is unit-tested in anomaly.test.ts): mean 0.1, stdev 0.05 ⇒ z = (amount − 0.1)/0.05.
const Z_BASELINE: PriceBaseline = { samples: [0.1, 0.1, 0.1, 0.1, 0.1], mean: 0.1, stdev: 0.05 };

describe('rule 4.6: price anomaly gate', () => {
  it('a normal payment against the settled baseline is ALLOWed with no reasons', () => {
    const engine = new PolicyEngine({ config: anomalyCfg(), configErrors: [] });
    const result = engine.evaluate(ctx({ amount: 0.1 }), {}, { baseline: Z_BASELINE });
    assert.equal(result.decision, 'ALLOW');
    assert.deepEqual(result.reasons, []);
  });

  it('a z below warnZ stays ALLOW and emits no reason (nothing annotated)', () => {
    const engine = new PolicyEngine({ config: anomalyCfg(), configErrors: [] });
    const result = engine.evaluate(ctx({ amount: 0.14 }), {}, { baseline: Z_BASELINE }); // z ≈ 0.8
    assert.equal(result.decision, 'ALLOW');
    assert.deepEqual(result.reasons, []);
  });

  it('a mild spike lands in the approval band — APPROVAL_REQUIRED with a PRICE_ANOMALY reason carrying z detail', () => {
    const engine = new PolicyEngine({ config: anomalyCfg(), configErrors: [] });
    const result = engine.evaluate(ctx({ amount: 0.2 }), {}, { baseline: Z_BASELINE }); // z ≈ 2
    assert.equal(result.decision, 'APPROVAL_REQUIRED');
    assert.deepEqual(codes(result), ['PRICE_ANOMALY', 'APPROVAL_REQUIRED']);
    const detail = result.reasons[0].detail!;
    assert.ok(Math.abs((detail.zScore as number) - 2) < 1e-9, `z should be ~2, got ${detail.zScore}`);
    assert.equal(detail.band, 'approval');
    assert.equal(detail.mean, 0.1);
    assert.equal(detail.stdev, 0.05);
    assert.equal(detail.samples, 5);
    assert.equal(detail.window, 20);
    assert.equal(detail.amount, 0.2);
    assert.equal(detail.host, 'example.com');
    assert.match(result.reasons[0].message, /human confirmation/);
  });

  it('a severe spike is hard-denied with PRICE_ANOMALY (routed by the band, not DENY_CODES)', () => {
    const engine = new PolicyEngine({ config: anomalyCfg(), configErrors: [] });
    const result = engine.evaluate(ctx({ amount: 0.3 }), {}, { baseline: Z_BASELINE }); // z ≈ 4
    assert.equal(result.decision, 'DENY');
    assert.deepEqual(codes(result), ['PRICE_ANOMALY']);
    const detail = result.reasons[0].detail!;
    assert.ok(Math.abs((detail.zScore as number) - 4) < 1e-9, `z should be ~4, got ${detail.zScore}`);
    assert.equal(detail.band, 'deny');
    assert.match(result.reasons[0].message, /denied/);
  });

  it('Casper is inert (amount 0 by design) — no PRICE_ANOMALY for the mote-denominated leg', () => {
    const engine = new PolicyEngine({ config: anomalyCfg(), configErrors: [] });
    const result = engine.evaluate(ctx({ chain: 'casper', token: 'wCSPR', amount: 0 }), {}, { baseline: Z_BASELINE });
    assert.equal(result.decision, 'ALLOW');
    assert.deepEqual(result.reasons, []);
  });

  it('a non-positive amount on a USD chain is a hard deny with the non-positive-amount detail', () => {
    const engine = new PolicyEngine({ config: anomalyCfg(), configErrors: [] });
    // amount 0 is spendable under the pre-existing rule 6 — only rule 4.6 fires.
    const zero = engine.evaluate(ctx({ amount: 0 }), {}, { baseline: Z_BASELINE });
    assert.equal(zero.decision, 'DENY', 'amount 0 must not be authorised');
    assert.deepEqual(codes(zero), ['PRICE_ANOMALY']);
    assert.equal(zero.reasons[0].detail!.reason, 'non-positive-amount');
    // A negative amount ALSO accumulates the pre-existing rule 6 fail-closed reason.
    const negative = engine.evaluate(ctx({ amount: -0.01 }), {}, { baseline: Z_BASELINE });
    assert.equal(negative.decision, 'DENY');
    assert.deepEqual(codes(negative), ['PRICE_ANOMALY', 'REQUEST_LIMIT_EXCEEDED']);
    // Non-finite amounts likewise accumulate rule 6.
    const nan = engine.evaluate(ctx({ amount: Number.NaN }), {}, { baseline: Z_BASELINE });
    assert.equal(nan.decision, 'DENY');
    assert.deepEqual(codes(nan), ['PRICE_ANOMALY', 'REQUEST_LIMIT_EXCEEDED']);
  });

  it('a thin or zero-variance baseline can only reach the approval band, never hard deny (conflict D)', () => {
    // Caps raised so the spike itself is not refused by the pre-existing per-request cap.
    const engine = new PolicyEngine({
      config: cfg({ payments: { enabled: true, maxPerRequest: 50, maxDaily: 100 }, anomaly: { enabled: true, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0 } }),
      configErrors: [],
    });
    const thin: PriceBaseline = { samples: [0.5, 0.5], mean: 0.5, stdev: 0 }; // 2 samples < minSamples 5, stdev 0
    const approval = engine.evaluate(ctx({ amount: 10 }), {}, { baseline: thin });
    assert.equal(approval.decision, 'APPROVAL_REQUIRED');
    assert.equal(approval.reasons[0].code, 'PRICE_ANOMALY');
    assert.ok(Math.abs((approval.reasons[0].detail!.ratio as number) - 20) < 1e-9);
    assert.equal(approval.reasons[1].code, 'APPROVAL_REQUIRED');
  });

  it('the compat default keeps the gate inert (anomaly.enabled false — the operator opt-in)', () => {
    const engine = new PolicyEngine({ config: cfg(), configErrors: [] }); // anomaly disabled
    // A 4.5x spike that would be denied with the gate on: with the compat
    // default it annotates nothing and the payment stays ALLOW.
    const result = engine.evaluate(ctx({ amount: 0.45 }), {}, { baseline: Z_BASELINE });
    assert.equal(result.decision, 'ALLOW');
    assert.deepEqual(result.reasons, []);
  });

  it('a denied evaluation never touches the input baseline object (purity of AnomalyInputs)', () => {
    const engine = new PolicyEngine({ config: anomalyCfg(), configErrors: [] });
    const baseline: PriceBaseline = { samples: [0.1, 0.1, 0.1, 0.1, 0.1], mean: 0.1, stdev: 0.05 };
    const snapshot = JSON.stringify(baseline);
    engine.evaluate(ctx({ amount: 5 }), {}, { baseline }); // over the per-request cap too ⇒ DENY
    assert.equal(JSON.stringify(baseline), snapshot, 'the engine must never mutate the caller-supplied baseline');
  });

  it('rule 4.6 accumulates between rule 4.5-era codes and rule 5 (fixed rule order)', () => {
    const engine = new PolicyEngine({
      config: cfg({
        anomaly: { enabled: true, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0 },
        tokens: { allowed: ['USDC'] },
        services: { unknown: { action: 'deny' }, discovered: { action: 'allow' }, verified: { action: 'allow' }, trusted: { action: 'allow' }, blocked: { action: 'deny' } },
      }),
      configErrors: [],
    });
    const result = engine.evaluate(ctx({ token: 'wCSPR', trustLevel: 'UNKNOWN', amount: 0.3 }), {}, { baseline: Z_BASELINE });
    assert.equal(result.decision, 'DENY');
    assert.deepEqual(codes(result), ['TOKEN_NOT_ALLOWED', 'PRICE_ANOMALY', 'UNKNOWN_SERVICE']);
  });
});
