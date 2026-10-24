// Issue #62 — the per-network asset table, exact decimals/USD pricing, and the
// (PR #74's offer-selection seam) table-driven offer ranking.
//
// RED commit (plan C1): this file imports ./assets.js, which does not exist
// yet, so the test compile fails with "Cannot find module './assets.js'" —
// the stated failure (the per-network asset table is not built yet). The
// pure-table tests green with C2 (src/assets.ts + policy config validation);
// the mock-seller and selection tests green with C3 (fetch.ts +
// offer-selection wiring). The stated RED errors are the TS2307 on
// ./assets.js and the TS2339 on PolicyConfig.assets (both by design).
//
// Hermetic: temp ledger/directory/state paths, throwaway keys generated at
// runtime, loopback mock sellers only, no live network, no real RPC. The two
// challenge fixtures below are the MEASURED 2026-10-24 shapes of the mainnet
// and devnet pings (public protocol identifiers — asset ids and CAIP-2
// network strings, not secrets).

import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Hermetic env: temp ledger/directory/state paths BEFORE importing fetch.js
// (the PAYMENT_LOG_PATH pattern from the existing suites). The e2e flows run
// in mainnet mode (issue #59's explicit env — set from the start so these
// tests survive C7; the variable is simply unused before it).
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'x402-assets-test-'));
const LEDGER_PATH = join(dir, 'ledger.jsonl');
process.env.PAYMENT_LOG_PATH = LEDGER_PATH;
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
process.env.X402_STATE_DIR = join(dir, 'state');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-24' }), 'utf8');
process.env.X402_NETWORK_MODE = 'mainnet';

// Throwaway runtime keys only — signing is fully local; the Solana leg uses
// the simulated mint-metadata RPC (the blockhash rides the offer's extra).
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = Buffer.from(publicKey.export({ type: 'spki', format: 'der' } as any).slice(-32) as unknown as Uint8Array);
const priv = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' } as any).slice(16) as unknown as Uint8Array);
const SOLANA_KEY_B58 = bs58.encode(Buffer.concat([priv, pub]));
process.env.SOLANA_PRIVATE_KEY = SOLANA_KEY_B58;
const EVM_KEY = `0x${'22'.repeat(32)}`;
process.env.EVM_PRIVATE_KEY = EVM_KEY;

const { registerFetchTool } = await import('./tools/fetch.js');
// C1 RED: ./assets.js does not exist yet — the typed dynamic import below is
// the stated compile failure of this commit ("Cannot find module
// './assets.js' and its corresponding type declarations").
const ASSETS = (await import('./assets.js')) as typeof import('./assets.js');
const { getPolicyEngine, buildPolicyContext } = (await import('./policy/config.js')) as typeof import('./policy/config.js');
const { TOKEN_PROGRAM_ADDRESS } = (await import('@x402/svm')) as typeof import('@x402/svm');
const { DEFAULT_CHAIN_ORDER } = (await import('./tools/offer-selection.js')) as typeof import('./tools/offer-selection.js');

// ---------------------------------------------------------------------------
// Fixture constants: the measured challenges + public protocol identifiers.
// ---------------------------------------------------------------------------
const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOLANA_DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const CASPER_MAINNET_CAIP2 = 'casper:casper';
const CASPER_TESTNET_CAIP2 = 'casper:casper-test';
/** Solana mainnet USDC — the live mainnet ping's asset (amount 2000 atomic → $0.002). */
const USDC_MAINNET_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Solana devnet USDC — the live devnet ping's asset (amount 1000 atomic → the documented $0.001). */
const USDC_DEVNET_SOL = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
/** wCSPR package hashes (public CEP-18 identifiers, from src/casper/accepts.ts). */
const { WCSPR_ASSETS } = (await import('./casper/accepts.js')) as typeof import('./casper/accepts.js');
const USDC_MAINNET_EVM = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_POLYGON_EVM = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const USDC_ARBITRUM_EVM = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

/** A 9-decimal EXTENSION-listed asset fixture (test-only id, never shipped). */
const NINE_DP_ASSET = 'aaaa9AAAAAAAAA9AAAAA9AAAAAAAAA9AAAAA9AAAAA9';
const NINE_DP_RATE = 5; // USD per whole token unit → priced USD = usdFromAtomic(atomic, 9) × 5
const nineDpExtension = [
  { network: SOLANA_MAINNET_CAIP2, asset: NINE_DP_ASSET, symbol: 'WUSD9', decimals: 9, usdRate: NINE_DP_RATE },
];

/** Solana mainnet USDT — an SDK default asset (public protocol id) used for the token-allowlist e2e. */
const USDT_MAINNET_SOL = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// ---------------------------------------------------------------------------
// Pure table + pricing tests (green with C2)
// ---------------------------------------------------------------------------

it('table: the shipped entries carry symbol, decimals and the USD-peg flag', () => {
  const table = ASSETS.ASSET_TABLE;
  const find = (network: string, asset: string) =>
    table.find((e) => e.network === network && e.asset.toLowerCase() === asset.toLowerCase());
  const mainnet = find(SOLANA_MAINNET_CAIP2, USDC_MAINNET_SOL)!;
  const devnet = find(SOLANA_DEVNET_CAIP2, USDC_DEVNET_SOL)!;
  assert.ok(mainnet, 'mainnet USDC entry must exist');
  assert.ok(devnet, 'devnet USDC entry must exist');
  assert.deepEqual({ symbol: mainnet.symbol, decimals: mainnet.decimals, usdPeg: mainnet.usdPeg }, { symbol: 'USDC', decimals: 6, usdPeg: true });
  assert.deepEqual({ symbol: devnet.symbol, decimals: devnet.decimals, usdPeg: devnet.usdPeg }, { symbol: 'USDC', decimals: 6, usdPeg: true });
  const base = find('eip155:8453', USDC_MAINNET_EVM)!;
  const polygon = find('eip155:137', USDC_POLYGON_EVM)!;
  const arbitrum = find('eip155:42161', USDC_ARBITRUM_EVM)!;
  for (const entry of [base, polygon, arbitrum]) {
    assert.ok(entry, 'the EVM mainnet USDC entries must exist');
    assert.equal(entry!.decimals, 6);
    assert.equal(entry!.usdPeg, true);
    assert.equal(entry!.symbol, 'USDC');
  }
  const wcSprMain = find(CASPER_MAINNET_CAIP2, WCSPR_ASSETS[CASPER_MAINNET_CAIP2])!;
  const wcSprTest = find(CASPER_TESTNET_CAIP2, WCSPR_ASSETS[CASPER_TESTNET_CAIP2])!;
  assert.ok(wcSprMain && wcSprTest, 'both wCSPR entries must exist');
  assert.deepEqual({ symbol: wcSprMain.symbol, decimals: wcSprMain.decimals, usdPeg: wcSprMain.usdPeg }, { symbol: 'wCSPR', decimals: 9, usdPeg: false });
  assert.deepEqual({ symbol: wcSprTest.symbol, decimals: wcSprTest.decimals, usdPeg: wcSprTest.usdPeg }, { symbol: 'wCSPR', decimals: 9, usdPeg: false });
});

it('pricing: the MEASURED mainnet and devnet fixtures price exactly at 6 decimals', () => {
  // mainnet ping: asset USDC mainnet, amount 2000
  const main = ASSETS.priceAtomicAsUsd(SOLANA_MAINNET_CAIP2, USDC_MAINNET_SOL, '2000');
  assert.ok(main.ok === true, 'the live mainnet fixture is listed and priced');
  assert.equal((main as { usd: number }).usd, 0.002);
  assert.equal((main as { symbol: string }).symbol, 'USDC');
  // devnet ping: amount 1000 atomic = the documented $0.001
  const dev = ASSETS.priceAtomicAsUsd(SOLANA_DEVNET_CAIP2, USDC_DEVNET_SOL, '1000');
  assert.ok(dev.ok === true, 'the live devnet fixture is listed and priced');
  assert.equal((dev as { usd: number }).usd, 0.001);
  assert.equal((dev as { symbol: string }).symbol, 'USDC');
});

it('pricing: an unlisted asset is refused with the stable ASSET_NOT_LISTED code (never priced, never assumed)', () => {
  const unlisted = ASSETS.priceAtomicAsUsd(SOLANA_MAINNET_CAIP2, 'FakeTokEn11111111111111111111111111111111', '10000');
  assert.deepEqual(unlisted, { ok: false, code: 'ASSET_NOT_LISTED' });
  // an asset that exists on the WRONG network is unlisted too (network-strict)
  const wrongNet = ASSETS.priceAtomicAsUsd(SOLANA_DEVNET_CAIP2, USDC_MAINNET_SOL, '10000');
  assert.deepEqual(wrongNet, { ok: false, code: 'ASSET_NOT_LISTED' });
});

it('pricing: the per-call cap boundary prices exactly at 6 decimals (largest fitting amount passes, one unit above is refused)', async () => {
  const saved = { cap: process.env.MAX_PAYMENT_PER_CALL, daily: process.env.MAX_DAILY_SPEND, tokens: process.env.X402_POLICY_TOKENS };
  try {
    process.env.MAX_PAYMENT_PER_CALL = '1.50';
    process.env.MAX_DAILY_SPEND = '20.00';
    delete process.env.X402_POLICY_TOKENS;
    // largest atomic value that still fits the cap: exactly 1.50 (reaching the
    // cap exactly is allowed — the same boundary checkSpendingLimit enforces)
    const atCap = ASSETS.priceAtomicAsUsd(SOLANA_MAINNET_CAIP2, USDC_MAINNET_SOL, '1500000') as { ok: true; usd: number; symbol: string };
    assert.ok(atCap.ok === true && atCap.usd === 1.5);
    const evalAt = getPolicyEngine().evaluate(
      buildPolicyContext('https://cap-boundary.fixture/api', 'solana', atCap.symbol, atCap.usd),
      { dailySpentUsd: 0, perServiceSpentUsd: 0 },
    );
    assert.equal(evalAt.decision, 'ALLOW');
    // one unit above the cap is refused with the stable code, never clamped
    const above = ASSETS.priceAtomicAsUsd(SOLANA_MAINNET_CAIP2, USDC_MAINNET_SOL, '1500001') as { ok: true; usd: number; symbol: string };
    assert.ok(above.ok === true && above.usd === 1.500001);
    const evalAbove = getPolicyEngine().evaluate(
      buildPolicyContext('https://cap-boundary.fixture/api', 'solana', above.symbol, above.usd),
      { dailySpentUsd: 0, perServiceSpentUsd: 0 },
    );
    assert.equal(evalAbove.decision, 'DENY');
    assert.ok(evalAbove.reasons.some((r) => r.code === 'REQUEST_LIMIT_EXCEEDED'));
  } finally {
    if (saved.cap !== undefined) process.env.MAX_PAYMENT_PER_CALL = saved.cap; else delete process.env.MAX_PAYMENT_PER_CALL;
    if (saved.daily !== undefined) process.env.MAX_DAILY_SPEND = saved.daily; else delete process.env.MAX_DAILY_SPEND;
    if (saved.tokens !== undefined) process.env.X402_POLICY_TOKENS = saved.tokens; else delete process.env.X402_POLICY_TOKENS;
  }
});

it('pricing: a 9-decimal entry prices exactly at several amounts; its cap boundary holds too', async () => {
  const saved = { cap: process.env.MAX_PAYMENT_PER_CALL, daily: process.env.MAX_DAILY_SPEND, tokens: process.env.X402_POLICY_TOKENS };
  try {
    process.env.MAX_PAYMENT_PER_CALL = '1.50';
    process.env.MAX_DAILY_SPEND = '20.00';
    process.env.X402_POLICY_TOKENS = 'USDC,WUSD9';
    const priced = ASSETS.priceAtomicAsUsd(SOLANA_MAINNET_CAIP2, NINE_DP_ASSET, '900000000', nineDpExtension) as { ok: true; usd: number; symbol: string };
    assert.ok(priced.ok === true, 'the extension-listed 9-decimal asset is priced');
    assert.equal(priced.usd, 4.5, '0.9 whole units × usdRate 5');
    assert.equal(priced.symbol, 'WUSD9');
    // cap boundary at 9 decimals: 1.50 / 5 = 0.30 whole units → 300000000 atomic fits exactly
    const atCap = ASSETS.priceAtomicAsUsd(SOLANA_MAINNET_CAIP2, NINE_DP_ASSET, '300000000', nineDpExtension) as { ok: true; usd: number };
    assert.ok(atCap.ok === true && atCap.usd === 1.5);
    const evalAt = getPolicyEngine().evaluate(
      buildPolicyContext('https://cap-boundary-9dp.fixture/api', 'solana', 'WUSD9', atCap.usd),
      { dailySpentUsd: 0, perServiceSpentUsd: 0 },
    );
    assert.equal(evalAt.decision, 'ALLOW');
    const above = ASSETS.priceAtomicAsUsd(SOLANA_MAINNET_CAIP2, NINE_DP_ASSET, '300000001', nineDpExtension) as { ok: true; usd: number };
    assert.ok(above.ok === true && above.usd === 1.500000005);
    const evalAbove = getPolicyEngine().evaluate(
      buildPolicyContext('https://cap-boundary-9dp.fixture/api', 'solana', 'WUSD9', above.usd),
      { dailySpentUsd: 0, perServiceSpentUsd: 0 },
    );
    assert.equal(evalAbove.decision, 'DENY');
    assert.ok(evalAbove.reasons.some((r) => r.code === 'REQUEST_LIMIT_EXCEEDED'));
  } finally {
    if (saved.cap !== undefined) process.env.MAX_PAYMENT_PER_CALL = saved.cap; else delete process.env.MAX_PAYMENT_PER_CALL;
    if (saved.daily !== undefined) process.env.MAX_DAILY_SPEND = saved.daily; else delete process.env.MAX_DAILY_SPEND;
    if (saved.tokens !== undefined) process.env.X402_POLICY_TOKENS = saved.tokens; else delete process.env.X402_POLICY_TOKENS;
  }
});

it('pricing: a non-pegged asset without a configured rate is refused with ASSET_NO_USD_RATE (never a made-up price)', () => {
  // wCSPR: listed, 9 decimals, NOT USD-pegged, no rate → the USD-leg refusal code.
  const unpriced = ASSETS.priceAtomicAsUsd(CASPER_MAINNET_CAIP2, WCSPR_ASSETS[CASPER_MAINNET_CAIP2], '1000000000');
  assert.deepEqual(unpriced, { ok: false, code: 'ASSET_NO_USD_RATE' });
});

it('config: assets.extensions[] entries validate fail-closed; a priced entry applies', async () => {
  const { loadPolicyConfig } = (await import('./policy/config.js')) as typeof import('./policy/config.js');
  const configDir = mkdtempSync(join(tmpdir(), 'x402-assets-config-'));
  const previousConfigPath = process.env.POLICY_CONFIG_PATH;
  try {
    // (1) an entry without usdPeg:true and without a positive usdRate is
    //     REJECTED at config validation (fail closed — never an assumed rate)
    process.env.POLICY_CONFIG_PATH = join(configDir, 'bad.json');
    writeFileSync(process.env.POLICY_CONFIG_PATH, JSON.stringify({
      payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
      assets: { extensions: [{ network: SOLANA_MAINNET_CAIP2, asset: NINE_DP_ASSET, symbol: 'WUSD9', decimals: 9 }] },
    }), 'utf8');
    const bad = loadPolicyConfig();
    assert.ok(bad.configErrors.some((e) => /assets\.extensions\[0\]/.test(e)), 'the offending entry is named');
    assert.ok(bad.configErrors.some((e) => /usdRat|usd Peg|prices nothing/i.test(e)), `the unpriced entry is rejected at CONFIG VALIDATION (got: ${bad.configErrors.join(' | ')})`);
    assert.deepEqual(bad.config.assets, { extensions: [] }, 'a rejected asset extension list falls back to the empty default (fail closed)');

    // (2) a priced entry applies and the loaded entry carries every field
    process.env.POLICY_CONFIG_PATH = join(configDir, 'good.json');
    writeFileSync(process.env.POLICY_CONFIG_PATH, JSON.stringify({
      payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
      tokens: { allowed: ['USDC', 'WUSD9'] },
      assets: { extensions: [{ network: SOLANA_MAINNET_CAIP2, asset: NINE_DP_ASSET, symbol: 'WUSD9', decimals: 9, usdRate: NINE_DP_RATE }] },
    }), 'utf8');
    const good = loadPolicyConfig();
    assert.deepEqual(good.configErrors, [], 'a priced entry validates');
    assert.equal(good.config.assets?.extensions?.length, 1);
    assert.deepEqual(
      { ...good.config.assets?.extensions?.[0] },
      { network: SOLANA_MAINNET_CAIP2, asset: NINE_DP_ASSET, symbol: 'WUSD9', decimals: 9, usdRate: NINE_DP_RATE },
      'operator-extended symbol/decimals/rate are loaded verbatim (no normalisation)'
    );
  } finally {
    if (previousConfigPath !== undefined) process.env.POLICY_CONFIG_PATH = previousConfigPath; else delete process.env.POLICY_CONFIG_PATH;
    rmSync(configDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Selection: different-decimal offers rank by TABLE-PRICED USD — never by the
// raw atomic string and never by a fixed-6 float (the PR #74 seam; green with
// C3 when selectOffer accepts the usdOf injection; before that the call shape
// below is what the wiring must implement).
// ---------------------------------------------------------------------------

it('selection: with a 9-decimal offer numerically cheaper as a raw atomic string, ranking picks the USD-cheaper offer', async () => {
  const sel = (await import('./tools/offer-selection.js')) as any;
  const payTo = bs58.encode(Buffer.alloc(32, 0x21));
  // A: 9-decimal extension asset priced at $4.50 — its ATOMIC string
  // (900000000) is numerically SMALLER than B's (1000000000), and a fixed-6
  // float rank would also pick it (900 < 1000). Table-USD ranking must pick
  // B ($1.00).
  const accepts = [
    {
      scheme: 'exact', network: SOLANA_MAINNET_CAIP2, asset: NINE_DP_ASSET, amount: '900000000',
      payTo, maxTimeoutSeconds: 60, extra: { name: 'WUSD9' },
    },
    {
      scheme: 'exact', network: SOLANA_MAINNET_CAIP2, asset: USDC_MAINNET_SOL, amount: '1000000000',
      payTo, maxTimeoutSeconds: 60, extra: { name: 'USDC' },
    },
  ];
  const usdOf = (asset: string, network: string, atomic: string) =>
    ASSETS.priceAtomicAsUsd(network, asset, atomic, nineDpExtension as never);
  const result = sel.selectOffer({
    accepts,
    keysLoaded: { solana: true, evm: true },
    allowedNetworks: ['solana'],
    networkAllowed: () => true,
    usdOf,
    policyFor: () => 'ALLOW',
    chainOrder: DEFAULT_CHAIN_ORDER,
  });
  const chosen = (result as { ok: boolean; chosen?: { asset: string; usd: number } }).chosen;
  assert.ok(result.ok === true && chosen, 'a payable offer is selected');
  assert.equal(chosen!.asset, USDC_MAINNET_SOL, 'the USD-cheaper offer wins — ranking never runs on the raw atomic string or a fixed-6 float');
  assert.equal(chosen!.usd, 1.0, 'the ranking input is the table-priced USD value');
});

// ---------------------------------------------------------------------------
// E2E: the asset boundary inside x402_fetch (green with C3). Loopback mock
// sellers only; the private-host allowlist is set per seller port.
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

function challengeResponse(
  requestUrl: string,
  accepts: unknown[],
  overrides: Record<string, unknown> = {},
): { status: number; headers: Record<string, string>; body: string } {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts,
    ...overrides,
  });
  return {
    status: 402,
    headers: { 'content-type': 'application/json', 'payment-required': b64url(payload) },
    body: 'Payment Required',
  };
}

function solanaPayTo(): string {
  return bs58.encode(Buffer.alloc(32, 0x11));
}

/** A valid 82-byte SPL mint account (owner = Token program, decimals 6). */
const MINT_ACCOUNT_B64 = (() => {
  const mint = Buffer.alloc(82);
  mint.writeUInt8(6, 44);
  mint.writeUInt8(1, 45);
  return mint.toString('base64');
})();

function rpcSimResponse(rpcBody: string): Response {
  const { id, method } = JSON.parse(rpcBody);
  assert.equal(method, 'getAccountInfo', 'the only RPC touchpoint is the mint-metadata fetch (the blockhash rides the offer)');
  return new Response(JSON.stringify({
    jsonrpc: '2.0', id,
    result: { context: { apiVersion: '2.2.0', slot: 1234 }, value: { data: [MINT_ACCOUNT_B64, 'base64'], executable: false, lamports: 1000000, owner: TOKEN_PROGRAM_ADDRESS, rentEpoch: 0, space: 82 } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const RPC_SIM_URL = 'https://rpc-sim.invalid';
const realFetch = globalThis.fetch.bind(globalThis);
function installMock(handlers: { rpc?: (body: string) => Response } = {}): void {
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const urlStr = input instanceof Request ? input.url : String(input);
    const parsed = new URL(urlStr);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      return await realFetch(input as any, init as any);
    }
    if (handlers.rpc && urlStr.startsWith(RPC_SIM_URL)) return handlers.rpc((JSON.stringify((init as any)?.body ?? '')) as string);
    throw new Error(`unexpected network touch in this test: ${urlStr}`);
  }) as unknown as typeof fetch;
}

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

it('e2e: an offer on an UNLISTED asset is refused with a stable code BEFORE any signing — zero payment headers, nothing bound', async () => {
  const { url, recorded } = await seller((req, res) => {
    const resp = challengeResponse(url, [solanaAcceptWith('FakeTokEn222222222222222222222222222222222', '10000')]);
    res.writeHead(resp.status, resp.headers);
    res.end(resp.body);
  });
  installMock();
  const result = await handler()({ url, chain: 'solana' });
  const parsed = JSON.parse(result.content[0].text);
  assert.match(parsed.error as string, /ASSET_NOT_LISTED/, `the refusal carries the stable code before any signing (got: ${parsed.error})`);
  assert.equal(parsed.reasons?.[0]?.code, 'ASSET_NOT_LISTED');
  assert.equal(parsed.status, undefined, 'no HTTP status: the paid request never ran');
  assert.equal(recorded.length, 1, 'the paid request never ran — the refusal precedes the client entirely');
  assert.ok(recorded.every(noPaymentHeaders), 'zero payment headers ever left');
  assert.ok(!ledgerLines().some((e) => e.status === 'success'), 'nothing settled');
});

it('e2e: tokens.allowed excluding the offer symbol refuses with TOKEN_NOT_ALLOWED; including it pays', async () => {
  // The offer's asset must be BOTH table-listed (via assets.extensions — the
  // shipped table is USDC+wCSPR only) AND SDK-signable (an SDK default
  // asset) → the second default Solana token. The symbol the POLICY sees is
  // the one the test-configured list entry carries.
  const rpcSimHandler = rpcSimResponse;
  for (const [allowed, expectPaid] of [['USDC', false], ['USDC,USDT', true]] as const) {
    const configDir = mkdtempSync(join(tmpdir(), 'x402-assets-tokens-'));
    const previousConfigPath = process.env.POLICY_CONFIG_PATH;
    try {
      process.env.POLICY_CONFIG_PATH = join(configDir, 'policy.json');
      writeFileSync(process.env.POLICY_CONFIG_PATH, JSON.stringify({
        payments: { enabled: true, maxPerRequest: 0.50, maxDaily: 10 },
        networks: { allowed: ['solana'] },
        tokens: { allowed: allowed.split(',') },
        assets: { extensions: [{ network: SOLANA_MAINNET_CAIP2, asset: USDT_MAINNET_SOL, symbol: 'USDT', decimals: 6, usdPeg: true }] },
      }), 'utf8');
      process.env.MAX_PAYMENT_PER_CALL = '0.50';
      process.env.MAX_DAILY_SPEND = '10.00';
      process.env.SOLANA_RPC_URL = RPC_SIM_URL;

      const receiptB64 = Buffer.from(JSON.stringify({ success: true, transaction: 'cd'.repeat(32) })).toString('base64');
      const { url, recorded } = await seller((req, res, _visitIndex, signed) => {
        if (!signed) {
          const resp = challengeResponse(url, [{
            scheme: 'exact', network: SOLANA_MAINNET_CAIP2, asset: USDT_MAINNET_SOL, amount: '10000',
            payTo: bs58.encode(Buffer.alloc(32, 0x17)), maxTimeoutSeconds: 60,
            extra: { name: 'USDT', feePayer: bs58.encode(Buffer.alloc(32, 0x19)), recentBlockhash: bs58.encode(Buffer.alloc(32, 0x1b)) },
          }]);
          res.writeHead(resp.status, resp.headers);
          res.end(resp.body);
          return;
        }
        res.writeHead(200, { 'payment-response': receiptB64 });
        res.end('{"ok":true}');
      });
      installMock({ rpc: rpcSimHandler });
      const result = await handler()({ url, chain: 'solana' });
      const parsed = JSON.parse(result.content[0].text);
      if (!expectPaid) {
        assert.equal(parsed.status, undefined, `tokens.allowed=[${allowed}] refuses the offer at the policy gate`);
        assert.match(parsed.error as string, /TOKEN_NOT_ALLOWED/, 'the excluded symbol blocks the offer');
        assert.ok(recorded.every(noPaymentHeaders), 'zero payment headers under the exclusion');
      } else {
        assert.equal(parsed.status, 200, `tokens.allowed=[${allowed}] allows the offer`);
        assert.equal(parsed.paid, true);
        assert.equal(parsed.selected_offer.amount_usdc, 0.01, 'priced through the list entry at exactly 6 decimals');
        assert.ok(recorded.some((r) => !noPaymentHeaders(r)), 'a signed paid leg happened when the symbol is allowed');
      }
      for (const s of liveSellers.splice(0)) await new Promise<void>((resolve) => s.server.close(() => resolve()));
    } finally {
      if (previousConfigPath !== undefined) process.env.POLICY_CONFIG_PATH = previousConfigPath; else delete process.env.POLICY_CONFIG_PATH;
      rmSync(configDir, { recursive: true, force: true });
    }
  }
});

function solanaAcceptWith(asset: string, amount: string): Record<string, unknown> {
  return {
    scheme: 'exact',
    network: SOLANA_MAINNET_CAIP2,
    asset,
    amount,
    payTo: bs58.encode(Buffer.alloc(32, 0x11)),
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', feePayer: bs58.encode(Buffer.alloc(32, 0x13)), recentBlockhash: bs58.encode(Buffer.alloc(32, 0x15)) },
  };
}

// ---------------------------------------------------------------------------
afterEach(() => {
  // Restore the hermetic baseline (tests may override policy env vars).
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
  process.env = { ...process.env, PAYMENT_LOG_PATH: undefined } as NodeJS.ProcessEnv;
  delete process.env.PAYMENT_LOG_PATH;
  rmSync(dir, { recursive: true, force: true });
});