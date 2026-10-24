import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Issue #56 remainder (C8): the PAID leg of the x402 flow must not be the
// agent's soft spot. Two bounds, both fail-closed:
//   1. the paid response body is READ bounded (a seller streaming a huge
//      body can no longer dictate the agent's memory) — the cap surfaces as
//      an honest failed ledger row, never as unbounded memory;
//   2. the paid request carries the flow's own AbortSignal.timeout, so a
//      seller that never answers produces a fixed PAID_TIMEOUT refusal —
//      never a hang, never a raw AbortError message.
//
// Against the pre-C8 implementation these fail as follows: test 1 settles a
// success row after reading all 5 MiB into memory (unbounded read); test 2
// hangs until undici's own (minutes-long) socket timeouts, with no
// PAID_TIMEOUT anywhere; test 3 is written to keep passing (it pins that the
// cap is not entangled with settlement); test 4 fails on the missing
// replay.paidTimeoutMs export. The commit stages tests+feat together per the
// plan (C8 = `test(56)+feat(56)`).
//
// Hermetic per the established pattern: loopback 127.0.0.1 mock seller,
// X402_ALLOW_PRIVATE_HOSTS env-only, temp ledger/directory/state, throwaway
// runtime keys (the EVM leg signs fully locally — no RPC at all).
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-paid-limits-test-'));
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
process.env.X402_STATE_DIR = join(dir, 'state');

// Throwaway runtime key only; the EVM leg signs fully locally.
const EVM_KEY = generatePrivateKey();
process.env.EVM_PRIVATE_KEY = EVM_KEY;
env.EVM_PRIVATE_KEY = EVM_KEY; // survive the afterEach env restore

const { registerFetchTool } = await import('./fetch.js');
const { paidTimeoutMs } = await import('../transport/replay.js') as typeof import('../transport/replay.js');

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

/** Loopback mock seller. `onVisit(req, res, visitIndex, signed)` is the
 * seller-brain. For the never-answering scenario the brain simply never
 * calls res.end() — the socket stays open on the seller's side, exactly as
 * a silent (or half-open) endpoint would behave. */
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

/** Chargeable v2 challenge served to the (unsigned) probe. */
function challengeResponse(requestUrl: string): { status: number; headers: Record<string, string>; body: string } {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{ scheme: 'exact', network: BASE_CAIP2, asset: BASE_USDC_ADDRESS, amount: '10000', payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
  });
  return { status: 402, headers: { 'content-type': 'application/json', 'payment-required': b64url(payload) }, body: 'Payment Required' };
}

/** Standard scenario: the probe gets the chargeable challenge with the
 * payment-required header, the single signed paid leg gets `body`. */
async function chargingSeller(paidBody: string | Buffer): Promise<{ url: string; recorded: Array<{ method: string; signed: boolean }> }> {
  return seller((req, res, _i, signed) => {
    if (!signed) {
      const challenge = challengeResponse(`http://${req.headers.host}${req.url}`);
      res.writeHead(challenge.status, challenge.headers);
      res.end(challenge.body);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(paidBody);
  });
}

const FIVE_MIB = 'x'.repeat(5 * 1024 * 1024);

it('issue #56 (C8): a 5 MiB paid response body is read bounded — the cap surfaces as an honest failed row with the read bound named, never an unbounded read', { timeout: 40_000 }, async () => {
  const s = await chargingSeller(FIVE_MIB);
  const before = ledgerLines().length;
  const parsed = JSON.parse((await handler()({ url: s.url })).content[0].text);
  const row = ledgerLines().slice(before).find((r: any) => r.url === s.url);
  assert.ok(row, 'every paid attempt leaves a ledger row');
  assert.equal(row.status, 'failed', 'the seller\u2019s 5 MiB body never settles a success row in this flow');
  assert.equal(row.amount_usdc, 0);
  assert.equal(row.error, 'Payment response exceeds size limit', 'the bounded read names its own cap');
  assert.equal(parsed.error, 'x402 payment failed');
  // Exactly two network legs (issue #61): the probe and the signed leg. No
  // third (SDK-unpaid) leg, no retry loop after the cap: the attempt is
  // finished, audited, and never retried against a seller that just showed
  // us a 5 MiB body.
  assert.equal(s.recorded.length, 2);
  assert.equal(s.recorded.filter((r) => r.signed).length, 1);
});

it('issue #56 (C8): a paid request that never answers refuses with the fixed PAID_TIMEOUT code quickly, with an honest zero-spend row', { timeout: 20_000 }, async () => {
  process.env.X402_PAID_TIMEOUT_MS = '300';
  const s = await seller((req, res, _i, signed) => {
    // The probe answers (the challenge); the signed leg never does.
    if (!signed) {
      const challenge = challengeResponse(`http://${req.headers.host ?? ''}${req.url}`);
      res.writeHead(challenge.status, challenge.headers);
      res.end(challenge.body);
      return;
    }
    // Signed leg: never answer. The socket stays open on the seller's side.
  });
  const before = ledgerLines().length;
  const started = Date.now();
  const parsed = JSON.parse((await handler()({ url: s.url })).content[0].text);
  const elapsed = Date.now() - started;
  assert.equal(parsed.error, 'PAID_TIMEOUT', `the fixed refusal code, got: ${JSON.stringify(parsed)}`);
  assert.ok(elapsed < 10_000, `the timeout bound is honoured quickly (took ${elapsed}ms; the pre-#56 flow waits on undici's minutes-long defaults)`);
  const row = ledgerLines().slice(before).find((r: any) => r.url === s.url);
  assert.ok(row, 'the timed-out attempt is audited like any other failure');
  assert.equal(row.status, 'failed');
  assert.equal(row.amount_usdc, 0);
});

it('issue #56 (C8): a paid body just under the cap still settles honestly — the cap is not entangled with settlement', { timeout: 40_000 }, async () => {
  // ~950 KiB JSON body: under the 1 MiB read bound.
  const s = await chargingSeller('{"result":"ok","pad":"' + 'x'.repeat(950 * 1024) + '"}');
  const before = ledgerLines().length;
  const parsed = JSON.parse((await handler()({ url: s.url })).content[0].text);
  assert.equal(parsed.status, 200, 'an under-cap body settles normally');
  assert.equal(parsed.paid, true);
  assert.equal(parsed.cost_usdc, 0.01, 'the signed amount is recorded');
  const row = ledgerLines().slice(before).find((r: any) => r.url === s.url);
  assert.equal(row?.status, 'success');
});

it('issue #56 (C8): X402_PAID_TIMEOUT_MS fails closed — absent/blank ⇒ 30000, digits ⇒ the value, anything else ⇒ throw (never clamp, never silent fallback)', () => {
  assert.equal(paidTimeoutMs({}), 30_000, 'absent ⇒ the documented default');
  assert.equal(paidTimeoutMs({ X402_PAID_TIMEOUT_MS: '  ' }), 30_000, 'blank ⇒ the documented default');
  assert.equal(paidTimeoutMs({ X402_PAID_TIMEOUT_MS: '300' }), 300);
  assert.equal(paidTimeoutMs({ X402_PAID_TIMEOUT_MS: '30000' }), 30_000);
  assert.throws(() => paidTimeoutMs({ X402_PAID_TIMEOUT_MS: '300ms' }), RangeError, 'not digits ⇒ fail closed by throwing');
  assert.throws(() => paidTimeoutMs({ X402_PAID_TIMEOUT_MS: '0' }), RangeError, 'zero ⇒ fail closed by throwing');
  assert.throws(() => paidTimeoutMs({ X402_PAID_TIMEOUT_MS: '-300' }), RangeError, 'negative ⇒ fail closed by throwing');
  assert.throws(() => paidTimeoutMs({ X402_PAID_TIMEOUT_MS: '1e3' }), RangeError, 'exponent notation is not accepted (digits only)');
  assert.throws(() => paidTimeoutMs({ X402_PAID_TIMEOUT_MS: `${'9'.repeat(50)}` }), RangeError, 'beyond a safe integer ⇒ fail closed by throwing');
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