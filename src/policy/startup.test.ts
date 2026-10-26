// Unit tests for the PURE startup-line builder (src/policy/startup.ts):
// profileStartupLines(state) renders the stderr lines the server prints about
// the policy profile, derived from the EFFECTIVE PolicyEngineState instead of
// re-reading env inline (the prior inline block in src/index.ts printed the
// permissive warning whenever the profile resolved permissive — even when a
// POLICY_CONFIG_PATH file had tightened services.unknown — and reported an
// INVALID X402_POLICY_PROFILE as "strict"). Pinned here, TDD-first (RED):
//
//   - the first line is always policy_profile=<profile>, or
//     policy_profile=invalid when the resolver reported an error;
//   - the error line accompanies it, newlines stripped;
//   - the permissive warning exists ONLY when the effective config says
//     unknown services really are payable (configErrors empty AND
//     services.unknown still "allow"); a file-tightened services.unknown
//     announces the tightening instead; a fail-closed state announces nothing.
import { strict as assert } from 'node:assert';
import { afterEach, it } from 'node:test';
import { profileStartupLines } from './startup.js';
import { defaultPolicyConfig } from './config.js';
import type { PolicyEngineState } from './types.js';

const baseEnv = { ...process.env };
afterEach(() => { process.env = { ...baseEnv }; });

const WARNING_LINE =
  'policy_profile=permissive: unknown services are payable up to the global caps — tighten with X402_POLICY_PROFILE=strict or X402_POLICY_PROFILE=standard (a POLICY_CONFIG_PATH file overrides the profile)';
const TIGHTENED_LINE = 'policy_profile=permissive (tightened by policy config)';

function permissiveState(overrides: Partial<PolicyEngineState> = {}): PolicyEngineState {
  return { config: defaultPolicyConfig(), configErrors: [], profile: 'permissive', ...overrides };
}

it('#86: a permissive state with an effective allow on unknown services prints the profile line + the warning', () => {
  assert.deepEqual(profileStartupLines(permissiveState()), ['policy_profile=permissive', WARNING_LINE]);
});

it('#86: a file that tightened services.unknown replaces the blanket warning with the tightened announcement', () => {
  const state = permissiveState();
  state.config.services.unknown = { action: 'deny' };
  assert.deepEqual(profileStartupLines(state), ['policy_profile=permissive', TIGHTENED_LINE]);
});

it('#86: strict and standard print exactly one line — never the permissive warning', () => {
  assert.deepEqual(profileStartupLines({ ...permissiveState(), profile: 'strict' }), ['policy_profile=strict']);
  assert.deepEqual(profileStartupLines({ ...permissiveState(), profile: 'standard' }), ['policy_profile=standard']);
});

it('#86: a fail-closed state (configErrors non-empty) never prints the payable warning — and unknown:deny prints nothing extra', () => {
  const state = permissiveState({ configErrors: ['X402_POLICY_MAX_DAILY=10 is not a finite non-negative number'] });
  assert.deepEqual(profileStartupLines(state), ['policy_profile=permissive']);
});

it('#86: an invalid X402_POLICY_PROFILE reports policy_profile=invalid plus the resolver error, not strict', () => {
  const state = permissiveState({
    profile: 'strict',
    configErrors: ["X402_POLICY_PROFILE='bogus' must be one of strict|standard|permissive"],
    profileError: "X402_POLICY_PROFILE='bogus' must be one of strict|standard|permissive",
  });
  assert.deepEqual(profileStartupLines(state), [
    'policy_profile=invalid',
    "policy_profile_error=X402_POLICY_PROFILE='bogus' must be one of strict|standard|permissive",
  ]);
});

it('#86: the profile error line never carries a newline (log-injection-safe rendering)', () => {
  const state = permissiveState({ profile: 'strict', configErrors: ['boom'], profileError: 'line one\nline two' });
  const lines = profileStartupLines(state);
  assert.equal(lines[0], 'policy_profile=invalid');
  assert.equal(lines[1], 'policy_profile_error=line one line two');
  for (const line of lines) assert.ok(!line.includes('\n'), 'no newline inside a rendered startup line');
});

it('#86: a hand-built state with no profile renders the default profile name without the warning gate tripping', () => {
  assert.deepEqual(profileStartupLines({ config: defaultPolicyConfig(), configErrors: [] }), ['policy_profile=permissive']);
});

it('#86: the profile lines are pure — the same state renders the same lines, and env never leaks in', () => {
  process.env.X402_POLICY_PROFILE = 'strict';
  assert.deepEqual(profileStartupLines(permissiveState()), ['policy_profile=permissive', WARNING_LINE], 'env is never read by the builder');
  assert.deepEqual(profileStartupLines(permissiveState()), ['policy_profile=permissive', WARNING_LINE], 'deterministic: state in, lines out');
});