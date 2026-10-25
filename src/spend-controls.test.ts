// Issue #62 (D4) and the money path's SDK boundary — spend controls.
//
// The SDK (x402Client) carries its own spend controls; with none configured it
// defaults to an implicit $1-per-payment USD cap on its DEFAULT assets plus an
// implicit default-asset allowlist. That implicit behavior is exactly what
// issue #62 (D4) removes from the flow: the project's own caps must be the
// single source of truth, passed as EXPLICIT spend controls at client
// construction; the SDK cap must never be the reason an allowed payment fails
// ("the SDK is never more permissive than the project gate is fine — the
// project gate is never more RESTRICTIVE than what the SDK then enforces").
//
// RED commit (plan C4): the pin tests on the INSTALLED SDK pass immediately;
// the cap-above-$1 e2e test is RED by design until C5 sets the explicit
// controls (the flow still runs on the SDK's implicit $1 default cap, so a
// $2.10 offer inside a $5 cap fails at the SDK).
//
// Hermetic: temp ledger/directory/state paths, throwaway keys generated at
// runtime, loopback mock sellers only, no live network. Version pins read the
// installed SDK's own public constants (no network).

import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import bs58 from 'bs58';

const dir = mkdtempSync(join(tmpdir(), 'x402-spend-controls-test-'));
const LEDGER_PATH = join(dir, 'ledger.jsonl');
process.env.PAYMENT_LOG_PATH = LEDGER_PATH;
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
process.env.X402_STATE_DIR = join(dir, 'state');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-24' }), 'utf8');
process.env.X402_NETWORK_MODE = 'mainnet';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = Buffer.from(publicKey.export({ type: 'spki', format: 'der' } as any).slice(-32) as unknown as Uint8Array);
const priv = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' } as any).slice(16) as unknown as Uint8Array);
const SOLANA_KEY_B58 = bs58.encode(Buffer.concat([priv, pub]));
process.env.SOLANA_PRIVATE_KEY = SOLANA_KEY_B58;
const EVM_KEY = `0x${'33'.repeat(32)}`;
process.env.EVM_PRIVATE_KEY = EVM_KEY;

const { registerFetchTool } = await import('./tools/fetch.js');
const { DEFAULT_MAX_AMOUNT_PER_PAYMENT, x402Client } = (await import('@x402/core/client')) as typeof import('@x402/core/client');
const { TOKEN_PROGRAM_ADDRESS } = (await import('@x402/svm')) as typeof import('@x402/svm');

// ---------------------------------------------------------------------------
// Pin the installed SDK's implicit default controls (issue #62 req 5). If an
// SDK bump changes the implicit $1 default cap or the implicit default-asset
// allowlist, these pins fail the build BEFORE anything relies on the old
// semantic.
// ---------------------------------------------------------------------------

it('pin: the installed @x402/core declares DEFAULT_MAX_AMOUNT_PER_PAYMENT === "$1"', () => {
  assert.equal(typeof DEFAULT_MAX_AMOUNT_PER_PAYMENT, 'string', 'the default cap is the Money string form');
  assert.equal(DEFAULT_MAX_AMOUNT_PER_PAYMENT, '$1', 'the SKD default per-payment cap must still be the implicit $1 — an SDK bump that changes this must fail this pin before the flow is trusted');
});

it('pin: with NO explicit controls the SDK still refuses a non-default asset (implicit default-asset allowlist)', async () => {
  const client = new (x402Client as any)();
  client.register('eip155:8453', fakeSchemeClient());
  await assert.rejects(
    client.createPaymentPayload({
      x402Version: 2,
      accepts: [evmRequirement('BaseTestOnlyAsset88889999', '10000')],
    } as any) as unknown as Promise<unknown>,
    /All payment requirements were rejected by spendControls/,
    'an SDK bump that stops filtering non-default assets under empty controls must fail this pin',
  );
});

it('pin: with NO explicit controls the SDK still enforces the $1 default cap on a default asset (boundary: $1.00 passes, $2.00 refuses)', async () => {
  const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const defaultAsset = { asset: USDC_BASE, symbol: 'USDC', decimals: 6 };
  const mk = (): any => {
    const c = new (x402Client as any)();
    c.register('eip155:8453', fakeSchemeClient({ defaultAsset }));
    return c;
  };
  const payload = {
    x402Version: 2,
    accepts: [evmRequirement(USDC_BASE, '1000000')],
  } as any;
  // exactly $1.00: under the implicit cap — the selection RUNS (past the
  // controls) and reaches the scheme's payload creation, which this test
  // double aborts with its marker throw.
  await assert.rejects((mk() as any).createPaymentPayload(payload) as unknown as Promise<unknown>, /not signed in this pin test/,
    'the $1.00 offer reached payload creation — the implicit $1 cap boundary still holds at the installed SDK');
  // $2.00: over the implicit cap — rejected by the USD-cap control itself.
  await assert.rejects(
    (mk() as any).createPaymentPayload({ ...payload, accepts: [evmRequirement(USDC_BASE, '2000000')] } as any) as Promise<unknown>,
    /spendControls\.maxAmountPerPayment/,
    'an SDK bump that stops enforcing the implicit $1 default cap must fail this pin',
  );
});

/** A minimal SchemeNetworkClient test double: its findDefaultAsset drives the
 * SDK's implicit default-asset classification; payload creation never runs in
 * these pins (the marker throw proves the controls PASSED the requirement). */
function fakeSchemeClient(opts: { defaultAsset?: { asset: string; symbol: string; decimals: number } } = {}): any {
  return {
    scheme: 'exact',
    x402Version: 2,
    findDefaultAsset: (asset: string): { asset: string; symbol: string; decimals: number } | undefined =>
      opts.defaultAsset && asset.toLowerCase() === opts.defaultAsset.asset.toLowerCase() ? opts.defaultAsset :
      opts.defaultAsset && asset === undefined ? opts.defaultAsset : undefined,
    createPaymentPayload: async () => {
      throw new Error('not signed in this pin test');
    },
  };
}

function evmRequirement(asset: string, amount: string): unknown {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    asset,
    amount,
    payTo: '0x2222222222222222222222222222222222222222',
    maxTimeoutSeconds: 60,
    extra: { name: 'USD Coin', version: '2' },
  };
}

// ---------------------------------------------------------------------------
// E2E against the flow (mock sellers). The cap-above-$1 test is RED until C5.
// ---------------------------------------------------------------------------

interface RecordedRequest { method: string; url: string; headers: Record<string, string | string[] | undefined> }
const liveSellers: Array<{ server: http.Server }> = [];

async function seller(
  onVisit: (req: http.IncomingMessage, res: http.ServerResponse, visitIndex: number, signed: boolean) => void,
): Promise<{ url: string; recorded: RecordedRequest[] }> {
  const recorded: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers } });
      const signed = req.headers['x-payment'] !== undefined || req.headers['payment-signature'] !== undefined;
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
  return { url: `http://127.0.0.1:${port}/v1/paid`, recorded };
}

const b64url = (s: string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function baseChallenge(requestUrl: string, amount: string, overrides: Record<string, unknown> = {}): { status: number; headers: Record<string, string>; body: string } {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{
      scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount, payTo: '0x2222222222222222222222222222222222222222', maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2' },
    }],
    ...overrides,
  });
  return { status: 402, headers: { 'content-type': 'application/json', 'payment-required': b64url(payload) }, body: 'Payment Required' };
}

const RECEIPT_B64 = Buffer.from(JSON.stringify({ success: true, transaction: 'dd'.repeat(32) })).toString('base64');

function ledgerLines(): any[] {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function noPaymentHeaders(r: RecordedRequest): boolean {
  return r.headers['x-payment'] === undefined && r.headers['payment-signature'] === undefined
    && r.headers['payment-nonce'] === undefined && r.headers['payment-timestamp'] === undefined;
}

function handler() {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

it('e2e: a per-call cap ABOVE $1 lets a $1 < amount < cap offer PROCEED — the SDK cap must never be the reason', async () => {
  const saved = { cap: process.env.MAX_PAYMENT_PER_CALL, daily: process.env.MAX_DAILY_SPEND };
  try {
    process.env.MAX_PAYMENT_PER_CALL = '5';  // $5 per call; the offer is $2.10
    process.env.MAX_DAILY_SPEND = '50';
    const { url, recorded } = await seller((req, res, _i, signed) => {
      if (!signed) {
        const resp = baseChallenge(url, '2100000'); // $2.10 — under the project cap, over the SDK default $1
        res.writeHead(resp.status, resp.headers);
        res.end(resp.body);
        return;
      }
      res.writeHead(200, { 'payment-response': RECEIPT_B64 });
      res.end('{"ok":true}');
    });
    globalThis.fetch = (async (input: unknown, init: unknown) => {
      const urlStr = input instanceof Request ? input.url : String(input);
      const parsed = new URL(urlStr);
      if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') return await realFetch(input as any, init as any);
      throw new Error(`unexpected network touch in this test: ${urlStr}`);
    }) as unknown as typeof fetch;
    const result = await handler()({ url });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, 200, `a $2.10 offer inside a $5 per-call cap must proceed (got: ${parsed.error})`);
    assert.equal(parsed.paid, true);
    assert.ok(recorded.some((r) => !noPaymentHeaders(r)), 'the signed paid leg happened');
  } finally {
    if (saved.cap !== undefined) process.env.MAX_PAYMENT_PER_CALL = saved.cap; else delete process.env.MAX_PAYMENT_PER_CALL;
    if (saved.daily !== undefined) process.env.MAX_DAILY_SPEND = saved.daily; else delete process.env.MAX_DAILY_SPEND;
  }
});

it('e2e: the SDK is never more permissive than the project gate — a >cap offer is refused by the PROJECT (not the SDK cap, which would allow it)', async () => {
  const saved = { cap: process.env.MAX_PAYMENT_PER_CALL, daily: process.env.MAX_DAILY_SPEND };
  try {
    process.env.MAX_PAYMENT_PER_CALL = '0.05';  // far below the SDK's $1 — the project gate must be the boundary
    process.env.MAX_DAILY_SPEND = '10';
    const { url, recorded } = await seller((req, res) => {
      const resp = baseChallenge(url, '100000'); // $0.10 — over the project cap, under the SDK's $1
      res.writeHead(resp.status, resp.headers);
      res.end(resp.body);
    });
    globalThis.fetch = (async (input: unknown, init: unknown) => {
      const urlStr = input instanceof Request ? input.url : String(input);
      const parsed = new URL(urlStr);
      if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') return await realFetch(input as any, init as any);
      throw new Error(`unexpected network touch in this test: ${urlStr}`);
    }) as unknown as typeof fetch;
    const before = ledgerLines();
    const result = await handler()({ url });
    const parsed = JSON.parse(result.content[0].text);
    assert.match(parsed.error as string, /REQUEST_LIMIT_EXCEEDED/, 'the PROJECT gate refuses first (the SDK cap would have allowed $0.10)');
    assert.ok(recorded.every(noPaymentHeaders), 'zero payment headers under the project refusal');
    assert.ok(!ledgerLines().some((e) => e.url === url && e.status === 'success'), 'nothing settled for this url');
    assert.deepEqual(ledgerLines(), before, 'no ledger row written by this refusal');
  } finally {
    if (saved.cap !== undefined) process.env.MAX_PAYMENT_PER_CALL = saved.cap; else delete process.env.MAX_PAYMENT_PER_CALL;
    if (saved.daily !== undefined) process.env.MAX_DAILY_SPEND = saved.daily; else delete process.env.MAX_DAILY_SPEND;
  }
});

// ---------------------------------------------------------------------------
// Issue #62 (C5): the exact-atomic cap derivation + the Casper authority.
// ---------------------------------------------------------------------------

it('payment-utils: the per-call cap converts to an EXACT integer atomic cap per decimals (no float multiply)', async () => {
  const pu = (await import('./payment-utils.js')) as typeof import('./payment-utils.js');
  const saved = process.env.MAX_PAYMENT_PER_CALL;
  try {
    process.env.MAX_PAYMENT_PER_CALL = '0.50';
    assert.equal(pu.getMaxPerCallAtomic(6), 500000n, "'0.50' at 6 decimals is exactly 500000");
    assert.equal(pu.getMaxPerCallAtomic(9), 500000000n, "'0.50' at 9 decimals is exactly 500000000");
    process.env.MAX_PAYMENT_PER_CALL = '5';
    assert.equal(pu.getMaxPerCallAtomic(6), 5000000n);
    process.env.MAX_PAYMENT_PER_CALL = '1.50';
    assert.equal(pu.getMaxPerCallAtomic(6), 1500000n, 'the largest atomic value still within the cap (the exact boundary the tests pin)');
    process.env.MAX_PAYMENT_PER_CALL = '0.05';
    assert.equal(pu.getMaxPerCallAtomic(9), 50000000n);
    process.env.MAX_PAYMENT_PER_CALL = '1.000000001';
    assert.equal(pu.getMaxPerCallAtomic(6), 1000000n, 'fraction digits finer than the asset floors the cap — only integer atomic amounts exist');
    process.env.MAX_PAYMENT_PER_CALL = 'not-a-number';
    assert.equal(pu.getMaxPerCallAtomic(6), 0n, 'a malformed cap reads as the same fail-closed 0 the value path reads (nothing over 0 is signed)');
    process.env.MAX_PAYMENT_PER_CALL = saved ?? '0.50';
    assert.equal(pu.getMaxPerCallAtomic(19), undefined, 'out-of-domain decimals return undefined (entry excluded, fail closed)');
  } finally {
    if (saved !== undefined) process.env.MAX_PAYMENT_PER_CALL = saved; else delete process.env.MAX_PAYMENT_PER_CALL;
  }
});

it('casper: the wCSPR leg pays DESPITE the SDK default-asset allowlist, and its refusals come from the repo budget guard — never the SDK controls', async () => {
  const { WCSPR_ASSETS } = (await import('./casper/accepts.js')) as typeof import('./casper/accepts.js');
  const { casperBudget } = (await import('./casper/budget.js')) as typeof import('./casper/budget.js');
  const offer = {
    scheme: 'exact', network: 'casper:casper', asset: WCSPR_ASSETS['casper:casper'],
    payTo: '00' + 'ab'.repeat(32), amount: '1000000000', maxTimeoutSeconds: 60,
    extra: { name: 'Wrapped CSPR', version: '1' },
  };
  const casperChallenge = (): Response => {
    const payload = JSON.stringify({ x402Version: 2, resource: { url: 'https://example.invalid', description: '', mimeType: 'text/plain' }, accepts: [{ ...offer }] });
    return new Response(payload, { status: 402, headers: { 'payment-required': Buffer.from(payload).toString('base64') } } as ResponseInit);
  };
  process.env.CASPER_PRIVATE_KEY = '44'.repeat(32);
  process.env.X402_ALLOW_PRIVATE_HOSTS = '';

  // (1) the BUDGET guard refuses a too-expensive offer (its own message —
  // not anything the SDK's spend controls would say) and nothing is signed.
  const beforeSpend = casperBudget.getDailySpent();
  process.env.CASPER_MAX_PAYMENT_PER_CALL = '0.1';
  process.env.CASPER_MAX_DAILY_SPEND = '10';
  let calls = 0;
  globalThis.fetch = (async (input: unknown) => {
    calls++;
    if (input instanceof Request) assert.ok(noPaymentHeaders({ method: '', url: '', headers: Object.fromEntries(input.headers) }), 'zero payment headers before the guard allows');
    return casperChallenge();
  }) as unknown as typeof fetch;
  const refused = JSON.parse((await handler()({ url: 'https://example.invalid', chain: 'casper' })).content[0].text);
  assert.match(refused.error as string, /Casper per-call budget exceeded/, 'the REPO budget guard is the Casper authority — its refusal code and message surface');
  assert.doesNotMatch(refused.error as string, /spendControls/, 'the SDK spend controls must never be the Casper refusal source');
  assert.equal(calls, 1, 'the SDK never ran a paid leg under the budget refusal');
  assert.equal(casperBudget.getDailySpent(), beforeSpend, 'a budget refusal debits nothing');

  // (2) with an ample budget the wCSPR offer PAYS — wCSPR is NOT an SDK
  // default asset, so the SDK's implicit default-asset allowlist would have
  // refused this very offer: the Casper path's SDK spend controls are
  // DISABLED (setSpendControls(false)) and the repo budget guard is the only
  // authority.
  calls = 0;
  process.env.CASPER_MAX_PAYMENT_PER_CALL = '1';
  process.env.CASPER_MAX_DAILY_SPEND = '10';
  const receiptB64 = Buffer.from(JSON.stringify({ success: true, transaction: 'ab'.repeat(32), network: 'casper:casper' })).toString('base64');
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    calls++;
    const headers = new Headers(input instanceof Request ? (input as Request).headers : (init as any)?.headers);
    if (calls <= 2) return casperChallenge();
    const sigHeader = headers.get('payment-signature');
    assert.ok(sigHeader, 'the paid leg carries a real signature header');
    const payload = JSON.parse(Buffer.from(sigHeader!, 'base64').toString());
    assert.equal(payload.payload.authorization.value, '1000000000', 'the signed value is the mote-exact offer amount');
    assert.ok((payload.payload.signature ?? '').length > 0);
    return new Response('{"ok":true}', { status: 200, headers: { 'payment-response': receiptB64 } });
  }) as unknown as typeof fetch;
  const paid = JSON.parse((await handler()({ url: 'https://example.invalid', chain: 'casper' })).content[0].text);
  assert.equal(paid.paid, true, `the wCSPR leg pays with the SDK controls disabled — the repo budget guard is authoritative (${JSON.stringify(paid)})`);
  assert.equal(casperBudget.getDailySpent(), beforeSpend + 1000000000n, 'the budget guard debited the signed motes — never the SDK controls');
});

// ---------------------------------------------------------------------------
afterEach(() => {
  process.env.PAYMENT_LOG_PATH = LEDGER_PATH;
  process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
  process.env.X402_STATE_DIR = join(dir, 'state');
  process.env.X402_NETWORK_MODE = 'mainnet';
  process.env.SOLANA_PRIVATE_KEY = SOLANA_KEY_B58;
  process.env.EVM_PRIVATE_KEY = EVM_KEY;
  process.env.X402_ALLOW_PRIVATE_HOSTS = '';
  globalThis.fetch = realFetch;
});
after(async () => {
  for (const { server } of liveSellers) await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.PAYMENT_LOG_PATH;
  rmSync(dir, { recursive: true, force: true });
});
const realFetch = globalThis.fetch.bind(globalThis);