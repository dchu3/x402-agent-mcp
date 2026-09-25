import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Issue #34 — liveness-ranked discovery in x402_search. Hermetic directory
// (X402_DIRECTORY_PATH, the repo test pattern) + the issue's fixture shape:
// 2 rows with FRESH live_402 probes / 1 stale / 1 never-probed / 1 OFF the
// pin set (no source — never pinned by default). The network tripwire is
// asserted in every test: search performs ZERO HTTP (probing lives in
// x402_probe_allowlist).
const dir = mkdtempSync(join(tmpdir(), 'x402-search-liveness-'));
const env = { ...process.env };
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');

const NOW = Date.now();
const FRESH_RECENT = new Date(NOW - 10_000).toISOString();   // 10 s ago
const FRESH_OLDER = new Date(NOW - 30_000).toISOString();    // 30 s ago (fresh, but older)
const STALE = new Date(NOW - 7_200_000).toISOString();       // 2 h ago (> 3600 s default max age)

function writeFixture(): void {
  writeFileSync(process.env.X402_DIRECTORY_PATH!, JSON.stringify({
    endpoints: [
      // Deliberately NOT pre-sorted: the rank must come from the tool.
      { name: 'StaleOne', description: 'stale probe', base_url: 'https://stale.example', chain: 'base', category: 'news', tags: [], endpoints: [], source: 'seed', liveness: { probed_at: STALE, status: 'live_402', latency_ms: 40, probe_url: 'https://stale.example' } },
      { name: 'FreshB', description: 'fresh but older', base_url: 'https://fresh-b.example', chain: 'solana', category: 'ai', tags: ['inference'], endpoints: [], source: 'seed', liveness: { probed_at: FRESH_OLDER, status: 'live_402', latency_ms: 20, probe_url: 'https://fresh-b.example' } },
      { name: 'OffList', description: 'not pinned', base_url: 'https://offlist.example', chain: 'base', category: 'ai', tags: [], endpoints: [] },
      { name: 'FreshA', description: 'freshest', base_url: 'https://fresh-a.example', chain: 'base', category: 'ai', tags: ['news'], endpoints: [{ path: '/score', method: 'POST', price_usdc: '0.05', description: 'd' }], source: 'seed', liveness: { probed_at: FRESH_RECENT, status: 'live_402', latency_ms: 15, probe_url: 'https://fresh-a.example' } },
      { name: 'NeverProbed', description: 'no record', base_url: 'https://never.example', chain: 'casper', category: 'multi', tags: [], endpoints: [], source: 'seed' },
    ],
    categories: ['ai', 'news', 'multi'], last_updated: '2026-09-25',
  }), 'utf8');
}
writeFixture();

const { registerSearchTool } = await import('./search.js');
const { clearDirectoryCache } = await import('../directory.js');

const originalFetch = globalThis.fetch;

/** Zero-network tripwire (issue #34: "Search itself performs no HTTP"). */
function tripwire() {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('x402_search must make ZERO network calls'); }) as any;
  return { get calls() { return calls; } };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...env, X402_DIRECTORY_PATH: join(dir, 'endpoints.json') };
  writeFixture();
  clearDirectoryCache();
});
after(() => { process.env = env; globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });

function handler() {
  let callback: any;
  registerSearchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

async function search(args: Record<string, unknown> = {}): Promise<any> {
  const result = await handler()(args);
  return JSON.parse(result.content[0].text);
}

function policyFile(content: Record<string, unknown>): string {
  const p = join(dir, `policy-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(content), 'utf8');
  return p;
}

it('ranks pinned live endpoints first (NEWEST probe first), then stale, then never-probed — and withholds unpinned rows by default', async () => {
  const net = tripwire();
  const parsed = await search();
  assert.deepEqual(parsed.results.map((r: any) => r.name), ['FreshA', 'FreshB', 'StaleOne', 'NeverProbed'], 'live fresh-first ordering, then stale, then never-probed');
  assert.deepEqual(parsed.results.map((r: any) => r.live), [true, true, false, false], 'live=true only for a fresh live_402 on a pinned row');
  assert.equal(parsed.total, 4, 'the unpinned row is withheld from the default set');
  assert.equal(parsed.live_total, 2);
  assert.equal(parsed.unverified_withheld, 1, 'the withheld count is reported');
  assert.ok(parsed.results.every((r: any) => r.name !== 'OffList'), 'OffList (no source) is off the pin set and withheld');
  assert.equal(net.calls, 0, 'ZERO network calls — search never probes');
});

it('every emitted row carries the entry-level liveness block ({status, probed_at, stale}; never-probed ⇒ null/true)', async () => {
  const net = tripwire();
  const parsed = await search();
  const byName = Object.fromEntries(parsed.results.map((r: any) => [r.name, r]));
  assert.deepEqual(byName.FreshA.liveness, { status: 'live_402', probed_at: FRESH_RECENT, stale: false });
  assert.deepEqual(byName.FreshB.liveness, { status: 'live_402', probed_at: FRESH_OLDER, stale: false });
  assert.deepEqual(byName.StaleOne.liveness, { status: 'live_402', probed_at: STALE, stale: true }, 'a probe older than max_age_seconds reports stale: true');
  assert.deepEqual(byName.NeverProbed.liveness, { status: 'never_probed', probed_at: null, stale: true });
  // Compat keys are untouched.
  assert.equal(byName.FreshA.base_url, 'https://fresh-a.example');
  assert.equal(byName.FreshA.endpoint_count, 1);
  assert.equal(byName.NeverProbed.endpoints, undefined);
  assert.equal(net.calls, 0);
});

it('include_unverified: true reveals unpinned rows — flagged live:false, ranked last-tier with the never-probed', async () => {
  const net = tripwire();
  const parsed = await search({ include_unverified: true });
  assert.equal(parsed.total, 5);
  assert.equal(parsed.live_total, 2);
  assert.equal(parsed.unverified_withheld, 0);
  const off = parsed.results.find((r: any) => r.name === 'OffList');
  assert.ok(off, 'the unpinned row is visible when requested');
  assert.equal(off.live, false, 'an unpinned row is NEVER live');
  assert.deepEqual(off.liveness, { status: 'never_probed', probed_at: null, stale: true });
  // Ranking keeps the live rows ahead even with the unverified included.
  assert.deepEqual(parsed.results.slice(0, 2).map((r: any) => r.name), ['FreshA', 'FreshB']);
  assert.equal(net.calls, 0);
});

it('explicit include_unverified: false matches the default exactly', async () => {
  const net = tripwire();
  const parsed = await search({ include_unverified: false });
  assert.equal(parsed.total, 4);
  assert.equal(parsed.unverified_withheld, 1);
  assert.equal(net.calls, 0);
});

it('an EMPTY explicit allowlist yields ZERO live results — by default and with include_unverified (L2/L3)', async () => {
  const net = tripwire();
  process.env.POLICY_CONFIG_PATH = policyFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    liveness: { allowlist: [] },
  });
  const withheld = await search();
  assert.equal(withheld.total, 0, 'pin set empty ⇒ nothing pinned ⇒ default set empty');
  assert.equal(withheld.live_total, 0);
  const all = await search({ include_unverified: true });
  assert.equal(all.total, 5, 'rows are still inspectable when unverified inclusion is requested');
  assert.equal(all.live_total, 0, 'zero live results: nothing is pinned, so nothing can be live');
  assert.ok(all.results.every((r: any) => r.live === false));
  assert.equal(net.calls, 0);
});

it('an explicit allowlist pins ONLY the named origins (source-agnostic): OffList pinned by name; the seed rows fall off', async () => {
  const net = tripwire();
  process.env.POLICY_CONFIG_PATH = policyFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    liveness: { allowlist: [{ base_url: 'https://offlist.example' }] },
  });
  const parsed = await search();
  assert.deepEqual(parsed.results.map((r: any) => r.name), ['OffList'], 'only the allowlisted origin is pinned');
  assert.equal(parsed.live_total, 0, 'pinned but never probed ⇒ not live');
  assert.equal(parsed.results[0].live, false);
  assert.equal(net.calls, 0);
});

it('an explicit paths constraint narrows row visibility to the origin (the gate applies paths per-URL)', async () => {
  const net = tripwire();
  process.env.POLICY_CONFIG_PATH = policyFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    liveness: { allowlist: [{ base_url: 'https://fresh-a.example', paths: ['/score'] }] },
  });
  const parsed = await search();
  assert.deepEqual(parsed.results.map((r: any) => r.name), ['FreshA']);
  assert.equal(parsed.results[0].live, true, 'the row is pinned (origin-level) and freshly live');
  assert.equal(net.calls, 0);
});

it('query/category/chain filters are unchanged — applied over the pinned, ranked set', async () => {
  const net = tripwire();
  const byCategory = await search({ category: 'ai' });
  assert.deepEqual(byCategory.results.map((r: any) => r.name), ['FreshA', 'FreshB'], 'fresh-first rank inside the filter (OffList withheld)');
  const byChain = await search({ chain: 'base', include_unverified: true });
  assert.deepEqual(byChain.results.map((r: any) => r.name), ['FreshA', 'StaleOne', 'OffList']);
  const byQuery = await search({ query: 'inference', include_unverified: true });
  assert.deepEqual(byQuery.results.map((r: any) => r.name), ['FreshB']);
  const none = await search({ query: 'no-such-thing' });
  assert.equal(none.total, 0);
  assert.equal(none.live_total, 0);
  assert.equal(net.calls, 0);
});

it('a stale-only pin set ranks rows but none are live (probe older than max_age_seconds ⇒ stale:true, not live)', async () => {
  const net = tripwire();
  writeFileSync(process.env.X402_DIRECTORY_PATH!, JSON.stringify({
    endpoints: [
      { name: 'OnlyStale', description: '', base_url: 'https://only-stale.example', chain: 'base', category: 'ai', tags: [], endpoints: [], source: 'seed', liveness: { probed_at: STALE, status: 'live_402', latency_ms: 40, probe_url: 'https://only-stale.example' } },
      { name: 'OnlyNever', description: '', base_url: 'https://only-never.example', chain: 'base', category: 'ai', tags: [], endpoints: [], source: 'seed' },
    ],
    categories: [], last_updated: '2026-09-25',
  }), 'utf8');
  clearDirectoryCache();
  const parsed = await search();
  assert.deepEqual(parsed.results.map((r: any) => r.name), ['OnlyStale', 'OnlyNever'], 'record-bearing rows rank above never-probed');
  assert.deepEqual(parsed.results.map((r: any) => r.live), [false, false]);
  assert.equal(parsed.live_total, 0);
  assert.equal(parsed.results[0].liveness.stale, true);
  assert.equal(net.calls, 0);
});
