import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Issue #34 — x402_probe_allowlist: the liveness REFRESH probe (L5). Hermetic
// directory + ledger paths (X402_DIRECTORY_PATH / PAYMENT_LOG_PATH test
// pattern); ALL network is the mocked globalThis.fetch — no live HTTP. The
// tool never pays: the payment ledger must not exist after any run.

const dir = mkdtempSync(join(tmpdir(), 'x402-probe-allowlist-'));
const env = { ...process.env };
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');

const { registerProbeAllowlistTool } = await import('./probe-allowlist.js');
const { clearDirectoryCache } = await import('../directory.js');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...env, X402_DIRECTORY_PATH: join(dir, 'endpoints.json'), PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl') };
});
after(() => { process.env = env; globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });

const b64url = (s: string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function challenge402(network = 'eip155:8453'): Response {
  const payload = { x402Version: 2, accepts: [{ scheme: 'exact', network, amount: '10000', payTo: '0xabc', asset: '0xdef' }] };
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(JSON.stringify(payload)) } });
}

function handler() {
  let callback: any;
  registerProbeAllowlistTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

function seedEntry(name: string, baseUrl: string, extra: Record<string, unknown> = {}) {
  return { name, description: '', base_url: baseUrl, chain: 'base', category: 'ai', tags: [], endpoints: [], ...extra };
}

function writeDirectory(endpoints: unknown[]): void {
  writeFileSync(process.env.X402_DIRECTORY_PATH!, JSON.stringify({ endpoints, categories: [], last_updated: '2026-09-25' }), 'utf8');
  clearDirectoryCache();
}

function readDirectory(): any {
  clearDirectoryCache();
  return JSON.parse(readFileSync(process.env.X402_DIRECTORY_PATH!, 'utf-8'));
}

function policyFile(content: Record<string, unknown>): string {
  const p = join(dir, `policy-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(content), 'utf8');
  return p;
}

function ledgerUntouched(): void {
  assert.equal(existsSync(process.env.PAYMENT_LOG_PATH!), false, 'the probe tool must never touch the payment ledger');
}

it('probes the seed pin set: live_402 / no_402 / error recorded atomically per entry, discovery rows untouched, ledger untouched', async () => {
  writeDirectory([
    seedEntry('Live1', 'https://live1.example', { source: 'seed' }),
    seedEntry('No402', 'https://no402.example', { source: 'seed' }),
    seedEntry('Borked', 'https://borked.example', { source: 'seed' }),
    seedEntry('Crawled', 'https://crawled.example', { source: 'discovery' }),
  ]);
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url.startsWith('https://live1.example')) return challenge402();
    if (url.startsWith('https://no402.example')) return new Response('free page', { status: 200 });
    throw new Error(`simulated network failure for ${url}`);
  }) as any;

  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.mode, 'seed', 'no liveness.allowlist ⇒ seed-pinned mode');
  assert.equal(parsed.config_valid, true);
  assert.equal(parsed.probed, 3, 'only the three seed rows are probed — the discovery row is NOT pinned');
  assert.equal(parsed.live_total, 1);
  assert.ok(seen.every((u) => !u.startsWith('https://crawled.example')), 'the discovery row is never probed');

  const byUrl = Object.fromEntries(parsed.results.map((r: any) => [r.url, r]));
  assert.equal(byUrl['https://live1.example'].status, 'live_402');
  assert.equal(byUrl['https://live1.example'].recorded, true);
  assert.ok(typeof byUrl['https://live1.example'].latency_ms === 'number');
  assert.ok(Number.isFinite(Date.parse(byUrl['https://live1.example'].probed_at)), 'probed_at is an ISO timestamp');
  assert.equal(byUrl['https://no402.example'].status, 'no_402');
  assert.equal(byUrl['https://borked.example'].status, 'error');
  assert.match(byUrl['https://borked.example'].error ?? '', /simulated network failure/);

  const dirAfter = readDirectory();
  const live1 = dirAfter.endpoints.find((e: any) => e.name === 'Live1');
  assert.equal(live1.liveness.status, 'live_402', 'the record persisted to the directory file');
  assert.deepEqual(live1.liveness.accepts, [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', payTo: '0xabc', asset: '0xdef' }], 'the accepts snapshot is recorded on a live_402');
  const no402 = dirAfter.endpoints.find((e: any) => e.name === 'No402');
  assert.equal(no402.liveness.status, 'no_402');
  assert.equal(no402.liveness.accepts, undefined, 'no_402 never invents an accepts snapshot');
  const borked = dirAfter.endpoints.find((e: any) => e.name === 'Borked');
  assert.equal(borked.liveness.status, 'error');
  assert.equal(borked.liveness.accepts, undefined);
  const crawled = dirAfter.endpoints.find((e: any) => e.name === 'Crawled');
  assert.equal(crawled.liveness, undefined, 'unpinned rows are never written');
  ledgerUntouched();
});

it('a timeout/abort records status "error", never live', async () => {
  writeDirectory([seedEntry('Slow', 'https://slow.example', { source: 'seed' })]);
  globalThis.fetch = (async (_input: unknown, init: any) => {
    const signal: AbortSignal | undefined = init?.signal;
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
  }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].status, 'error', 'timeouts are recorded as error — never live (L5)');
  assert.equal(parsed.live_total, 0);
  const dirAfter = readDirectory();
  assert.equal(dirAfter.endpoints[0].liveness.status, 'error');
  ledgerUntouched();
});

it('concurrency is capped at 4 (bounded pool, L5)', async () => {
  const rows = Array.from({ length: 9 }, (_, i) => seedEntry(`Svc${i}`, `https://svc-${i}.example`, { source: 'seed' }));
  writeDirectory(rows);
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = (async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return challenge402();
  }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.probed, 9);
  assert.equal(parsed.live_total, 9);
  assert.ok(maxInFlight <= 4, `the cap must hold — saw ${maxInFlight} in flight`);
  assert.ok(maxInFlight > 1, `the pool must actually parallelise — saw ${maxInFlight}`);
  ledgerUntouched();
});

it('explicit allowlist mode: paths drive which URLs are probed (first live_402 wins), unlisted rows are not probed', async () => {
  writeDirectory([
    seedEntry('Pinned', 'https://pinned.example'),
    seedEntry('Skipped', 'https://skipped.example', { source: 'seed' }), // NOT on the explicit allowlist
  ]);
  process.env.POLICY_CONFIG_PATH = policyFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    liveness: { allowlist: [{ base_url: 'https://pinned.example', paths: ['/api', '/v2'] }] },
  });
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url === 'https://pinned.example/api') return new Response('not here', { status: 200 });
    if (url === 'https://pinned.example/v2') return challenge402();
    throw new Error(`unexpected probe target ${url}`);
  }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.mode, 'explicit');
  assert.equal(parsed.probed, 1, 'only the allowlisted row is probed');
  assert.deepEqual(seen, ['https://pinned.example/api', 'https://pinned.example/v2'], 'the paths drive the probes, in order');
  assert.equal(parsed.results[0].status, 'live_402', 'the first live_402 wins');
  assert.equal(parsed.results[0].probe_url, 'https://pinned.example/v2');
  const dirAfter = readDirectory();
  const pinned = dirAfter.endpoints.find((e: any) => e.name === 'Pinned');
  assert.equal(pinned.liveness.status, 'live_402');
  assert.equal(pinned.liveness.probe_url, 'https://pinned.example/v2');
  assert.equal(dirAfter.endpoints.find((e: any) => e.name === 'Skipped').liveness, undefined, 'rows outside the explicit allowlist are never probed');
  ledgerUntouched();
});

it('an empty pin set ([] allowlist) probes nothing and says so', async () => {
  writeDirectory([seedEntry('Anything', 'https://anything.example', { source: 'seed' })]);
  process.env.POLICY_CONFIG_PATH = policyFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    liveness: { allowlist: [] },
  });
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return challenge402(); }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.mode, 'explicit');
  assert.equal(parsed.probed, 0);
  assert.equal(parsed.live_total, 0);
  assert.deepEqual(parsed.results, []);
  assert.match(parsed.note ?? '', /No pinned directory rows/);
  assert.equal(calls, 0, 'nothing to probe ⇒ zero network');
  const dirAfter = readDirectory();
  assert.equal(dirAfter.endpoints[0].liveness, undefined, 'no records are written');
  ledgerUntouched();
});

it('the accepts snapshot is capped at 8 entries and 200 chars per field', async () => {
  writeDirectory([seedEntry('Big', 'https://big.example', { source: 'seed' })]);
  const bigAccepts = Array.from({ length: 12 }, (_, i) => ({
    scheme: 'exact', network: eip(i), amount: `${i}${'0'.repeat(300)}`, payTo: `0x${'ab'.repeat(150)}`, asset: 'x'.repeat(400),
  }));
  function eip(i: number): string { return `eip155:${8453 + i}`; }
  globalThis.fetch = (async () => new Response('Payment Required', {
    status: 402,
    headers: { 'payment-required': b64url(JSON.stringify({ x402Version: 2, accepts: bigAccepts })) },
  })) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.results[0].status, 'live_402');
  const dirAfter = readDirectory();
  const accepts = dirAfter.endpoints[0].liveness.accepts;
  assert.equal(accepts.length, 8, 'capped at 8 entries');
  for (const a of accepts) {
    for (const v of Object.values(a)) {
      assert.ok((v as string).length <= 200, 'each field capped at 200 chars');
    }
  }
  ledgerUntouched();
});

// ---------------------------------------------------------------------------
// Issue #38 — the probe must reach a PAYABLE PATH. Most x402 hosts serve a
// free 200/404 landing page at root and challenge on an API path, so a
// root-only probe recorded a permanent no_402 — and the fail-closed gate then
// refused a demonstrably payable endpoint forever. These cases pin the
// bounded candidate walk (advertised → root → openapi discovery), the caps,
// and the configured-paths-exhaustive contract. All network is the mocked
// globalThis.fetch — no live HTTP; the ledger is untouched in every case.
// ---------------------------------------------------------------------------

function openApiSpec(paths: Record<string, unknown>): Response {
  return Response.json({ openapi: '3.0.0', paths });
}

it('issue #38 regression: root free/404 but the API path challenges ⇒ recorded live_402 at the paid path', async () => {
  // The measured live shape (plan fact 2): root → 404; /openapi.json lists
  // three FREE GET paths before the paid one; /weather/current → 402.
  writeDirectory([seedEntry('Weather', 'https://weather.example', { source: 'seed' })]);
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url === 'https://weather.example') return new Response('not found', { status: 404 });
    if (url === 'https://weather.example/openapi.json') {
      return openApiSpec({
        '/.well-known/x402': { get: {} },
        '/health': { get: {} },
        '/llms.txt': { get: {} },
        '/weather/current': { get: {} },
        '/weather/forecast': { get: {} },
      });
    }
    if (url === 'https://weather.example/weather/current') return challenge402();
    throw new Error(`unexpected probe target ${url}`);
  }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.probed, 1);
  assert.equal(parsed.live_total, 1, 'a path-challenging service is now live — the #38 fix');
  assert.equal(parsed.results[0].status, 'live_402');
  assert.equal(parsed.results[0].probe_url, 'https://weather.example/weather/current', 'the record points at the payable PATH');
  // Build-then-walk: the spec fetch happens first, then root (free), then the
  // paid path wins with early exit — noise and the remaining discovery
  // candidate are never fetched.
  assert.deepEqual(seen, [
    'https://weather.example/openapi.json',
    'https://weather.example',
    'https://weather.example/weather/current',
  ]);
  const dirAfter = readDirectory();
  const weather = dirAfter.endpoints.find((e: any) => e.name === 'Weather');
  assert.equal(weather.liveness.status, 'live_402');
  assert.equal(weather.liveness.probe_url, 'https://weather.example/weather/current');
  assert.ok(Array.isArray(weather.liveness.accepts), 'the accepts snapshot comes from the winning 402 challenge');
  ledgerUntouched();
});

it('advertised GET paths are probed ahead of root and win — with placeholders substituted only in the request URL', async () => {
  // Plan fact 5: svm402.com advertises /price/{address} — the clearly-marked
  // placeholder probe is a valid representative.
  writeDirectory([seedEntry('Svm', 'https://svm.example', {
    source: 'seed',
    endpoints: [{ path: '/price/{address}', method: 'GET', price_usdc: '0.01', description: '' }],
  })]);
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url === 'https://svm.example/openapi.json') {
      return openApiSpec({ '/also-paid': { get: {} } }); // must never be reached — the advertised path wins first
    }
    if (url === 'https://svm.example/price/x402-probe') return challenge402();
    throw new Error(`unexpected probe target ${url}`);
  }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.results[0].status, 'live_402');
  assert.equal(parsed.results[0].probe_url, 'https://svm.example/price/x402-probe', 'the substituted advertised path wins');
  assert.deepEqual(seen, ['https://svm.example/openapi.json', 'https://svm.example/price/x402-probe'],
    'early exit at the advertised path: root and discovery candidates are never fetched');
  ledgerUntouched();
});

it('full precedence order: advertised (GET-only, POST skipped) → root → noise-filtered openapi discovery', async () => {
  writeDirectory([seedEntry('Order', 'https://order.example', {
    source: 'seed',
    endpoints: [
      { path: '/only-post', method: 'POST', price_usdc: '0.01', description: '' }, // never probed
      { path: '/v1/quote', method: 'GET', price_usdc: '0.01', description: '' },
    ],
  })]);
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url === 'https://order.example/openapi.json') {
      return openApiSpec({
        '/.well-known/x402': { get: {} }, // noise — filtered BEFORE the cap, never probed
        '/health': { get: {} },
        '/llms.txt': { get: {} },
        '/paid': { get: {} },
      });
    }
    if (url === 'https://order.example/v1/quote') return new Response('free quote', { status: 200 });
    if (url === 'https://order.example') return new Response('landing', { status: 200 });
    if (url === 'https://order.example/paid') return challenge402();
    throw new Error(`unexpected probe target ${url}`);
  }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.results[0].status, 'live_402');
  assert.equal(parsed.results[0].probe_url, 'https://order.example/paid');
  assert.deepEqual(seen, [
    'https://order.example/openapi.json',
    'https://order.example/v1/quote',
    'https://order.example',
    'https://order.example/paid',
  ], 'advertised → root → discovery, in order; POST-only advertised path and noise never probed');
  ledgerUntouched();
});

it('all-free ⇒ still no_402 (no false live) and the walk stays capped at 5 URLs (P4)', async () => {
  writeDirectory([seedEntry('Free', 'https://free.example', {
    source: 'seed',
    endpoints: [{ path: '/free', method: 'GET', price_usdc: '0', description: '' }],
  })]);
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url === 'https://free.example/openapi.json') {
      const paths: Record<string, unknown> = {};
      for (let i = 1; i <= 12; i++) paths[`/d${i}`] = { get: {} }; // 12 GET paths — discovery caps at 8, walk at 5
      return openApiSpec(paths);
    }
    return new Response('free page', { status: 200 });
  }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.results[0].status, 'no_402', 'free answers everywhere ⇒ no_402 — never a false live');
  assert.equal(parsed.results[0].probe_url, 'https://free.example/free', 'the first ANSWERED candidate is recorded');
  assert.deepEqual(seen, [
    'https://free.example/openapi.json',
    'https://free.example/free',
    'https://free.example',
    'https://free.example/d1',
    'https://free.example/d2',
    'https://free.example/d3',
  ], 'candidates [advertised, root, d1..d8] truncated to the 5-URL walk cap');
  const dirAfter = readDirectory();
  const free = dirAfter.endpoints.find((e: any) => e.name === 'Free');
  assert.equal(free.liveness.status, 'no_402');
  assert.equal(free.liveness.accepts, undefined, 'no_402 never invents an accepts snapshot');
  ledgerUntouched();
});

it('every candidate errors ⇒ recorded error with the diagnostic (never live)', async () => {
  writeDirectory([seedEntry('Down', 'https://down.example', { source: 'seed' })]);
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    throw new Error(`simulated network failure for ${url}`);
  }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.results[0].status, 'error');
  assert.match(parsed.results[0].error ?? '', /simulated network failure/);
  assert.equal(parsed.results[0].probe_url, 'https://down.example', 'the last attempted candidate is recorded');
  assert.equal(parsed.live_total, 0);
  const dirAfter = readDirectory();
  assert.equal(dirAfter.endpoints[0].liveness.status, 'error');
  ledgerUntouched();
});

it('an unreachable openapi.json does not break the walk — root free ⇒ no_402', async () => {
  writeDirectory([seedEntry('NoSpec', 'https://nospec.example', { source: 'seed' })]);
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url === 'https://nospec.example/openapi.json') return new Response('nope', { status: 404 });
    if (url === 'https://nospec.example') return new Response('free page', { status: 200 });
    throw new Error(`unexpected probe target ${url}`);
  }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.results[0].status, 'no_402');
  assert.equal(parsed.results[0].probe_url, 'https://nospec.example');
  assert.deepEqual(seen, ['https://nospec.example/openapi.json', 'https://nospec.example']);
  ledgerUntouched();
});

it('configured paths stay exhaustive (mirror of the :152-182 contract, in a new case): first live wins early, NO discovery', async () => {
  writeDirectory([seedEntry('Cfg', 'https://cfg.example', { source: 'seed' })]);
  // Issue #36: a configured "{param}" path is now a validation error (W2), so
  // this mirror of the exhaustive-configured-paths contract uses the supported
  // wildcard form — the substitution contract it pins is unchanged.
  process.env.POLICY_CONFIG_PATH = policyFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    liveness: { allowlist: [{ base_url: 'https://cfg.example', paths: ['/price/*', '/v2'] }] },
  });
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url === 'https://cfg.example/price/x402-probe') return challenge402();
    throw new Error(`unexpected probe target ${url}`);
  }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.mode, 'explicit');
  assert.equal(parsed.results[0].status, 'live_402');
  assert.equal(parsed.results[0].probe_url, 'https://cfg.example/price/x402-probe', 'the placeholder is substituted in the REQUEST URL only');
  assert.deepEqual(seen, ['https://cfg.example/price/x402-probe'],
    'exactly the configured paths are probed — no openapi fetch, no advertised paths, early exit skips /v2');
  const policyOnDisk = readFileSync(process.env.POLICY_CONFIG_PATH!, 'utf8');
  assert.ok(policyOnDisk.includes('/price/*'), 'the configured path string is never mutated (P3)');
  ledgerUntouched();
});

it('configured paths that all answer free ⇒ no_402 and zero discovery — openapi would throw if it were ever fetched', async () => {
  writeDirectory([seedEntry('CfgFree', 'https://cfgfree.example', { source: 'seed' })]);
  process.env.POLICY_CONFIG_PATH = policyFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    liveness: { allowlist: [{ base_url: 'https://cfgfree.example', paths: ['/a', '/b'] }] },
  });
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url === 'https://cfgfree.example/a' || url === 'https://cfgfree.example/b') return new Response('free', { status: 200 });
    throw new Error(`unexpected probe target ${url}`);
  }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.results[0].status, 'no_402');
  assert.deepEqual(seen, ['https://cfgfree.example/a', 'https://cfgfree.example/b'],
    'configured paths are the ONLY URLs probed — exhaustive, no discovery (fact 7)');
  ledgerUntouched();
});

// ---------------------------------------------------------------------------
// Issue #36 — a configured trailing-* wildcard entry probes a SUBSTITUTED
// representative (the x402-probe token), never the literal wildcard URL. The
// gate side (pathMatches) admits the real parametrized routes; the record
// must be truthful about the exact URL the probe fetched. All network is the
// mocked globalThis.fetch — any unexpected target (including the literal
// `.../price/*`) throws, so these cases PROVE the literal is never requested.
// ---------------------------------------------------------------------------

it('issue #36: a configured wildcard entry probes the SUBSTITUTED representative — the literal wildcard URL is never requested', async () => {
  writeDirectory([seedEntry('Wild', 'https://pinned.example', { source: 'seed' })]);
  process.env.POLICY_CONFIG_PATH = policyFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    liveness: { allowlist: [{ base_url: 'https://pinned.example', paths: ['/price/*'] }] },
  });
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url === 'https://pinned.example/price/x402-probe') return challenge402(); // 402 ONLY for the substituted path
    throw new Error(`unexpected probe target ${url}`);
  }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.mode, 'explicit');
  assert.equal(parsed.results[0].status, 'live_402', 'the substituted representative answers 402');
  assert.equal(parsed.results[0].probe_url, 'https://pinned.example/price/x402-probe', 'the record carries the SUBSTITUTED URL');
  assert.deepEqual(seen, ['https://pinned.example/price/x402-probe'],
    'exactly one candidate: the literal https://pinned.example/price/* is never requested (it would throw above) and no discovery runs');
  const dirAfter = readDirectory();
  const wild = dirAfter.endpoints.find((e: any) => e.name === 'Wild');
  assert.equal(wild.liveness.status, 'live_402');
  assert.equal(wild.liveness.probe_url, 'https://pinned.example/price/x402-probe');
  assert.ok(Array.isArray(wild.liveness.accepts), 'the accepts snapshot comes from the substituted 402');
  ledgerUntouched();
});

it('issue #36: a wildcard entry whose placeholder answers free records no_402 — truthful, never live_402 by literal tolerance', async () => {
  writeDirectory([seedEntry('WildFree', 'https://wildfree.example', { source: 'seed' })]);
  process.env.POLICY_CONFIG_PATH = policyFile({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    liveness: { allowlist: [{ base_url: 'https://wildfree.example', paths: ['/price/*'] }] },
  });
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url === 'https://wildfree.example/price/x402-probe') return new Response('free', { status: 200 });
    throw new Error(`unexpected probe target ${url}`);
  }) as any;
  const result = await handler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.results[0].status, 'no_402', 'a free placeholder is a truthful no_402');
  assert.equal(parsed.results[0].probe_url, 'https://wildfree.example/price/x402-probe');
  assert.deepEqual(seen, ['https://wildfree.example/price/x402-probe'], 'exactly one candidate — the substituted representative');
  const dirAfter = readDirectory();
  const row = dirAfter.endpoints.find((e: any) => e.name === 'WildFree');
  assert.equal(row.liveness.status, 'no_402');
  assert.equal(row.liveness.accepts, undefined, 'no_402 never invents an accepts snapshot');
  ledgerUntouched();
});
