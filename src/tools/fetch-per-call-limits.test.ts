import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Issue #80 (R2): per-call narrowing arguments. max_price_usd,
// expected_pay_to and allowed_chains are optional x402_fetch arguments that
// can only NARROW the global policy — the offer must fit inside them (and
// inside the operator's caps) or the call is refused BEFORE anything is
// signed. Pre-#80 the three keys were silently dropped by the SDK's zod
// object (grok-bot's finding: "per-call limits ignored").
//
// Refusal codes (stable): MAX_PRICE_REFUSED (offer price exceeds the caller
// cap — compared in integer atomic units at the offer asset's decimals,
// never floats), PAY_TO_MISMATCH (offer payTo ≠ expected_pay_to),
// CHAIN_NOT_ALLOWED (offer chain outside allowed_chains). Every refusal
// happens after offer selection and before payload creation: the mock seller
// records exactly one (unsigned) request and the ledger gains no row.
//
// Hermetic: loopback 127.0.0.1 mock seller, X402_ALLOW_PRIVATE_HOSTS,
// temp ledger/directory/state, throwaway runtime EVM key (fully local
// signing).
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-per-call-limits-test-'));
process.env.X402_NETWORK_MODE = 'mainnet'; // issue #59: name the MAINNET mode explicitly — set BEFORE the env capture so every afterEach restore keeps it
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
process.env.X402_STATE_DIR = join(dir, 'state');

const EVM_KEY = generatePrivateKey();
process.env.EVM_PRIVATE_KEY = EVM_KEY;
env.EVM_PRIVATE_KEY = EVM_KEY;

const { registerFetchTool } = await import('./fetch.js');

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

function ledgerLines(): any[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

const liveSellers: Array<{ server: http.Server }> = [];

async function seller(
  onVisit: (req: http.IncomingMessage, res: http.ServerResponse, visitIndex: number, signed: boolean) => void,
): Promise<{ url: string; recorded: Array<{ method: string; signed: boolean }> }> {
  const recorded: Array<{ method: string; signed: boolean }> = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const signed = req.headers['x-payment'] !== undefined || req.headers['payment-signature'] !== undefined;
      recorded.push({ method: req.method ?? '', signed });
      onVisit(req, res, recorded.length - 1, signed);
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
  return { url: `http://127.0.0.1:${port}/api`, recorded };
}

/** Chargeable v2 challenge with a parameterized amount (6-decimal USDC
 * atomic) and payTo. */
function challengePayload(requestUrl: string, amountAtomic: string, payTo: string): { status: number; headers: Record<string, string>; body: string } {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{ scheme: 'exact', network: BASE_CAIP2, asset: BASE_USDC_ADDRESS, amount: amountAtomic, payTo, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
  });
  return { status: 402, headers: { 'content-type': 'application/json', 'payment-required': b64url(payload) }, body: 'Payment Required' };
}

/** Standard scenario: probe gets the $0.01 challenge, the single signed paid
 * leg gets a 200 body. A refusal case never reaches the signed leg. */
async function chargingSeller(amountAtomic = '10000', payTo = BASE_PAYTO) {
  return seller((req, res, _i, signed) => {
    if (!signed) {
      const challenge = challengePayload(`http://${req.headers.host}${req.url}`, amountAtomic, payTo);
      res.writeHead(challenge.status, challenge.headers);
      res.end(challenge.body);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('{"result":"ok"}');
  });
}

/** Refusal assertions shared by every narrowing case: the named code, ZERO
 * signed requests, exactly one network contact (the probe), no ledger row. */
function assertZeroPayment(result: any, s: { recorded: Array<{ signed: boolean }> }, beforeRows: number, code: string) {
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(
    (parsed.reasons ?? []).some((r: any) => r.code === code),
    `the refusal names ${code}, got: ${JSON.stringify(parsed)}`,
  );
  assert.equal(s.recorded.length, 1, 'only the probe may touch the network — refusal before signing');
  assert.equal(s.recorded.filter((r) => r.signed).length, 0, 'ZERO signed requests at the seller');
  assert.equal(ledgerLines().length, beforeRows, 'no ledger row for a caller-limit refusal (nothing was paid)');
  return parsed;
}

it('issue #80 (R2): max_price_usd below the offer price refuses with MAX_PRICE_REFUSED before signing', { timeout: 20_000 }, async () => {
  const s = await chargingSeller('10000'); // $0.01
  const before = ledgerLines().length;
  const parsed = assertZeroPayment(await handler()({ url: s.url, max_price_usd: 0.005 }), s, before, 'MAX_PRICE_REFUSED');
  assert.equal(parsed.policy_decision, 'ALLOW', 'the outer policy gate allowed it — the caller cap is what refuses');
});

it('issue #80 (R2): max_price_usd exactly equal to the offer price still pays — the boundary refuses only above the cap', { timeout: 20_000 }, async () => {
  const s = await chargingSeller('10000'); // $0.01
  const parsed = JSON.parse((await handler()({ url: s.url, max_price_usd: 0.01 })).content[0].text);
  assert.equal(parsed.status, 200, `a price at the cap is not refused: ${JSON.stringify(parsed)}`);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.cost_usdc, 0.01);
  assert.equal(s.recorded.filter((r) => r.signed).length, 1, 'signed exactly once');
  const row = ledgerLines().find((r: any) => r.url === s.url);
  assert.equal(row?.status, 'success');
});

it('issue #80 (R2): expected_pay_to unequal to the offer payTo refuses with PAY_TO_MISMATCH before signing', { timeout: 20_000 }, async () => {
  const s = await chargingSeller('10000', BASE_PAYTO);
  const before = ledgerLines().length;
  assertZeroPayment(
    await handler()({ url: s.url, expected_pay_to: '0x3333333333333333333333333333333333333333' }),
    s,
    before,
    'PAY_TO_MISMATCH',
  );
});

it('issue #80 (R2): expected_pay_to matching the offer payTo pays exactly as before', { timeout: 20_000 }, async () => {
  const s = await chargingSeller('10000', BASE_PAYTO);
  const parsed = JSON.parse((await handler()({ url: s.url, expected_pay_to: BASE_PAYTO })).content[0].text);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.cost_usdc, 0.01);
  assert.equal(s.recorded.filter((r) => r.signed).length, 1);
});

it('issue #80 (R2): allowed_chains excluding the offer chain refuses with CHAIN_NOT_ALLOWED before signing', { timeout: 20_000 }, async () => {
  const s = await chargingSeller('10000'); // a base offer
  const before = ledgerLines().length;
  assertZeroPayment(await handler()({ url: s.url, allowed_chains: ['solana'] }), s, before, 'CHAIN_NOT_ALLOWED');
});

it('issue #80 (R2): allowed_chains containing the offer chain pays exactly as before', { timeout: 20_000 }, async () => {
  const s = await chargingSeller('10000');
  const parsed = JSON.parse((await handler()({ url: s.url, allowed_chains: ['solana', 'base'] })).content[0].text);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(s.recorded.filter((r) => r.signed).length, 1);
});

it('issue #80 (R2): a max_price_usd above the global per-call cap never RAISES the cap — the global cap still refuses before signing', { timeout: 20_000 }, async () => {
  const s = await chargingSeller('600000'); // $0.60 — above the default MAX_PAYMENT_PER_CALL (0.50)
  const before = ledgerLines().length;
  const parsed = JSON.parse((await handler()({ url: s.url, max_price_usd: 100 })).content[0].text);
  // The caller's generous cap cannot widen the operator's: the refusal is the
  // global per-call cap (policy rule), NOT the caller's narrowing keys.
  assert.ok(
    (parsed.reasons ?? []).some((r: any) => r.code === 'REQUEST_LIMIT_EXCEEDED') || /Spending limit exceeded/.test(parsed.error ?? ''),
    `the global cap refuses a $0.60 offer despite max_price_usd=100, got: ${JSON.stringify(parsed)}`,
  );
  assert.ok(!(parsed.reasons ?? []).some((r: any) => r.code === 'MAX_PRICE_REFUSED'), 'the caller cap did not refuse — the global cap did');
  assert.equal(s.recorded.filter((r) => r.signed).length, 0, 'ZERO signed requests — nothing above the global cap was paid');
  assert.equal(ledgerLines().length, before, 'no ledger row');
});

it('issue #80 (R2): malformed narrowing values are refused, never silently ignored (the pre-#80 failure mode)', { timeout: 20_000 }, async () => {
  const s = await chargingSeller('10000');
  const before = ledgerLines().length;
  for (const args of [
    { max_price_usd: -1 },
    { max_price_usd: 0 },
    { allowed_chains: [] },
    { allowed_chains: ['nope'] },
    { expected_pay_to: '' },
  ] as const) {
    const parsed = JSON.parse((await handler()({ url: s.url, ...(args as any) })).content[0].text);
    assert.ok(
      (parsed.reasons ?? []).some((r: any) => r.code === 'PER_CALL_LIMIT_INVALID'),
      `${JSON.stringify(args)} must be refused, never ignored: ${JSON.stringify(parsed)}`,
    );
  }
  assert.equal(s.recorded.filter((r) => r.signed).length, 0, 'ZERO signed requests across all malformed args');
  assert.equal(ledgerLines().length, before, 'no ledger rows');
});

afterEach(() => {
  process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_DIRECTORY_PATH: join(dir, 'endpoints.json'), X402_STATE_DIR: join(dir, 'state') };
});
after(async () => {
  process.env = env;
  for (const { server } of liveSellers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(dir, { recursive: true, force: true });
});
