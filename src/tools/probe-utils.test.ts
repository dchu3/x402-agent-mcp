import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { parseChainFromNetwork, probePaymentChallenge } from './probe-utils.js';

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
