import { strict as assert } from 'node:assert';
import { afterEach, after, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the directory in a temp file BEFORE loading directory.js — the repo's
// live endpoints.json is gitignored operator data and must never be written by tests.
const dir = mkdtempSync(join(tmpdir(), 'x402-crawl-test-'));
const env = { ...process.env };
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-01-01' }));

const { registerCrawlX402ScanTool, X402SCAN_SOURCES } = await import('./crawl-directory.js');
const { clearDirectoryCache } = await import('../directory.js');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

function handler() {
  let callback: any;
  registerCrawlX402ScanTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

const HTML_CATCH_ALL = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>';

function readDirectory() {
  return JSON.parse(readFileSync(join(dir, 'endpoints.json'), 'utf-8'));
}

function resourcesPage(hosts: string[]) {
  return new Response(hosts.map((h) => `<a href="https://${h}/">link</a>`).join(' '), { status: 200 });
}

function probeMock(map: Record<string, (url: string) => Response>) {
  return async (input: any, _init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === X402SCAN_SOURCES[0]) return resourcesPage(Object.keys(map));
    for (const [host, fn] of Object.entries(map)) {
      if (url.startsWith(`https://${host}`)) return fn(url);
    }
    return new Response('Not Found', { status: 404 });
  };
}

it('crawler skips a host whose well-known is an HTML catch-all and never adds it to the directory', async () => {
  clearDirectoryCache();
  globalThis.fetch = probeMock({
    'spa-catchall.example': () => new Response(HTML_CATCH_ALL, { status: 200, headers: { 'content-type': 'text/html' } }),
  }) as any;
  const result = JSON.parse((await handler()({ max_results: 5 })).content[0].text);
  assert.equal(result.new_services_added, 0);
  assert.equal(readDirectory().endpoints.length, 0);
});

it('crawler fails loudly instead of silently scraping a 404 error page', async () => {
  clearDirectoryCache();
  globalThis.fetch = (async () => new Response('<!doctype html><title>404</title>', { status: 404 })) as any;
  const result = JSON.parse((await handler()({ max_results: 5 })).content[0].text);
  assert.match(result.error, /HTTP 404/);
  assert.equal(readDirectory().endpoints.length, 0);
});

it('crawler returns the normal summary shape when an OK page yields zero service URLs', async () => {
  clearDirectoryCache();
  globalThis.fetch = probeMock({}); // 200 resources page listing no hosts
  const result = JSON.parse((await handler()({ max_results: 5 })).content[0].text);
  // Content-level emptiness is a legitimate outcome, not a failure: the
  // summary shape is kept and urls_scraped reports the honest zero.
  assert(!('error' in result));
  assert.equal(result.urls_scraped, 0);
  assert.equal(result.new_services_added, 0);
  assert.deepEqual(result.services, []);
  assert.equal(readDirectory().endpoints.length, 0);
});

it('crawler still adds hosts with a valid {version:1,resources:[...]} well-known', async () => {
  clearDirectoryCache();
  globalThis.fetch = probeMock({
    'stableenrich.example': (url) => url.endsWith('/.well-known/x402')
      ? new Response(JSON.stringify({ version: 1, resources: ['/api/enrich'], description: 'Enrichment API' }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('Not Found', { status: 404 }),
  }) as any;
  const result = JSON.parse((await handler()({ max_results: 5 })).content[0].text);
  assert.equal(result.new_services_added, 1);
  const endpoints = readDirectory().endpoints;
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].base_url, 'https://stableenrich.example');
});

it('crawled entries are stamped source: "discovery" (#19 trust-level baseline)', async () => {
  clearDirectoryCache();
  globalThis.fetch = probeMock({
    'stamped.example': (url) => url.endsWith('/.well-known/x402')
      ? new Response(JSON.stringify({ version: 1, resources: ['/x'], description: 'd' }), { status: 200 })
      : new Response('Not Found', { status: 404 }),
  }) as any;
  const result = JSON.parse((await handler()({ max_results: 5 })).content[0].text);
  assert.equal(result.new_services_added, 1);
  const [entry] = readDirectory().endpoints;
  assert.equal(entry.source, 'discovery', '#18.2/#18.7: crawled additions carry discovery provenance');
});

it('crawler enables a host via root 402 PAYMENT-REQUIRED challenge with correct chain', async () => {
  clearDirectoryCache();
  const challenge = JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', payTo: '0xWALLET' }],
  });
  const b64 = Buffer.from(challenge).toString('base64');
  globalThis.fetch = probeMock({
    'claw402-2.example': (url) => url === 'https://claw402-2.example'
      ? new Response('Payment Required', { status: 402, headers: { 'payment-required': b64 } })
      : new Response('Not Found', { status: 404 }),
  }) as any;
  const result = JSON.parse((await handler()({ max_results: 5 })).content[0].text);
  assert.equal(result.new_services_added, 1);
  assert.equal(result.services[0].chains[0], 'base');
});

it('crawler finds the 402 challenge via openapi.json GET paths when the root is an HTML landing page', async () => {
  clearDirectoryCache();
  const challenge = JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', payTo: '0xWALLET' }],
  });
  const b64 = Buffer.from(challenge).toString('base64');
  globalThis.fetch = probeMock({
    'landing.example': (url) => {
      if (url === 'https://landing.example') return new Response(HTML_CATCH_ALL, { status: 200, headers: { 'content-type': 'text/html' } });
      if (url === 'https://landing.example/openapi.json') {
        return new Response(JSON.stringify({ openapi: '3.0.0', info: { title: 'X' }, paths: { '/api/data': { get: {} } } }), { status: 200 });
      }
      if (url === 'https://landing.example/api/data') {
        return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64 } });
      }
      return new Response('Not Found', { status: 404 });
    },
  }) as any;
  const result = JSON.parse((await handler()({ max_results: 5 })).content[0].text);
  assert.equal(result.new_services_added, 1);
  assert.equal(result.services[0].chains[0], 'base');
});

it('crawler derives chains from SIWX supportedChains when accepts is empty', async () => {
  clearDirectoryCache();
  const challenge = JSON.stringify({
    x402Version: 2,
    accepts: [],
    extensions: { 'sign-in-with-x': { supportedChains: [{ chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }] } },
  });
  const b64 = Buffer.from(challenge).toString('base64');
  globalThis.fetch = probeMock({
    'siwx.example': (url) => url === 'https://siwx.example'
      ? new Response('Payment Required', { status: 402, headers: { 'payment-required': b64 } })
      : new Response('Not Found', { status: 404 }),
  }) as any;
  const result = JSON.parse((await handler()({ max_results: 5 })).content[0].text);
  assert.equal(result.new_services_added, 1);
  assert.deepEqual(result.services[0].chains, ['solana']);
});

it('crawler prefers a real service name and strips a leading www. from the hostname fallback', async () => {
  clearDirectoryCache();
  globalThis.fetch = probeMock({
    'www.named.example': (url) => url.endsWith('/.well-known/x402')
      ? new Response(JSON.stringify({ version: 1, resources: ['/x'], name: undefined }), { status: 200 })
      : url.endsWith('/.well-known/ai-catalog.json')
        ? new Response(JSON.stringify({ name: 'RealName', description: 'd' }), { status: 200 })
        : new Response('Not Found', { status: 404 }),
  }) as any;
  const result = JSON.parse((await handler()({ max_results: 5 })).content[0].text);
  assert.equal(result.new_services_added, 1);
  assert.equal(result.services[0].name, 'RealName');
});

it('crawler falls back to the homepage source when the primary /all page is non-OK', async () => {
  clearDirectoryCache();
  const before = readDirectory().endpoints.length;
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === X402SCAN_SOURCES[0]) return new Response('Not Found', { status: 404 });
    if (url === X402SCAN_SOURCES[1]) return resourcesPage(['fallback-host.example']);
    if (url === 'https://fallback-host.example/.well-known/x402') {
      return new Response(JSON.stringify({ version: 1, resources: ['/api/x'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ max_results: 5 })).content[0].text);
  assert(!('error' in result), 'fallback success must keep the summary shape');
  assert.equal(result.new_services_added, 1);
  assert.equal(result.services[0].url, 'https://fallback-host.example');
  assert.equal(readDirectory().endpoints.length, before + 1, 'fallback-discovered host must land in the on-disk directory');
});

it('crawler fails loudly naming every candidate when all sources return non-OK', async () => {
  clearDirectoryCache();
  globalThis.fetch = (async () => new Response('Service Unavailable', { status: 503 })) as any;
  const result = JSON.parse((await handler()({ max_results: 5 })).content[0].text);
  assert.match(result.error, /Failed to crawl x402scan: all sources failed/);
  for (const source of X402SCAN_SOURCES) {
    assert.match(result.error, new RegExp(source.replace(/[/.]/g, '\\$&') + ' returned HTTP 503'));
  }
  assert.strictEqual(result.new_services_added, undefined);
  assert(!('urls_scraped' in result), 'failure must not be reported as an empty success summary');
});

it('crawler fails loudly when every candidate throws (unreachable), not just non-OK', async () => {
  clearDirectoryCache();
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as any;
  const result = JSON.parse((await handler()({ max_results: 5 })).content[0].text);
  assert.match(result.error, /all sources failed/);
  assert.match(result.error, /ECONNREFUSED/);
  assert.strictEqual(result.new_services_added, undefined);
  assert(!('urls_scraped' in result));
});

it('directory page returning non-OK (404) returns an error string, never new_services_added: 0', async () => {
  clearDirectoryCache();
  const before = readDirectory().endpoints.length;
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    // The directory page itself is dead; no fallback saves us either.
    if (url === X402SCAN_SOURCES[0]) return new Response('<!doctype html><title>404</title>', { status: 404 });
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ max_results: 5 })).content[0].text);
  assert.notEqual(result.error, undefined, 'parsed result must have .error defined');
  assert.equal(typeof result.error, 'string');
  assert.match(result.error, /Failed to crawl x402scan: all sources failed/);
  assert.match(result.error, /HTTP 404/);
  assert(!('new_services_added' in result), 'failure must not be reported as new_services_added: 0');
  assert.strictEqual(result.new_services_added, undefined, 'MUST NOT report new_services_added: 0 as success');
  assert(!('urls_scraped' in result), 'failure must not be reported as urls_scraped: 0');
  assert.equal(readDirectory().endpoints.length, before, 'directory must not change on a failed crawl');
});
