// Issue #66 stage A — the X402_POLICY_PROFILE parser contract, pinned BEFORE
// the feature lands (TDD): unset/empty resolves to the permissive default;
// the three shipped values resolve EXACTLY (lowercase, no error); anything
// else is an ERROR (fail-closed) whose returned profile is never "permissive"
// — a bad value must fail closed in loadPolicyConfig (CONFIG_INVALID,
// payments disabled), never silently degrade to today's permissive behavior.
// Stage boundary: the DEFAULT stays permissive this release (flipping it is
// the later B/C rollout, never this stage).
//
// resolvePolicyProfile() reads X402_POLICY_PROFILE from env when called
// without an argument, so tests pin both the argument and the env-driven
// path (repo env-isolation pattern: snapshot at module load, restore in
// afterEach).
import { strict as assert } from 'node:assert';
import { afterEach, it } from 'node:test';
import { DEFAULT_POLICY_PROFILE, POLICY_PROFILES, applyProfileDefaults, capTrustForProfile, resolvePolicyProfile } from './profile.js';
import { defaultPolicyConfig } from './config.js';
import type { PolicyConfig } from './types.js';

const baseEnv = { ...process.env };
afterEach(() => { process.env = { ...baseEnv }; });

it('the profile vocabulary is exactly strict | standard | permissive, with permissive pinned as the stage-A default', () => {
  assert.deepEqual([...POLICY_PROFILES], ['strict', 'standard', 'permissive']);
  assert.equal(DEFAULT_POLICY_PROFILE, 'permissive');
});

it('unset / empty / whitespace-only resolve to the permissive default with no error', () => {
  delete process.env.X402_POLICY_PROFILE;
  assert.deepEqual(resolvePolicyProfile(), { profile: 'permissive' });
  assert.deepEqual(resolvePolicyProfile(undefined), { profile: 'permissive' });
  assert.deepEqual(resolvePolicyProfile(''), { profile: 'permissive' });
  assert.deepEqual(resolvePolicyProfile('   '), { profile: 'permissive' });
});

it('the env variable feeds the argumentless call at resolve time', () => {
  for (const p of ['strict', 'standard', 'permissive']) {
    process.env.X402_POLICY_PROFILE = p;
    assert.deepEqual(resolvePolicyProfile(), { profile: p });
  }
});

it('each shipped value resolves exactly, lowercase, with no error', () => {
  for (const p of ['strict', 'standard', 'permissive']) {
    assert.deepEqual(resolvePolicyProfile(p), { profile: p });
  }
});

it('matching is exact: case variants and surrounding whitespace do not resolve', () => {
  for (const bad of ['STRICT', 'Strict', 'PERMISSIVE', ' strict', 'strict ', 'standard\n']) {
    const r = resolvePolicyProfile(bad);
    assert.ok(r.error, `'${bad}' must not resolve`);
    assert.notEqual(r.profile, 'permissive', `'${bad}' must never silently degrade to permissive`);
  }
});

it('a bad value yields a non-empty error naming the variable and the raw value, and never the permissive profile', () => {
  const r = resolvePolicyProfile('bogus');
  assert.ok(typeof r.error === 'string' && r.error.length > 0, 'a bad value must carry an error');
  assert.ok(r.error.includes('X402_POLICY_PROFILE'), 'the error must name the variable');
  assert.ok(r.error.includes('bogus'), 'the error must echo the raw value');
  assert.notEqual(r.profile, 'permissive', 'no code path may read permissive off a bad value');
});
// ---------------------------------------------------------------------------
// Issue #66 stage A — requirement 6 (commit 4): capTrustForProfile — the
// pure derivation cap. Direct unit pins of the pure contract; the
// buildPolicyContext wiring is pinned behaviorally in config.test.ts.
// ---------------------------------------------------------------------------

it('#66: capTrustForProfile demotes a directory row to UNKNOWN only in strict/standard, and never demotes explicit entries', () => {
  // permissive: byte-identical passthrough in every respect
  assert.equal(capTrustForProfile('DISCOVERED', 'host.example', 'permissive', () => false), 'DISCOVERED');
  // strict/standard: a directory row (discovered via the directory) raises no trust
  assert.equal(capTrustForProfile('DISCOVERED', 'host.example', 'strict', () => false), 'UNKNOWN');
  assert.equal(capTrustForProfile('DISCOVERED', 'host.example', 'standard', () => false), 'UNKNOWN');
  // explicit policy entries keep their level — the operator's own lists win
  assert.equal(capTrustForProfile('DISCOVERED', 'host.example', 'strict', () => true), 'DISCOVERED', 'an explicitly trusted host is the exception');
  assert.equal(capTrustForProfile('TRUSTED', 'host.example', 'strict', () => false), 'TRUSTED');
  assert.equal(capTrustForProfile('BLOCKED', 'host.example', 'strict', () => false), 'BLOCKED');
  // levels a derivation can carry besides DISCOVERED are untouched
  assert.equal(capTrustForProfile('UNKNOWN', 'host.example', 'standard', () => false), 'UNKNOWN');
  assert.equal(capTrustForProfile('VERIFIED', 'host.example', 'strict', () => false), 'VERIFIED');
});

// ---------------------------------------------------------------------------
// Post-merge review of the shipped profiles — the per-host cap the tightening
// profiles declare must actually apply. The gap: the overlays wrote a
// per-request cap ONLY on services.discovered, but capTrustForProfile demotes
// every non-allowlisted directory host to UNKNOWN — so in strict the only
// payable level (TRUSTED, no cap in the defaults) rode the global caps, and
// standard had no per-host cap at all. Pinned here (RED first): BOTH
// tightening profiles carry a per-host line on TRUSTED/VERIFIED — maxPerRequest
// 0.05 (the same low line strict already writes on services.discovered) and
// maxDaily 1.0 (one order of magnitude below the $10 legacy global) — every
// value Math.min()-ed against whatever is already configured, never raised.
// Standard additionally flips the recipient gate to allowlist so it is
// "otherwise like strict" — the first payment to a new recipient is refused.
// ---------------------------------------------------------------------------

/** A pinned compat default: the legacy 0.5 / 10.0 line regardless of the
 * operator env this suite may run under (applyProfileDefaults reads nothing
 * from env itself — hermetic by construction). */
function pinnedCompatConfig(): PolicyConfig {
  return defaultPolicyConfig();
}

function strictConfig(): PolicyConfig {
  const cfg = pinnedCompatConfig();
  cfg.payments = { enabled: true, maxPerRequest: 0.5, maxDaily: 10.0 };
  return cfg;
}

it('#86: strict caps the one level that can pay (TRUSTED) per host — 0.05 per request, 1.00 per host daily', () => {
  const cfg = strictConfig();
  applyProfileDefaults(cfg, 'strict');
  assert.deepEqual(cfg.services.trusted, { action: 'allow', maxPerRequest: 0.05, maxDaily: 1.0 });
});

it('#86: strict caps services.verified with the same per-host line (the level the type system allows)', () => {
  const cfg = strictConfig();
  applyProfileDefaults(cfg, 'strict');
  assert.deepEqual(cfg.services.verified, { action: 'allow', maxPerRequest: 0.05, maxDaily: 1.0 });
});

it('#86: standard carries the same per-host caps as strict (trusted + verified)', () => {
  const cfg = strictConfig();
  applyProfileDefaults(cfg, 'standard');
  assert.deepEqual(cfg.services.trusted, { action: 'allow', maxPerRequest: 0.05, maxDaily: 1.0 });
  assert.deepEqual(cfg.services.verified, { action: 'allow', maxPerRequest: 0.05, maxDaily: 1.0 });
});

it('#86: standard flips the recipient gate to allowlist — otherwise like strict', () => {
  const cfg = strictConfig();
  applyProfileDefaults(cfg, 'standard');
  assert.equal(cfg.recipients.mode, 'allowlist', 'the first payment to a new recipient must be refused in standard too');
  const strict = strictConfig();
  applyProfileDefaults(strict, 'strict');
  assert.equal(strict.recipients.mode, 'allowlist');
});

it('#86: the per-host caps never raise a preset level cap — min() against the existing value (non-widening)', () => {
  const cfg = strictConfig();
  cfg.services.trusted = { action: 'allow', maxPerRequest: 5, maxDaily: 20 };
  applyProfileDefaults(cfg, 'strict');
  assert.equal(cfg.services.trusted.maxPerRequest, 0.05);
  assert.equal(cfg.services.trusted.maxDaily, 1.0);
});

it('#86: a preset below the host line survives untouched, and a missing preset falls back through the global line', () => {
  const cfg = strictConfig();
  cfg.payments = { enabled: true, maxPerRequest: 0.01, maxDaily: 10.0 };
  cfg.services.verified = { action: 'allow', maxPerRequest: 0.02, maxDaily: 0.5 };
  applyProfileDefaults(cfg, 'standard');
  assert.equal(cfg.services.verified.maxPerRequest, 0.02, 'a preset below the line is min()-ed, never raised');
  assert.equal(cfg.services.verified.maxDaily, 0.5);
  assert.equal(cfg.services.trusted.maxPerRequest, 0.01, 'no preset → fallback is the global per-request cap, then the host line');
  assert.equal(cfg.services.trusted.maxDaily, 1.0, 'no preset → fallback is the legacy default daily, then the host line');
});
