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
import { DEFAULT_POLICY_PROFILE, POLICY_PROFILES, resolvePolicyProfile } from './profile.js';

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