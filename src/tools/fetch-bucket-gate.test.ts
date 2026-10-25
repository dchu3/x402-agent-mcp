import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Issue #59 (D7) — the policy engine's DAILY gate must read the LEG'S OWN
// spend bucket. The Step 3.5 gate computed `dailySpentOfBucket` (the devnet
// bucket's own total for a devnet leg, the mainnet whole-map total — which
// EXCLUDES devnet — for every other leg) and then threw it away, passing the
// raw `getDailySpent()` mainnet total instead: a devnet leg was gated against
// an EMPTY-looking mainnet total while the ledger recorded its spend in the
// devnet bucket, so `payments.maxDaily` never bound a devnet leg until the
// inner MAX_DAILY_SPEND cap (a different knob, env-fed) tripped. The
// selection-time `policyFor` callback (issue #61) had the same defect AND
// scoped reservations to the plain `service:<host>` scope a devnet hold does
// not carry.
//
// The tests (lettered as in the review brief; the file is one shared module
// instance + one ledger, so the scenarios are ORDERED and every assertion is
// stated on before/after DELTAS of the in-memory buckets — the
// state-independent regression pins come first, then the two tests whose
// FAILURES are the defect's demonstration, with their isolation literals
// naming the exact bucket levels each scenario leaves):
//   (b) devnet spend $1 + $2 devnet offer → allowed (a guard: the fix may
//       not tighten what both layers already allow against the devnet bucket);
//   (c) mainnet regression pins: a mainnet leg is gated against the MAINNET
//       total only — $4 of devnet spend never counts toward its rule 7 (c1) —
//       and $4 of mainnet spend + a $2 mainnet offer still refuses with
//       DAILY_LIMIT_EXCEEDED (c2, unchanged);
//   (a) devnet spend $4 + $2 devnet offer → refused with
//       DAILY_LIMIT_EXCEEDED before signing — with the old code the mainnet
//       total reads $2 (under what a $2 mainnet-side read allows) and the leg
//       PAYS despite policy payments.maxDaily 5;
//   (d) selection-time consistency: with the mainnet total over the cap and
//       the devnet bucket under it, selection evaluates each devnet candidate
//       against the DEVNET total (the over-cap sibling is reported as a
//       selection refusal and the under-cap sibling is chosen and paid —
//       with the old code both candidates read the mainnet total and nothing
//       is chosen). Test (a) is the same over-cap geometry seen at Step 3.5;
//       the two refusal sites agree because both now read the leg's bucket.
//
// Hermetic per the established pattern (network-mode.test.ts for the devnet
// legs, fetch-accounting.test.ts for the EVM legs): loopback mock sellers
// only, throwaway runtime keys, temp ledger/directory/policy paths, no live
// network, no real RPC (the Solana leg's only RPC touchpoint — the mint
// metadata fetch — is answered by an in-process mock).
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-bucket-gate-'));
const LEDGER_PATH = join(dir, 'ledger.jsonl');
const DIRECTORY = join(dir, 'endpoints.json');
writeFileSync(DIRECTORY, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-24' }), 'utf8');
// The POLICY doc binds rule 7 at $5 while MAX_DAILY_SPEND stays $10 (the
// reservation/spending-limit knob) — the two knobs must stay distinct here:
// in (a) the inner checks PASS at $6 while the policy gate must refuse, so
// the only binding cap in the test is the one the policy engine reads.
const POLICY = join(dir, 'policy.json');
writeFileSync(POLICY, JSON.stringify({
  payments: { enabled: true, maxPerRequest: 50, maxDaily: 5 },
  networks: { allowed: ['solana', 'base'] },
  tokens: { allowed: ['USDC'] },
}), 'utf8');
process.env.PAYMENT_LOG_PATH = LEDGER_PATH;
process.env.X402_DIRECTORY_PATH = DIRECTORY;
process.env.X402_STATE_DIR = join(dir, 'state');
process.env.POLICY_CONFIG_PATH = POLICY;
process.env.MAX_PAYMENT_PER_CALL = '50';
process.env.MAX_DAILY_SPEND = '10';

// Throwaway keys generated at runtime — both legs sign fully locally.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = Buffer.from(publicKey.export({ type: 'spki', format: 'der' } as any).slice(-32) as unknown as Uint8Array);
const priv = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' } as any).slice(16) as unknown as Uint8Array);
const SOLANA_KEY_B58 = bs58.encode(Buffer.concat([priv, pub]));
process.env.SOLANA_PRIVATE_KEY = SOLANA_KEY_B58;
process.env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`;

const { registerFetchTool } = await import('./fetch.js');
// Same module instances the flow records into.
const PM = (await import('../payment-utils.js')) as typeof import('../payment-utils.js');
const { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } = (await import('@x402/svm')) as typeof import('@x402/svm');

// Public protocol identifiers (not secrets).
const USDC_DEVNET_SOL = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const BASE_CAIP2 = 'eip155:8453';
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_PAYTO = '0x2222222222222222222222222222222222222222';

const env = { ...process.env }; // captured AFTER the constants above
afterEach(() => {
  process.env = { ...env, X402_ALLOW_PRIVATE_HOSTS: '' };
  globalThis.fetch = realFetch;
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

function ledgerLines(): any[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function noPaymentHeaders(r: RecordedRequest): boolean {
  return r.headers['x-payment'] === undefined && r.headers['payment-signature'] === undefined
    && r.headers['payment-nonce'] === undefined && r.headers['payment-timestamp'] === undefined;
}

/** Bucket seeds: settled ledger rows, exactly the shape rehydration buckets
 * them — a devnet row under its network id, a mainnet row under its chain. */
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

// --- devnet-leg harness (loopback HTTP seller + RPC sim; network-mode.test.ts pattern) ---
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
  const result = await handler()({ url, chain: 'solana' });
  return { parsed: JSON.parse(result.content[0].text), recorded };
}

// --- mainnet (EVM/base) leg harness (fetch-accounting.test.ts pattern) ---
async function runBaseFlow(prefix: string): Promise<{ parsed: any; probeVisits: number; signedRetries: number; url: string }> {
  const url = `https://${prefix}-base-leg.invalid/api`;
  let probeVisits = 0, signedRetries = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const u = input instanceof Request ? input.url : String(input);
    assert.equal(u, url, 'no other endpoint call may happen');
    const headers = new Headers(input instanceof Request ? input.headers : (init as any)?.headers);
    if (!headers.has('payment-signature')) {
      probeVisits++;
      const payload = JSON.stringify({
        x402Version: 2,
        resource: { url, description: '', mimeType: 'text/plain' },
        accepts: [{ scheme: 'exact', network: BASE_CAIP2, asset: BASE_USDC_ADDRESS, amount: '2000000', payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
      });
      return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
    }
    signedRetries++;
    return new Response('{"result":"ok"}', { status: 200 });
  }) as any;
  const result = await handler()({ url });
  return { parsed: JSON.parse(result.content[0].text), probeVisits, signedRetries, url };
}

// ---------------------------------------------------------------------------
// (b) — the under-cap DEVNET leg stays payable: $1 devnet spend + $2 devnet
// offer ≤ payments.maxDaily 5. Green before AND after (it guards that the fix
// does not tighten what both layers already allow against the DEVNET bucket).
// ---------------------------------------------------------------------------
it('(b) devnet $1 spend + $2 devnet offer pays: rule 7 reads the DEVNET bucket at both gate sites', async () => {
  process.env.X402_NETWORK_MODE = 'devnet';
  seedDevnet(1);
  const devnetBefore = PM.getDailySpent(SOLANA_DEVNET_CAIP2);
  const mainnetBefore = PM.getDailySpent();
  assert.equal(devnetBefore, 1, 'test isolation: the devnet bucket starts at the seeded $1');
  assert.equal(mainnetBefore, 0, 'test isolation: the mainnet total starts at $0');

  const { parsed, recorded } = await runDevnetFlow([solanaAccept(SOLANA_DEVNET_CAIP2, USDC_DEVNET_SOL, '2000000')]);

  assert.equal(parsed.status, 200, `the under-cap devnet leg pays (got: ${parsed.error ?? parsed.status})`);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.network_mode, 'devnet');
  assert.equal(parsed.network, SOLANA_DEVNET_CAIP2);
  assert.equal(parsed.selected_offer.amount_usdc, 2);
  assert.ok(recorded.some((r) => !noPaymentHeaders(r)), 'a signed paid leg happened');
  assert.equal(PM.getDailySpent(SOLANA_DEVNET_CAIP2) - devnetBefore, 2, 'the DEVNET bucket absorbed exactly the paid $2');
  assert.equal(PM.getDailySpent() - mainnetBefore, 0, 'the MAINNET total is untouched by a devnet payment');
  const row = ledgerLines().find((e) => e.url === parsed.url && e.status === 'success' && e.asset === USDC_DEVNET_SOL);
  assert.ok(row, 'the devnet settlement is in the ledger');
  assert.equal(row.amount_usdc, 2);
  assert.equal(row.network, SOLANA_DEVNET_CAIP2, 'the ledger row carries the exact devnet network');
});

// ---------------------------------------------------------------------------
// (c1) — the MAINNET exclusion pin, independent of the RED tests' outcomes:
// with the DEVNET bucket at $4 (its reads must never move the mainnet leg's
// gate) and the mainnet total at $0, a $2 mainnet leg PAYS. If the gate
// summed the whole map (devnet included), 4 + 2 > 5 would refuse it.
// ---------------------------------------------------------------------------
it('(c1) a mainnet leg gates against the mainnet total only: $4 of devnet spend does not count toward its rule 7', async () => {
  process.env.X402_NETWORK_MODE = 'mainnet';
  seedDevnet(1); // cumulative state: (b) left the devnet bucket at $3; seed to $4 for the pin's shape
  const devnetBefore = PM.getDailySpent(SOLANA_DEVNET_CAIP2);
  const mainnetBefore = PM.getDailySpent();
  assert.equal(devnetBefore, 4, 'test isolation: the devnet bucket holds the seeded $4');
  assert.equal(mainnetBefore, 0, 'test isolation: the mainnet total is $0');
  const ledgerBefore = ledgerLines().length;

  const { parsed, probeVisits, signedRetries } = await runBaseFlow('c1');

  assert.equal(parsed.status, 200, `the mainnet leg pays — the devnet spend is a separate bucket (got: ${parsed.error ?? 'ok'})`);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.network, BASE_CAIP2);
  assert.equal(signedRetries, 1, 'exactly one signed paid request');
  assert.equal(probeVisits, 1, 'exactly one probe (the SDK\u2019s first request rides the probe replay)');
  assert.equal(PM.getDailySpent(SOLANA_DEVNET_CAIP2) - devnetBefore, 0, 'the mainnet payment never touches the devnet bucket');
  assert.equal(PM.getDailySpent() - mainnetBefore, 2, 'the mainnet total absorbed exactly the paid $2');
  const row = ledgerLines().slice(ledgerBefore).find((e) => e.url === parsed.url && e.status === 'success');
  assert.ok(row, 'the mainnet settlement is in the ledger');
  assert.ok(row.network !== SOLANA_DEVNET_CAIP2, 'a mainnet row is not a devnet-bucketed row');
});

// ---------------------------------------------------------------------------
// (a) — THE defect: $4 of DEVNET spend + a $2 devnet offer against
// payments.maxDaily 5 (the inner MAX_DAILY_SPEND knob at 10 does NOT bind —
// 6 ≤ 10 — so ONLY the policy gate can refuse). Before the fix both policy
// read-sites passed the mainnet total ($2 here — under what a $2 mainnet-side
// read allows) and the leg PAID; after the fix the leg refuses
// DAILY_LIMIT_EXCEEDED at Step 3.5 with zero payment headers.
// ---------------------------------------------------------------------------
it('(a) devnet $4 spend + $2 devnet offer refuses DAILY_LIMIT_EXCEEDED before signing (the mainnet total must not mask it)', async () => {
  process.env.X402_NETWORK_MODE = 'devnet';
  // Cumulative state: (b) and (c1) left the devnet bucket at exactly $4; the
  // mainnet total is $2 — a $2 mainnet-side read would still ALLOW here, so
  // the PRE-FIX code reaches a signed leg while the fixed code refuses.
  const devnetBefore = PM.getDailySpent(SOLANA_DEVNET_CAIP2);
  const mainnetBefore = PM.getDailySpent();
  assert.equal(devnetBefore, 4, 'test isolation: the devnet bucket starts at the brief\u2019s $4');
  assert.equal(mainnetBefore, 2, 'test isolation: the mainnet total is under what a $2 mainnet-side read allows');
  const ledgerBefore = ledgerLines().length;

  const { parsed, recorded } = await runDevnetFlow([solanaAccept(SOLANA_DEVNET_CAIP2, USDC_DEVNET_SOL, '2000000')]);

  assert.match(parsed.error as string, /DAILY_LIMIT_EXCEEDED/, `the policy gate refuses on the leg\u2019s own bucket (got: ${parsed.error})`);
  assert.equal(parsed.reasons?.[0]?.code, 'DAILY_LIMIT_EXCEEDED');
  assert.ok(parsed.status === undefined, 'no signed HTTP response: the leg never ran');
  assert.ok(parsed.paid === undefined, 'nothing was paid');
  assert.equal(recorded.length, 1, 'only the probe reached the seller');
  assert.ok(recorded.every(noPaymentHeaders), 'zero payment headers ever left');
  assert.equal(ledgerLines().length, ledgerBefore, 'no new ledger rows beyond the seeds');
  assert.equal(PM.getDailySpent(SOLANA_DEVNET_CAIP2) - devnetBefore, 0, 'a refused leg moves no bucket');
  assert.equal(PM.getDailySpent() - mainnetBefore, 0, 'the mainnet total stays untouched');
});

// ---------------------------------------------------------------------------
// (c2) — the MAINNET regression pin (unchanged behaviour): $4 of mainnet
// spend + a $2 mainnet offer against the $5 cap refuses DAILY_LIMIT_EXCEEDED.
// ---------------------------------------------------------------------------
it('(c2) mainnet regression: $4 of mainnet spend + $2 mainnet offer still refuses DAILY_LIMIT_EXCEEDED (unchanged behaviour)', async () => {
  process.env.X402_NETWORK_MODE = 'mainnet';
  seedMainnet(2); // cumulative state: (c1) paid $2 → seed to the brief's $4
  const mainnetBefore = PM.getDailySpent();
  const devnetBefore = PM.getDailySpent(SOLANA_DEVNET_CAIP2);
  assert.equal(mainnetBefore, 4, 'test isolation: the mainnet total starts at the brief\u2019s $4');
  const ledgerBefore = ledgerLines().length;

  const { parsed, probeVisits, signedRetries } = await runBaseFlow('c2');

  assert.match(parsed.error as string, /DAILY_LIMIT_EXCEEDED/, `the mainnet leg still refuses on its own total (got: ${parsed.error})`);
  assert.equal(parsed.reasons?.[0]?.code, 'DAILY_LIMIT_EXCEEDED');
  assert.ok(parsed.paid === undefined, 'nothing was paid');
  assert.equal(signedRetries, 0, 'no signed request ever left');
  assert.equal(probeVisits, 1, 'only the probe ran');
  assert.equal(PM.getDailySpent() - mainnetBefore, 0, 'a refused leg moves no mainnet spend');
  assert.equal(PM.getDailySpent(SOLANA_DEVNET_CAIP2) - devnetBefore, 0, 'and moves no devnet spend');
  assert.equal(ledgerLines().length, ledgerBefore, 'no new ledger rows beyond the seeds');
});

// ---------------------------------------------------------------------------
// (d) — selection-time consistency: the SAME over-cap geometry the (a) Step
// 3.5 refusal shows, observed at the SELECTION layer. Mainnet total $4.01
// (over the $5 cap for a $1 mainnet-side read), devnet bucket $4 (under it):
// the $2 devnet sibling is REFUSED by the candidate gate against the DEVNET
// total (reported as a selection refusal, never chosen) and the $1 devnet
// sibling is chosen and paid — reaching the exact cap is the allowed boundary
// of rule 7 (spent + amount > cap refuses; equality passes). With the
// pre-fix code both candidates were gated against the MAINNET total
// (4.01 + 1 > 5) and NOTHING was payable. The two gate sites agree because
// they read the same leg-scoped bucket.
// ---------------------------------------------------------------------------
it('(d) selection evaluates a devnet candidate against the DEVNET total (over-cap sibling refused at selection, under-cap sibling chosen)', async () => {
  process.env.X402_NETWORK_MODE = 'devnet';
  seedMainnet(0.01); // cumulative state: (c2) left the mainnet total at $4 → seed to $4.01
  const devnetBefore = PM.getDailySpent(SOLANA_DEVNET_CAIP2);
  const mainnetBefore = PM.getDailySpent();
  assert.equal(mainnetBefore, 4.01, 'test isolation: the mainnet total is over what a $1 mainnet-side read could allow');
  const ledgerBefore = ledgerLines().length;

  const { parsed, recorded } = await runDevnetFlow([
    solanaAccept(SOLANA_DEVNET_CAIP2, USDC_DEVNET_SOL, '2000000'), // $2 sibling: devnet 4 + 2 > 5 → refused
    solanaAccept(SOLANA_DEVNET_CAIP2, USDC_DEVNET_SOL, '1000000'), // $1 sibling: devnet 4 + 1 = 5 ≤ boundary → allowed
  ]);

  assert.equal(parsed.status, 200, `the under-cap devnet candidate is chosen and paid (got: ${parsed.error ?? 'ok'})`);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.selected_offer.amount_usdc, 1, 'the policy-ALLOWED sibling is the chosen offer');
  assert.equal(parsed.offer_refusals.length, 1, 'the over-cap sibling is a REPORTED selection refusal');
  assert.equal(parsed.offer_refusals[0].index, 0, 'the refusal names the $2 sibling');
  assert.equal(parsed.offer_refusals[0].reject, 'policy_refused', 'the selection-time gate refused it (never silently skipped)');
  assert.ok(recorded.some((r) => !noPaymentHeaders(r)), 'the chosen under-cap candidate pays');
  assert.equal(PM.getDailySpent(SOLANA_DEVNET_CAIP2) - devnetBefore, 1, 'the devnet bucket absorbed exactly the paid $1');
  assert.equal(PM.getDailySpent() - mainnetBefore, 0, 'the mainnet total is untouched');
  const row = ledgerLines().slice(ledgerBefore).find((e) => e.status === 'success' && e.asset === USDC_DEVNET_SOL);
  assert.ok(row, 'the devnet settlement is in the ledger');
  assert.equal(row.amount_usdc, 1);
});