import { strict as assert } from 'node:assert';
import { it, describe } from 'node:test';
import { DEFAULT_ANOMALY_CONFIG, emptyBaseline, evaluatePriceAnomaly, updateBaseline } from './anomaly.js';
import type { AnomalyConfig, PriceBaseline } from './types.js';

// Issue #30 — the pure price-anomaly module. No I/O, no env reads, no clocks:
// everything here is a pure function of its arguments (the engine imports
// this module, so purity is inherited, not re-established).

function cfg(overrides: Partial<AnomalyConfig> = {}): AnomalyConfig {
  return { enabled: true, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0, ...overrides };
}

/** Build a baseline from chosen samples (population stdev). Used where the
 * exact stats don't need to be hand-picked; boundary tests hand-set stats
 * instead for exact z values. */
function baselineOf(samples: number[]): PriceBaseline {
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const stdev = samples.length < 2 ? 0 : Math.sqrt(samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length);
  return { samples, mean, stdev };
}

/** Baseline with hand-set stats: mean 0.1, stdev 0.05 ⇒ z = (amount − 0.1)/0.05
 * picks clean numbers (0.14 → 0.8, 0.2 → ~2, 0.25 → ~3). The engine and the
 * rule trust the stats as given — baselines are inputs (the store recomputes
 * them; updateBaseline's math is verified separately above). */
const Z_BASELINE: PriceBaseline = { samples: [0.1, 0.1, 0.1, 0.1, 0.1], mean: 0.1, stdev: 0.05 };

describe('updateBaseline', () => {
  it('appends the settled amount and recomputes mean and population stdev', () => {
    let b = emptyBaseline();
    b = updateBaseline(b, 1);
    b = updateBaseline(b, 2);
    b = updateBaseline(b, 3);
    b = updateBaseline(b, 4);
    assert.deepEqual(b.samples, [1, 2, 3, 4]);
    assert.equal(b.mean, 2.5);
    assert.ok(Math.abs(b.stdev - Math.sqrt(1.25)) < 1e-12, `population stdev of {1,2,3,4} is sqrt(1.25), got ${b.stdev}`);
  });

  it('caps the samples at the window, dropping the oldest', () => {
    let b = emptyBaseline();
    for (let i = 1; i <= 5; i++) b = updateBaseline(b, i, 3);
    assert.deepEqual(b.samples, [3, 4, 5]);
    assert.equal(b.mean, 4);
    assert.ok(Math.abs(b.stdev - Math.sqrt(2 / 3)) < 1e-12, `population stdev of {3,4,5} is sqrt(2/3), got ${b.stdev}`);
  });

  it('defaults the window to the documented default (20)', () => {
    let b = emptyBaseline();
    for (let i = 1; i <= 21; i++) b = updateBaseline(b, i);
    assert.equal(b.samples.length, 20);
    assert.deepEqual(b.samples, Array.from({ length: 20 }, (_, k) => k + 2));
    assert.equal(b.mean, 11.5); // mean of 2..21
  });

  it('yields stdev 0 for fewer than two samples', () => {
    const one = updateBaseline(emptyBaseline(), 7);
    assert.deepEqual(one, { samples: [7], mean: 7, stdev: 0 });
    assert.equal(one.samples.length, 1);
  });

  it('ignores non-finite and negative amounts (fresh, unchanged copy)', () => {
    const frozen = Object.freeze({ samples: Object.freeze([1, 2, 3]), mean: 2, stdev: 1 }) as PriceBaseline;
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01]) {
      const next = updateBaseline(frozen, bad);
      assert.notEqual(next, frozen, 'must return a fresh object, never the argument');
      assert.deepEqual(next.samples, [1, 2, 3]);
      assert.equal(next.mean, 2);
      assert.equal(next.stdev, 1);
    }
  });

  it('never mutates its argument (frozen input would throw on any write in strict mode)', () => {
    const input = { samples: [1, 2, 3], mean: 2, stdev: 1 };
    const frozen = Object.freeze(input) as PriceBaseline;
    const next = updateBaseline(frozen, 4);
    assert.deepEqual([...input.samples], [1, 2, 3], 'the argument must stay untouched');
    assert.deepEqual(next.samples, [1, 2, 3, 4]);
  });
});

describe('evaluatePriceAnomaly', () => {
  it('is inert when disabled (the compat default) — even for absurd amounts', () => {
    const c = cfg({ enabled: false });
    for (const amount of [0.01, 100, 0, Number.NaN]) {
      assert.deepEqual(evaluatePriceAnomaly(c, 'base', 'example.com', amount, { baseline: baselineOf([0.1, 0.2, 0.15, 0.1, 0.1]) }), { band: 'none' });
    }
  });

  it('is inert for the Casper leg (amount 0 by design — conflict A)', () => {
    const c = cfg();
    for (const amount of [0, 100, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(evaluatePriceAnomaly(c, 'casper', 'casper.example', amount, { baseline: Z_BASELINE }), { band: 'none' });
    }
  });

  it('hard-denies a non-positive amount on a USD chain with the non-positive-amount detail', () => {
    const c = cfg();
    for (const amount of [0, -0.01, Number.NaN]) {
      const { band, reason } = evaluatePriceAnomaly(c, 'base', 'example.com', amount, {});
      assert.equal(band, 'deny', `amount ${amount} must be a hard deny`);
      assert.equal(reason!.code, 'PRICE_ANOMALY');
      assert.deepEqual(reason!.detail, { reason: 'non-positive-amount', amount, host: 'example.com' });
      assert.match(reason!.message, /not a positive finite number/);
    }
  });

  it('a missing or empty baseline is the seed band: allow, never annotated', () => {
    const c = cfg();
    assert.deepEqual(evaluatePriceAnomaly(c, 'base', 'example.com', 0.01, {}), { band: 'seed' });
    assert.deepEqual(evaluatePriceAnomaly(c, 'base', 'example.com', 0.01, { baseline: emptyBaseline() }), { band: 'seed' });
  });

  it('below minSamples the multiplier path is used and can only reach the approval band (conflict D)', () => {
    const c = cfg({ minSamples: 5 });
    const thin = baselineOf([0.1, 0.1]); // 2 samples AND stdev 0
    const approval = evaluatePriceAnomaly(c, 'base', 'example.com', 0.3, { baseline: thin });
    assert.equal(approval.band, 'approval');
    assert.equal(approval.reason!.code, 'PRICE_ANOMALY');
    assert.equal(approval.reason!.detail!.band, 'approval');
    assert.ok(Math.abs((approval.reason!.detail!.ratio as number) - 3) < 1e-9, `ratio should be 3, got ${approval.reason!.detail!.ratio}`);
    assert.match(approval.reason!.message, /human confirmation/);
    // A huge spike against a stub baseline is still only APPROVAL_REQUIRED —
    // never a hard deny (statistics are the evidence for a hard deny).
    assert.equal(evaluatePriceAnomaly(c, 'base', 'example.com', 1000, { baseline: thin }).band, 'approval');
    // Within tolerance ⇒ none.
    assert.deepEqual(evaluatePriceAnomaly(c, 'base', 'example.com', 0.15, { baseline: thin }), { band: 'none' });
  });

  it('a zero-variance full baseline also takes the multiplier path (approval-only)', () => {
    const c = cfg();
    const flat: PriceBaseline = { samples: [0.1, 0.1, 0.1, 0.1, 0.1], mean: 0.1, stdev: 0 };
    assert.equal(evaluatePriceAnomaly(c, 'base', 'example.com', 0.21, { baseline: flat }).band, 'approval');
    // Exactly at the tolerance boundary is not over it.
    assert.deepEqual(evaluatePriceAnomaly(c, 'base', 'example.com', 0.2, { baseline: flat }), { band: 'none' });
  });

  it('when the mean is unusable the directory price backs the multiplier path', () => {
    const c = cfg();
    const zeroMean: PriceBaseline = { samples: [0, 0], mean: 0, stdev: 0 };
    const approval = evaluatePriceAnomaly(c, 'base', 'example.com', 1.5, { baseline: zeroMean, directoryPriceUsd: 0.5 });
    assert.equal(approval.band, 'approval');
    assert.ok(Math.abs((approval.reason!.detail!.ratio as number) - 3) < 1e-9);
    assert.match(approval.reason!.message, /reference price/);
    // No usable reference at all (missing or non-positive) ⇒ no annotation.
    assert.deepEqual(evaluatePriceAnomaly(c, 'base', 'example.com', 1.5, { baseline: zeroMean }), { band: 'none' });
    assert.deepEqual(evaluatePriceAnomaly(c, 'base', 'example.com', 1.5, { baseline: zeroMean, directoryPriceUsd: 0 }), { band: 'none' });
    assert.deepEqual(evaluatePriceAnomaly(c, 'base', 'example.com', 1.5, { baseline: zeroMean, directoryPriceUsd: Number.NaN }), { band: 'none' });
  });

  it('z-score bands: below warnZ none, [warnZ, denyZ) approval, >= denyZ deny — with the full detail payload', () => {
    const c = cfg();
    // z = (amount - 0.1)/0.05 → 0.14 → 0.8 (none), 0.2 → 2 (approval), 0.25 → 3 (deny).
    assert.deepEqual(evaluatePriceAnomaly(c, 'base', 'example.com', 0.14, { baseline: Z_BASELINE }), { band: 'none' });

    const approval = evaluatePriceAnomaly(c, 'base', 'example.com', 0.2, { baseline: Z_BASELINE });
    assert.equal(approval.band, 'approval');
    const approvalDetail = approval.reason!.detail!;
    assert.ok(Math.abs((approvalDetail.zScore as number) - 2) < 1e-9, `z should be ~2, got ${approvalDetail.zScore}`);
    assert.equal(approvalDetail.band, 'approval');
    assert.equal(approvalDetail.mean, 0.1);
    assert.equal(approvalDetail.stdev, 0.05);
    assert.equal(approvalDetail.samples, 5);
    assert.equal(approvalDetail.window, 20);
    assert.equal(approvalDetail.amount, 0.2);
    assert.equal(approvalDetail.host, 'example.com');
    assert.equal(approvalDetail.ratio, undefined, 'the z path carries zScore, not the fallback ratio');
    assert.match(approval.reason!.message, /human confirmation/);

    const deny = evaluatePriceAnomaly(c, 'base', 'example.com', 0.3, { baseline: Z_BASELINE }); // z ≈ 4 — well past denyZ 3
    assert.equal(deny.band, 'deny');
    const denyDetail = deny.reason!.detail!;
    assert.ok(Math.abs((denyDetail.zScore as number) - 4) < 1e-9, `z should be ~4, got ${denyDetail.zScore}`);
    assert.equal(denyDetail.band, 'deny');
    assert.equal(denyDetail.samples, 5);
    assert.equal(denyDetail.window, 20);
    assert.equal(denyDetail.host, 'example.com');
    assert.match(deny.reason!.message, /denied/);
  });

  it('threshold boundaries are exact: z == warnZ annotates, z == denyZ hard-denies', () => {
    // Binary-exact arithmetic: (amount − 1)/0.5 → 1.4 = 0.8, 2 = 2, 2.5 = 3, 3.5 = 5.
    const b: PriceBaseline = { samples: [1, 1, 1, 1, 1], mean: 1, stdev: 0.5 };
    const wide = cfg({ warnZ: 2, denyZ: 4 });
    assert.equal(evaluatePriceAnomaly(wide, 'base', 'example.com', 1.4, { baseline: b }).band, 'none'); // 0.8 < 2
    assert.equal(evaluatePriceAnomaly(wide, 'base', 'example.com', 2, { baseline: b }).band, 'approval'); // z == warnZ is inclusive
    assert.equal(evaluatePriceAnomaly(wide, 'base', 'example.com', 2.5, { baseline: b }).band, 'approval'); // 3 < 4
    const tight = cfg({ warnZ: 2, denyZ: 3 });
    assert.equal(evaluatePriceAnomaly(tight, 'base', 'example.com', 2.5, { baseline: b }).band, 'deny'); // z == denyZ is inclusive
  });

  it('DEFAULT_ANOMALY_CONFIG carries the documented compat default (disabled, issue thresholds)', () => {
    assert.deepEqual(DEFAULT_ANOMALY_CONFIG, { enabled: false, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0 });
  });
});