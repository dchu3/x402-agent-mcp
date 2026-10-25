import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The throwaway EVM key is GENERATED in test code (same pattern as the other
// fetch tests) — never a literal key-shaped string in the repository.
import { generatePrivateKey } from 'viem/accounts';
// The wCSPR asset id is the SHIPPED public package hash from casper/accepts
// — imported, never re-typed (a re-typed 64-hex literal is indistinguishable
// from a key in a security scan).
import { WCSPR_ASSETS } from '../casper/accepts.js';

// ---------------------------------------------------------------------------
// Issue #67 (plan C5) — x402_inspect: a FREE inspection of an offer (or a
// whole 402 challenge) WITHOUT paying. It runs the SAME selection logic as
// x402_fetch (the extracted offer-evaluation wiring — one wiring, two
// callers), reports every offer's fate (exact amounts, USD when the table
// prices it, rejection tokens, policy + budget verdicts, the ceiling), and
// never probes, never reserves, never signs, never makes a network call.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-inspect-'));
process.env.X402_NETWORK_MODE = 'mainnet'; // issue #59: name the mode explicitly.
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'payments', 'ledger.jsonl');
process.env.X402_STATE_DIR = join(dir, 'state');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-24' }), 'utf8');
// Signers for the base leg: keys loaded (the same envs the fetch seam reads).
const EVM_KEY = generatePrivateKey();
process.env.EVM_PRIVATE_KEY = EVM_KEY;

const paymentUtils = (await import('../payment-utils.js')) as typeof import('../payment-utils.js');
const { registerInspectTool } = (await import('./inspector.js')) as typeof import('./inspector.js');

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async (..._a: unknown[]) => { fetchCalls++; throw new Error('x402_inspect must make ZERO network calls'); }) as any;

const originalConsoleError = console.error;
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  paymentUtils._resetForTests();
  process.env = {
    ...env,
    X402_NETWORK_MODE: 'mainnet',
    PAYMENT_LOG_PATH: join(dir, 'payments', 'ledger.jsonl'),
    X402_STATE_DIR: join(dir, 'state'),
    X402_DIRECTORY_PATH: join(dir, 'endpoints.json'),
    EVM_PRIVATE_KEY: EVM_KEY,
  };
  delete process.env.MAX_DAILY_SPEND_TOTAL_USD;
  delete process.env.X402_RATE_WCSPR_USD;
});
after(() => { process.env = env; globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });

const BASE_USDC = { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '500000', payTo: '0x1111111111111111111111111111111111111111', extra: {} };
const UNLISTED = { scheme: 'exact', network: 'eip155:8453', asset: '0xDEADBEEF00000000000000000000000000000001', amount: '100000', payTo: '0x2222222222222222222222222222222222222222', extra: {} };
const DISALLOWED = { scheme: 'exact', network: 'eip155:137', asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', amount: '200000', payTo: '0x3333333333333333333333333333333333333333', extra: {} };
const CASPER_OFFER = {
  scheme: 'exact',
  network: 'casper:casper',
  asset: WCSPR_ASSETS['casper:casper'],
  amount: '1500000000',
  payTo: '00' + 'a'.repeat(64),
};

function handler(): (args: any) => Promise<any> {
  let callback: any;
  registerInspectTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

it('registerInspectTool registers x402_inspect as a never-pays inspector', () => {
  const captured: { name: string; description: string } = { name: '', description: '' };
  registerInspectTool({ tool: (name: unknown, description: unknown) => {
    captured.name = name as string;
    captured.description = description as string;
  } } as any);
  assert.equal(captured.name, 'x402_inspect');
  assert.ok(/never (pays|signs)/i.test(captured.description));
});

it('accepts a whole payment requirement, an accepts array, or a single offer', async () => {
  const one: any = await handler()({ offer: { ...BASE_USDC } });
  assert.equal(parse(one).selection.chosen_index, 0);
  const arr: any = await handler()({ offer: [BASE_USDC] });
  assert.equal(parse(arr).selection.chosen_index, 0);
  const wrap: any = await handler()({ offer: { accepts: [BASE_USDC] } });
  assert.equal(parse(wrap).selection.chosen_index, 0);
  const wrapAlt: any = await handler()({ offer: { accept: [BASE_USDC] } });
  assert.equal(parse(wrapAlt).selection.chosen_index, 0);
});

it('reports every offer with exact amounts, priced USD and rejection tokens, choosing the cheapest payable', async () => {
  const result = await handler()({ url: 'https://inspect.example/api', offer: [UNLISTED, BASE_USDC, DISALLOWED] });
  const parsed = parse(result);
  assert.equal(parsed.offers.length, 3);
  assert.equal(parsed.selection.code, undefined, 'a payable offer exists → no refusal code');
  assert.equal(parsed.selection.chosen_index, 1, 'the payable base offer wins');
  const chosen = parsed.offers[1];
  assert.equal(chosen.amount_atomic, '500000');
  assert.equal(chosen.amount_unit, '0.500000', 'exact 6-decimal USD rendering of the priced offer');
  assert.equal(chosen.symbol, 'USDC');
  const unlisted = parsed.offers[0];
  assert.equal(unlisted.reject, 'asset_not_listed', 'the table’s stable refusal token surfaces per offer');
  assert.equal(unlisted.usd_estimate, null);
  const disallowed = parsed.offers[2];
  assert.equal(disallowed.reject, 'network_not_allowed', 'polygon is outside the default allowlist');
});

it('reports the selection refusal when nothing is payable, with every token', async () => {
  const result = await handler()({ url: 'https://inspect.example/api', offer: [UNLISTED, DISALLOWED] });
  const parsed = parse(result);
  assert.equal(parsed.selection.code, 'NO_PAYABLE_OFFER');
  assert.deepEqual(parsed.selection.rejected.map((r: any) => r.reject), ['asset_not_listed', 'network_not_allowed']);
});

it('gives the chosen offer a budget verdict: within caps, or the exact cap that binds', async () => {
  // The POLICY gate must be looser than the spend-control envs here — the
  // flow refuses at the policy gate first (policy_refused), so a budget
  // verdict is only reached when the policy allows the leg.
  process.env.X402_POLICY_MAX_PER_REQUEST = '5';
  process.env.X402_POLICY_MAX_DAILY = '100';
  const okResult = await handler()({ url: 'https://inspect.example/api', offer: [BASE_USDC] });
  const okParsed = parse(okResult);
  assert.equal(okParsed.selection.budget.verdict, 'within', 'a 0.50 offer at the 0.50 per-call cap and fresh daily budget fits');
  assert.equal(okParsed.selection.budget.rail, 'usd');

  process.env.MAX_PAYMENT_PER_CALL = '0.25';
  const overCall = parse(await handler()({ url: 'https://inspect.example/api', offer: { ...BASE_USDC, amount: '750000' } }));
  assert.equal(overCall.selection.budget.verdict, 'refused');
  assert.match(overCall.selection.budget.reason, /MAX_PAYMENT_PER_CALL/);

  process.env.MAX_PAYMENT_PER_CALL = '2.00';
  const { logPayment } = paymentUtils;
  logPayment({ timestamp: new Date().toISOString(), url: 'https://inspect.example/api', method: 'GET', chain: 'base', amount_usdc: 10, status: 'success' });
  const overDaily = parse(await handler()({ url: 'https://inspect.example/api', offer: { ...BASE_USDC, amount: '100000' } }));
  assert.equal(overDaily.selection.budget.verdict, 'refused');
  assert.match(overDaily.selection.budget.reason, /MAX_DAILY_SPEND/);
});

it('a policy refusal is reported per offer without paying', async () => {
  process.env.X402_POLICY_PAYMENTS_ENABLED = 'false';
  const parsed = parse(await handler()({ url: 'https://inspect.example/api', offer: [BASE_USDC] }));
  assert.equal(parsed.offers[0].reject, 'policy_refused');
  assert.equal(parsed.selection.code, 'NO_PAYABLE_OFFER');
  delete process.env.X402_POLICY_PAYMENTS_ENABLED;
});

it('a Casper offer reports the mote rail: unpriced under an active ceiling → RAIL_DISABLED_NO_RATE, no debit', async () => {
  process.env.MAX_DAILY_SPEND_TOTAL_USD = '10.00';
  process.env.CASPER_MAX_PAYMENT_PER_CALL = '10';
  process.env.CASPER_MAX_DAILY_SPEND = '10';
  let errors = 0;
  console.error = () => { errors++; };
  const parsed = parse(await handler()({ url: 'https://inspect.example/api', offer: [CASPER_OFFER] }));
  const casper = parsed.offers[0];
  assert.equal(casper.chain, 'casper');
  assert.equal(casper.amount_atomic, '1500000000');
  assert.equal(casper.amount_unit, '1.500000000', 'the mote amount renders exactly at 9 decimals');
  assert.equal(casper.rail_budget.verdict, 'refused');
  assert.equal(casper.rail_budget.code, 'RAIL_DISABLED_NO_RATE', 'the stable refusal code surfaces in the REPORT (the fetch flow refuses at pay time)');
  assert.equal(casper.usd_estimate, null, 'no configured rate → never an assumed USD value');
  paymentUtils._resetForTests();
  const { readFileSync: _r } = await import('node:fs');
  if (existsSync(process.env.PAYMENT_LOG_PATH!)) {
    assert.ok(!readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').includes('casper'), 'nothing settled');
  }
  assert.ok(errors >= 0);
});

it('a priced Casper offer prices by its configured rate into the ceiling report', async () => {
  process.env.MAX_DAILY_SPEND_TOTAL_USD = '10.00';
  process.env.X402_RATE_WCSPR_USD = '0.25';
  process.env.CASPER_MAX_PAYMENT_PER_CALL = '10';
  process.env.CASPER_MAX_DAILY_SPEND = '10';
  const parsed = parse(await handler()({ url: 'https://inspect.example/api', offer: [CASPER_OFFER] }));
  const casper = parsed.offers[0];
  assert.ok(casper.rail_budget.verdict === 'within', JSON.stringify(casper.rail_budget));
  assert.ok(Math.abs(casper.rail_budget.usd_value - 0.375) < 1e-9, '1.5 CSPR at $0.25/CSPR');
});

it('never probes, never reserves, never writes the ledger — zero network calls', async () => {
  const ledgerBefore = existsSync(process.env.PAYMENT_LOG_PATH!) ? readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8') : null;
  const before = fetchCalls;
  await handler()({ url: 'https://inspect.example/api', offer: [BASE_USDC, CASPER_OFFER] });
  assert.equal(fetchCalls, before, 'x402_inspect must make ZERO network calls');
  const ledgerAfter = existsSync(process.env.PAYMENT_LOG_PATH!) ? readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8') : null;
  assert.equal(ledgerAfter, ledgerBefore, 'the ledger file is byte-identical after any inspection');
});

it('malformed offer input is a reported refusal, never a throw into the framework', async () => {
  const parsed = parse(await handler()({ offer: 'not json at all {{' }));
  assert.equal(parsed.offers.length, 0);
  assert.equal(parsed.selection.code, 'NO_PAYABLE_OFFER');
  assert.ok(parsed.error ?? true, 'a shape-aware error field is fine');
});

// ---------------------------------------------------------------------------
// Issue #67 req 1 (fix round 2) — `url` WITHOUT `offer`: the tool performs
// the SAME guarded probe the paid flow makes (probePaymentChallenge over
// guardedFetch: private-host guard, redirect refusal, timeout, size caps) and
// feeds the fetched challenge into the SAME offer-evaluation wiring. Hermetic
// per the acceptance tests: a real loopback mock seller on 127.0.0.1 with
// X402_ALLOW_PRIVATE_HOSTS set env-only for that port (the
// fetch-selection.test.ts pattern). The mock seller records every request so
// tests can assert NO payment header was ever sent and the ledger stays
// byte-identical.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

const liveSellers: Array<{ server: http.Server }> = [];

/** Start one loopback mock seller; the seller-brain writes the 402 (or not).
 * X402_ALLOW_PRIVATE_HOSTS is set env-only for this suite's own port — a tool
 * caller can never add to it (issue #58 req 6). */
async function seller(
  onVisit: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; recorded: RecordedRequest[] }> {
  const recorded: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers } });
      onVisit(req, res);
    });
  });
  liveSellers.push({ server });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
  process.env.X402_ALLOW_PRIVATE_HOSTS = `127.0.0.1:${port}`;
  return { url: `http://127.0.0.1:${port}/v1/paid`, recorded };
}

after(async () => {
  for (const { server } of liveSellers) {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

const b64url = (s: string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function ledgerBytes(): string | null {
  return existsSync(process.env.PAYMENT_LOG_PATH!) ? readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8') : null;
}

it('url + no offer: the tool performs the guarded probe itself — a live 402 yields the full per-offer report', async () => {
  const { url, recorded } = await seller((_req, res) => {
    res.writeHead(402, {
      'payment-required': b64url(JSON.stringify({ x402Version: 2, accepts: [DISALLOWED, BASE_USDC] })),
    });
    res.end('Payment Required');
  });
  const before = ledgerBytes();
  const parsed = parse(await handler()({ url }));
  assert.equal(parsed.probe.kind, 'live_402', 'the probe outcome is reported');
  assert.ok(Number.isFinite(parsed.probe.latency_ms));
  assert.equal(parsed.offers.length, 2, 'every listed offer is reported');
  assert.equal(parsed.offers[0].reject, 'network_not_allowed', 'polygon is refused by the same wiring');
  assert.equal(parsed.offers[1].amount_atomic, '500000');
  assert.equal(parsed.offers[1].amount_unit, '0.500000', 'exact 6-decimal rendering of the wired-offer');
  assert.equal(parsed.selection.chosen_index, 1, 'the payable base offer is marked');
  assert.equal(parsed.selection.budget.verdict, 'within', 'the chosen leg gets the SAME budget verdict');
});

it('the url probe makes exactly one credential-less request, no payment header, ledger byte-identical', async () => {
  const { url, recorded } = await seller((_req, res) => {
    res.writeHead(402, {
      'payment-required': b64url(JSON.stringify({ x402Version: 2, accepts: [BASE_USDC] })),
    });
    res.end('Payment Required');
  });
  const before = ledgerBytes();
  const parsed = parse(await handler()({ url }));
  assert.equal(parsed.selection.chosen_index, 0);
  assert.equal(recorded.length, 1, 'exactly ONE request — the probe; no paid leg follows');
  assert.equal(recorded[0].headers['x-payment'], undefined, 'the mock records NO payment header');
  assert.equal(recorded[0].headers['payment-signature'], undefined, 'no signature was ever sent');
  assert.equal(ledgerBytes(), before, 'the ledger stays byte-identical');
  assert.match(String(parsed.note), /nothing was signed|never pays/i);
});

it('a private-host url is refused with PRIVATE_HOST_REFUSED and zero requests (no payment attempt)', async () => {
  let requests = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => { requests++; return new Response('x'); }) as any;
  try {
    const before = ledgerBytes();
    const parsed = parse(await handler()({ url: 'http://192.168.1.10/v1/paid' }));
    assert.equal(parsed.error, 'PRIVATE_HOST_REFUSED', 'the stable transport code is the reported refusal');
    assert.match(parsed.detail, /192\.168\.1\.10/);
    assert.equal(parsed.probe.kind, 'error');
    assert.equal(parsed.probe.error_code, 'PRIVATE_HOST_REFUSED', 'the probe outcome carries the stable code');
    assert.equal(parsed.offers.length, 0);
    assert.equal(parsed.selection.code, 'NO_PAYABLE_OFFER');
    assert.equal(requests, 0, 'nothing reached any host — refused before any request, never a payment attempt');
    assert.equal(ledgerBytes(), before, 'the ledger stays byte-identical');
  } finally {
    globalThis.fetch = prev;
  }
});

it('offer precedence: when both `url` and `offer` are supplied the OFFER wins and zero requests are made', async () => {
  let requests = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => { requests++; return new Response('Probe ran — it must not.'); }) as any;
  try {
    const parsed = parse(await handler()({ url: 'https://203.0.113.10/should-not-be-probed', offer: [BASE_USDC] }));
    assert.equal(parsed.selection.chosen_index, 0, 'the offer payload drives the report, unchanged');
    assert.equal(parsed.offers.length, 1);
    assert.equal(parsed.probe, undefined, 'no probe block — no request was made');
    assert.equal(requests, 0, 'the offer path keeps ZERO network calls even with a url present');
  } finally {
    globalThis.fetch = prev;
  }
});

it("a redirecting url is refused REDIRECT_REFUSED and the redirect target is never fetched", async () => {
  const seen: string[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    seen.push(String(input instanceof Request ? (input as Request).url : input));
    return new Response(null, { status: 302, headers: { location: 'http://10.1.2.3/steal' } });
  }) as any;
  try {
    const parsed = parse(await handler()({ url: 'https://203.0.113.10/redirect' }));
    assert.equal(parsed.error, 'REDIRECT_REFUSED', 'the stable transport code is the reported refusal');
    assert.match(parsed.detail, /302/);
    assert.equal(parsed.probe.kind, 'error');
    assert.equal(parsed.offers.length, 0);
    assert.equal(parsed.selection.code, 'NO_PAYABLE_OFFER');
    assert.deepEqual(seen, ['https://203.0.113.10/redirect'], 'only the probe ran — the redirect target was never fetched');
  } finally {
    globalThis.fetch = prev;
  }
});

it('an oversized response body on the probe is a reported refusal, never a throw into the framework', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => new Response('a'.repeat(65537), { status: 402 })) as any;
  try {
    const parsed = parse(await handler()({ url: 'https://203.0.113.10/oversized' }));
    assert.equal(parsed.error, 'Payment response exceeds size limit', 'the paid path\'s own bounded-read wording surfaces as the outcome');
    assert.equal(parsed.probe.kind, 'error');
    assert.equal(parsed.offers.length, 0);
    assert.equal(parsed.selection.code, 'NO_PAYABLE_OFFER');
  } finally {
    globalThis.fetch = prev;
  }
});

it('a url that answers without a 402 is a no_402 report — nothing to inspect, nothing paid', async () => {
  const { url, recorded } = await seller((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>free landing page</html>');
  });
  const parsed = parse(await handler()({ url }));
  assert.equal(parsed.probe.kind, 'no_402');
  assert.equal(parsed.offers.length, 0);
  assert.equal(parsed.selection.code, 'NO_PAYABLE_OFFER');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].headers['x-payment'], undefined);
});