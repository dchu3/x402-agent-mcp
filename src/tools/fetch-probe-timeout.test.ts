import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Issue #80 (R1c): the PROBE's timeout is configurable (X402_PROBE_TIMEOUT_MS,
// default 30000 ms, same fail-closed parsing as X402_PAID_TIMEOUT_MS) and a
// probe that runs out of time BEFORE any payment carries its own stable code
// — timeout_before_payment — instead of the generic "Failed to probe
// endpoint" (which hid timeouts among seller garbage). The probe is a direct
// guardedFetch(url, init) — no SDK Request chain — so its signal reliably
// aborts even a stalled body read; the refusal must arrive at the configured
// bound, never sign anything, and never touch the ledger.
//
// Against the pre-#80 implementation: the probeTimeoutMs import is missing
// (unit test fails on that) and the flow test surfaces the generic
// "Failed to probe endpoint" instead of the named code.
//
// Hermetic: loopback 127.0.0.1 mock seller (never a network call beyond it),
// X402_ALLOW_PRIVATE_HOSTS env-only, temp ledger/directory/state, throwaway
// runtime EVM key. The signer-never-invoked assertion is structural: the mock
// records exactly one request (the probe), unsigned.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-probe-timeout-test-'));
process.env.X402_NETWORK_MODE = 'mainnet'; // issue #59: these suites must name the MAINNET mode explicitly — set BEFORE the env capture so every afterEach restore keeps it
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
process.env.X402_STATE_DIR = join(dir, 'state');

// Throwaway runtime key only; nothing here ever signs.
const EVM_KEY = generatePrivateKey();
process.env.EVM_PRIVATE_KEY = EVM_KEY;
env.EVM_PRIVATE_KEY = EVM_KEY; // survive the afterEach env restore

const { registerFetchTool } = await import('./fetch.js');
const { probeTimeoutMs } = await import('../transport/replay.js') as unknown as { probeTimeoutMs?: (env?: NodeJS.ProcessEnv) => number };

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
  onVisit: (req: http.IncomingMessage, res: http.ServerResponse, visitIndex: number) => void,
): Promise<{ url: string; recorded: Array<{ method: string; signed: boolean }> }> {
  const recorded: Array<{ method: string; signed: boolean }> = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const signed = req.headers['x-payment'] !== undefined || req.headers['payment-signature'] !== undefined;
      recorded.push({ method: req.method ?? '', signed });
      onVisit(req, res, recorded.length - 1);
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

async function runFlow(args: Record<string, unknown>, hardCapMs: number): Promise<{ result: any; elapsed: number }> {
  let cap: NodeJS.Timeout | undefined;
  const started = Date.now();
  try {
    const result = await Promise.race([
      handler()(args),
      new Promise<never>((_resolve, reject) => {
        cap = setTimeout(() => reject(new Error(`WATCHDOG: the flow did not finish within ${hardCapMs} ms`)), hardCapMs);
        cap.unref?.();
      }),
    ]);
    return { result, elapsed: Date.now() - started };
  } finally {
    if (cap) clearTimeout(cap);
  }
}

it('issue #80 (R1c): a 402 whose body never completes ends in timeout_before_payment at the configured probe timeout — the signer never runs, the ledger stays at 0', { timeout: 15_000 }, async () => {
  process.env.X402_PROBE_TIMEOUT_MS = '3000';
  const s = await seller((_req, res) => {
    // 402 WITHOUT a payment-required header (the flow then reads the body to
    // find the challenge) — headers complete, body stalls forever.
    res.writeHead(402, { 'content-type': 'application/json' });
    res.flushHeaders();
  });
  const { getDailySpent } = await import('../payment-utils.js') as typeof import('../payment-utils.js');
  const beforeRows = ledgerLines().length;
  const spentBefore = getDailySpent();
  const { result, elapsed } = await runFlow({ url: s.url }, 7_000);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.error, 'timeout_before_payment', `the named pre-payment timeout code, got: ${JSON.stringify(parsed)}`);
  assert.ok(elapsed >= 2_000 && elapsed <= 4_000, `the refusal arrives at the configured bound ±1 s (3000 ms; took ${elapsed} ms)`);
  assert.equal(s.recorded.length, 1, 'exactly one request: the probe — the paid leg never ran');
  assert.equal(s.recorded.filter((r) => r.signed).length, 0, 'the signer was never invoked (zero signed requests)');
  assert.equal(getDailySpent(), spentBefore, 'ledger spend is unchanged (0 movement)');
  assert.equal(ledgerLines().length, beforeRows, 'no ledger row for a pre-payment probe timeout');
});

it('issue #80 (R1c): a probe that never answers at all also ends in timeout_before_payment at the configured bound', { timeout: 15_000 }, async () => {
  process.env.X402_PROBE_TIMEOUT_MS = '3000';
  const s = await seller(() => { /* never answers anything */ });
  const beforeRows = ledgerLines().length;
  const { result, elapsed } = await runFlow({ url: s.url }, 7_000);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.error, 'timeout_before_payment');
  assert.ok(elapsed >= 2_000 && elapsed <= 4_000, `took ${elapsed} ms (bound 3000)`);
  assert.equal(s.recorded.length, 1);
  assert.equal(s.recorded.filter((r) => r.signed).length, 0, 'the signer never ran');
  assert.equal(ledgerLines().length, beforeRows, 'no ledger row');
});

it('issue #80 (R1c): a non-timeout probe failure keeps the generic code — timeout_before_payment is never applied to seller garbage', { timeout: 15_000 }, async () => {
  process.env.X402_PROBE_TIMEOUT_MS = '10000';
  const s = await seller((_req, res) => {
    // 402 with no payment-required header AND an unparseable body — the
    // challenge parse throws (not a timeout).
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end('this is not json');
  });
  const { result, elapsed } = await runFlow({ url: s.url }, 7_000);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.error, 'Failed to probe endpoint');
  assert.ok(elapsed < 5_000, `a parse failure fails fast (took ${elapsed} ms)`);
  assert.equal(s.recorded.length, 1);
});

it('issue #80 (R1c): X402_PROBE_TIMEOUT_MS fails closed — absent/blank ⇒ 30000, digits ⇒ the value, anything else ⇒ RangeError (never clamped, never a silent fallback)', () => {
  assert.equal(typeof probeTimeoutMs, 'function', 'replay.probeTimeoutMs exists');
  assert.equal(probeTimeoutMs!({}), 30_000, 'absent ⇒ the documented default');
  assert.equal(probeTimeoutMs!({ X402_PROBE_TIMEOUT_MS: '  ' }), 30_000, 'blank ⇒ the documented default');
  assert.equal(probeTimeoutMs!({ X402_PROBE_TIMEOUT_MS: '500' }), 500);
  assert.equal(probeTimeoutMs!({ X402_PROBE_TIMEOUT_MS: '30000' }), 30_000);
  assert.throws(() => probeTimeoutMs!({ X402_PROBE_TIMEOUT_MS: '500ms' }), RangeError);
  assert.throws(() => probeTimeoutMs!({ X402_PROBE_TIMEOUT_MS: '0' }), RangeError, 'zero ⇒ fail closed by throwing');
  assert.throws(() => probeTimeoutMs!({ X402_PROBE_TIMEOUT_MS: '-500' }), RangeError);
  assert.throws(() => probeTimeoutMs!({ X402_PROBE_TIMEOUT_MS: '1e3' }), RangeError, 'exponent notation is not accepted');
  assert.throws(() => probeTimeoutMs!({ X402_PROBE_TIMEOUT_MS: '1.5' }), RangeError, 'decimals are not accepted');
  assert.throws(() => probeTimeoutMs!({ X402_PROBE_TIMEOUT_MS: `${'9'.repeat(50)}` }), RangeError, 'beyond a safe integer ⇒ throw');
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
