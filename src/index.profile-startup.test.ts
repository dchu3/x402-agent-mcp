import { strict as assert } from 'node:assert';
import { after, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Issue #66 (D4): the policy profile is visible in the SERVER STARTUP LINE —
// the first stderr line an operator greps. The pure builder itself is pinned
// in src/policy/startup.test.ts (profileStartupLines over a state); this file
// spawns the BUILT entry (same pattern as index.timeout-config.test.ts) and
// pins the LINES the real server prints:
//   - unset profile  → `policy_profile=permissive` + the permissive warning
//     (the honest default announcement).
//   - an invalid profile → `policy_profile=invalid` + a
//     `policy_profile_error=X402_POLICY_PROFILE=...` line, and the server
//     still STARTS: a bad profile disables payments fail-closed, it never
//     takes the whole agent down.
//
// Hermetic: no credentials, no network; the spawn env points the ledger and
// state dir at a temp path so the server writes nothing into the repo.
// ---------------------------------------------------------------------------

const entry = fileURLToPath(new URL('./index.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'x402-profile-startup-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const BASE_SPAWN_ENV: Record<string, string> = {
  PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'),
  X402_STATE_DIR: join(dir, 'state'),
  X402_DIRECTORY_PATH: join(dir, 'endpoints.json'),
};

function spawnEntry(extraEnv: Record<string, string>, timeoutMs = 9_000) {
  return spawnSync(process.execPath, [entry], {
    env: { PATH: process.env.PATH ?? '', ...BASE_SPAWN_ENV, ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

it('D4: with the profile unset the startup line reports policy_profile=permissive (and the server starts)', { timeout: 20_000 }, () => {
  const r = spawnEntry({});
  const stillRunning = (r.error as any)?.code === 'ETIMEDOUT';
  const ok = stillRunning || r.status === 0;
  assert.ok(ok, `the server must START with an unset profile — got status=${r.status} signal=${r.signal} stderr=${r.stderr?.slice(0, 200)}`);
  const stderr = String(r.stderr ?? '');
  assert.match(stderr, /policy_profile=permissive/, `the startup stderr must announce the effective profile; got: ${stderr.slice(0, 400)}`);
  assert.match(stderr, /policy_profile=permissive: unknown services are payable/, 'the permissive warning wording is unchanged');
});

it('D4: an invalid profile is announced as policy_profile=invalid with an operator-echoing error line, and the server still starts (payments fail closed, the agent stays up)', { timeout: 20_000 }, () => {
  const r = spawnEntry({ X402_POLICY_PROFILE: 'bogus' });
  const stillRunning = (r.error as any)?.code === 'ETIMEDOUT';
  const ok = stillRunning || r.status === 0;
  assert.ok(ok, `a bad profile must not refuse startup — got status=${r.status} signal=${r.signal} stderr=${r.stderr?.slice(0, 200)}`);
  const stderr = String(r.stderr ?? '');
  assert.match(stderr, /policy_profile=invalid/, `the invalid profile must be announced as invalid; got: ${stderr.slice(0, 400)}`);
  assert.match(stderr, /policy_profile_error=X402_POLICY_PROFILE=/, 'the error line must name the variable');
  assert.match(stderr, /'bogus'/, 'the error line must echo the raw operator value');
});