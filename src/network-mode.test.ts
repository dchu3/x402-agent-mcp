// Issue #59 — the EXPLICIT network mode (X402_NETWORK_MODE), exact CAIP-2
// classification, and the separate devnet spend bucket.
//
// RED commit (plan C6): this file imports ./networks.js (the post-C7 module)
// and payment-utils' getDevnetDailySpent(), neither of which exists yet, so
// the test compile fails with "Cannot find module './networks.js'" and the
// TS2339 on getDevnetDailySpent — the stated failures (the mode resolver
// module and the devnet spend bucket are not built yet; precedent: #61's C1
// and #62's C1/C4). The classification tests additionally fail at RUNTIME
// against the current probe-utils.ts:51 substring matcher (that is the #59
// req 6 defect being pinned). Everything goes green with C7 (mode resolver +
// exact parser + mode-bounded registration + RPC split) and C8 (the devnet
// ledger network + bucket).
//
// Hermetic: temp ledger/directory/state paths, throwaway runtime keys,
// loopback mock sellers only, no live network, no real RPC. The devnet
// fixture is the MEASURED 2026-10-24 shape of the lab-devnet ping (asset id,
// CAIP-2 network and feePayer are public protocol identifiers, not secrets).

import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Hermetic env: temp ledger/directory/state paths BEFORE importing fetch.js.
// The mode itself is per-test: the flow reads X402_NETWORK_MODE at call time
// (post-C7 resolveNetworkMode()), so each test sets and afterEach restores it.
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'x402-netmode-test-'));
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

const { registerFetchTool } = await import('./tools/fetch.js');
// C6 RED: ./networks.js does not exist yet — the typed dynamic imports below
// are the stated compile failure of this commit ("Cannot find module
// './networks.js' and its corresponding type declarations").
const NET = (await import('./networks.js')) as typeof import('./networks.js');
const PU = (await import('./tools/probe-utils.js')) as typeof import('./tools/probe-utils.js');
const PM = (await import('./payment-utils.js')) as typeof import('./payment-utils.js');
const { TOKEN_PROGRAM_ADDRESS, SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2 } = (await import('@x402/svm')) as typeof import('@x402/svm');

// ---------------------------------------------------------------------------
// Fixture constants (public protocol identifiers).
// ---------------------------------------------------------------------------
const USDC_MAINNET_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DEVNET_SOL = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const EVM_BASE_CAIP2 = 'eip155:8453';

// ---------------------------------------------------------------------------
// Pure resolver pins (green with C7's src/networks.ts)
// ---------------------------------------------------------------------------

it('pure: parseNetworkMode — mainnet/devnet accepted, unset absent, and invalid values read with the key context', () => {
  assert.deepEqual(NET.parseNetworkMode({ X402_NETWORK_MODE: 'mainnet' } as NodeJS.ProcessEnv), { mode: 'mainnet' });
  assert.deepEqual(NET.parseNetworkMode({ X402_NETWORK_MODE: 'devnet' } as NodeJS.ProcessEnv), { mode: 'devnet' });
  // Case/whitespace tolerant (documented): a capitalized value is still explicit.
  assert.deepEqual(NET.parseNetworkMode({ X402_NETWORK_MODE: ' Devnet ' } as unknown as NodeJS.ProcessEnv), { mode: 'devnet' });
  // Unset → no mode (the gate then decides by key presence).
  assert.deepEqual(NET.parseNetworkMode({} as unknown as NodeJS.ProcessEnv), {});
  // Any other value is INVALID — the mode is never guessed.
  assert.deepEqual(NET.parseNetworkMode({ X402_NETWORK_MODE: 'moonnet' } as unknown as NodeJS.ProcessEnv), { invalid: 'moonnet' });
  assert.deepEqual(NET.parseNetworkMode({ X402_NETWORK_MODE: 'main net' } as unknown as NodeJS.ProcessEnv), { invalid: 'main net' });
});

it('pure: modeAllowsNetwork — the exact network must be the mode\'s; a devnet/testnet id never passes in mainnet mode', () => {
  assert.equal(NET.modeAllowsNetwork('mainnet', SOLANA_MAINNET_CAIP2), true, 'mainnet mode allows the exact solana mainnet id');
  assert.equal(NET.modeAllowsNetwork('mainnet', EVM_BASE_CAIP2), true, 'mainnet mode allows EVM mainnet chains (the policy narrows further)');
  assert.equal(NET.modeAllowsNetwork('mainnet', SOLANA_DEVNET_CAIP2), false, 'a devnet genesis is NOT the solana chain — refused in mainnet mode (req 4)');
  assert.equal(NET.modeAllowsNetwork('mainnet', 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z'), false, 'the solana testnet id is refused in mainnet mode');
  assert.equal(NET.modeAllowsNetwork('mainnet', 'eip155:84532'), false, 'a known EVM testnet id is refused in mainnet mode');
  assert.equal(NET.modeAllowsNetwork('mainnet', ''), true, 'a legacy asset-less offer (no network) still reaches today\'s legacy path');
  assert.equal(NET.modeAllowsNetwork('devnet', SOLANA_DEVNET_CAIP2), true, 'devnet mode allows exactly the solana devnet id');
  assert.equal(NET.modeAllowsNetwork('devnet', SOLANA_MAINNET_CAIP2), false, 'devnet mode refuses the mainnet id (req 4)');
  assert.equal(NET.modeAllowsNetwork('devnet', EVM_BASE_CAIP2), false, 'devnet mode is the solana devnet only, not EVM');
  // Casper ids are governed by the D6 agreement check (the casper branch),
  // never by modeAllowsNetwork — return true so the check stays in one place.
  assert.equal(NET.modeAllowsNetwork('mainnet', 'casper:casper-test'), true);
});

it('pure: casperNetworkResolved (D6) — the mode and CASPER_NETWORK must agree; unset follows the mode', () => {
  // The env hints at casper-test while the mode is mainnet → refuse.
  const main = NET.casperNetworkResolved('mainnet', 'casper-test');
  assert.equal(main.ok, false, 'mainnet mode refuses the Casper testnet (req 3)');
  // The env hints at the mainnet while the mode is devnet → refuse.
  const dev = NET.casperNetworkResolved('devnet', 'casper');
  assert.equal(dev.ok, false, 'devnet mode refuses the Casper mainnet (req 3)');
  // Agreement passes through and resolves to the exact CAIP-2s.
  assert.deepEqual(NET.casperNetworkResolved('mainnet', 'casper'), { ok: true, network: 'casper:casper' });
  assert.deepEqual(NET.casperNetworkResolved('devnet', 'casper-test'), { ok: true, network: 'casper:casper-test' });
  // Unset → the mode decides (mainnet mode works the casper mainnet).
  assert.deepEqual(NET.casperNetworkResolved('mainnet', undefined), { ok: true, network: 'casper:casper' });
  assert.deepEqual(NET.casperNetworkResolved('devnet', undefined), { ok: true, network: 'casper:casper-test' });
  assert.equal(NET.casperNetworkResolved(undefined, undefined).ok, true, 'no mode (legacy run) keeps today\'s casper behavior');
  // An unsupported casper value stays today's behavior for a mode-less run.
  assert.equal(NET.casperNetworkResolved(undefined, 'weird').ok, true);
  // But an unsupported casper value under an EXPLICIT mode is refused — the
  // mode must be able to say what its casper network is.
  assert.equal(NET.casperNetworkResolved('mainnet', 'weird').ok, false);
});

// ---------------------------------------------------------------------------
// Classification pins (#59 req 6): the exact CAIP-2s resolve to the chain
// vocabulary; EVERYTHING else stays verbatim. Red at runtime against the
// current probe-utils.ts:51 substring matcher (<prefix>;solana and unknown
// solana:* collapse onto "solana"); green with C7's exact parser.
// ---------------------------------------------------------------------------

it('classification: exact CAIP-2s resolve; anything else is verbatim — never substring matching', () => {
  const parse = PU.parseChainFromNetwork;
  // The exact mainnet id resolves to the chain vocabulary (unchanged).
  assert.equal(parse(SOLANA_MAINNET_CAIP2), 'solana');
  // The exact devnet id ALSO resolves to the chain (the registered network
  // stays exact — the registration is the mode's job, C7).
  assert.equal(parse(SOLANA_DEVNET_CAIP2), 'solana');
  // "<prefix>;solana" is an opaque VERBATIM string — a namespace whose
  // name happens to end in "solana" classifies to nothing.
  assert.equal(parse('devnet;solana'), 'devnet;solana', 'req 6: no substring matching');
  assert.equal(parse('test;solana'), 'test;solana');
  // An unknown solana:* genesis is verbatim — NOT the solana chain.
  assert.equal(parse('solana:DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF'), 'solana:DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF',
    'an unknown solana:* reference must classify to nothing (the exact ids only)');
  // The V1 protocol network name keeps resolving (the V1→V2 map's key).
  assert.equal(parse('solana'), 'solana');
  // Malformed / unrelated inputs stay verbatim.
  assert.equal(parse('solana:'), 'solana:');
  assert.equal(parse('https://example.com'), 'https://example.com');
  assert.equal(parse(''), '');
});

// ---------------------------------------------------------------------------
// E2E: the mode boundary inside x402_fetch (green with C7/C8). Loopback mock
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

function challengeResponse(requestUrl: string, accepts: unknown[]): { status: number; headers: Record<string, string>; body: string } {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts,
  });
  return {
    status: 402,
    headers: { 'content-type': 'application/json', 'payment-required': b64url(payload) },
    body: 'Payment Required',
  };
}

function solanaAccept(networkCaip2: string, asset: string, amount: string): Record<string, unknown> {
  return {
    scheme: 'exact',
    network: networkCaip2,
    asset,
    amount,
    payTo: bs58.encode(Buffer.alloc(32, 0x11)),
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', feePayer: bs58.encode(Buffer.alloc(32, 0x13)), recentBlockhash: bs58.encode(Buffer.alloc(32, 0x15)) },
  };
}

/** A valid 82-byte SPL mint account (owner = Token program, decimals 6). */
const MINT_ACCOUNT_B64 = (() => {
  const mint = Buffer.alloc(82);
  mint.writeUInt8(6, 44);
  mint.writeUInt8(1, 45);
  return mint.toString('base64');
})();

function rpcSimHandler(): (body: string) => Response {
  return (rpcBody: string) => {
    const { id, method } = JSON.parse(rpcBody);
    assert.equal(method, 'getAccountInfo', 'the only RPC touchpoint is the mint-metadata fetch');
    return new Response(JSON.stringify({
      jsonrpc: '2.0', id,
      result: { context: { apiVersion: '2.2.0', slot: 1234 }, value: { data: [MINT_ACCOUNT_B64, 'base64'], executable: false, lamports: 1000000, owner: TOKEN_PROGRAM_ADDRESS, rentEpoch: 0, space: 82 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/** RPC sentinels: whichever host appears in the mock's unexpected branch is
 * the proof the WRONG mode's RPC was touched (the throw fails the leg). */
const RPC_SIM_URL = 'https://rpc-sim.invalid';
const OTHER_MODE_RPC_URL = 'https://other-mode-rpc-never.invalid';
const realFetch = globalThis.fetch.bind(globalThis);
function installMock(handlers: { rpc?: (body: string) => Response } = {}): void {
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const urlStr = input instanceof Request ? input.url : String(input);
    const parsed = new URL(urlStr);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      return await realFetch(input as any, init as any);
    }
    if (handlers.rpc && urlStr.startsWith(RPC_SIM_URL)) return handlers.rpc(((init as any)?.body ?? '') as string);
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

// The mode gate: a key loaded + NO mode → NETWORK_NOT_CONFIGURED before the
// probe; a free tool keeps working (issue #59, operator decision Option A).
it('mode gate: a key loaded + X402_NETWORK_MODE unset refuses before probing; a free tool still works', async () => {
  delete process.env.X402_NETWORK_MODE;
  installMock();
  const { url, recorded } = await seller(() => {
    throw new Error('the seller must never be probed while the mode is unset');
  });
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  assert.match(parsed.error as string, /NETWORK_NOT_CONFIGURED/, `the unset mode with a key loaded refuses before probing (got: ${parsed.error})`);
  assert.match(parsed.reasons?.[0]?.code ?? '', /NETWORK_NOT_CONFIGURED/);
  assert.equal(recorded.length, 0, 'the probe never ran');
  assert.ok(recorded.every(noPaymentHeaders), 'zero payment headers');

  // An INVALID value refuses the same way.
  process.env.X402_NETWORK_MODE = 'moonnet';
  const result2 = await handler()({ url });
  const parsed2 = JSON.parse(result2.content[0].text);
  assert.match(parsed2.error as string, /NETWORK_NOT_CONFIGURED/, 'an invalid mode value refuses too');
  assert.equal(recorded.filter(() => true).length, 0, 'still zero probes');

  // Free-tool immunity (option A): the same server with keys loaded and no
  // mode still runs the free tools.
  const { registerCheckPaymentTool } = (await import('./tools/check-payment.js')) as typeof import('./tools/check-payment.js');
  let freeCallback: any;
  registerCheckPaymentTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { freeCallback = fn; } } as any);
  const freeResult = await freeCallback();
  const freeParsed = JSON.parse(freeResult.content[0].text);
  assert.equal(freeParsed.error, undefined, 'a free tool works with the mode unset (immunity)');
});

// Cross-mode refusals (req 4): an offer whose network is not the mode's is
// refused before any signing, with zero payment headers.
it('mainnet mode refuses a DEVNET offer before signing (same asset id, different genesis)', async () => {
  process.env.X402_NETWORK_MODE = 'mainnet';
  process.env.SOLANA_RPC_URL = OTHER_MODE_RPC_URL;
  installMock({ rpc: rpcSimHandler() });
  const { url, recorded } = await seller((req, res) => {
    const resp = challengeResponse(url, [solanaAccept(SOLANA_DEVNET_CAIP2, USDC_DEVNET_SOL, '1000')]);
    res.writeHead(resp.status, resp.headers);
    res.end(resp.body);
  });
  const result = await handler()({ url, chain: 'solana' });
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(
    !/Failed to create payment payload/.test(parsed.error ?? ''),
    `the refusal is the FLOW's mode boundary, not an SDK crash (got: ${parsed.error})`,
  );
  assert.ok(parsed.status === undefined, 'no signed HTTP response: the leg never ran');
  assert.ok(recorded.every(noPaymentHeaders), 'zero payment headers ever left');
  assert.ok(!recorded.some((r) => r.url !== url), 'only the seller was touched — the mainnet RPC never (the mock throws on it, which would fail the leg)');
  const settled = ledgerLines().some((e) => e.status === 'success' && e.chain === 'solana' && e.amount_usdc === 0.001);
  assert.ok(!settled, 'nothing settled for the cross-mode offer');
});

it('devnet mode refuses a MAINNET offer before signing (mirror direction)', async () => {
  process.env.X402_NETWORK_MODE = 'devnet';
  process.env.SOLANA_DEVNET_RPC_URL = OTHER_MODE_RPC_URL;
  installMock({ rpc: rpcSimHandler() });
  const { url, recorded } = await seller((req, res) => {
    const resp = challengeResponse(url, [solanaAccept(SOLANA_MAINNET_CAIP2, USDC_MAINNET_SOL, '2000')]);
    res.writeHead(resp.status, resp.headers);
    res.end(resp.body);
  });
  const result = await handler()({ url, chain: 'solana' });
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(!/Failed to create payment payload/.test(parsed.error ?? ''), `the refusal is the flow's mode boundary (got: ${parsed.error})`);
  assert.ok(parsed.status === undefined, 'no signed HTTP response: the leg never ran');
  assert.ok(recorded.every(noPaymentHeaders), 'zero payment headers ever left');
  assert.ok(!ledgerLines().some((e) => e.chain === 'solana' && e.amount_usdc === 0.002), 'the mainnet offer never settled under devnet mode');
});

it('devnet mode refuses an EVM offer before signing (devnet is the solana devnet only)', async () => {
  process.env.X402_NETWORK_MODE = 'devnet';
  installMock();
  const { url, recorded } = await seller((req, res) => {
    const resp = challengeResponse(url, [{
      scheme: 'exact', network: EVM_BASE_CAIP2,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '10000',
      payTo: '0x' + '11'.repeat(20), maxTimeoutSeconds: 60,
    }]);
    res.writeHead(resp.status, resp.headers);
    res.end(resp.body);
  });
  const result = await handler()({ url, chain: 'base' });
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(!/Failed to create payment payload/.test(parsed.error ?? ''), `an EVM offer never signs under devnet mode (got: ${parsed.error})`);
  assert.ok(parsed.status === undefined);
  assert.ok(recorded.every(noPaymentHeaders), 'zero payment headers');
});

// The devnet leg pays when the mode matches the challenge (green with C7's
// registration + C8's devnet ledger network/bucket): the ledger row carries
// the devnet network, the devnet daily bucket grows, and the MAINNET daily
// total is unchanged by the devnet payment.
it('devnet mode pays the devnet ping against the mock: a devnet ledger row, an unchanged mainnet daily total', async () => {
  process.env.X402_NETWORK_MODE = 'devnet';
  // The devnet leg uses the DEVNET RPC: this sentinel is served by the mock;
  // the MAINNET RPC points at a host the mock refuses — any mainnet-RPC
  // touch fails the leg (the mainnet-RPC-never-in-devnet assertion).
  const configDir = mkdtempSync(join(tmpdir(), 'x402-netmode-policy-'));
  const previousConfigPath = process.env.POLICY_CONFIG_PATH;
  try {
    process.env.POLICY_CONFIG_PATH = join(configDir, 'policy.json');
    writeFileSync(process.env.POLICY_CONFIG_PATH, JSON.stringify({
      payments: { enabled: true, maxPerRequest: 0.50, maxDaily: 10 },
      networks: { allowed: ['solana'] },
      tokens: { allowed: ['USDC'] },
    }), 'utf8');
    process.env.MAX_PAYMENT_PER_CALL = '0.50';
    process.env.MAX_DAILY_SPEND = '10.00';
    process.env.SOLANA_RPC_URL = OTHER_MODE_RPC_URL;
    process.env.SOLANA_DEVNET_RPC_URL = RPC_SIM_URL;

    // Seed the MAINNET (non-devnet) daily total: a mainnet-classified row.
    PM.logPayment({
      timestamp: new Date().toISOString(), url: 'https://mainnet-seed.invalid/v1/paid', method: 'GET', chain: 'solana',
      amount_usdc: 0.002, amount_atomic: '2000', decimals: 6,
      asset: USDC_MAINNET_SOL, currency: 'USDC', status: 'success',
    });
    const mainnetBefore = PM.getDailySpent();
    const devnetBefore = PM.getDevnetDailySpent();
    assert.ok(!PM.getDevnetDailySpent(), 'the devnet bucket starts empty (a mainnet-classified row does not feed it)');

    const receiptB64 = Buffer.from(JSON.stringify({ success: true, transaction: 'ef'.repeat(32) })).toString('base64');
    const { url, recorded } = await seller((req, res, _visitIndex, signed) => {
      if (!signed) {
        const resp = challengeResponse(url, [solanaAccept(SOLANA_DEVNET_CAIP2, USDC_DEVNET_SOL, '1000')]);
        res.writeHead(resp.status, resp.headers);
        res.end(resp.body);
        return;
      }
      res.writeHead(200, { 'payment-response': receiptB64 });
      res.end('{"ok":true}');
    });
    installMock({ rpc: rpcSimHandler() });
    const result = await handler()({ url, chain: 'solana' });
    // RED until C7/C8: today the flow still registers MAINNET and reads the
    // mainnet RPC, so this leg fails ("Failed to create payment payload").
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, 200, `devnet mode + a devnet offer pays against the mock (got: ${parsed.error ?? 'ok'})`);
    assert.equal(parsed.paid, true);
    assert.equal(parsed.selected_offer.network, SOLANA_DEVNET_CAIP2, 'the selected offer is the devnet offer');
    assert.equal(parsed.selected_offer.amount_usdc, 0.001, 'priced through the SHIPPED devnet table entry (the measured $0.001 ping)');
    assert.ok(recorded.some((r) => !noPaymentHeaders(r)), 'a signed paid leg happened');
    assert.ok(!ledgerLines().some((e) => e.url?.includes?.('/v1/paid') === true && e.chain !== 'solana'), 'only solana rows for this leg');

    // C8: the devnet row with its network marker; the MAINNET total uncharged.
    const devnetRow = ledgerLines().find((e) => e.status === 'success' && e.asset === USDC_DEVNET_SOL);
    assert.ok(devnetRow, 'the devnet settlement is in the ledger');
    assert.equal(devnetRow.network, SOLANA_DEVNET_CAIP2, 'the ledger row carries the exact devnet network');
    assert.equal(devnetRow.chain, 'solana', 'the chain vocabulary is still solana');
    assert.equal(devnetRow.amount_usdc, 0.001);
    assert.equal(PM.getDailySpent(), mainnetBefore, 'the MAINNET daily total is UNCHANGED by a devnet payment');
    assert.equal(PM.getDevnetDailySpent(), devnetBefore + 0.001, 'the DEVNET daily bucket absorbed exactly the paid amount');
  } finally {
    if (previousConfigPath !== undefined) process.env.POLICY_CONFIG_PATH = previousConfigPath; else delete process.env.POLICY_CONFIG_PATH;
    rmSync(configDir, { recursive: true, force: true });
  }
});

// Mainnet mode ignores the DEVNET RPC (mirror of the assertion above).
it('mainnet mode ignores SOLANA_DEVNET_RPC_URL: the mainnet RPC stays the scheme\u2019s', async () => {
  process.env.X402_NETWORK_MODE = 'mainnet';
  process.env.SOLANA_RPC_URL = RPC_SIM_URL;
  process.env.SOLANA_DEVNET_RPC_URL = OTHER_MODE_RPC_URL;
  installMock({ rpc: rpcSimHandler() });
  const receiptB64 = Buffer.from(JSON.stringify({ success: true, transaction: 'f0'.repeat(32) })).toString('base64');
  const { url, recorded } = await seller((req, res, _visitIndex, signed) => {
    if (!signed) {
      const resp = challengeResponse(url, [solanaAccept(SOLANA_MAINNET_CAIP2, USDC_MAINNET_SOL, '1000')]);
      res.writeHead(resp.status, resp.headers);
      res.end(resp.body);
      return;
    }
    res.writeHead(200, { 'payment-response': receiptB64 });
    res.end('{"ok":true}');
  });
  const result = await handler()({ url, chain: 'solana' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 200, `the mainnet leg pays using the MAINNET RPC (got: ${parsed.error ?? 'ok'})`);
  assert.ok(recorded.some((r) => !noPaymentHeaders(r)), 'a signed leg happened');
});

// ---------------------------------------------------------------------------
afterEach(() => {
  // Restore the hermetic baseline (each test sets its own mode).
  process.env.PAYMENT_LOG_PATH = LEDGER_PATH;
  process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
  process.env.X402_STATE_DIR = join(dir, 'state');
  process.env.X402_NETWORK_MODE = 'mainnet';
  process.env.SOLANA_PRIVATE_KEY = SOLANA_KEY_B58;
  delete process.env.SOLANA_RPC_URL;
  delete process.env.SOLANA_DEVNET_RPC_URL;
  process.env.X402_ALLOW_PRIVATE_HOSTS = '';
  globalThis.fetch = realFetch;
});
after(async () => {
  for (const { server } of liveSellers) await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.PAYMENT_LOG_PATH;
  delete process.env.SOLANA_PRIVATE_KEY;
  rmSync(dir, { recursive: true, force: true });
});