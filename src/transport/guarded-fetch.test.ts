import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedFetch } from './guard.js';

// Issue #58 C3 — guardedFetch is THE one fetch for the probe, the paid leg,
// health, crawl and the shared probe utils. These tests pin:
//   1. a 3xx is refused (REDIRECT_REFUSED) and never followed — the Location
//      target is never fetched;
//   2. private/loopback literals are refused with ZERO fetch calls and the
//      stable PRIVATE_HOST_REFUSED code (issue #58 req 4);
//   3. plain http for a public host is refused (HTTP_NOT_ALLOWED);
//   4. an allowlisted loopback host passes through (the mock-seller path);
//   5. every tool surfaces the guard refusal as { error, detail } BEFORE any
//      payment attempt — for x402_fetch the ledger must stay untouched.
//
// All network is the mocked globalThis.fetch — no live HTTP, no real DNS
// (refused hosts are literals; passing hosts are .invalid names that cannot
// resolve).

const env = { ...process.env };
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...env }; });
after(() => { process.env = env; });

const originalFetch = globalThis.fetch;

function redirectAnswer(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

async function refusalOf(p: Promise<Response>): Promise<{ code: string; detail: string }> {
  try {
    await p;
    assert.fail('guardedFetch must refuse');
  } catch (err: any) {
    return { code: err.code, detail: err.detail };
  }
  throw new Error('unreachable');
}

it('guardedFetch refuses a 3xx with REDIRECT_REFUSED and NEVER fetches the redirect target', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    seen.push(String(input));
    return redirectAnswer(302, 'http://10.1.2.3/steal'); // Location points at a private host
  }) as any;
  const refused = await refusalOf(guardedFetch('https://redirector.invalid/v1'));
  assert.equal(refused.code, 'REDIRECT_REFUSED');
  assert.match(refused.detail, /302/);
  assert.deepEqual(seen, ['https://redirector.invalid/v1'], 'the Location target is never fetched');
});

it('guardedFetch refuses every 3xx class it can see (301 and 307 alike)', async () => {
  globalThis.fetch = (async () => redirectAnswer(301, 'https://elsewhere.invalid/')) as any;
  assert.equal((await refusalOf(guardedFetch('https://r301.invalid/'))).code, 'REDIRECT_REFUSED');
  globalThis.fetch = (async () => redirectAnswer(307, 'https://elsewhere.invalid/')) as any;
  assert.equal((await refusalOf(guardedFetch('https://r307.invalid/'))).code, 'REDIRECT_REFUSED');
});

it('guardedFetch refuses private literals with ZERO fetch calls (refused before any request)', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('x'); }) as any;
  for (const raw of ['http://127.0.0.1:8080/', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[fe80::1]/']) {
    const refused = await refusalOf(guardedFetch(raw));
    assert.equal(refused.code, 'PRIVATE_HOST_REFUSED', raw);
  }
  assert.equal(calls, 0, 'nothing may be sent to a refused host');
});

it('guardedFetch refuses plain http for a public host (HTTP_NOT_ALLOWED) and https passes through', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('ok'); }) as any;
  assert.equal((await refusalOf(guardedFetch('http://93.184.216.34/x'))).code, 'HTTP_NOT_ALLOWED');
  assert.equal(calls, 0, 'http-to-public is refused before any request');
  assert.equal((await guardedFetch('https://93.184.216.34/x')).status, 200, 'https for a public host is fine');
  assert.equal(calls, 1);
});

it('guardedFetch lets an allowlisted loopback host through (http + https)', async () => {
  let calls = 0;
  process.env.X402_ALLOW_PRIVATE_HOSTS = '127.0.0.1:8931';
  globalThis.fetch = (async () => { calls++; return new Response('ok'); }) as any;
  assert.equal((await guardedFetch('http://127.0.0.1:8931/v1/paid')).status, 200);
  assert.equal(calls, 1);
});

// ---- tool surfacing: every tool renders { error, detail } before payment ----

const { registerFetchTool } = await import('../tools/fetch.js');
const { registerHealthCheckTool } = await import('../tools/health.js');
const { registerCrawlX402ScanTool, X402SCAN_SOURCES } = await import('../tools/crawl-directory.js');
const { probePaymentChallenge, fetchRootPaymentChallenge, fetchJson } = await import('../tools/probe-utils.js');

// Isolate ledger + directory for the fetch tool (the repo test pattern).
const dir = mkdtempSync(join(tmpdir(), 'x402-guarded-fetch-'));
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-24' }), 'utf8');

after(() => { rmSync(dir, { recursive: true, force: true }); });

function handlerFor(register: (s: any) => void) {
  let callback: any;
  register({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

it('x402_fetch refuses a private host BEFORE any request and any payment (stable code, zero fetches, empty ledger)', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('x'); }) as any;
  const result = JSON.parse((await handlerFor(registerFetchTool)({ url: 'http://169.254.169.254/latest/meta-data/' })).content[0].text);
  assert.equal(result.error, 'PRIVATE_HOST_REFUSED');
  assert.match(result.detail, /refused before any request/);
  assert.equal(calls, 0, 'no request, no payment attempt');
  assert.equal(existsSync(process.env.PAYMENT_LOG_PATH!), false, 'the refusal never reaches the payment ledger');
});

it('x402_fetch probe renders REDIRECT_REFUSED instead of following or throwing an indistinct error', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    seen.push(String(input));
    return redirectAnswer(302, 'http://10.1.2.3/x');
  }) as any;
  const result = JSON.parse((await handlerFor(registerFetchTool)({ url: 'https://redirect-probe.invalid/api' })).content[0].text);
  assert.equal(result.error, 'REDIRECT_REFUSED');
  assert.equal(seen.length, 1, 'only the probe ran — the redirect target was never fetched');
});

it('x402_health refuses private hosts and redirects with the stable codes', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('x'); }) as any;
  const refused = JSON.parse((await handlerFor(registerHealthCheckTool)({ url: 'http://10.1.2.3/' })).content[0].text);
  assert.equal(refused.error, 'PRIVATE_HOST_REFUSED', 'private host refusal is the structured stable code');
  assert.equal(calls, 0);

  globalThis.fetch = (async () => redirectAnswer(302, 'https://elsewhere.invalid/')) as any;
  const redirected = JSON.parse((await handlerFor(registerHealthCheckTool)({ url: 'https://health-redirect.invalid/' })).content[0].text);
  assert.equal(redirected.error, 'REDIRECT_REFUSED', 'a redirecting health target is refused, never followed');
});

it('x402_crawl_directory refuses a redirecting listing source and names the code (both sources down → loud error)', async () => {
  globalThis.fetch = (async (input: unknown) => {
    return redirectAnswer(302, 'https://elsewhere.invalid/'); // any source redirects
  }) as any;
  const result = JSON.parse((await handlerFor(registerCrawlX402ScanTool)({ max_results: 5 })).content[0].text);
  assert.ok(typeof result.error === 'string' && /REDIRECT_REFUSED/.test(result.error),
    'the scraped listing must never be followed — the refusal names the stable code');
});

it('the shared probe utils refuse private targets: null for the silent helpers, a stable error outcome for the liveness probe', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('x'); }) as any;
  assert.equal(await fetchJson('http://192.168.0.1/.well-known/x402'), null);
  assert.equal(await fetchRootPaymentChallenge('http://10.0.0.1/'), null);
  const probe = await probePaymentChallenge('http://127.0.0.1:9/paid');
  assert.equal(probe.kind, 'error', 'a refused host is NEVER a no_402 liveness verdict');
  assert.equal(probe.error?.startsWith('PRIVATE_HOST_REFUSED: '), true, `stable code prefix, got: ${probe.error}`);
  assert.equal(calls, 0, 'nothing is sent to refused hosts from any probe helper');
});

it('the shared probe utils refuse redirects (REDIRECT_REFUSED), never follow', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return redirectAnswer(302, 'http://10.1.2.3/x'); }) as any;
  const probe = await probePaymentChallenge('https://redirect-probe.invalid/');
  assert.equal(probe.kind, 'error');
  assert.equal(probe.error?.startsWith('REDIRECT_REFUSED: '), true, `stable code prefix, got: ${probe.error}`);
  assert.equal(calls, 1, 'one answered request — the redirect target was never fetched');
  assert.equal(await fetchJson('https://redirect-json.invalid/'), null);
  assert.equal(await fetchRootPaymentChallenge('https://redirect-json.invalid/'), null);
  assert.equal(calls, 3, 'each helper answered once; no follow-up fetches');
});

it('X402SCAN_SOURCES are fetched through the guard (the scraper cannot bypass it)', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    seen.push(url);
    if (url === X402SCAN_SOURCES[0]) return redirectAnswer(302, 'http://10.1.2.3/');
    return new Response('<html>404</html>', { status: 404 });
  }) as any;
  await handlerFor(registerCrawlX402ScanTool)({});
  assert.deepEqual(seen, [X402SCAN_SOURCES[0], X402SCAN_SOURCES[1]], 'only the two listing sources were requested; the redirect target was never fetched');
});