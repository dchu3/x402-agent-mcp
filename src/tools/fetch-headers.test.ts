import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';

// Issue #64 — optional extra request headers for sellers that need them,
// DENY-BY-DEFAULT. A real loopback mock seller (node:http on 127.0.0.1)
// records the headers every leg actually sends:
//   request 1 = the free 402 probe (x402_fetch's own guardedFetch)
//   request 2 = the SDK's first request (wrapFetchWithPayment's initial call)
//   request 3 = the signed paid retry (same Request + X-PAYMENT)
// so req 1 (one identity across probe + SDK-first + paid leg) is proven on
// the wire, not against a stub.
//
// Test isolation: X402_ALLOW_PRIVATE_HOSTS=127.0.0.1:<port> is set HERE, in
// this suite's own env (issue #58 req 6: the allowlist is env-only — a tool
// caller cannot extend it); X402_EXTRA_HEADER_ALLOWLIST is set per test.
// The key below is generated at runtime (throwaway); no real keys.

const dir = mkdtempSync(join(tmpdir(), 'x402-fetch-headers-test-'));
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-24' }), 'utf8');

// Throwaway EVM key: EIP-3009 payment payloads sign fully offline, so the
// paid leg completes against the loopback seller without any RPC.
const EVM_KEY = generatePrivateKey();
process.env.EVM_PRIVATE_KEY = EVM_KEY;
env.EVM_PRIVATE_KEY = EVM_KEY; // survive afterEach restores

const { registerFetchTool } = await import('./fetch.js');

const BASE_CAIP2 = 'eip155:8453';
// Public protocol identifiers (same convention as fetch.test.ts): the USDC
// contract on Base is an asset ID, not a secret.
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_PAYTO = '0x2222222222222222222222222222222222222222';
const RECEIPT_B64 = Buffer.from(JSON.stringify({ success: true, transaction: 'ab'.repeat(32) })).toString('base64');

const b64url = (s: string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

const liveSellers: Array<{ server: http.Server; recorded: RecordedRequest[] }> = [];

/** Start one loopback seller: returns its base URL, its recorder and sets
 * X402_ALLOW_PRIVATE_HOSTS for this suite's own env. */
async function seller(): Promise<{ url: string; recorded: RecordedRequest[] }> {
  const recorded: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers } });
      if (req.headers['x-payment'] !== undefined || req.headers['payment-signature'] !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json', 'payment-response': RECEIPT_B64 });
        res.end('{"ok":true}');
        return;
      }
      const port = (server.address() as { port?: number })?.port ?? 0;
      const payload = JSON.stringify({
        x402Version: 2,
        resource: { url: `http://127.0.0.1:${port}${req.url ?? '/'}`, description: '', mimeType: 'text/plain' },
        accepts: [{ scheme: 'exact', network: BASE_CAIP2, asset: BASE_USDC_ADDRESS, amount: '10000', payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
      });
      res.writeHead(402, { 'content-type': 'application/json', 'payment-required': b64url(payload) });
      res.end('Payment Required');
    });
  });
  liveSellers.push({ server, recorded });
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
  // Issue #58 req 6: the private-host allowlist is env-only — THIS suite sets
  // it for its own loopback port; a tool caller can never add to it.
  process.env.X402_ALLOW_PRIVATE_HOSTS = `127.0.0.1:${port}`;
  return { url: `http://127.0.0.1:${port}/v1/paid`, recorded };
}

afterEach(() => {
  process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_DIRECTORY_PATH: join(dir, 'endpoints.json'), EVM_PRIVATE_KEY: env.EVM_PRIVATE_KEY };
});
after(async () => {
  process.env = env;
  for (const { server } of liveSellers) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function handler() {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

function ledgerLines(): any[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

const MARKER = `x402-hdr-value-${Math.random().toString(36).slice(2)}`;

// ---------------------------------------------------------------------------
// RED baseline: x402_fetch has no headers argument yet, so every allowlist/
// validation/delivery assertion below fails. C5 (headers argument +
// allowlist + hard deny list + validation) makes them pass.
// ---------------------------------------------------------------------------

it('an allowlisted header reaches the probe, the SDK-first request and the signed paid leg with the SAME value (issue #64 req 1)', async () => {
  process.env.X402_EXTRA_HEADER_ALLOWLIST = 'x-client-id';
  const s = await seller();
  const result = JSON.parse((await handler()({ url: s.url, headers: { 'x-client-id': MARKER } })).content[0].text);
  assert.equal(result.status, 200, 'the paid flow must complete against the loopback seller');
  assert.equal(result.paid, true);
  assert.equal(s.recorded.length, 3, 'probe + SDK-first + signed paid leg (exactly three legs)');
  assert.equal(s.recorded[0].headers['x-client-id'], MARKER, 'the free probe carries the caller header');
  assert.equal(s.recorded[1].headers['x-client-id'], MARKER, 'the SDK-first request carries the caller header');
  assert.equal(s.recorded[2].headers['x-client-id'], MARKER, 'the signed paid leg carries the caller header');
});

it('a header NOT on the allowlist is refused before any request (issue #64 req 2)', async () => {
  process.env.X402_EXTRA_HEADER_ALLOWLIST = 'x-client-id';
  const s = await seller();
  const result = JSON.parse((await handler()({ url: s.url, headers: { 'x-session': MARKER } })).content[0].text);
  assert.equal(result.error, 'HEADER_REFUSED', `stable refusal code, got: ${JSON.stringify(result)}`);
  assert.equal(s.recorded.length, 0, 'no request may be made for a refused header');
  assert.deepEqual(ledgerLines(), [], 'no payment attempt is recorded either');
});

it('every hard-denied header is refused EVEN WHEN allowlisted (issue #64 req 3)', async () => {
  const denied = [
    'authorization', 'cookie', 'proxy-authorization', 'host', 'content-length',
    'transfer-encoding', 'connection', 'payment-required', 'payment-signature',
    'x-payment', 'x-payment-response', 'keep-alive', 'te', 'trailer', 'upgrade',
  ];
  process.env.X402_EXTRA_HEADER_ALLOWLIST = ['x-client-id', ...denied].join(',');
  const s = await seller();
  for (const name of denied) {
    const result = JSON.parse((await handler()({ url: s.url, headers: { [name]: MARKER } })).content[0].text);
    assert.equal(result.error, 'HEADER_REFUSED', `${name} must be refused even though it is allowlisted`);
    assert.match(String(result.detail ?? ''), new RegExp(`\\b${name}\\b`), 'the refusal names the header (names are not secrets; values never are)');
  }
  assert.equal(s.recorded.length, 0, 'no request may be made for any refused header');
});

it('CR, LF and NUL in a value are refused (header injection)', async () => {
  process.env.X402_EXTRA_HEADER_ALLOWLIST = 'x-client-id';
  const s = await seller();
  for (const bad of ['x\r\nEvil: 1', 'x\n', 'x\0', 'x\r']) {
    const result = JSON.parse((await handler()({ url: s.url, headers: { 'x-client-id': bad } })).content[0].text);
    assert.equal(result.error, 'HEADER_REFUSED', `value ${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(s.recorded.length, 0);
});

it('an over-long value is refused; a non-token name is refused; too many headers are refused (issue #64 req 4)', async () => {
  process.env.X402_EXTRA_HEADER_ALLOWLIST = ['x-client-id', ...Array.from({ length: 17 }, (_, i) => `x-extra-${i + 1}`)].join(',');
  const s = await seller();
  // value length cap: 1025 refused (1024 allowed — boundary in its own test)
  const longRefused = JSON.parse((await handler()({ url: s.url, headers: { 'x-client-id': 'a'.repeat(1025) } })).content[0].text);
  assert.equal(longRefused.error, 'HEADER_REFUSED', 'a 1025-char value must be refused');
  assert.equal(s.recorded.length, 0);
  // name token validation: spaces are not RFC 7230 token characters
  const badName = JSON.parse((await handler()({ url: s.url, headers: { 'x client id': MARKER } })).content[0].text);
  assert.equal(badName.error, 'HEADER_REFUSED', 'a non-token name must be refused');
  assert.equal(s.recorded.length, 0);
  // count cap: 17 headers refused
  const tooMany = JSON.parse((await handler()({
    url: s.url,
    headers: Object.fromEntries(['x-client-id', ...Array.from({ length: 16 }, (_, i) => `x-extra-${i + 1}`)].map((n) => [n, MARKER])),
  })).content[0].text);
  assert.equal(tooMany.error, 'HEADER_REFUSED', '17 headers must exceed the count cap');
  assert.equal(s.recorded.length, 0);
});

it('duplicate names differing only by case are refused (issue #64 req 4)', async () => {
  process.env.X402_EXTRA_HEADER_ALLOWLIST = 'x-client-id';
  const s = await seller();
  const result = JSON.parse((await handler()({ url: s.url, headers: { 'X-Client-Id': 'one', 'x-client-id': 'two' } })).content[0].text);
  assert.equal(result.error, 'HEADER_REFUSED', `case-duplicates must be refused, got: ${JSON.stringify(result)}`);
  assert.equal(s.recorded.length, 0);
});

it('a header VALUE never appears in server log output or in the ledger row (issue #64 req 5) — names may (names only)', async () => {
  process.env.X402_EXTRA_HEADER_ALLOWLIST = 'x-client-id';
  const s = await seller();
  const stderrLines: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { stderrLines.push(args.map(String).join(' ')); };
  try {
    const result = JSON.parse((await handler()({ url: s.url, headers: { 'x-client-id': MARKER } })).content[0].text);
    assert.equal(result.status, 200, 'the flow completes so the ledger row exists');
  } finally {
    console.error = origError;
  }
  for (const line of stderrLines) {
    assert.ok(!line.includes(MARKER), `a header VALUE must never be logged — leaked: ${line}`);
  }
  assert.ok(stderrLines.some((l) => /x-client-id/.test(l)), 'the header NAME is logged (names only)');
  const rows = ledgerLines();
  assert.ok(rows.some((r) => r.status === 'success'), 'a settled ledger row exists');
  for (const row of rows) {
    assert.ok(!JSON.stringify(row).includes(MARKER), 'the marker value must never reach the ledger');
    assert.ok(!('headers' in row), 'the ledger row must not carry a headers field at all');
  }
});

it('with NO allowlist, a headers argument is refused by default (deny-by-default)', async () => {
  delete process.env.X402_EXTRA_HEADER_ALLOWLIST;
  const s = await seller();
  const result = JSON.parse((await handler()({ url: s.url, headers: { 'x-client-id': MARKER } })).content[0].text);
  assert.equal(result.error, 'HEADER_REFUSED', `empty allowlist must deny, got: ${JSON.stringify(result)}`);
  assert.equal(s.recorded.length, 0);
});

it('with NO allowlist and NO headers argument, behaviour is unchanged (issue #64 req 6)', async () => {
  delete process.env.X402_EXTRA_HEADER_ALLOWLIST;
  const s = await seller();
  const result = JSON.parse((await handler()({ url: s.url })).content[0].text);
  assert.equal(result.status, 200);
  assert.equal(result.paid, true);
  assert.equal(s.recorded.length, 3);
  assert.ok(s.recorded.every((r) => r.headers['x-client-id'] === undefined), 'no extra header is ever invented');
});

it('boundary: a 1024-char value (exactly at the cap) is delivered on all three legs', async () => {
  process.env.X402_EXTRA_HEADER_ALLOWLIST = 'x-client-id';
  const s = await seller();
  const value = 'b'.repeat(1024);
  const result = JSON.parse((await handler()({ url: s.url, headers: { 'x-client-id': value } })).content[0].text);
  assert.equal(result.status, 200);
  assert.equal(s.recorded.length, 3);
  assert.equal(s.recorded[0].headers['x-client-id'], value);
  assert.equal(s.recorded[1].headers['x-client-id'], value);
  assert.equal(s.recorded[2].headers['x-client-id'], value);
});
