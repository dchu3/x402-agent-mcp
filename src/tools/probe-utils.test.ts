import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import {
  openApiProbePaths,
  parseChainFromNetwork,
  probeChallengeAcross,
  probePaymentChallenge,
  probePlaceholderUrl,
} from './probe-utils.js';

// Issue #32 — parseChainFromNetwork resolves the REAL CAIP-2 id through the
// shared EVM vocabulary instead of collapsing every eip155:* to "base".
// Fail-closed contract: an unknown eip155:* returns VERBATIM (policy then
// denies it — CHAIN_NOT_ALLOWED under the default allowlist), and a string
// merely CONTAINING "8453" never claims EVM at all.

it('known EVM CAIP-2 ids resolve to their aliases', () => {
  assert.equal(parseChainFromNetwork('eip155:8453'), 'base');
  assert.equal(parseChainFromNetwork('eip155:84532'), 'base-sepolia');
  assert.equal(parseChainFromNetwork('eip155:137'), 'polygon');
  assert.equal(parseChainFromNetwork('eip155:42161'), 'arbitrum');
  assert.equal(parseChainFromNetwork('eip155:1'), 'ethereum');
});

it('padded eip155 spellings resolve through the same vocabulary (numeric canonicalization, review follow-up)', () => {
  assert.equal(parseChainFromNetwork('eip155:08453'), 'base');
  assert.equal(parseChainFromNetwork('eip155:01'), 'ethereum', 'a padded L1 id resolves to ethereum — policy hard-denies it');
  assert.equal(parseChainFromNetwork('eip155:010'), 'eip155:10', 'unknown padded ids keep their canonical identity');
});

it('an unknown eip155:* network returns VERBATIM — never "base" (the #32 bug fix)', () => {
  assert.equal(parseChainFromNetwork('eip155:10'), 'eip155:10', 'Optimism keeps its real identity; policy denies it');
  assert.equal(parseChainFromNetwork('eip155:56'), 'eip155:56');
  assert.equal(parseChainFromNetwork('eip155:999999'), 'eip155:999999');
});

it('8453-containing non-EVM strings never claim EVM (substring collapse removed)', () => {
  assert.equal(parseChainFromNetwork('8453'), '8453');
  assert.equal(parseChainFromNetwork('prefix-8453-suffix'), 'prefix-8453-suffix');
  assert.equal(parseChainFromNetwork('eip155'), 'eip155');
  assert.equal(parseChainFromNetwork('eip155:'), 'eip155:');
  assert.equal(parseChainFromNetwork('not-eip155:8453'), 'not-eip155:8453');
});

it('solana detection is unchanged', () => {
  assert.equal(parseChainFromNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), 'solana');
  assert.equal(parseChainFromNetwork('solana'), 'solana');
  assert.equal(parseChainFromNetwork('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), 'solana');
});

it('casper detection is unchanged', () => {
  assert.equal(parseChainFromNetwork('casper:casper'), 'casper');
  assert.equal(parseChainFromNetwork('casper:casper-test'), 'casper');
  assert.equal(parseChainFromNetwork('casper-test'), 'casper');
});

it('EVM aliases and unrecognised chains pass through the raw fallback unchanged', () => {
  assert.equal(parseChainFromNetwork('polygon'), 'polygon');
  assert.equal(parseChainFromNetwork('arbitrum'), 'arbitrum');
  assert.equal(parseChainFromNetwork('weird-chain'), 'weird-chain');
  assert.equal(parseChainFromNetwork(''), '');
});

// ---------------------------------------------------------------------------
// Issue #38 — bounded multi-path candidate discovery. A root-only probe
// records a permanent no_402 for the common "free landing page at root, 402
// on an API path" shape, so these helpers build a BOUNDED candidate list
// (placeholders substituted in the request URL only, noise-filtered openapi
// discovery) and walk it with early exit. All network is the mocked
// globalThis.fetch — no live HTTP in tests.
// ---------------------------------------------------------------------------

describe('probePlaceholderUrl — request-URL-only param substitution (issue #38, P3)', () => {
  it('a trailing * becomes x402-probe', () => {
    assert.equal(probePlaceholderUrl('/price/*'), '/price/x402-probe');
  });

  it('{...} in a path segment becomes x402-probe', () => {
    assert.equal(probePlaceholderUrl('/safety/{address}'), '/safety/x402-probe');
    assert.equal(probePlaceholderUrl('/price/{address}'), '/price/x402-probe');
  });

  it('{...} in a query string becomes x402-probe (the measured 2s.io shape)', () => {
    assert.equal(probePlaceholderUrl('/api/weather/zip?zip={zipcode}'), '/api/weather/zip?zip=x402-probe');
  });

  it('multiple placeholders in one URL are all substituted', () => {
    assert.equal(
      probePlaceholderUrl('/x/{a}/y/{b}?q={c}&r=1'),
      '/x/x402-probe/y/x402-probe?q=x402-probe&r=1',
    );
  });

  it('a URL without placeholders is byte-identical (configured paths stay verbatim)', () => {
    for (const p of ['/weather/current?city=London', '/api', '/v2', '/', '', '/a/b/c?q=1&x=2']) {
      assert.equal(probePlaceholderUrl(p), p);
    }
  });

  it('only a TRAILING * is substituted — an interior * is left verbatim', () => {
    assert.equal(probePlaceholderUrl('/a/*/b'), '/a/*/b');
  });
});

describe('openApiProbePaths — noise-filtered, capped discovery candidates (issue #38, P2)', () => {
  // The measured live shape of plan fact 3: the hugen host's /openapi.json
  // lists three FREE paths ahead of the paid ones — findPaymentChallenge's
  // 3-path insertion-order budget spent itself on the noise and never
  // reached /weather/current. The filter must drop the noise BEFORE the cap.
  const hugenSpec = {
    paths: {
      '/.well-known/x402': { get: {} },
      '/health': { get: {} },
      '/llms.txt': { get: {} },
      '/weather/current': { get: {} },
      '/weather/forecast': { get: {} },
    },
  };

  it('noise is dropped first, paid paths kept in insertion order (the measured #38 fixture)', () => {
    assert.deepEqual(openApiProbePaths(hugenSpec), ['/weather/current', '/weather/forecast']);
  });

  it('GET-only: post/put-only paths are dropped, mixed-method paths kept', () => {
    const spec = { paths: { '/a': { post: {} }, '/b': { get: {}, post: {} }, '/c': { put: {} } } };
    assert.deepEqual(openApiProbePaths(spec), ['/b']);
  });

  it('the cap is honoured AFTER noise filtering, order preserved (default 8, custom limit)', () => {
    const paths: Record<string, any> = {};
    for (let i = 1; i <= 12; i++) paths[`/d${i}`] = { get: {} };
    assert.deepEqual(openApiProbePaths({ paths }), Array.from({ length: 8 }, (_, i) => `/d${i + 1}`));
    assert.deepEqual(openApiProbePaths({ paths }, 3), ['/d1', '/d2', '/d3']);
  });

  it('every noise shape from the plan is dropped, including /.well-known/* prefixes', () => {
    const spec = {
      paths: {
        '/.well-known/x402': { get: {} },
        '/.well-known/other': { get: {} },
        '/robots.txt': { get: {} },
        '/favicon.ico': { get: {} },
        '/openapi.json': { get: {} },
        '/llms.txt': { get: {} },
        '/health': { get: {} },
        '/paid': { get: {} },
      },
    };
    assert.deepEqual(openApiProbePaths(spec), ['/paid']);
  });

  it('junk specs yield [] — never throws', () => {
    for (const s of [null, undefined, 42, 'x', [], {}, { paths: null }, { paths: 'x' }, { paths: {} }]) {
      assert.deepEqual(openApiProbePaths(s), []);
    }
  });
});

describe('probeChallengeAcross — the bounded aggregate walk (issue #38, P5/P6)', () => {
  const challenge = () => {
    const payload = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', payTo: '0xabc' }] };
    return new Response('Payment Required', { status: 402, headers: { 'payment-required': probeB64url(JSON.stringify(payload)) } });
  };

  it('the first live_402 wins, probe_url is that exact URL, later candidates are never fetched', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url === 'https://w.example/') return new Response('landing', { status: 200 });
      if (url === 'https://w.example/current') return challenge();
      throw new Error(`unexpected probe target ${url}`);
    }) as any;
    const out = await probeChallengeAcross(['https://w.example/', 'https://w.example/current', 'https://w.example/forecast']);
    assert.equal(out.result.kind, 'live_402');
    assert.equal(out.result.challenge?.accepts?.[0]?.network, 'eip155:8453', 'the winning challenge is carried verbatim');
    assert.equal(out.probe_url, 'https://w.example/current');
    assert.deepEqual(seen, ['https://w.example/', 'https://w.example/current'], 'early exit — the tail is never fetched');
  });

  it('no_402 when at least one candidate answered — even if later candidates error', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url === 'https://w.example/free') return new Response('free', { status: 200 });
      throw new Error(`simulated network failure for ${url}`);
    }) as any;
    const out = await probeChallengeAcross(['https://w.example/free', 'https://w.example/down']);
    assert.equal(out.result.kind, 'no_402', 'an answered candidate beats a later error (P5)');
    assert.equal(out.probe_url, 'https://w.example/free', 'the first answered candidate is reported');
    assert.equal(out.result.challenge, undefined);
    assert.equal(out.result.error, undefined);
    assert.deepEqual(seen, ['https://w.example/free', 'https://w.example/down']);
  });

  it('error when EVERY candidate throws — diagnostic from the last attempt, probe_url is the last URL', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      seen.push(String(input));
      throw new Error(`ECONNREFUSED simulated for ${String(input)}`);
    }) as any;
    const out = await probeChallengeAcross(['https://down.example/a', 'https://down.example/b']);
    assert.equal(out.result.kind, 'error');
    assert.match(out.result.error ?? '', /ECONNREFUSED.*b/, 'the last attempt carries the diagnostic');
    assert.equal(out.probe_url, 'https://down.example/b');
    assert.deepEqual(seen, ['https://down.example/a', 'https://down.example/b']);
  });

  it('the walk is capped (default 5; explicit limit honoured) — beyond-cap URLs are never fetched', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      seen.push(String(input));
      return new Response('free', { status: 200 });
    }) as any;
    const seven = Array.from({ length: 7 }, (_, i) => `https://cap.example/${i}`);
    const out = await probeChallengeAcross(seven);
    assert.equal(out.result.kind, 'no_402');
    assert.equal(out.probe_url, 'https://cap.example/0', 'the first answered candidate is reported');
    assert.deepEqual(seen, seven.slice(0, 5), 'only the first 5 candidates are walked (P4)');

    seen.length = 0;
    const liveBeyondCap = Array.from({ length: 7 }, (_, i) => `https://cap.example/${i}`);
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url === 'https://cap.example/5') return challenge();
      return new Response('free', { status: 200 });
    }) as any;
    const outLive = await probeChallengeAcross(liveBeyondCap);
    assert.equal(outLive.result.kind, 'no_402', 'a live_402 beyond the cap is never reached — the cap holds');
    assert.equal(outLive.probe_url, 'https://cap.example/0');
    assert.equal(seen.length, 5, 'exactly 5 candidates fetched');

    seen.length = 0;
    const out2 = await probeChallengeAcross(['https://cap.example/a', 'https://cap.example/b', 'https://cap.example/c'], 10000, 2);
    assert.equal(out2.result.kind, 'no_402');
    assert.equal(out2.probe_url, 'https://cap.example/a', 'an explicit limit is honoured');
    assert.deepEqual(seen, ['https://cap.example/a', 'https://cap.example/b']);
  });

  it('duplicate URLs are fetched once (exact-string dedup, P4)', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      seen.push(String(input));
      return new Response('free', { status: 200 });
    }) as any;
    const out = await probeChallengeAcross(['https://d.example/x', 'https://d.example/x', 'https://d.example/x']);
    assert.equal(out.result.kind, 'no_402');
    assert.equal(out.probe_url, 'https://d.example/x');
    assert.deepEqual(seen, ['https://d.example/x'], 'exact-string duplicates collapse to one request');
  });

  it('zero URLs ⇒ a deterministic error outcome, never a throw', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('x'); }) as any;
    const out = await probeChallengeAcross([]);
    assert.equal(out.result.kind, 'error');
    assert.match(out.result.error ?? '', /no candidate/i);
    assert.equal(out.probe_url, '');
    assert.equal(calls, 0, 'nothing to probe ⇒ zero network');
  });
});

// ---------------------------------------------------------------------------
// Issue #34 — probePaymentChallenge: the DISCRIMINATED liveness probe. Unlike
// fetchRootPaymentChallenge (which collapses "answered, no 402" and "network
// error/timeout" into the same null), this classifies live_402 / no_402 /
// error so the directory's liveness record can tell a dead host from a free
// one. All network is the mocked globalThis.fetch — no live HTTP in tests.
// ---------------------------------------------------------------------------

const probeB64url = (s: string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('probePaymentChallenge — the discriminated liveness probe (issue #34)', () => {
  it('a 402 with a decodable payment-required header is live_402 and carries the parsed challenge', async () => {
    const seen: Array<{ url: unknown; init: any }> = [];
    globalThis.fetch = (async (url: unknown, init: any) => {
      seen.push({ url, init });
      const payload = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', payTo: '0xabc' }] };
      return new Response('Payment Required', { status: 402, headers: { 'payment-required': probeB64url(JSON.stringify(payload)) } });
    }) as any;
    const result = await probePaymentChallenge('https://probe.invalid/api');
    assert.equal(result.kind, 'live_402');
    assert.equal(result.challenge.accepts[0].network, 'eip155:8453', 'the parsed challenge object is carried verbatim');
    assert.equal(result.error, undefined);
    assert.ok(Number.isFinite(result.latency_ms) && result.latency_ms >= 0, 'latency is always recorded');
    assert.equal(seen.length, 1, 'exactly one request');
    assert.equal(seen[0].init.redirect, 'error', 'redirects are never followed');
  });

  it('a 402 whose header is missing or undecodable is no_402 (answered, but nothing decodable)', async () => {
    for (const header of [undefined, '!!!not-base64!!!', Buffer.from('{broken json').toString('base64')]) {
      globalThis.fetch = (async () => new Response('Payment Required', {
        status: 402,
        headers: header === undefined ? {} : { 'payment-required': header },
      })) as any;
      const result = await probePaymentChallenge('https://probe.invalid/api');
      assert.equal(result.kind, 'no_402', `header ${String(header)} must not classify as live`);
      assert.equal(result.challenge, undefined, 'no_402 never invents a challenge');
      assert.equal(result.error, undefined);
    }
  });

  it('any non-402 answered response is no_402 — never live by HTTP status alone', async () => {
    for (const status of [200, 301, 404, 500]) {
      globalThis.fetch = (async () => new Response('body', { status })) as any;
      const result = await probePaymentChallenge('https://probe.invalid/api');
      assert.equal(result.kind, 'no_402', `status ${status} is an answer, not liveness`);
      assert.equal(result.challenge, undefined);
      assert.equal(result.error, undefined);
    }
  });

  it('a thrown fetch is error with the diagnostic carried — and never live', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED simulated'); }) as any;
    const result = await probePaymentChallenge('https://down.invalid/api');
    assert.equal(result.kind, 'error');
    assert.match(result.error ?? '', /ECONNREFUSED/);
    assert.equal(result.challenge, undefined);
    assert.ok(Number.isFinite(result.latency_ms) && result.latency_ms >= 0);
  });

  it('an aborted probe (timeout) is error, never live_402', async () => {
    globalThis.fetch = (async (_url: unknown, init: any) => {
      const signal: AbortSignal = init.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    }) as any;
    const started = Date.now();
    const result = await probePaymentChallenge('https://slow.invalid/api', 20);
    assert.equal(result.kind, 'error', 'a timeout records an error — never a live result');
    assert.match(result.error ?? '', /abort/i);
    assert.ok(result.latency_ms >= 10, 'latency reflects the real wait');
    assert.ok(Date.now() - started < 5000, 'the timeout must actually cut the probe short');
  });
});
