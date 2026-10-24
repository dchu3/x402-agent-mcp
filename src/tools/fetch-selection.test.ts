// Issue #61 — deterministic offer selection + one unpaid request per paid
// fetch. RED commit by design (plan C5): this file imports
// ./offer-selection.js, which does not exist yet, so the test compile fails
// with "Cannot find module './offer-selection.js'" — the stated failure (the
// deterministic selector and the probe replay do not exist yet), not a bug.
//
// Two layers of tests:
//   - unit: the selector's ranking/rejection contract (pure — feeds the
//     fixed refusal vocabulary, integer-atomic ranking, chain-order ties),
//   - e2e: a real loopback mock seller (node:test + node:http on 127.0.0.1,
//     X402_ALLOW_PRIVATE_HOSTS env-only for the port) so the selection is
//     proven on the wire, not against stubs. Throwaway runtime keys only —
//     no real keys, no live network, no RPC (the Solana leg uses the
//     simulated mint-metadata RPC pattern from fetch.test.ts; its blockhash
//     rides the offer's extra so no getLatestBlockhash call happens).
//
// Commit staging (per the plan): the selection-half tests green with C6
// (selector + fetch.ts wiring + selected_offer output); the
// request-count/one-unpaid-request tests stay RED until C7 (replay +
// selector) — at C6 the flow still makes the SDK's own first request.

import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import bs58 from 'bs58';
import { generatePrivateKey } from 'viem/accounts';
import { DEFAULT_CHAIN_ORDER, selectOffer, type OfferCandidate, type SelectOfferArgs, type SelectOfferResult } from './offer-selection.js';

// ---------------------------------------------------------------------------
// Hermetic env: temp ledger/path/state BEFORE importing fetch.js (the
// PAYMENT_LOG_PATH pattern from the existing suites).
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'x402-fetch-selection-test-'));
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
process.env.X402_STATE_DIR = join(dir, 'state');

// Throwaway runtime keys only. EIP-3009 signing is fully local; the Solana
// leg uses its simulated-RPC counterpart, so no real key/RPC is ever hit.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = Buffer.from(publicKey.export({ type: 'spki', format: 'der' } as any).slice(-32) as unknown as Uint8Array);
const priv = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' } as any).slice(16) as unknown as Uint8Array);
const SOLANA_KEY_B58 = bs58.encode(Buffer.concat([priv, pub]));
process.env.SOLANA_PRIVATE_KEY = SOLANA_KEY_B58;
env.SOLANA_PRIVATE_KEY = SOLANA_KEY_B58; // survive the afterEach env restore
const EVM_KEY = generatePrivateKey();
process.env.EVM_PRIVATE_KEY = EVM_KEY;
env.EVM_PRIVATE_KEY = EVM_KEY; // survive the afterEach env restore

const { registerFetchTool } = await import('./fetch.js');
const { USDC_MAINNET_ADDRESS } = await import('@x402/svm') as any;

// Public protocol identifiers (the established convention in this repo's
// tests: asset ids/program ids are not secrets; wallets are fake-but-well-
// formed 32-byte base58 / 20-byte hex placeholders).
const BASE_CAIP2 = 'eip155:8453';
const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_PAYTO = '0x2222222222222222222222222222222222222222';
const CHARGE_PAYTO_B58 = bs58.encode(Buffer.alloc(32, 0x07));
const CHARGE_FEE_PAYER_B58 = bs58.encode(Buffer.alloc(32, 0x09));
const CHARGE_BLOCKHASH_B58 = bs58.encode(Buffer.alloc(32, 0x05));
const SOLANA_PAYER_B58 = bs58.encode(Buffer.alloc(32, 0x0b)); // throwaway payer for scope checks

const RPC_SIM_URL = 'https://rpc-sim.invalid';
/** Valid 82-byte SPL mint account (owner = Token program, decimals 6). */
const MINT_ACCOUNT_B64 = (() => {
  const mint = Buffer.alloc(82);
  mint.writeUInt8(6, 44);
  mint.writeUInt8(1, 45);
  return mint.toString('base64');
})();
const { TOKEN_PROGRAM_ADDRESS } = await import('@x402/svm') as any;

const RECEIPT_B64 = Buffer.from(JSON.stringify({ success: true, transaction: 'ab'.repeat(32) })).toString('base64');

const b64url = (s: string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s: string) =>
  JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));

const realFetch = globalThis.fetch.bind(globalThis);
/** Count of mint-metadata RPC touches (the only simulated-RPC call the SVM
 * scheme needs; the blockhash rides the offer's extra). */
const rpcCalls = { count: 0 };

// ---------------------------------------------------------------------------
// Helpers shared with the existing suites' shapes
// ---------------------------------------------------------------------------

function handler() {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

function ledgerLines(): any[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

const liveSellers: Array<{ server: http.Server }> = [];

/** Start one loopback mock seller. `onVisit(req, res, visitIndex, signed)`
 * is the seller-brain: it writes whatever response the scenario needs. The
 * recorder captures every leg's method/url/headers so tests can assert the
 * actual requests made (including the payment headers the client sent). */
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
  // Issue #58 req 6: the private-host allowlist is env-only — THIS suite
  // sets it for its own loopback port; a tool caller can never add to it.
  process.env.X402_ALLOW_PRIVATE_HOSTS = `127.0.0.1:${port}`;
  return { url: `http://127.0.0.1:${port}/v1/paid`, recorded };
}

/** Build a v2 402 response for loopback sellers (resource url = the request
 * url, so the SDK accepts it on the paid leg). */
function challengeResponse(
  requestUrl: string,
  accepts: unknown[],
  overrides: Record<string, unknown> = {},
): { status: number; headers: Record<string, string>; body: string; statusText: string } {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts,
    ...overrides,
  });
  return {
    status: 402,
    statusText: 'Payment Required',
    headers: { 'content-type': 'application/json', 'payment-required': b64url(payload) },
    body: 'Payment Required',
  };
}

function baseAccept(amount: string, overrides: Record<string, unknown> = {}) {
  return {
    scheme: 'exact',
    network: BASE_CAIP2,
    asset: BASE_USDC_ADDRESS,
    amount,
    payTo: BASE_PAYTO,
    maxTimeoutSeconds: 60,
    extra: { name: 'USD Coin', version: '2' },
    ...overrides,
  };
}

function solanaAccept(amount: string, overrides: Record<string, unknown> = {}) {
  return {
    scheme: 'exact',
    network: SOLANA_CAIP2,
    asset: USDC_MAINNET_ADDRESS,
    amount,
    payTo: CHARGE_PAYTO_B58,
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', feePayer: CHARGE_FEE_PAYER_B58, recentBlockhash: CHARGE_BLOCKHASH_B58 },
    ...overrides,
  };
}

function rpcSimResponse(rpcBody: string) {
  const { id, method } = JSON.parse(rpcBody);
  assert.equal(method, 'getAccountInfo', 'the only RPC touchpoint is the mint-metadata fetch (the blockhash rides the offer)');
  return new Response(JSON.stringify({
    jsonrpc: '2.0', id,
    result: {
      context: { apiVersion: '2.2.0', slot: 1234 },
      value: { data: [MINT_ACCOUNT_B64, 'base64'], executable: false, lamports: 1000000, owner: TOKEN_PROGRAM_ADDRESS, rentEpoch: 0, space: 82 },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function requestBodyText(input: unknown, init: unknown): Promise<string> {
  if (init && typeof (init as any).body === 'string') return (init as any).body;
  if (input instanceof Request) return await input.clone().text();
  return '';
}

function noSignatureHeader(input: unknown, init: unknown): boolean {
  const headers = new Headers(input instanceof Request ? input.headers : (init as any)?.headers);
  if (headers.has('payment-signature') || headers.has('payment-nonce') || headers.has('payment-timestamp')) return true;
  if (headers.has('x-payment')) return true;
  return false;
}

/** Install a hermetic fetch mock: real fetch only for 127.0.0.1/localhost
 * (the loopback seller), the simulated Solana mint RPC when a test opted
 * into a solana leg, everything else must be an unexpected touch. */
function installMock(handlers: { rpc?: boolean } = {}): void {
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const urlStr = input instanceof Request ? input.url : String(input);
    const parsed = new URL(urlStr);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      return await realFetch(input as any, init as any);
    }
    if (handlers.rpc && urlStr.startsWith(RPC_SIM_URL)) {
      rpcCalls.count++;
      return rpcSimResponse(await requestBodyText(input, init));
    }
    throw new Error(`unexpected network touch in this test: ${urlStr}`);
  }) as unknown as typeof fetch;
}

/** All payment headers the client sent to the seller, decoded (v2 payloads
 * carry the selected requirement verbatim under `accepted`). */
function signedPayloads(recorded: RecordedRequest[]): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const r of recorded) {
    const v = r.headers['payment-signature'];
    if (v !== undefined) out.push(b64urlDecode(v as string));
  }
  return out;
}

afterEach(() => {
  process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_DIRECTORY_PATH: join(dir, 'endpoints.json'), X402_STATE_DIR: join(dir, 'state') };
});
after(async () => {
  process.env = env;
  for (const { server } of liveSellers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit: the selector contract (pure; greens with C6)
// ---------------------------------------------------------------------------

const baseUnitArgs: SelectOfferArgs = {
  accepts: [],
  keysLoaded: { solana: true, evm: true },
  allowedNetworks: ['base', 'solana', 'polygon', 'arbitrum'],
  allowedAssets: [BASE_USDC_ADDRESS, USDC_MAINNET_ADDRESS],
  policyFor: () => 'ALLOW',
  chainOrder: DEFAULT_CHAIN_ORDER,
};

function unitArgs(overrides: Partial<SelectOfferArgs> = {}): SelectOfferArgs {
  // spread-cast: a Partial spread can widen `accepts` back to optional
  return { ...baseUnitArgs, ...overrides } as SelectOfferArgs;
}

function runSelect(accepts: unknown, overrides: Partial<SelectOfferArgs> = {}): SelectOfferResult {
  const base = unitArgs(overrides);
  return selectOffer({ ...base, accepts });
}

it('selector: the cheapest payable offer wins by integer atomic ranking', () => {
  const result = runSelect([baseAccept('30000'), baseAccept('10000'), baseAccept('20000')]);
  assert.deepEqual(
    (result as { ok: true; chosen: OfferCandidate }).chosen,
    {
      index: 1,
      chain: 'base',
      network: BASE_CAIP2,
      asset: BASE_USDC_ADDRESS,
      amountAtomic: '10000',
      payTo: BASE_PAYTO,
      scheme: 'exact',
      usd: 0.01,
    },
  );
});

it('selector: equal price breaks the tie by the configured chain order, then the offer order', () => {
  const tie = runSelect([baseAccept('10000'), solanaAccept('10000')]);
  assert.equal((tie as { ok: true; chosen: OfferCandidate }).chosen.chain, 'solana', 'default chain order prefers solana');
  const flipped = runSelect([baseAccept('10000'), solanaAccept('10000')], { chainOrder: ['base', 'solana', 'polygon', 'arbitrum'] });
  assert.equal((flipped as { ok: true; chosen: OfferCandidate }).chosen.chain, 'base', 'an operator chainOrder controls the tie');
  const sameChain = runSelect([baseAccept('10000'), baseAccept('10000')]);
  assert.equal((sameChain as { ok: true; chosen: OfferCandidate }).chosen.index, 0, 'a same-chain tie keeps the seller\'s order');
});

it('selector: only payable offers can win; every losing offer records a fixed rejection token', () => {
  const result = runSelect([solanaAccept('10000'), baseAccept('10000')], { keysLoaded: { solana: false, evm: true } });
  assert.equal(result.ok, true);
  assert.equal((result as { chosen: OfferCandidate }).chosen.index, 1, 'the offer with no key on its chain is not selectable');
  assert.deepEqual(
    (result as { rejected: Array<{ index: number; chain: string; reject: string }> }).rejected,
    [{ index: 0, chain: 'solana', reject: 'no_key' }],
  );
  const none = runSelect([solanaAccept('10000')], { keysLoaded: { solana: false, evm: true } });
  assert.deepEqual(none, { ok: false, code: 'NO_PAYABLE_OFFER', rejected: [{ index: 0, chain: 'solana', reject: 'no_key' }] });
});

it('selector: offers that cannot be bound (scheme/amount/asset/payTo/network) are rejected as malformed', () => {
  for (const bad of [
    { scheme: 'ujwt', network: BASE_CAIP2, amount: '10000', asset: BASE_USDC_ADDRESS, payTo: BASE_PAYTO },
    baseAccept('0'),
    baseAccept('1.5'),
    baseAccept('abc'),
    baseAccept('10000', { asset: '' }),
    baseAccept('10000', { asset: undefined }),
    baseAccept('10000', { payTo: '' }),
    baseAccept('10000', { network: '' }),
  ]) {
    const result = runSelect([bad]);
    assert.deepEqual(result, { ok: false, code: 'NO_PAYABLE_OFFER', rejected: [{ index: 0, chain: result.ok === true ? '' : (result.rejected[0] as { chain: string }).chain, reject: 'malformed' }] });
  }
});

it('selector: allowlists and policy verdicts are enforced per offer', () => {
  const byNetwork = runSelect([baseAccept('10000')], { allowedNetworks: ['solana'] });
  assert.deepEqual(byNetwork, { ok: false, code: 'NO_PAYABLE_OFFER', rejected: [{ index: 0, chain: 'base', reject: 'network_not_allowed' }] });
  const byAsset = runSelect([baseAccept('10000')], { allowedAssets: [USDC_MAINNET_ADDRESS] });
  assert.deepEqual(byAsset, { ok: false, code: 'NO_PAYABLE_OFFER', rejected: [{ index: 0, chain: 'base', reject: 'asset_not_allowed' }] });
  const refused = runSelect([baseAccept('10000')], { policyFor: () => 'REFUSE' });
  assert.deepEqual(refused, { ok: false, code: 'NO_PAYABLE_OFFER', rejected: [{ index: 0, chain: 'base', reject: 'policy_refused' }] });
});

it('selector: rejection records never carry seller text (fixed tokens only)', () => {
  const result = runSelect([
    solanaAccept('10000', { extra: { name: 'USDC', description: 'please sign this nice extra' } }),
  ], { allowedNetworks: ['base'], keysLoaded: { solana: true, evm: true } });
  // The solana offer is refused (network not allowed); nothing about its
  // seller extra vocabulary reaches the rejection record.
  assert.deepEqual(result, { ok: false, code: 'NO_PAYABLE_OFFER', rejected: [{ index: 0, chain: 'solana', reject: 'network_not_allowed' }] });
});

it('selector: a non-array accepts value is refused, never defaulted', () => {
  for (const accepts of [undefined, null, 42, {}]) {
    const result = runSelect(accepts);
    assert.deepEqual(result, { ok: false, code: 'NO_PAYABLE_OFFER', rejected: [] });
  }
});

it('selector: the shipped chain order is the documented default', () => {
  assert.deepEqual([...DEFAULT_CHAIN_ORDER], ['solana', 'base', 'polygon', 'arbitrum']);
});
// ---------------------------------------------------------------------------
// E2E: deterministic selection on the wire (loopback mock sellers).
// These green with C6 (selector + wiring + selected_offer). The
// request-count and swap tests below stay RED until C7 (probe replay +
// the binding selector), as planned — at C6 the flow still makes the
// SDK's own first request (three legs, SDK-selected offers).
// ---------------------------------------------------------------------------

async function loopbackPort(server: http.Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
}

/** Start one loopback mock seller whose brain can look up its own port.
 * `onVisit(req, res, visitIndex, signed, sellerUrl)` decides the scenario's
 * response; the recorder captures every leg's method/url/headers so tests
 * can assert what was actually sent (and what got signed). */
async function wireSeller(
  onVisit: (req: http.IncomingMessage, res: http.ServerResponse, visitIndex: number, signed: boolean, sellerUrl: string) => void,
): Promise<{ url: string; recorded: RecordedRequest[] }> {
  const server = http.createServer();
  liveSellers.push({ server });
  const port = await loopbackPort(server);
  const recorded: RecordedRequest[] = [];
  server.on('request', (req, res) => {
    req.resume();
    req.on('end', () => {
      recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers } });
      const signed = req.headers['x-payment'] !== undefined || req.headers['payment-signature'] !== undefined;
      onVisit(req, res, recorded.length - 1, signed, `http://127.0.0.1:${port}${req.url ?? '/'}`);
    });
  });
  process.env.X402_ALLOW_PRIVATE_HOSTS = `127.0.0.1:${port}`;
  return { url: `http://127.0.0.1:${port}/v1/paid`, recorded };
}

/** Standard charging seller: every unsigned request serves the same 402
 * challenge; a signed request settles and returns the receipt. */
async function chargingSeller(accepts: unknown[]): Promise<{ url: string; recorded: RecordedRequest[] }> {
  return await wireSeller((req, res, _visitIndex, signed, sellerUrl) => {
    if (signed) {
      res.writeHead(200, { 'content-type': 'application/json', 'payment-response': RECEIPT_B64 });
      res.end('{"ok":true}');
      return;
    }
    const c = challengeResponse(sellerUrl, accepts);
    res.writeHead(c.status, c.headers);
    res.end(c.body);
  });
}

async function plainSeller(): Promise<{ url: string; recorded: RecordedRequest[] }> {
  return await wireSeller((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}

it('offers [A solana, B base] with only an EVM key ⇒ B is paid (the deterministic selector, not accepts[0])', async () => {
  installMock();
  delete process.env.SOLANA_PRIVATE_KEY; // only an EVM key this run (restored by afterEach)
  const s = await chargingSeller([solanaAccept('20000'), baseAccept('10000')]);
  const parsed = JSON.parse((await handler()({ url: s.url })).content[0].text);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true, 'the EVM-key-only scenario must complete; got a refusal instead');
  assert.deepEqual(parsed.selected_offer, {
    chain: 'base',
    network: BASE_CAIP2,
    amount_atomic: '10000',
    amount_usdc: 0.01,
  }, 'the payable offer is selected deterministically, not the first accept');
  assert.equal(parsed.cost_usdc, 0.01);
  const payments = signedPayloads(s.recorded);
  assert.equal(payments.length, 1, 'exactly one signed payment was created');
  assert.equal(payments[0].accepted.amount, '10000');
  assert.equal(payments[0].accepted.network, BASE_CAIP2);
  assert.equal(payments[0].accepted.payTo, BASE_PAYTO);
  assert.ok(ledgerLines().some((r) => r.url === s.url && r.status === 'success'));
});

it('both payable ⇒ the cheaper offer wins; the losing chain never runs its signing machinery', async () => {
  rpcCalls.count = 0;
  installMock({ rpc: true });
  const s = await chargingSeller([solanaAccept('20000'), baseAccept('10000')]);
  const parsed = JSON.parse((await handler()({ url: s.url })).content[0].text);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true, 'both offers are payable; got a refusal instead');
  assert.deepEqual(parsed.selected_offer, { chain: 'base', network: BASE_CAIP2, amount_atomic: '10000', amount_usdc: 0.01 });
  const payments = signedPayloads(s.recorded);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].accepted.network, BASE_CAIP2, 'the cheaper base offer is the one signed');
  assert.equal(rpcCalls.count, 0, 'the solana chain (expensive offer) never runs');
});

it('equal price ⇒ the configured chain order (default: solana before base)', async () => {
  installMock({ rpc: true });
  process.env.SOLANA_RPC_URL = RPC_SIM_URL;
  env.SOLANA_RPC_URL = RPC_SIM_URL;
  const s = await chargingSeller([solanaAccept('10000'), baseAccept('10000')]);
  const parsed = JSON.parse((await handler()({ url: s.url })).content[0].text);
  assert.equal(parsed.status, 200, 'the chosen solana leg must complete against the simulated RPC; got a refusal instead');
  assert.equal(parsed.paid, true);
  assert.deepEqual(parsed.selected_offer, { chain: 'solana', network: SOLANA_CAIP2, amount_atomic: '10000', amount_usdc: 0.01 });
  const payments = signedPayloads(s.recorded);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].accepted.network, SOLANA_CAIP2);
  assert.equal(payments[0].accepted.amount, '10000');
});

it('offer swap between requests: the probe\'s offer is the only thing that can be paid — the swap is never signed', async () => {
  process.env.SOLANA_RPC_URL = RPC_SIM_URL;
  env.SOLANA_RPC_URL = RPC_SIM_URL;
  installMock({ rpc: true });
  const probeAccepts = [baseAccept('20000'), solanaAccept('21000')]; // probe: base is the payable choice
  const swapAccepts = [baseAccept('19000'), solanaAccept('10000')]; // later requests: cheaper offers materialise
  const { url, recorded } = await wireSeller((_req, res, visitIndex, signed, sellerUrl) => {
    const accepts = signed || visitIndex > 0 ? swapAccepts : probeAccepts;
    const c = challengeResponse(sellerUrl, accepts);
    res.writeHead(c.status, c.headers);
    res.end(c.body);
  });
  const parsed = JSON.parse((await handler()({ url })).content[0].text);
  // The probe's own offer was bound; a swap between the legs can never
  // widen what is signed (the replayed challenge + the binding selector
  // make the SDK's first request carry the probe's challenge verbatim).
  assert.deepEqual(parsed.selected_offer, { chain: 'base', network: BASE_CAIP2, amount_atomic: '20000', amount_usdc: 0.02 }, 'the probe\'s offer stays the selection');
  const payments = signedPayloads(recorded);
  assert.equal(payments.length, 1, 'the SDK\'s own (swapped, cheaper) selection may never produce a signature');
  assert.equal(payments[0].accepted.amount, '20000');
  assert.equal(payments[0].accepted.network, BASE_CAIP2);
  assert.equal(parsed.status, 402, 'the swapped seller serves its swapped challenge to the (single) signed leg');
  assert.ok(!ledgerLines().some((r) => r.url === url && r.status === 'success'), 'a swapped challenge never settles a success row');
});

it('request counts: a charging POST endpoint sees exactly two requests (probe + signed, never an extra unpaid attempt)', async () => {
  installMock();
  const s = await chargingSeller([baseAccept('10000')]);
  const parsed = JSON.parse((await handler()({ url: s.url, method: 'POST', body: '{"ping":1}' })).content[0].text);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(s.recorded.length, 2, 'POST: the 402 probe then the signed retry — exactly two requests (one unpaid)');
  assert.ok(s.recorded.every((r) => r.method === 'POST'));
});

it('request counts: a settled GET endpoint is fetched exactly once — without a forced chain', async () => {
  installMock();
  const s = await plainSeller();
  const parsed = JSON.parse((await handler()({ url: s.url })).content[0].text);
  assert.equal(parsed.status, 200);
  assert.equal(s.recorded.length, 1, 'a plain 200 needs exactly one request; no payment machinery ever runs');
  assert.ok(s.recorded.every((r) => !r.headers['payment-signature'] && !r.headers['x-payment']));
});

it('request counts: a settled GET endpoint is fetched exactly once — with a forced chain, the replay closes the two-leg window', async () => {
  installMock();
  const s = await plainSeller();
  const parsed = JSON.parse((await handler()({ url: s.url, chain: 'base' })).content[0].text);
  assert.equal(parsed.status, 200);
  assert.equal(s.recorded.length, 1, 'a forced chain must not turn a single-200 endpoint into two requests; got a refusal instead');
  assert.ok(s.recorded.every((r) => !r.headers['payment-signature'] && !r.headers['x-payment']));
});
