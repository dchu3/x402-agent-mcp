import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the endpoint directory BEFORE importing the tool, so discovery
// can never mutate the repo-root endpoints.json (PAYMENT_LOG_PATH pattern).
const dir = mkdtempSync(join(tmpdir(), 'x402-discover-test-'));
const overridePath = join(dir, 'endpoints.json');
writeFileSync(overridePath, readFileSync(join(import.meta.dirname, '..', '..', 'endpoints.example.json'), 'utf-8'));
const env = { ...process.env };
process.env.X402_DIRECTORY_PATH = overridePath;

const { registerDiscoverUrlTool } = await import('./discover-url.js');
const { clearDirectoryCache } = await import('../directory.js');

const repoRootEndpoints = join(import.meta.dirname, '..', '..', 'endpoints.json');
// endpoints.json at the repo root is gitignored operator data; its absence
// (clean checkout) is the normal case. Snapshot it once at module load if it
// exists so tests can assert — unconditionally — that the discover flow never
// creates, deletes, or modifies it.
const repoRootSnapshot = existsSync(repoRootEndpoints)
  ? createHash('md5').update(readFileSync(repoRootEndpoints)).digest('hex')
  : null;

function assertRepoRootUntouched(): void {
  if (!existsSync(repoRootEndpoints)) {
    assert.equal(repoRootSnapshot, null, 'repo-root endpoints.json must not be created or deleted by the flow');
    return;
  }
  assert.ok(repoRootSnapshot !== null, 'repo-root endpoints.json must not be created by the flow');
  assert.equal(
    createHash('md5').update(readFileSync(repoRootEndpoints)).digest('hex'),
    repoRootSnapshot,
    'repo-root endpoints.json hash must be unchanged'
  );
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; clearDirectoryCache(); process.env = { ...env, X402_DIRECTORY_PATH: overridePath }; });
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

function handler() {
  let callback: any;
  registerDiscoverUrlTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

const b64url = (s: string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function challengeResponse() {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: 'https://x402.twit.sh', description: 'Pay-per-use tweet API', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0xSELLERWALLET',
      maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2' },
    }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
}

const twitShOpenApi = {
  openapi: '3.0.0',
  info: { title: 'Twit.sh API', description: 'Post tweets for a fee' },
  paths: {
    '/api/tweet': { post: { summary: 'Post a tweet', description: 'Posts a tweet to X' } },
    '/api/status': { get: { summary: 'Service status' } },
  },
};

function twitShMock() {
  return async (input: any, _init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://x402.twit.sh/openapi.json') {
      return new Response(JSON.stringify(twitShOpenApi), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://x402.twit.sh') return challengeResponse();
    return new Response('Not Found', { status: 404 });
  };
}

it('twit.sh shape: root 402 PAYMENT-REQUIRED challenge enables x402 with parsed chains', async () => {
  globalThis.fetch = twitShMock() as any;
  const result = JSON.parse((await handler()({ url: 'https://x402.twit.sh' })).content[0].text);
  assert.equal(result.x402_enabled, true);
  assert.deepEqual(result.payment.chains, ['base']);
  assert.equal(result.payment.seller_wallet, '0xSELLERWALLET');
  assert.deepEqual(result.payment.schemes, ['exact']);
  assert.deepEqual(result.payment.tokens, ['USD Coin']);
});

it('twit.sh shape: service info comes from openapi.json fallback with fallback error note', async () => {
  globalThis.fetch = twitShMock() as any;
  const result = JSON.parse((await handler()({ url: 'https://x402.twit.sh' })).content[0].text);
  assert.equal(result.service.name, 'Twit.sh API');
  assert.equal(result.service.description, 'Post tweets for a fee');
  assert.equal(result.service.category, 'other');
  assert.equal(result.service.endpoints.length, 2);
  const post = result.service.endpoints.find((e: any) => e.method === 'POST');
  assert.equal(post.path, '/api/tweet');
  assert.equal(post.price_usdc, '');
  assert.ok(post.description.length <= 120);
  assert.match(post.description, /Post a tweet/);
  assert.ok(result.errors.some((e: string) => /fell back to openapi\.json/i.test(e)));
  assert.ok(result.errors.some((e: string) => /fell back to root 402 payment-required challenge/i.test(e)));
});

it('all sources present: ai-catalog wins over openapi.json and x402 endpoints', async () => {
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/.well-known/x402')) {
      return new Response(JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '5000', payTo: 'SoLWallet', extra: { name: 'USDC' } }],
        endpoints: [{ path: '/from-x402', method: 'GET' }],
      }), { status: 200 });
    }
    if (url.endsWith('/.well-known/ai-catalog.json')) {
      return new Response(JSON.stringify({ name: 'CatalogSvc', description: 'from catalog', category: 'ai', endpoints: [{ path: '/c', method: 'GET', price_usdc: '0.01' }] }), { status: 200 });
    }
    if (url.endsWith('/openapi.json')) {
      return new Response(JSON.stringify({ openapi: '3.0.0', info: { title: 'ShouldNotWin' }, paths: { '/x': { get: {} } } }), { status: 200 });
    }
    if (url.endsWith('/llms.txt')) return new Response('# hi', { status: 200 });
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ url: 'https://example.invalid' })).content[0].text);
  assert.equal(result.x402_enabled, true);
  assert.equal(result.service.name, 'CatalogSvc');
  assert.equal(result.service.category, 'ai');
  assert.equal(result.llms_txt, '# hi');
  assert.equal(result.errors, undefined);
});

it('twit.sh real shape: root 301 landing with no challenge, 402 found by probing openapi GET path', async () => {
  const twitShRealOpenApi = {
    openapi: '3.0.0',
    info: { title: 'Twit.sh API', description: 'Post tweets for a fee' },
    paths: {
      '/api/tweet': { post: { summary: 'Post a tweet' } },
      '/api/status': { get: { summary: 'Service status' } },
    },
  };
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://x402.twit.sh/openapi.json') {
      return new Response(JSON.stringify(twitShRealOpenApi), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://x402.twit.sh/api/status') return challengeResponse();
    if (url === 'https://x402.twit.sh') {
      // 301 to marketing landing page — no PAYMENT-REQUIRED header
      return new Response(null, { status: 301, headers: { location: 'https://twit.sh/landing' } });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ url: 'https://x402.twit.sh' })).content[0].text);
  assert.equal(result.x402_enabled, true);
  assert.deepEqual(result.payment.chains, ['base']);
  assert.equal(result.payment.seller_wallet, '0xSELLERWALLET');
  assert.deepEqual(result.payment.schemes, ['exact']);
  assert.ok(result.errors.some((e: string) => /fell back to 402 challenge on \/api\/status/i.test(e)), JSON.stringify(result.errors));
});

it('openapi GET paths yield no challenge and root has none: x402_enabled false', async () => {
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/openapi.json')) {
      return new Response(JSON.stringify({
        openapi: '3.0.0', info: { title: 'Free API' },
        paths: { '/status': { get: { summary: 's' } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ url: 'https://free.invalid' })).content[0].text);
  assert.equal(result.x402_enabled, false);
  assert.match(result.error, /No \/.well-known\/x402 found — this service may not be x402-enabled/);
});

it('well-known x402 minimal v1 (no accepts): payment info from 402 challenge on openapi GET path', async () => {
  const minimalWellKnown = {
    version: 1,
    resources: ['https://x402.twit.sh/api/tweet'],
    ownershipProofs: [],
    instructions: 'Pay per tweet',
  };
  const openapi = {
    openapi: '3.0.0',
    info: { title: 'Twit.sh API', description: 'Post tweets for a fee' },
    paths: {
      '/api/tweet': { post: { summary: 'Post a tweet' } },
      '/api/status': { get: { summary: 'Service status' } },
    },
  };
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://x402.twit.sh/.well-known/x402') {
      return new Response(JSON.stringify(minimalWellKnown), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://x402.twit.sh/openapi.json') {
      return new Response(JSON.stringify(openapi), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://x402.twit.sh/api/status') return challengeResponse();
    if (url === 'https://x402.twit.sh') {
      // no challenge on root
      return new Response('<html>landing</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ url: 'https://x402.twit.sh' })).content[0].text);
  assert.equal(result.x402_enabled, true);
  assert.deepEqual(result.payment.chains, ['base']);
  assert.equal(result.payment.seller_wallet, '0xSELLERWALLET');
  assert.deepEqual(result.payment.schemes, ['exact']);
  assert.deepEqual(result.payment.tokens, ['USD Coin']);
  assert.ok(
    result.errors.some((e: string) => /well-known x402 has no accepts.*402 challenge on \/api\/status/i.test(e)),
    JSON.stringify(result.errors)
  );
});

it('nothing anywhere: x402_enabled false with existing error message', async () => {
  globalThis.fetch = (async () => new Response('Not Found', { status: 404 })) as any;
  const result = JSON.parse((await handler()({ url: 'https://dead.invalid' })).content[0].text);
  assert.equal(result.x402_enabled, false);
  assert.match(result.error, /No \/.well-known\/x402 found — this service may not be x402-enabled/);
});

it('discover flow adds to the override path only and never touches repo-root endpoints.json', async () => {
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/.well-known/x402')) {
      return new Response(JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '5000', payTo: 'SoLWallet', extra: { name: 'USDC' } }],
        endpoints: [{ path: '/from-x402', method: 'GET' }],
      }), { status: 200 });
    }
    if (url.endsWith('/.well-known/ai-catalog.json')) {
      return new Response(JSON.stringify({ name: 'CatalogSvc', description: 'from catalog', category: 'ai', endpoints: [{ path: '/c', method: 'GET', price_usdc: '0.01' }] }), { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ url: 'https://example.invalid' })).content[0].text);
  assert.equal(result.x402_enabled, true);
  assert.equal(result.service.name, 'CatalogSvc');
  const written = JSON.parse(readFileSync(overridePath, 'utf-8'));
  assert.ok(written.endpoints.some((e: any) => e.base_url === 'https://example.invalid'), 'fixture entry must be written to the override path');
  assertRepoRootUntouched();
});
