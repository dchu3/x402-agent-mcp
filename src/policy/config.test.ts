import { strict as assert } from 'node:assert';
import { afterEach, after, it } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicyConfig, getPolicyEngine, resolveTrustLevel, DEFAULT_POLICY_CONFIG } from './config.js';
import type { PolicyConfig } from './types.js';
import { clearDirectoryCache } from '../directory.js';

// config.ts reads env at loadPolicyConfig() call time, so tests mutate
// process.env directly and restore in afterEach (repo env-isolation pattern).
const baseEnv = { ...process.env };
const dirs: string[] = [];
afterEach(() => { process.env = { ...baseEnv }; clearDirectoryCache(); });
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'x402-policy-config-'));
  dirs.push(dir);
  return dir;
}

function configFile(name: string, content: string): string {
  const p = join(tempDir(), name);
  writeFileSync(p, content, 'utf8');
  return p;
}

function validFileJson(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    services: {
      unknown: { action: 'allow' },
      discovered: { action: 'allow' },
      verified: { action: 'allow' },
      trusted: { action: 'allow' },
      blocked: { action: 'deny' },
    },
    networks: { allowed: ['base', 'solana', 'casper'] },
    tokens: { allowed: ['USDC', 'wCSPR'] },
  };
  return JSON.stringify({ ...base, ...overrides });
}

function codesOf(engine: ReturnType<typeof getPolicyEngine>, ctx: Parameters<typeof engine.evaluate>[0]): string[] {
  return engine.evaluate(ctx).reasons.map((r) => r.code);
}

const discoveredCtx = { service: 'svc.example', chain: 'base', token: 'USDC', amount: 0.1, trustLevel: 'DISCOVERED' as const };

it('no POLICY_CONFIG_PATH loads the behavior-compat default policy', () => {
  const state = loadPolicyConfig();
  assert.deepEqual(state.configErrors, []);
  assert.equal(state.config.payments.enabled, true);
  assert.equal(state.config.payments.maxPerRequest, 0.5);
  assert.equal(state.config.payments.maxDaily, 10);
  assert.deepEqual(state.config.networks.allowed, ['base', 'solana', 'casper']);
  assert.deepEqual(state.config.tokens.allowed, ['USDC', 'wCSPR']);
  // Compat decision (operator-ratified, documented in README): the default
  // policy reproduces today's behavior exactly — every directory service is
  // payable at the global caps, and non-directory hosts are governed by
  // services.unknown which defaults to allow (today they are payable too).
  assert.equal(state.config.services.unknown.action, 'allow');
  assert.equal(state.config.services.discovered.action, 'allow');
  assert.equal(state.config.services.verified.action, 'allow');
  assert.equal(state.config.services.trusted.action, 'allow');
  assert.equal(state.config.services.blocked.action, 'deny');
});

it('the default policy honours today\'s MAX_PAYMENT_PER_CALL / MAX_DAILY_SPEND env values', () => {
  process.env.MAX_PAYMENT_PER_CALL = '2.00';
  process.env.MAX_DAILY_SPEND = '25.00';
  const state = loadPolicyConfig();
  assert.equal(state.config.payments.maxPerRequest, 2.0);
  assert.equal(state.config.payments.maxDaily, 25.0);
});

it('a valid config file overrides the defaults', () => {
  process.env.POLICY_CONFIG_PATH = configFile('policy.json', validFileJson({
    payments: { enabled: true, maxPerRequest: 0.25, maxDaily: 5 },
    networks: { allowed: ['base'] },
    services: { unknown: { action: 'deny' } },
  }));
  const state = loadPolicyConfig();
  assert.deepEqual(state.configErrors, []);
  assert.equal(state.config.payments.maxPerRequest, 0.25);
  assert.equal(state.config.payments.maxDaily, 5);
  assert.deepEqual(state.config.networks.allowed, ['base']);
  assert.equal(state.config.services.unknown.action, 'deny');
  // Sections not present in the file keep their defaults.
  assert.equal(state.config.services.discovered.action, 'allow');
  assert.deepEqual(state.config.tokens.allowed, ['USDC', 'wCSPR']);
});

it('malformed JSON fails closed: evaluate returns DENY with CONFIG_INVALID + PAYMENTS_DISABLED', () => {
  process.env.POLICY_CONFIG_PATH = configFile('broken.json', '{not valid json');
  const engine = getPolicyEngine();
  const result = engine.evaluate(discoveredCtx);
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(result.reasons.map((r) => r.code), ['CONFIG_INVALID', 'PAYMENTS_DISABLED']);
});

it('wrong types fail closed (string where number required, bogus action, array where object required)', () => {
  for (const bad of [
    validFileJson({ payments: { enabled: true, maxPerRequest: '0.50', maxDaily: 10 } }),
    validFileJson({ payments: { enabled: 'true', maxPerRequest: 0.5, maxDaily: 10 } }),
    validFileJson({ services: { discovered: { action: 'maybe' } } }),
    validFileJson({ networks: { allowed: 'base' } }),
    validFileJson({ tokens: { allowed: [42] } }),
  ]) {
    process.env.POLICY_CONFIG_PATH = configFile('badtype.json', bad);
    const result = getPolicyEngine().evaluate(discoveredCtx);
    assert.equal(result.decision, 'DENY', `config ${bad} must fail closed`);
    assert.ok(result.reasons.some((r) => r.code === 'CONFIG_INVALID'), `config ${bad} must report CONFIG_INVALID`);
    assert.ok(result.reasons.some((r) => r.code === 'PAYMENTS_DISABLED'), `config ${bad} must report PAYMENTS_DISABLED`);
  }
});

it('missing critical payments fields fail closed', () => {
  for (const bad of [
    validFileJson({ payments: undefined }),
    validFileJson({ payments: { enabled: true, maxPerRequest: 0.5 } }), // maxDaily missing
    validFileJson({ payments: { enabled: true, maxDaily: 10 } }),       // maxPerRequest missing
  ]) {
    process.env.POLICY_CONFIG_PATH = configFile('missing.json', bad);
    const result = getPolicyEngine().evaluate(discoveredCtx);
    assert.equal(result.decision, 'DENY', `config ${bad} must fail closed`);
  }
});

it('unknown keys in the config file fail closed (typo protection)', () => {
  process.env.POLICY_CONFIG_PATH = configFile('typo.json', validFileJson({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10, maxPerRequst: 9 },
  }));
  const result = getPolicyEngine().evaluate(discoveredCtx);
  assert.equal(result.decision, 'DENY');
  assert.ok(result.reasons.some((r) => r.code === 'CONFIG_INVALID'));
});

it('negative or non-finite caps fail closed', () => {
  for (const bad of [
    validFileJson({ payments: { enabled: true, maxPerRequest: -0.5, maxDaily: 10 } }),
    validFileJson({ payments: { enabled: true, maxPerRequest: 0.5, maxDaily: Number.NaN } }),
  ]) {
    process.env.POLICY_CONFIG_PATH = configFile('negative.json', bad);
    const result = getPolicyEngine().evaluate(discoveredCtx);
    assert.equal(result.decision, 'DENY');
  }
});

it('a missing config file at POLICY_CONFIG_PATH loads the default policy (ratified behavior)', () => {
  process.env.POLICY_CONFIG_PATH = join(tempDir(), 'does-not-exist.json');
  const state = loadPolicyConfig();
  assert.deepEqual(state.configErrors, []);
  assert.equal(state.config.payments.enabled, true);
  assert.equal(state.config.payments.maxPerRequest, 0.5);
});

// ---------------------------------------------------------------------------
// Post-#23 follow-up: the loader used to swallow EVERY read error as if the
// file were merely missing — a file that EXISTS but is UNREADABLE (revoked
// permissions, a directory path, …) then silently ran the DEFAULT policy,
// discarding the operator's tightened rules and failing open. Missing file
// (ENOENT) stays ratified default-policy behavior; every OTHER read error
// fails closed with CONFIG_INVALID + PAYMENTS_DISABLED.
// ---------------------------------------------------------------------------

it('a config file that exists but is unreadable (EACCES) fails closed — never silently permissive', (t) => {
  const p = configFile('unreadable.json', validFileJson());
  chmodSync(p, 0o000);
  try {
    readFileSync(p); // root (or CAP_DAC_OVERRIDE) can still read chmod-000 files
    t.skip('chmod-000 is still readable to this process (e.g. running as root) — cannot simulate EACCES here');
  } catch {
    // unreadable exactly as intended — proceed
  }
  process.env.POLICY_CONFIG_PATH = p;
  const engine = getPolicyEngine();
  const result = engine.evaluate(discoveredCtx);
  assert.equal(result.decision, 'DENY', 'an unreadable config must never fall back to the (permissive) default policy');
  assert.deepEqual(result.reasons.map((r) => r.code), ['CONFIG_INVALID', 'PAYMENTS_DISABLED']);
  assert.ok(
    result.reasons.some((r) => r.code === 'CONFIG_INVALID' && r.message.includes('EACCES')),
    'the CONFIG_INVALID reason must carry the underlying read error',
  );
});

it('a config path pointing at a directory (EISDIR) fails closed like any other non-missing read error', () => {
  process.env.POLICY_CONFIG_PATH = tempDir(); // a directory — readFileSync throws EISDIR, not ENOENT
  const engine = getPolicyEngine();
  const result = engine.evaluate(discoveredCtx);
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(result.reasons.map((r) => r.code), ['CONFIG_INVALID', 'PAYMENTS_DISABLED']);
  assert.ok(
    result.reasons.some((r) => r.code === 'CONFIG_INVALID' && r.message.includes('EISDIR')),
    'the CONFIG_INVALID reason must carry the underlying read error',
  );
});

it('X402_POLICY_* env overrides take precedence over the config file', () => {
  process.env.POLICY_CONFIG_PATH = configFile('policy.json', validFileJson({
    payments: { enabled: true, maxPerRequest: 0.25, maxDaily: 5 },
  }));
  process.env.X402_POLICY_MAX_PER_REQUEST = '0.75';
  process.env.X402_POLICY_PAYMENTS_ENABLED = 'false';
  const state = loadPolicyConfig();
  assert.deepEqual(state.configErrors, []);
  assert.equal(state.config.payments.maxPerRequest, 0.75);
  assert.equal(state.config.payments.enabled, false);
  // Untouched fields still come from the file.
  assert.equal(state.config.payments.maxDaily, 5);
});

it('X402_POLICY_NETWORKS / X402_POLICY_TOKENS override allowlists', () => {
  process.env.X402_POLICY_NETWORKS = 'base, solana';
  process.env.X402_POLICY_TOKENS = 'USDC';
  const state = loadPolicyConfig();
  assert.deepEqual(state.config.networks.allowed, ['base', 'solana']);
  assert.deepEqual(state.config.tokens.allowed, ['USDC']);
  const engine = getPolicyEngine();
  assert.ok(codesOf(engine, { ...discoveredCtx, chain: 'casper', token: 'wCSPR' }).includes('CHAIN_NOT_ALLOWED'));
  assert.ok(codesOf(engine, { ...discoveredCtx, chain: 'base', token: 'wCSPR' }).includes('TOKEN_NOT_ALLOWED'));
});

it('X402_POLICY_SERVICE_* overrides actions and per-level caps', () => {
  process.env.X402_POLICY_SERVICE_DISCOVERED = 'deny';
  process.env.X402_POLICY_SERVICE_TRUSTED = 'approval';
  process.env.X402_POLICY_SERVICE_TRUSTED_MAX_PER_REQUEST = '5';
  process.env.X402_POLICY_SERVICE_DISCOVERED_MAX_DAILY = '1.5';
  const state = loadPolicyConfig();
  assert.equal(state.config.services.discovered.action, 'deny');
  assert.equal(state.config.services.trusted.action, 'approval');
  assert.equal(state.config.services.trusted.maxPerRequest, 5);
  assert.equal(state.config.services.discovered.maxDaily, 1.5);
  const engine = getPolicyEngine();
  assert.deepEqual(codesOf(engine, discoveredCtx), ['SERVICE_BLOCKED']);
  const approval = engine.evaluate({ ...discoveredCtx, trustLevel: 'TRUSTED' });
  assert.equal(approval.decision, 'APPROVAL_REQUIRED');
});

it('an invalid env override value fails closed (never silently permissive)', () => {
  process.env.X402_POLICY_PAYMENTS_ENABLED = 'yes';
  const result = getPolicyEngine().evaluate(discoveredCtx);
  assert.equal(result.decision, 'DENY');
  assert.ok(result.reasons.some((r) => r.code === 'CONFIG_INVALID'));
  delete process.env.X402_POLICY_PAYMENTS_ENABLED;
  process.env.X402_POLICY_MAX_PER_REQUEST = 'lots';
  const result2 = getPolicyEngine().evaluate(discoveredCtx);
  assert.equal(result2.decision, 'DENY');
});

it('an unparseable legacy MAX_PAYMENT_PER_CALL fails closed instead of bypassing caps', () => {
  process.env.MAX_PAYMENT_PER_CALL = 'abc';
  const result = getPolicyEngine().evaluate(discoveredCtx);
  assert.equal(result.decision, 'DENY');
  assert.ok(result.reasons.some((r) => r.code === 'CONFIG_INVALID'));
});

it('resolveTrustLevel: BLOCKED env outranks TRUSTED env outranks directory, else UNKNOWN', () => {
  const dir = tempDir();
  process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
  writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({
    endpoints: [
      { name: 'Known', description: '', base_url: 'https://directory.example', chain: 'base', category: 'ai', tags: [], endpoints: [] },
      { name: 'KnownTrusted', description: '', base_url: 'https://dir-trusted.example', chain: 'base', category: 'ai', tags: [], endpoints: [] },
    ],
    categories: [], last_updated: '2026-09-21',
  }), 'utf8');
  clearDirectoryCache();
  process.env.POLICY_BLOCKED_HOSTS = 'blocked.example, Dir-Blocked.example';
  process.env.POLICY_TRUSTED_HOSTS = 'trusted.example, dir-trusted.example';
  assert.equal(resolveTrustLevel('blocked.example'), 'BLOCKED', 'blocklist wins over everything');
  assert.equal(resolveTrustLevel('dir-blocked.example'), 'BLOCKED', 'blocklist wins over directory membership');
  assert.equal(resolveTrustLevel('trusted.example'), 'TRUSTED', 'user-managed allowlist applies outside the directory');
  assert.equal(resolveTrustLevel('dir-trusted.example'), 'TRUSTED', 'user-managed allowlist outranks directory membership');
  process.env.POLICY_BLOCKED_HOSTS = '';
  process.env.POLICY_TRUSTED_HOSTS = '';
  assert.equal(resolveTrustLevel('directory.example'), 'DISCOVERED', 'a directory entry is DISCOVERED');
  assert.equal(resolveTrustLevel('stranger.example'), 'UNKNOWN', 'not in directory → UNKNOWN');
  assert.equal(resolveTrustLevel(''), 'UNKNOWN', 'unparseable host → UNKNOWN (fail-closed derivation)');
});

// ---------------------------------------------------------------------------
// Issue #26 — the top-level `recipients` block (recipient allowlisting +
// change detection). Strict validation in the same style as networks/tokens;
// unknown keys inside the block are errors (typo protection). The COMPAT
// DEFAULT (no recipients key, or the block absent in the file) is
// change-detect with no baselines — inactive by construction, so today's
// decisions are unchanged (rule 4.5 lives in engine.ts).
// ---------------------------------------------------------------------------

const VALID_RECIPIENTS = {
  mode: 'allowlist',
  allowed: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  perService: { 'svc.example': ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] },
  known: { 'svc.example': '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
};

it('a file with a valid recipients block loads clean and replaces the default block', () => {
  process.env.POLICY_CONFIG_PATH = configFile('recipients-valid.json', validFileJson({ recipients: VALID_RECIPIENTS }));
  const state = loadPolicyConfig();
  assert.deepEqual(state.configErrors, []);
  assert.deepEqual(state.config.recipients, {
    mode: 'allowlist',
    allowed: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    perService: { 'svc.example': ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] },
    known: { 'svc.example': '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  });
});

it('a partial recipients block merges over the defaults field-by-field (fresh copies, never aliased)', () => {
  process.env.POLICY_CONFIG_PATH = configFile('recipients-partial.json', validFileJson({
    recipients: { mode: 'allowlist', allowed: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] },
  }));
  const state = loadPolicyConfig();
  assert.deepEqual(state.configErrors, []);
  assert.equal(state.config.recipients.mode, 'allowlist');
  assert.deepEqual(state.config.recipients.allowed, ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  // Fields not present in the file keep their defaults.
  assert.deepEqual(state.config.recipients.perService, {});
  assert.deepEqual(state.config.recipients.known, {});
});

it('an invalid recipients mode fails closed (CONFIG_INVALID)', () => {
  process.env.POLICY_CONFIG_PATH = configFile('recipients-mode.json', validFileJson({ recipients: { ...VALID_RECIPIENTS, mode: 'deny' } }));
  const result = getPolicyEngine().evaluate(discoveredCtx);
  assert.equal(result.decision, 'DENY');
  assert.ok(result.reasons.some((r) => r.code === 'CONFIG_INVALID'));
});

it('a malformed recipients allowed list fails closed (CONFIG_INVALID)', () => {
  for (const bad of [
    { ...VALID_RECIPIENTS, allowed: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, // non-array
    { ...VALID_RECIPIENTS, allowed: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ''] }, // empty-string entry
    { ...VALID_RECIPIENTS, allowed: [42] }, // non-string entry
  ]) {
    process.env.POLICY_CONFIG_PATH = configFile('recipients-allowed.json', validFileJson({ recipients: bad }));
    const result = getPolicyEngine().evaluate(discoveredCtx);
    assert.equal(result.decision, 'DENY', `recipients block ${JSON.stringify(bad)} must fail closed`);
    assert.ok(result.reasons.some((r) => r.code === 'CONFIG_INVALID'));
  }
});

it('malformed perService / known maps fail closed (CONFIG_INVALID)', () => {
  for (const bad of [
    { ...VALID_RECIPIENTS, perService: 'svc.example' }, // not an object
    { ...VALID_RECIPIENTS, perService: { 'svc.example': '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }, // value not an array
    { ...VALID_RECIPIENTS, perService: { 'svc.example': [''] } }, // empty-string entry
    { ...VALID_RECIPIENTS, known: ['svc.example'] }, // not an object
    { ...VALID_RECIPIENTS, known: { 'svc.example': 42 } }, // value not a non-empty string
    { ...VALID_RECIPIENTS, known: { 'svc.example': '' } }, // empty-string baseline
  ]) {
    process.env.POLICY_CONFIG_PATH = configFile('recipients-maps.json', validFileJson({ recipients: bad }));
    const result = getPolicyEngine().evaluate(discoveredCtx);
    assert.equal(result.decision, 'DENY', `recipients block ${JSON.stringify(bad)} must fail closed`);
    assert.ok(result.reasons.some((r) => r.code === 'CONFIG_INVALID'));
  }
});

it('an unknown key inside the recipients block fails closed (typo protection)', () => {
  process.env.POLICY_CONFIG_PATH = configFile('recipients-typo.json', validFileJson({
    recipients: { ...VALID_RECIPIENTS, allow: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] },
  }));
  const result = getPolicyEngine().evaluate(discoveredCtx);
  assert.equal(result.decision, 'DENY');
  assert.ok(result.reasons.some((r) => r.code === 'CONFIG_INVALID' && r.message.includes('allow')));
});

it('a file WITHOUT a recipients block keeps the behavior-compat default (change-detect, empty maps — inactive)', () => {
  process.env.POLICY_CONFIG_PATH = configFile('no-recipients.json', validFileJson());
  const state = loadPolicyConfig();
  assert.deepEqual(state.configErrors, []);
  assert.deepEqual(state.config.recipients, { mode: 'change-detect', allowed: [], perService: {}, known: {} });
});

it('loading a recipients-bearing file never mutates DEFAULT_POLICY_CONFIG', () => {
  const snapshot = JSON.stringify(DEFAULT_POLICY_CONFIG);
  process.env.POLICY_CONFIG_PATH = configFile('recipients-snapshot.json', validFileJson({ recipients: VALID_RECIPIENTS }));
  loadPolicyConfig();
  assert.equal(JSON.stringify(DEFAULT_POLICY_CONFIG), snapshot, 'loadPolicyConfig must never mutate the default template (recipients included)');
});

// ---------------------------------------------------------------------------
// Issue #30 — the top-level `anomaly` block (price anomaly detection, rule
// 4.6). Strict validation in the same style as every other block; unknown
// keys inside the block are errors (typo protection). The COMPAT DEFAULT is
// `enabled: false` (conflict B): an always-on price gate could hard-deny a
// previously allowed payment, so enabling it is an operator opt-in. There is
// deliberately NO X402_POLICY_* env override (the recipients precedent).
// ---------------------------------------------------------------------------

const DEFAULT_ANOMALY = { enabled: false, window: 20, warnZ: 2.0, denyZ: 3.0, minSamples: 5, seedFromDirectory: true, defaultTolerance: 2.0 };
const VALID_ANOMALY = { enabled: true, window: 30, warnZ: 1.5, denyZ: 4, minSamples: 3, seedFromDirectory: false, defaultTolerance: 1.5 };

it('DEFAULT_POLICY_CONFIG.anomaly is the documented compat default: disabled, with the issue thresholds', () => {
  assert.deepEqual(DEFAULT_POLICY_CONFIG.anomaly, DEFAULT_ANOMALY);
  assert.equal(DEFAULT_POLICY_CONFIG.anomaly.enabled, false, 'the anomaly gate must ship disabled (operator opt-in, conflict B)');
});

it('no POLICY_CONFIG_PATH loads the anomaly compat default (enabled false)', () => {
  const state = loadPolicyConfig();
  assert.deepEqual(state.configErrors, []);
  assert.deepEqual(state.config.anomaly, DEFAULT_ANOMALY);
});

it('a file with a valid anomaly block loads clean and replaces the default block', () => {
  process.env.POLICY_CONFIG_PATH = configFile('anomaly-valid.json', validFileJson({ anomaly: VALID_ANOMALY }));
  const state = loadPolicyConfig();
  assert.deepEqual(state.configErrors, []);
  assert.deepEqual(state.config.anomaly, VALID_ANOMALY);
});

it('a partial anomaly block merges over the defaults field-by-field (fresh values, never aliased)', () => {
  process.env.POLICY_CONFIG_PATH = configFile('anomaly-partial.json', validFileJson({ anomaly: { enabled: true, warnZ: 1.0 } }));
  const state = loadPolicyConfig();
  assert.deepEqual(state.configErrors, []);
  // Fields present in the file override; warnZ 1 < denyZ 3 keeps the merged ordering valid.
  assert.deepEqual(state.config.anomaly, { ...DEFAULT_ANOMALY, enabled: true, warnZ: 1 });
  // The default template is untouched.
  assert.deepEqual(DEFAULT_POLICY_CONFIG.anomaly, DEFAULT_ANOMALY);
});

it('a file WITHOUT an anomaly block keeps the behavior-compat default (disabled)', () => {
  process.env.POLICY_CONFIG_PATH = configFile('no-anomaly.json', validFileJson());
  const state = loadPolicyConfig();
  assert.deepEqual(state.configErrors, []);
  assert.deepEqual(state.config.anomaly, DEFAULT_ANOMALY);
});

it('an unknown key inside the anomaly block fails closed (typo protection)', () => {
  process.env.POLICY_CONFIG_PATH = configFile('anomaly-typo.json', validFileJson({
    anomaly: { ...VALID_ANOMALY, warnz: 2 },
  }));
  const result = getPolicyEngine().evaluate(discoveredCtx);
  assert.equal(result.decision, 'DENY');
  assert.ok(result.reasons.some((r) => r.code === 'CONFIG_INVALID' && r.message.includes('warnz')));
});

it('malformed anomaly values fail closed (CONFIG_INVALID)', () => {
  for (const bad of [
    { ...VALID_ANOMALY, enabled: 'true' },          // non-boolean
    { ...VALID_ANOMALY, window: 0 },                // window < 1
    { ...VALID_ANOMALY, window: 2.5 },              // non-integer window
    { ...VALID_ANOMALY, minSamples: 0 },            // minSamples < 1
    { ...VALID_ANOMALY, minSamples: 1.5 },          // non-integer minSamples
    { ...VALID_ANOMALY, warnZ: -1 },                // negative warnZ
    { ...VALID_ANOMALY, denyZ: '3' },               // non-number denyZ
    { ...VALID_ANOMALY, defaultTolerance: 0.5 },    // below the >= 1 floor
    { ...VALID_ANOMALY, seedFromDirectory: 'yes' }, // non-boolean
    'yes',                                          // not an object at all
  ]) {
    process.env.POLICY_CONFIG_PATH = configFile('anomaly-bad.json', validFileJson({ anomaly: bad }));
    const result = getPolicyEngine().evaluate(discoveredCtx);
    assert.equal(result.decision, 'DENY', `anomaly block ${JSON.stringify(bad)} must fail closed`);
    assert.ok(result.reasons.some((r) => r.code === 'CONFIG_INVALID'));
  }
});

it('an inverted warnZ/denyZ ordering fails closed — including against the defaults after merging', () => {
  for (const bad of [
    { ...VALID_ANOMALY, warnZ: 5, denyZ: 3 },  // both present, inverted
    { ...VALID_ANOMALY, warnZ: 3, denyZ: 3 },  // equal is not <
    { warnZ: 5 },                              // partial block: warnZ raised above the DEFAULT denyZ 3
    { denyZ: 1 },                              // partial block: denyZ lowered below the DEFAULT warnZ 2
  ]) {
    process.env.POLICY_CONFIG_PATH = configFile('anomaly-order.json', validFileJson({ anomaly: bad }));
    const result = getPolicyEngine().evaluate(discoveredCtx);
    assert.equal(result.decision, 'DENY', `anomaly block ${JSON.stringify(bad)} must fail closed`);
    assert.ok(result.reasons.some((r) => r.code === 'CONFIG_INVALID' && r.message.includes('warnZ')));
  }
});

it('loading an anomaly-bearing file never mutates DEFAULT_POLICY_CONFIG', () => {
  const snapshot = JSON.stringify(DEFAULT_POLICY_CONFIG);
  process.env.POLICY_CONFIG_PATH = configFile('anomaly-snapshot.json', validFileJson({ anomaly: VALID_ANOMALY }));
  loadPolicyConfig();
  assert.equal(JSON.stringify(DEFAULT_POLICY_CONFIG), snapshot, 'loadPolicyConfig must never mutate the default template (anomaly included)');
});

it('DEFAULT_POLICY_CONFIG is the documented compat default and is not mutated by loading', () => {
  const snapshot = JSON.stringify(DEFAULT_POLICY_CONFIG);
  process.env.POLICY_CONFIG_PATH = configFile('policy.json', validFileJson({ payments: { enabled: true, maxPerRequest: 0.1, maxDaily: 1 } }));
  loadPolicyConfig();
  assert.equal(JSON.stringify(DEFAULT_POLICY_CONFIG), snapshot, 'loadPolicyConfig must never mutate the default template');
});