import { strict as assert } from 'node:assert';
import { afterEach, it } from 'node:test';
import { registerBatchDiscoverTool } from './batch-discover.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function handler() {
  let callback: any;
  registerBatchDiscoverTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

const HTML_CATCH_ALL = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>';

it('HTML catch-all host: 200 HTML well-known must NOT be marked x402_enabled and must not throw', async () => {
  globalThis.fetch = (async (_input: any) => new Response(HTML_CATCH_ALL, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })) as any;
  const result = JSON.parse((await handler()({ urls: ['https://spa-catchall.example'] })).content[0].text);
  const entry = result.results[0];
  assert.equal(entry.x402_enabled, false);
  assert.equal(entry.error, undefined);
  assert.deepEqual(entry.chains, []);
  assert.equal(result.x402_enabled, 0);
});

it('invalid JSON body with JSON content-type must NOT be marked x402_enabled and must not throw', async () => {
  globalThis.fetch = (async (_input: any) => new Response('{not json', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as any;
  const result = JSON.parse((await handler()({ urls: ['https://bad.example'] })).content[0].text);
  assert.equal(result.results[0].x402_enabled, false);
  assert.equal(result.results[0].error, undefined);
});

it('regression: {version:1,resources:[...]} well-known stays x402_enabled', async () => {
  const wellKnown = JSON.stringify({
    version: 1,
    resources: ['https://stableenrich.dev/api/enrich'],
    description: 'Enrichment API',
  });
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/.well-known/x402')) {
      return new Response(wellKnown, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ urls: ['https://stableenrich.dev'] })).content[0].text);
  assert.equal(result.results[0].x402_enabled, true);
});

it('regression: accepts-shaped well-known stays enabled and chains are parsed', async () => {
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/.well-known/x402')) {
      return new Response(JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', payTo: '0xWALLET' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ urls: ['https://x.example'] })).content[0].text);
  const entry = result.results[0];
  assert.equal(entry.x402_enabled, true);
  assert.deepEqual(entry.chains, ['base']);
});

it('non-JSON scalar/array well-known bodies are not x402-enabled', async () => {
  for (const body of ['"just a string"', '[1,2,3]', '42', 'null']) {
    globalThis.fetch = (async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/.well-known/x402')) {
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Not Found', { status: 404 });
    }) as any;
    const result = JSON.parse((await handler()({ urls: ['https://scalar.example'] })).content[0].text);
    assert.equal(result.results[0].x402_enabled, false, `body ${body} must not enable x402`);
  }
});

it('token4u.ai shape: 500 JSON well-known + 200 text/html ai-catalog -> not enabled, no throw', async () => {
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/.well-known/x402')) {
      return new Response('{"error":"Internal Server Error"}', { status: 500, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/.well-known/ai-catalog.json')) {
      return new Response(HTML_CATCH_ALL, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ urls: ['https://token4u.ai'] })).content[0].text);
  const entry = result.results[0];
  assert.equal(entry.x402_enabled, false);
  assert.equal(entry.error, undefined);
  assert.deepEqual(entry.chains, []);
  assert.ok(entry.notes?.some((n: string) => /no valid x402 manifest/i.test(n)));
});

it('socialx402.com/stabletravel.dev shape: 404 well-known + root 402 challenge -> enabled (regression: was false negative)', async () => {
  const mk = (network: string, payTo: string) => {
    const challenge = JSON.stringify({ x402Version: 2, accepts: [{ scheme: 'exact', network, amount: '10000', payTo }] });
    return Buffer.from(challenge).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const challenges: Record<string, string> = {
    'https://socialx402.com': mk('eip155:8453', '0xSOCIAL'),
    'https://stabletravel.dev': mk('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'SoLTravel'),
  };
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (challenges[url]) {
      return new Response('Payment Required', { status: 402, headers: { 'payment-required': challenges[url] } });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ urls: ['https://socialx402.com', 'https://stabletravel.dev'] })).content[0].text);
  assert.equal(result.x402_enabled, 2);
  const [social, travel] = result.results;
  assert.equal(social.x402_enabled, true);
  assert.deepEqual(social.chains, ['base']);
  assert.equal(travel.x402_enabled, true);
  assert.deepEqual(travel.chains, ['solana']);
  for (const entry of result.results) {
    assert.ok(entry.notes?.some((n: string) => /fell back to root 402/i.test(n)));
  }
});

it('404 well-known but root 402 PAYMENT-REQUIRED challenge -> enabled with correct chain', async () => {
  const challenge = JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '5000', payTo: 'SoLWallet' }],
  });
  const b64url = Buffer.from(challenge).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://claw402-ai.example') {
      return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url } });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ urls: ['https://claw402-ai.example'] })).content[0].text);
  const entry = result.results[0];
  assert.equal(entry.x402_enabled, true);
  assert.deepEqual(entry.chains, ['solana']);
  assert.ok(entry.notes?.some((n: string) => /fell back to root 402/i.test(n)));
});

it('404 well-known with HTML ai-catalog catch-all stays disabled', async () => {
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/.well-known/x402')) return new Response('Not Found', { status: 404 });
    return new Response(HTML_CATCH_ALL, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as any;
  const result = JSON.parse((await handler()({ urls: ['https://nothere.example'] })).content[0].text);
  assert.equal(result.results[0].x402_enabled, false);
});

it('valid ai-catalog service name is still extracted', async () => {
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/.well-known/x402')) {
      return new Response(JSON.stringify({ version: 1, resources: ['/pay'] }), { status: 200 });
    }
    if (url.endsWith('/.well-known/ai-catalog.json')) {
      return new Response(JSON.stringify({ name: 'MyService' }), { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
  const result = JSON.parse((await handler()({ urls: ['https://svc.example'] })).content[0].text);
  const entry = result.results[0];
  assert.equal(entry.x402_enabled, true);
  assert.equal(entry.service_name, 'MyService');
});
