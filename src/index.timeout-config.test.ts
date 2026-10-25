import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Issue #80 (R1d): an invalid timeout configuration must refuse the STARTUP,
// not a later payment. Pre-#80 the entry point never looked at
// X402_PAID_TIMEOUT_MS / X402_PROBE_TIMEOUT_MS — an unparsable value only
// surfaced per-call, mid-flow, folded into the generic payment failure.
// These tests spawn the BUILT entry (this file compiles next to it:
// dist-test/index.js) with a minimal env (no credentials — validation
// precedes any key handling) and assert a non-zero exit naming the variable.
//
// Hermetic: the spawned process performs no network I/O; the valid-env
// control proves the server STARTED (still running when the harness timeout
// kills it, or a clean exit 0 on stdin EOF — never the exit-1 refusal).
// ---------------------------------------------------------------------------

const entry = fileURLToPath(new URL('./index.js', import.meta.url));

function spawnEntry(extraEnv: Record<string, string>, timeoutMs: number) {
  return spawnSync(process.execPath, [entry], {
    env: { PATH: process.env.PATH ?? '', ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

const INVALID_VALUES = ['abc', '0', '-1', '1.5'];

for (const value of INVALID_VALUES) {
  it(`issue #80 (R1d): X402_PAID_TIMEOUT_MS=${JSON.stringify(value)} refuses startup (exit 1, names the variable)`, { timeout: 20_000 }, () => {
    const r = spawnEntry({ X402_PAID_TIMEOUT_MS: value }, 10_000);
    assert.notEqual((r.error as any)?.code, 'ETIMEDOUT', 'the invalid config must exit fast, not start and hang');
    assert.equal(r.status, 1, `expected exit 1, got status=${r.status} signal=${r.signal} stderr=${r.stderr?.slice(0, 200)}`);
    assert.match(r.stderr, /X402_PAID_TIMEOUT_MS/, 'the refusal names the offending variable');
  });

  it(`issue #80 (R1d): X402_PROBE_TIMEOUT_MS=${JSON.stringify(value)} refuses startup (exit 1, names the variable)`, { timeout: 20_000 }, () => {
    const r = spawnEntry({ X402_PROBE_TIMEOUT_MS: value }, 10_000);
    assert.notEqual((r.error as any)?.code, 'ETIMEDOUT', 'the invalid config must exit fast, not start and hang');
    assert.equal(r.status, 1, `expected exit 1, got status=${r.status} signal=${r.signal} stderr=${r.stderr?.slice(0, 200)}`);
    assert.match(r.stderr, /X402_PROBE_TIMEOUT_MS/, 'the refusal names the offending variable');
  });
}

it('issue #80 (R1d): valid values (and the variables unset) start the server instead of refusing — clean start (still running at kill) or a clean exit 0 on stdin EOF, never the exit-1 refusal', { timeout: 20_000 }, () => {
  for (const extraEnv of [{}, { X402_PAID_TIMEOUT_MS: '45000', X402_PROBE_TIMEOUT_MS: '5000' }] as const) {
    const r = spawnEntry({ ...extraEnv }, 2_500);
    const stillRunning = (r.error as any)?.code === 'ETIMEDOUT';
    assert.ok(
      stillRunning || r.status === 0,
      `with env ${JSON.stringify(extraEnv)} the server must START (still running, or exit 0 on stdin EOF) — got status=${r.status} error=${String(r.error)} stderr=${r.stderr?.slice(0, 200)}`,
    );
    assert.ok(!stillRunning || !/X402_(PAID|PROBE)_TIMEOUT_MS must be/.test(r.stderr), 'a valid config never triggers the refusal message');
  }
});
