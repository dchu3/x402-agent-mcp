import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Issue #93 (A1) — the structured refusals and the success output report the
// daily spend the leg's OWN daily gate compares, not the mainnet-only total.
// getDailySpent() sums every bucket EXCEPT the Solana-devnet bucket, so a
// devnet leg's daily_spent_usdc was the mainnet total (empty-looking in
// devnet mode) while the gate gated on the devnet bucket and its holds. The
// six daily_spent_usdc sites now render gateDailySpent(legNetwork):
// getDailySpent(bucket) + reservedUsd(dailyHoldScope(bucket)) — the devnet
// bucket total (plus the devnet hold scope) for a devnet leg, the mainnet
// total for every other leg.
//
// Tests, per the plan's acceptance list:
//   1. a devnet-mode payment shows the DEVNET total (never mixes in the
//      mainnet total and never the reverse — seeded so every candidate number
//      is distinguishable);
//   2. a mainnet-mode payment is unchanged — the mainnet total, devnet spend
//      excluded, no holds outstanding after its own reservation settled;
//   3. an in-flight hold is included — an overlapping leg's reservation hold
//      (placed through the real reserveSpend registry) counts at a refusal's
//      daily_spent_usdc, scoped to the leg's OWN bucket: a mainnet hold never
//      mutates a devnet leg's displayed figure.
//
// Hermetic per the established pattern (fetch-bucket-gate.test.ts for the
// devnet legs, fetch-accounting.test.ts for the EVM legs): loopback mock
// sellers only, throwaway runtime keys, temp ledger/directory/policy paths,
// no live network, no real RPC (the Solana leg's only RPC touchpoint — the
// mint metadata fetch — is answered by an in-process mock).
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-daily-display-'));
const LEDGER_PATH = join(dir, 'ledger.jsonl');
const DIRECTORY = join(dir, 'endpoints.json');
writeFileSync(DIRECTORY, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-27' }), 'utf8');
const POLICY = join(dir, 'policy.json');
process.env.PAYMENT_LOG_PATH = LEDGER_PATH;
process.env.X402_DIRECTORY_PATH = DIRECTORY;
process.env.X402_STATE_DIR = join(dir, 'state');
process.env.POLICY_CONFIG_PATH = POLICY;
process.env.MAX_PAYMENT_PER_CALL = '50';
process.env.MAX_DAILY_SPEND = '50';

// Throwaway keys generated at runtime — both legs sign fully locally.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = Buffer.from(publicKey.export({ type: 'spki', format: 'der' } as any).slice(-32) as unknown as Uint8Array);
const priv = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' } as any).slice(16) as unknown as Uint8Array);
process.env.SOLANA_PRIVATE_KEY = bs58.encode(Buffer.concat([priv, pub]));
process.env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`;

const { registerFetchTool } = await import('./fetch.js');
// The same module instances the flow records into (and the test seams the
// other accounting suites use for scenario isolation).
const PM = (await import('../payment-utils.js')) as typeof import('../payment-utils.js');
const reservations = (await import('../reservations.js')) as typeof import('../reservations.js');
const { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } = (await import('@x402/svm')) as typeof import('@x402/svm');

// Public protocol identifiers (not secrets).
const USDC_DEVNET_SOL = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const BASE_CAIP2 = 'eip155:8453';
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_PAYTO = '0x2222222222222222222222222222222222222222';

const env = { ...process.env }; // captured AFTER the constants above
afterEach(() => {
  process.env = { ...env, X402_ALLOW_PRIVATE_HOSTS: '', X402_NETWORK_MODE: '' };
  globalThis.fetch = realFetch;
  // Scenario isolation: empty in-memory buckets, no outstanding holds, empty
  // ledger FILE (never re-read mid-process — rehydration already happened —
  // but a truncated file keeps the directory clean for restart-parity audits).
  PM._resetForTests();
  reservations._resetReservationsForTests();
  try { rmSync(LEDGER_PATH, { force: true }); } catch { /* best effort */ }
});
after(async () => {
  process.env = env;
  for (const { server } of liveSellers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

interface RecordedRequest { method: string; url: string; headers: Record<string, string | string[] | undefined> }
const liveSellers: Array<{ server: http.Server }> = [];

function handler() {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

function noPaymentHeaders(r: RecordedRequest): boolean {
  return r.headers['x-payment'] === undefined && r.headers['payment-signature'] === undefined
    && r.headers['payment-nonce'] === undefined && r.headers['payment-timestamp'] === undefined;
}

/** Ledger seeds: settled rows, exactly the shape rehydration buckets them —
 * a devnet row under its network id, a mainnet row under its chain. */
let seedCounter = 0;
function seedDevnet(amountUsd: number): void {
  seedCounter++;
  PM.logPayment({
    timestamp: new Date().toISOString(),
    url: `https://seed-devnet-${seedCounter}.invalid/seed`,
    method: 'GET', chain: 'solana', network: SOLANA_DEVNET_CAIP2,
    amount_usdc: amountUsd, amount_atomic: String(BigInt(Math.round(amountUsd * 1e6))), decimals: 6,
    asset: USDC_DEVNET_SOL, currency: 'USDC', status: 'success',
  });
}
function seedMainnet(amountUsd: number): void {
  seedCounter++;
  PM.logPayment({
    timestamp: new Date().toISOString(),
    url: `https://seed-mainnet-${seedCounter}.invalid/seed`,
    method: 'GET', chain: 'base',
    amount_usdc: amountUsd, amount_atomic: String(BigInt(Math.round(amountUsd * 1e6))), decimals: 6,
    asset: BASE_USDC_ADDRESS, currency: 'USDC', status: 'success',
  });
}

function writePolicy(maxDaily: number): void {
  writeFileSync(POLICY, JSON.stringify({
    payments: { enabled: true, maxPerRequest: 50, maxDaily },
    networks: { allowed: ['solana', 'base'] },
    tokens: { allowed: ['USDC'] },
  }), 'utf8');
}

// --- devnet-leg harness (fetch-bucket-gate.test.ts pattern) ---
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

function solanaAccept(asset: string, amount: string): Record<string, unknown> {
  return {
    scheme: 'exact',
    network: SOLANA_DEVNET_CAIP2,
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

const RECEIPT_B64 = Buffer.from(JSON.stringify({ success: true, transaction: 'ef'.repeat(32) })).toString('base64');

/** Drive a DEVNET paid flow end-to-end against the harness: challenge with
 * the given accepts on the probe, receipt on the signed leg. Devnet mode +
 * devnet RPC (the mainnet RPC points at a host the mock refuses — any
 * mainnet-RPC touch fails the leg). */
async function runDevnetFlow(accepts: Array<Record<string, unknown>>): Promise<{ parsed: any; recorded: RecordedRequest[] }> {
  const { url, recorded } = await seller((req, res, _i, signed) => {
    if (!signed) {
      const resp = challengeResponse(url, accepts);
      res.writeHead(resp.status, resp.headers);
      res.end(resp.body);
      return;
    }
    res.writeHead(200, { 'payment-response': RECEIPT_B64 });
    res.end('{"ok":true}');
  });
  process.env.X402_NETWORK_MODE = 'devnet';
  process.env.SOLANA_RPC_URL = OTHER_MODE_RPC_URL;
  process.env.SOLANA_DEVNET_RPC_URL = RPC_SIM_URL;
  installMock({ rpc: rpcSimHandler() });
  const result = await handler()({ url });
  return { parsed: JSON.parse(result.content[0].text), recorded };
}

// --- mainnet (EVM/base) leg harness (fetch-accounting.test.ts pattern) ---
async function runBaseFlow(prefix: string): Promise<{ parsed: any }> {
  const url = `https://${prefix}-base-leg.invalid/api`;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const u = input instanceof Request ? input.url : String(input);
    assert.equal(u, url, 'no other endpoint call may happen');
    const headers = new Headers(input instanceof Request ? input.headers : (init as any)?.headers);
    if (!headers.has('payment-signature')) {
      const payload = JSON.stringify({
        x402Version: 2,
        resource: { url, description: '', mimeType: 'text/plain' },
        accepts: [{ scheme: 'exact', network: BASE_CAIP2, asset: BASE_USDC_ADDRESS, amount: '20000', payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
      });
      return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
    }
    return new Response('{"result":"ok"}', { status: 200 });
  }) as any;
  const result = await handler()({ url });
  return { parsed: JSON.parse(result.content[0].text) };
}

const tool = handler();

// ---------------------------------------------------------------------------
// 1. A devnet-mode PAYMENT shows the DEVNET total: devnet bucket seeded $1
// (then the paid $0.04 lands in the same bucket), mainnet seeded $3. The
// displayed figure must be 1.04 — the devnet bucket the gate compares — not
// the mainnet total (3.02/3.04) and not the pre-fix mainnet-only read (3).
// ---------------------------------------------------------------------------
it('a devnet-mode payment reports the DEVNET bucket total (the bucket the gate compares)', async () => {
  writePolicy(10);
  seedDevnet(1);
  seedMainnet(3);
  const devnetBefore = PM.getDailySpent(SOLANA_DEVNET_CAIP2);
  const mainnetBefore = PM.getDailySpent();
  assert.equal(devnetBefore, 1, 'test isolation: the devnet bucket starts at the seeded $1');
  assert.equal(mainnetBefore, 3, 'test isolation: the mainnet total starts at the seeded $3');

  const { parsed, recorded } = await runDevnetFlow([solanaAccept(USDC_DEVNET_SOL, '40000')]);

  assert.equal(parsed.status, 200, `the under-cap devnet leg pays (got: ${parsed.error ?? parsed.status})`);
  assert.equal(parsed.paid, true);
  assert.ok(recorded.some((r) => !noPaymentHeaders(r)), 'a signed paid leg happened');
  assert.equal(
    parsed.daily_spent_usdc.toFixed(4),
    (devnetBefore + 0.04).toFixed(4),
    'the success output reports the DEVNET bucket (seeded $1 + the paid $0.04), never the mainnet total',
  );
  assert.notEqual(parsed.daily_spent_usdc.toFixed(4), mainnetBefore.toFixed(4), 'the pre-fix mainnet-only value is gone');
});

// ---------------------------------------------------------------------------
// 2. A MAINNET-mode payment is unchanged: the mainnet total (seeded $3 + the
// paid $0.02), devnet spend excluded, and — because the leg's own
// reservation settles before the output renders — no hold inflates it.
// ---------------------------------------------------------------------------
it('a mainnet-mode payment reports the mainnet total — unchanged by this change', async () => {
  process.env.X402_NETWORK_MODE = 'mainnet';
  writePolicy(10);
  seedMainnet(3);
  seedDevnet(1);
  const mainnetBefore = PM.getDailySpent();
  const devnetBefore = PM.getDailySpent(SOLANA_DEVNET_CAIP2);
  assert.equal(mainnetBefore, 3, 'test isolation: the mainnet total starts at the seeded $3');
  assert.equal(devnetBefore, 1, 'test isolation: the devnet bucket holds the seeded $1');

  const { parsed } = await runBaseFlow('mainnet-display');

  assert.equal(parsed.status, 200, `the mainnet leg pays (got: ${parsed.error ?? parsed.status})`);
  assert.equal(parsed.paid, true);
  assert.equal(
    parsed.daily_spent_usdc.toFixed(4),
    (mainnetBefore + 0.02).toFixed(4),
    'the mainnet leg reports the MAINNET total only — the devnet bucket is excluded',
  );
  assert.notEqual(parsed.daily_spent_usdc, mainnetBefore + devnetBefore, 'the devnet bucket is never summed in');
});

// ---------------------------------------------------------------------------
// 3. An IN-FLIGHT HOLD is included, scoped to the leg's own bucket. A devnet
// leg is refused at the policy gate: seeded devnet spend 4.60 + the
// overlapping leg's 0.37 hold in the devnet hold scope + the 0.04 request >
// the 5.00 policy cap → DAILY_LIMIT_EXCEEDED BEFORE signing. The refusal's
// daily_spent_usdc must show 4.97 (bucket + hold), not the mainnet total (2)
// and not the bare bucket total (4.60); a MAINNET hold placed at the same
// moment never mutates the devnet leg's figure.
// ---------------------------------------------------------------------------
it('a refusal includes an in-flight hold in the leg\u2019s OWN bucket (a mainnet hold never counts)', async () => {
  writePolicy(5); // the binding cap — everything else stays wide
  seedDevnet(4.6);
  seedMainnet(2);
  assert.equal(PM.getDailySpent(SOLANA_DEVNET_CAIP2), 4.6, 'test isolation: the devnet bucket holds the seeded $4.60');
  assert.equal(PM.getDailySpent(), 2, 'test isolation: the mainnet total holds the seeded $2');
  // The overlapping legs' holds, placed through the REAL registry exactly the
  // way an in-flight paid leg holds budget: one DEVNET hold and one MAINNET
  // hold (the latter must never leak into the devnet leg's display).
  assert.ok(reservations.reserveSpend({ amountUsd: 0.2 }).ok === true, 'the mainnet hold must reserve cleanly');
  assert.ok(reservations.reserveSpend({ amountUsd: 0.37, networkBucket: SOLANA_DEVNET_CAIP2 }).ok === true,
    'the devnet hold must reserve cleanly (4.60 + 0.37 ≤ the 5.00 effective cap)');
  assert.equal(reservations.reservedUsd(`net:${SOLANA_DEVNET_CAIP2}`), 0.37, 'test isolation: the devnet hold is outstanding');

  const { parsed, recorded } = await runDevnetFlow([solanaAccept(USDC_DEVNET_SOL, '40000')]);

  assert.match(parsed.error as string, /DAILY_LIMIT_EXCEEDED/, `the policy gate refuses on the leg\u2019s own bucket + hold (got: ${parsed.error})`);
  assert.ok(recorded.every(noPaymentHeaders), 'zero payment headers ever left');
  assert.equal(
    parsed.daily_spent_usdc.toFixed(4),
    '4.9700',
    'the refusal reports the DEVNET bucket + the DEVNET in-flight hold (4.60 + 0.37), not the mainnet total (2.00) and not the bare bucket total (4.60)',
  );
  assert.notEqual(parsed.daily_spent_usdc, '2' as never, 'the pre-fix mainnet-only value would have read $2');
});