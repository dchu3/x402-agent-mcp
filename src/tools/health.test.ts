import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHealthCheckTool } from './health.js';

// Hermetic directory (issue #37): a `name`-based lookup resolves through
// loadDirectory(); without an X402_DIRECTORY_PATH override that reads the
// operator's LIVE gitignored endpoints.json. Pin the suite to an empty temp
// directory (the fetch.test.ts repo pattern) so directory data never leaks in.
const dir = mkdtempSync(join(tmpdir(), 'x402-health-test-'));
const env = { ...process.env };
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-09-25' }), 'utf8');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...env, X402_DIRECTORY_PATH: join(dir, 'endpoints.json') }; });
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

function handler() {
  let callback: any;
  registerHealthCheckTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

const urlOf = (input: any) => String(input instanceof Request ? input.url : input);

const v1WellKnown = {
  x402_version: 1,
  payment_scheme: 'exact',
  seller_wallet: 'SoLWallet111',
  endpoints: [{ path: '/api/paid', method: 'GET', price_usdc: '0.01' }],
};

it('root 200 HTML + /.well-known/x402 v1 payment fields -> x402_enabled true via fallback', async () => {
  globalThis.fetch = (async (input: any) => {
    const url = urlOf(input);
    if (url === 'https://svm402.com/.well-known/x402') {
      return new Response(JSON.stringify(v1WellKnown), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://svm402.com') {
      return new Response('<html>landing</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ url: 'https://svm402.com' })).content[0].text);
  assert.equal(result.live, true);
  assert.equal(result.status_code, 200);
  assert.equal(result.x402_enabled, true);
  assert.ok(result.probe_url.endsWith('/.well-known/x402'));
  assert.ok(result.note.length > 0);
});

it('root 200, no PAYMENT-REQUIRED header, no well-known payment fields -> x402_enabled false, live true', async () => {
  globalThis.fetch = (async (input: any) => {
    const url = urlOf(input);
    if (url === 'https://free.example') {
      return new Response('<html>free site</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ url: 'https://free.example' })).content[0].text);
  assert.equal(result.live, true);
  assert.equal(result.status_code, 200);
  assert.equal(result.x402_enabled, false);
});

it('root 402 -> x402_enabled true (existing path)', async () => {
  globalThis.fetch = (async () => new Response('Payment Required', { status: 402 })) as any;
  const result = JSON.parse((await handler()({ url: 'https://pay.example' })).content[0].text);
  assert.equal(result.live, true);
  assert.equal(result.status_code, 402);
  assert.equal(result.x402_enabled, true);
});

it('response_time_ms is a real measured elapsed number (not hardcoded 0)', async () => {
  globalThis.fetch = (async () => {
    await new Promise((r) => setTimeout(r, 40));
    return new Response('Payment Required', { status: 402 });
  }) as any;
  const result = JSON.parse((await handler()({ url: 'https://slow.example' })).content[0].text);
  assert.equal(typeof result.response_time_ms, 'number');
  assert.ok(result.response_time_ms >= 30, `expected >= 30ms, got ${result.response_time_ms}`);
});
