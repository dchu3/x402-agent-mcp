import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Issue #80: a FREE response is paid:false and is never a payment row.
//
// USD leg — pre-#80 (grok-bot's finding): a 200 settled with NOTHING signed
// (a free endpoint) fell through the paid-flow accounting: rowStatus
// "success", a ledger row at amount 0, `paid: true` in the output, and
// recordSettledAmount(url, 0) dragging the per-service price baseline to 0.
// Every fixture below answers 200 on the FIRST request (nothing is ever
// signed or sent) and asserts: exactly one network request, paid:false,
// served:true where the paid flow answered, cost_usdc 0, NO ledger row, and
// an untouched price baseline.
//
// Casper leg — the two-state flag `paid: authorized() > 0n && status ===
// 'success'` contradicted the #54 tri-state rule: a sent-but-unverified
// Casper authorization reported paid:false. It is now tri-state (true only on
// a verified success receipt; "unknown" when authorized > 0 and unverified;
// false otherwise), and no payment row is written when nothing was
// authorized.
//
// Hermetic: globalThis.fetch mocks (no sockets), temp ledger/directory/state,
// throwaway runtime keys. Public protocol identifiers only.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-free-response-test-'));
process.env.X402_NETWORK_MODE = 'mainnet'; // issue #59: name the MAINNET mode explicitly — set BEFORE the env capture so every afterEach restore keeps it
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
process.env.X402_STATE_DIR = join(dir, 'state');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-25' }), 'utf8');

const EVM_KEY = generatePrivateKey();
process.env.EVM_PRIVATE_KEY = EVM_KEY;
env.EVM_PRIVATE_KEY = EVM_KEY;

const { registerFetchTool } = await import('./fetch.js');
const { WCSPR_ASSETS } = await import('../casper/accepts.js') as any;

const originalFetch = globalThis.fetch;

// Public protocol identifiers.
const BASE_CAIP2 = 'eip155:8453';
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_PAYTO = '0x2222222222222222222222222222222222222222';

const b64url = (s: string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function handler() {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

function ledgerRows(): any[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function hasPaymentHeader(input: unknown, init: unknown): boolean {
  const headers = new Headers(input instanceof Request ? input.headers : (init as any)?.headers);
  return headers.has('payment-signature') || headers.has('x-payment');
}

/** A request-counting fetch mock: every request gets onRequest(i); returns
 * the mock so tests can assert contact counts and that nothing was signed. */
function countingFetch(onRequest: (index: number, signed: boolean) => Response) {
  const calls: Array<{ signed: boolean }> = [];
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const sgn = hasPaymentHeader(input, init);
    calls.push({ signed: sgn });
    return onRequest(calls.length, sgn);
  }) as any;
  return calls;
}

function freeResponse(body = '{"result":"ok"}') {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A legacy (asset-less) chargeable probe — the SDK passes the later request
 * through without signing (the #25 compat path), so the 200 that follows is
 * settled with nothing signed: exactly a free response inside the paid flow. */
function legacyChallenge() {
  const payload = JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: 'exact', network: BASE_CAIP2, amount: '10000', payTo: BASE_PAYTO, extra: { name: 'USDC' } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
}

async function baselineOf(host: string) {
  const store = await import('../policy/anomaly-store.js') as typeof import('../policy/anomaly-store.js');
  return store.getBaseline(host);
}

for (const method of ['GET', 'POST'] as const) {
  it(`issue #80: a free ${method} answered 200 on the first request, WITH a forced chain ⇒ exactly 1 request, paid:false, no payment row, untouched baseline`, async () => {
    const url = `https://free-${method.toLowerCase()}-forced-test.invalid/api`;
    const body = method === 'POST' ? '{"q":1}' : undefined;
    const calls = countingFetch(() => freeResponse());
    const before = ledgerRows().length;
    const result = await handler()({ url, method, ...(body ? { body } : {}), chain: 'base' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(calls.length, 1, 'exactly one network contact (the probe; the SDK first request rides the replay, issue #61)');
    assert.equal(calls.every((c) => !c.signed), true, 'nothing was ever signed');
    assert.equal(parsed.status, 200);
    assert.equal(parsed.paid, false, 'a free response is not paid — the pre-#80 flow reported paid:true');
    assert.equal(parsed.served, true);
    assert.equal(parsed.cost_usdc, 0);
    assert.equal(parsed.authorization_sent, false);
    assert.equal(ledgerRows().length, before, 'NO payment row — a free response is not spend');
    assert.equal(await baselineOf('free-' + method.toLowerCase() + '-forced-test.invalid'), undefined, 'a free response must not move the per-service price baseline');
  });

  it(`issue #80: a free ${method} answered 200 on the first request, WITHOUT a chain (auto-detect) ⇒ exactly 1 request, paid:false, no payment row`, async () => {
    const url = `https://free-${method.toLowerCase()}-auto-test.invalid/api`;
    const body = method === 'POST' ? '{"q":1}' : undefined;
    const calls = countingFetch(() => freeResponse());
    const before = ledgerRows().length;
    const result = await handler()({ url, method, ...(body ? { body } : {}) });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(calls.length, 1, 'exactly one network contact — the probe itself answered');
    assert.equal(parsed.status, 200);
    assert.equal(parsed.paid, false, 'the never-402 path also reports paid:false (nothing was paid)');
    assert.equal(ledgerRows().length, before, 'NO payment row');
  });
}

it('issue #80: an unsigned pass-through inside the paid flow (legacy chargeable probe, then a 200 with nothing signed) is paid:false with no payment row and no baseline movement', async () => {
  const url = 'https://free-unsigned-passthrough-test.invalid/api';
  const calls = countingFetch((index, _signed) => (index === 1 ? legacyChallenge() : freeResponse()));
  const before = ledgerRows().length;
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(calls.length, 2, 'probe (402) + the SDK first request (network: the legacy offer is not replayed, issue #61)');
  assert.equal(calls.every((c) => !c.signed), true, 'the SDK never created a payload — nothing signed or sent');
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, false, 'a 200 with nothing signed is free, not paid');
  assert.equal(parsed.served, true);
  assert.equal(parsed.cost_usdc, 0);
  assert.equal(ledgerRows().length, before, 'NO payment row — the pre-#80 flow wrote a success/0 row here');
  assert.equal(await baselineOf('free-unsigned-passthrough-test.invalid'), undefined, 'the baseline never moved (the pre-#80 flow dragged it to 0)');
});

it('issue #80: the signed happy path still reports paid:true and still writes the success row (control)', async () => {
  const url = 'https://free-control-test.invalid/api';
  const chargeable = (requestUrl: string) => {
    const payload = JSON.stringify({
      x402Version: 2,
      resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
      accepts: [{ scheme: 'exact', network: BASE_CAIP2, asset: BASE_USDC_ADDRESS, amount: '10000', payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
    });
    return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
  };
  const calls = countingFetch(() => chargeable(url));
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const sgn = hasPaymentHeader(input, init);
    calls.push({ signed: sgn });
    return sgn ? freeResponse() : chargeable(url);
  }) as any;
  const before = ledgerRows().length;
  const result = await handler()({ url, chain: 'base' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true, 'a signed settlement is paid — unchanged');
  assert.equal(parsed.cost_usdc, 0.01);
  assert.equal(calls.filter((c) => c.signed).length, 1);
  assert.equal(ledgerRows().length, before + 1, 'exactly one ledger row (the signed settlement)');
  assert.equal(ledgerRows().at(-1)?.status, 'success');
});

// ---------------------------------------------------------------------------
// Casper: the tri-state paid flag + no row when nothing was authorized.
// ---------------------------------------------------------------------------

function casperChallenge() {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: 'https://example.invalid', description: '', mimeType: 'text/plain' },
    accepts: [{ scheme: 'exact', network: 'casper:casper', asset: WCSPR_ASSETS['casper:casper'], payTo: '00' + 'ab'.repeat(32), amount: '1000000000', maxTimeoutSeconds: 60, extra: { name: 'Wrapped CSPR', version: '1' } }],
  });
  return new Response(payload, { status: 402, headers: { 'payment-required': Buffer.from(payload).toString('base64') } });
}

it('issue #80: Casper authorized-but-unverified ⇒ paid:"unknown" (the #54 tri-state rule), with the counted authorized_unserved row', async () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL = '1';
  process.env.CASPER_MAX_DAILY_SPEND = '10';
  process.env.CASPER_PRIVATE_KEY = '11'.repeat(32);
  const url = 'https://casper-unverified-test.invalid/api';
  let sawSigned = false;
  countingFetch((_i, signed) => {
    if (!signed) return casperChallenge();
    sawSigned = true;
    return freeResponse(); // 200 but NO payment-response receipt: authorized, unverified
  });
  const before = ledgerRows().length;
  const result = await handler()({ url, chain: 'casper' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(sawSigned, true, 'the Casper authorization was signed and sent');
  assert.equal(parsed.authorized_motes, '1000000000');
  assert.equal(parsed.paid, 'unknown', 'sent-but-unverified is NEVER paid:false after a send — and not paid:true without a verified receipt');
  const row = ledgerRows().slice(before).find((r: any) => r.url === url);
  assert.ok(row, 'the sent authorization is audited');
  assert.equal(row.status, 'authorized_unserved', 'the send counts until its own validity ends (issue #54)');
  assert.equal(row.amount_motes, '1000000000');
});

it('issue #80: a Casper response with NOTHING authorized is paid:false and writes no payment row', async () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL = '1';
  process.env.CASPER_MAX_DAILY_SPEND = '10';
  process.env.CASPER_PRIVATE_KEY = '11'.repeat(32);
  const url = 'https://casper-free-test.invalid/api';
  const calls = countingFetch((_i, signed) => {
    if (!signed && calls.length === 1) return casperChallenge(); // probe: chargeable challenge
    if (!signed) return freeResponse(); // the Casper leg's unpaid request: free 200
    throw new Error('nothing may be signed in this scenario');
  });
  const before = ledgerRows().length;
  const result = await handler()({ url, chain: 'casper' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.authorized_motes, '0');
  assert.equal(parsed.paid, false, 'nothing authorized ⇒ not paid');
  assert.equal(ledgerRows().filter((r) => r.url === url).length, 0, 'no payment row when nothing was authorized');
  assert.equal(ledgerRows().length, before, 'ledger untouched by the free Casper response');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_DIRECTORY_PATH: join(dir, 'endpoints.json'), X402_STATE_DIR: join(dir, 'state') };
});
after(() => {
  process.env = env;
  rmSync(dir, { recursive: true, force: true });
});
