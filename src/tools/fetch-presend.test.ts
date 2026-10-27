import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Issue #92: "payload built and sent" is NOT "failed before send". An RPC
// failure (429/5xx) DURING payload creation — here the mint-metadata
// getAccountInfo fetch the Solana exact scheme makes after the (locally
// signed) transaction is assembled — aborts the paid leg BEFORE the payment
// request ever leaves: no request carries a payment header, the seller sees
// zero paid attempts. The catch path must classify that as a plain
// pre-send failure:
//   - the response's tri-state paid is "no" (today it reports "unknown",
//     which forbids the agent from retrying a call that never left);
//   - the ledger row is a zero-amount `failed` row (today a counted
//     authorized_unserved row appears for a call that never left);
//   - no money is counted (today's daily total moves by the price);
//   - the reservation is RELEASED (not settled).
// The contrast case (RPC ok, the endpoint throws AFTER the signed request
// left) keeps the existing behavior: counted authorized_unserved row,
// paid: "unknown" — the distinction must never erase a real send.
//
// Real x402_fetch flow, loopback-bound by fetch mocks only: simulated RPC on
// a bogus host, a challenge with extra.recentBlockhash bound (signing needs
// no RPC), a throwaway runtime ed25519 key. No live network anywhere.
// ---------------------------------------------------------------------------

const RPC_SIM_URL = 'https://rpc-sim.invalid';
const dir = mkdtempSync(join(tmpdir(), 'x402-presend-'));
const LEDGER_PATH = join(dir, 'ledger.jsonl');
const DIRECTORY = join(dir, 'endpoints.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(DIRECTORY, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-27' }), 'utf8');
process.env.X402_NETWORK_MODE = 'mainnet';
process.env.PAYMENT_LOG_PATH = LEDGER_PATH;
process.env.X402_DIRECTORY_PATH = DIRECTORY;
process.env.X402_STATE_DIR = join(dir, 'state');
process.env.MAX_PAYMENT_PER_CALL = '50';
process.env.MAX_DAILY_SPEND = '50';
process.env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`;

// Throwaway runtime ed25519 key so the Solana scheme constructs locally.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = Buffer.from(publicKey.export({ type: 'spki', format: 'der' } as any).slice(-32) as unknown as Uint8Array);
const priv = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' } as any).slice(16) as unknown as Uint8Array);
const SOLANA_KEY_B58 = bs58.encode(Buffer.concat([priv, pub]));
process.env.SOLANA_PRIVATE_KEY = SOLANA_KEY_B58;
// The mint-metadata touchpoint of payload creation rides this simulated host
// (without it the SDK defaults to the public mainnet RPC — no network here).
process.env.SOLANA_RPC_URL = RPC_SIM_URL;

const PM = (await import('../payment-utils.js')) as typeof import('../payment-utils.js');
const RES = (await import('../reservations.js')) as typeof import('../reservations.js');

const fetchModRaw = await import('./fetch.js').catch(() => undefined) as any;

const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const { USDC_MAINNET_ADDRESS, TOKEN_PROGRAM_ADDRESS } = await import('@x402/svm') as any;
const BINDABLE_SOLANA_ASSET = USDC_MAINNET_ADDRESS;
const CHARGE_PAYTO_B58 = bs58.encode(Buffer.alloc(32, 0x07));
const CHARGE_FEE_PAYER_B58 = bs58.encode(Buffer.alloc(32, 0x09));
const CHARGE_BLOCKHASH_B58 = bs58.encode(Buffer.alloc(32, 0x05));
const PRICE_ATOMIC = '10000'; // $0.01

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env, PAYMENT_LOG_PATH: LEDGER_PATH, X402_DIRECTORY_PATH: DIRECTORY };
  globalThis.fetch = realFetch;
});
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

const realFetch = globalThis.fetch.bind(globalThis);

let registered: any;
function handler(): (args: any) => Promise<any> {
  if (registered !== undefined) return registered;
  assert.ok(typeof fetchModRaw?.registerFetchTool === 'function', 'src/tools/fetch.ts must export registerFetchTool');
  fetchModRaw.registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { registered = fn; } } as any);
  return registered;
}

function ledgerRows(): any[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function chargeableSolanaChallenge(requestUrl: string): Response {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{ scheme: 'exact', network: SOLANA_CAIP2, asset: BINDABLE_SOLANA_ASSET, amount: PRICE_ATOMIC, payTo: CHARGE_PAYTO_B58, maxTimeoutSeconds: 60, extra: { name: 'USDC', feePayer: CHARGE_FEE_PAYER_B58, recentBlockhash: CHARGE_BLOCKHASH_B58 } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
}

const MINT_ACCOUNT_B64 = (() => {
  const mint = Buffer.alloc(82);
  mint.writeUInt8(6, 44);
  mint.writeUInt8(1, 45);
  return mint.toString('base64');
})();

async function requestBodyText(input: unknown, init: unknown): Promise<string> {
  if (init && typeof (init as any).body === 'string') return (init as any).body;
  if (input instanceof Request) return await input.clone().text();
  return '';
}

function hasPaymentHeader(input: unknown, init: unknown): boolean {
  const headers = new Headers(input instanceof Request ? input.headers : (init as any)?.headers);
  return headers.has('payment-signature') || headers.has('x-payment');
}

/** Install the mocked network: the simulated JSON-RPC answers mint-metadata
 * with `rpcStatus` (429/500 = payload creation explodes AFTER the local
 * signing), the endpoint serves the challenge for unpaid calls and a
 * dropped response for a paid leg. Returns counters over what LEFT the
 * client. */
function installNetwork(opts: { rpcStatus: number }): {
  sellerSignedContacts: number; rpcCalls: number; headerRequests: number;
} {
  const counters = { sellerSignedContacts: 0, rpcCalls: 0, headerRequests: 0 };
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const u = input instanceof Request ? input.url : String(input);
    counters.headerRequests += hasPaymentHeader(input, init) ? 1 : 0;
    if (u.startsWith(RPC_SIM_URL)) {
      counters.rpcCalls++;
      const { id } = JSON.parse(await requestBodyText(input, init));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'simulated rpc failure' } }), { status: opts.rpcStatus, headers: { 'content-type': 'application/json' } });
    }
    if (!hasPaymentHeader(input, init)) return chargeableSolanaChallenge(u);
    counters.sellerSignedContacts++;
    return new Response(new ReadableStream({ start(c) { c.error(new Error('connection reset after send')); } }));
  }) as typeof fetch;
  return counters;
}

it('an RPC failure during payload creation leaves zero-signed contacts: no counted row, no daily spend, paid "no" (today it counts a payment that never left)', async () => {
  const url = 'https://presend-429.invalid/api';
  const counters = installNetwork({ rpcStatus: 429 });
  const dailyBefore = PM.getDailySpent();
  const reservedBefore = RES.reservedUsd('global');
  const result = await handler()({ url, chain: 'solana' });
  const parsed = JSON.parse(result.content[0].text);

  assert.equal(counters.rpcCalls, 1, 'payload creation touched the RPC once');
  assert.equal(counters.sellerSignedContacts, 0, 'the seller saw zero paid requests — the payment never left');
  assert.equal(counters.headerRequests, 0, 'no outgoing request carried a payment header at all');
  assert.equal(parsed.paid, 'no', 'a call that never left is "no" — never "unknown" (today: it reports unknown)');
  const row = ledgerRows().find((r) => r.url === url);
  assert.ok(row, 'the ledger records the attempt');
  assert.equal(row.status, 'failed', 'a pre-send failure records a failed row (today: a counted authorized_unserved row)');
  assert.equal(row.amount_usdc, 0, 'nothing was paid — the row carries a zero amount');
  const delta = PM.getDailySpent() - dailyBefore;
  assert.ok(Math.abs(delta) < 1e-9, `no money is counted for a call that never left (today: the daily total moved by ${delta})`);
  assert.ok(Math.abs(RES.reservedUsd('global') - reservedBefore) < 1e-9, 'the reservation was released (no hold lingers)');
});

it('the same pre-send classification applies when the RPC says 500', async () => {
  const url = 'https://presend-500.invalid/api';
  const counters = installNetwork({ rpcStatus: 500 });
  const dailyBefore = PM.getDailySpent();
  const result = await handler()({ url, chain: 'solana' });
  const parsed = JSON.parse(result.content[0].text);

  assert.equal(counters.sellerSignedContacts, 0, 'the seller saw zero paid requests');
  assert.equal(parsed.paid, 'no', 'no payment left — paid "no"');
  const row = ledgerRows().find((r) => r.url === url);
  assert.ok(row, 'a row exists');
  assert.equal(row.status, 'failed', 'a pre-send failure is a failed row');
  assert.equal(row.amount_usdc, 0);
  assert.ok(Math.abs(PM.getDailySpent() - dailyBefore) < 1e-9, 'the daily total did not move');
});