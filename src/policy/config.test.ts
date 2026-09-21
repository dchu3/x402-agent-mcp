import { strict as assert } from 'node:assert';
import { afterEach, after, it } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

it('DEFAULT_POLICY_CONFIG is the documented compat default and is not mutated by loading', () => {
  const snapshot = JSON.stringify(DEFAULT_POLICY_CONFIG);
  process.env.POLICY_CONFIG_PATH = configFile('policy.json', validFileJson({ payments: { enabled: true, maxPerRequest: 0.1, maxDaily: 1 } }));
  loadPolicyConfig();
  assert.equal(JSON.stringify(DEFAULT_POLICY_CONFIG), snapshot, 'loadPolicyConfig must never mutate the default template');
});