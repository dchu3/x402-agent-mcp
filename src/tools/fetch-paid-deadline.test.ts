import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Issue #80 (R1a): ONE repo-owned deadline for the WHOLE paid leg — headers
// AND body. The pre-#80 flow bounded the paid leg ONLY by setting
// AbortSignal.timeout(paidTimeoutMs) on the init passed to the SDK. Measured
// on this host (node v22): that bounds the "seller never answers" case (the
// abort lands while the fetch is still waiting for headers), but NOT the
// "seller sends headers then stalls the body" case: wrapFetchWithPayment
// resolves the paid response at headers-complete, and the flow then reads the
// body with boundedText() — a bare reader.read() loop with no timer. Whether
// the abort ever reaches that stream depends on the init signal surviving the
// SDK's new Request(input, init) → request.clone() → headers.set →
// fetch(clonedRequest.clone()) chain and undici's post-headers propagation —
// measured UNRELIABLE: reproducible runs where the init signal and the SDK's
// first request's signal abort at the bound while the paid request's
// clone-of-clone signal never does, and the body read never rejects.
//
// The failing RED cases below are the stalled-body scenarios: before the fix
// they hang until this suite's watchdog (configured value + 4 s) trips. The
// never-answer cases are the control: already bounded by the signal (kept to
// pin the exact default), now bounded by the same repo-owned deadline.
//
// R1b is verify-only (landed by #54/#81): the post-send-timeout rows written
// by the catch must already show the signed amount and COUNT; the tests below
// pin that counting and that a following call hitting the daily budget is
// refused before signing. (The issue text says "maxPerRequest"; the policy
// engine's per-request cap rule is amount-only by design — the property that
// reads counted spend is the daily budget rule, so that is what is pinned.)
//
// Hermetic per the established pattern (fetch-paid-limits.test.ts): loopback
// 127.0.0.1 mock seller, X402_ALLOW_PRIVATE_HOSTS env-only, temp
// ledger/directory/state, throwaway runtime EVM key (fully local signing).
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-paid-deadline-test-'));
process.env.X402_NETWORK_MODE = 'mainnet'; // issue #59: these suites must name the MAINNET mode explicitly — set BEFORE the env capture so every afterEach restore keeps it
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
process.env.X402_STATE_DIR = join(dir, 'state');

// Throwaway runtime key only; the EVM leg signs fully locally.
const EVM_KEY = generatePrivateKey();
process.env.EVM_PRIVATE_KEY = EVM_KEY;
env.EVM_PRIVATE_KEY = EVM_KEY; // survive the afterEach env restore

const { registerFetchTool } = await import('./fetch.js');
const { paidLegDeadline } = await import('../transport/replay.js') as unknown as { paidLegDeadline?: (ms: number) => {
  signal: AbortSignal;
  race<T>(work: Promise<T>): Promise<T>;
  end(): void;
} };

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

/** Loopback mock seller, same shape as fetch-paid-limits.test.ts. `onVisit`
 * is the seller brain; for the stall scenarios it simply never ends the
 * response — the socket stays open exactly like a half-dead endpoint. */
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

type Scenario = 'never_answers' | 'stall_200_body' | 'stall_402_body';

/** The three R1a flows: the probe gets the chargeable challenge (and is
 * replayed to the SDK's first request — issue #61, never a network leg), the
 * signed paid leg then (i) never answers, (ii) sends 200 headers and stalls
 * the body, or (iii) sends 402 headers (a re-challenge) and stalls the body. */
async function scenarioSeller(scenario: Scenario) {
  return seller((req, res, _i, signed) => {
    if (!signed) {
      const challenge = challengeResponse(`http://${req.headers.host}${req.url}`);
      res.writeHead(challenge.status, challenge.headers);
      res.end(challenge.body);
      return;
    }
    if (scenario === 'never_answers') return; // socket stays open, nothing is written
    if (scenario === 'stall_200_body') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.flushHeaders();
      return; // headers sent, body never
    }
    const challenge = challengeResponse(`http://${req.headers.host}${req.url}`);
    res.writeHead(402, challenge.headers);
    res.flushHeaders(); // re-challenge headers sent, body never
  });
}

/** Run the tool callback against a wall-clock hard cap: pre-fix the stalled
 * flows hang, and the cap — not a runner timeout — is what reports the RED. */
async function runPaidFlow(args: Record<string, unknown>, hardCapMs: number): Promise<any> {
  let cap: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      handler()(args),
      new Promise<never>((_resolve, reject) => {
        cap = setTimeout(() => reject(new Error(
          `WATCHDOG: the paid flow did not refuse within the hard cap of ${hardCapMs} ms — the configured paid-leg deadline did not bound it`,
        )), hardCapMs);
        cap.unref?.();
      }),
    ]);
  } finally {
    if (cap) clearTimeout(cap);
  }
}

/** The shared R1a assertions: PAID_TIMEOUT at the configured bound ±1 s, the
 * post-send tri-state (paid "unknown"), the counted authorized_unserved row,
 * and exactly two network legs (probe + one signed paid leg — never retried). */
async function assertDeadlineFires(scenario: Scenario, configuredMs: number | undefined) {
  if (configuredMs === undefined) delete process.env.X402_PAID_TIMEOUT_MS;
  else process.env.X402_PAID_TIMEOUT_MS = String(configuredMs);
  const expected = configuredMs ?? 30_000;
  const s = await scenarioSeller(scenario);
  const before = ledgerLines().length;
  const started = Date.now();
  const parsed = JSON.parse((await runPaidFlow({ url: s.url }, expected + 4_000)).content[0].text);
  const elapsed = Date.now() - started;
  assert.equal(parsed.error, 'PAID_TIMEOUT', `the fixed refusal code, got: ${JSON.stringify(parsed)}`);
  assert.ok(
    elapsed >= expected - 1_000 && elapsed <= expected + 1_000,
    `the deadline fires at the configured value ±1 s (expected ${expected}, took ${elapsed} ms)`,
  );
  // The paid request WAS signed and sent — the agent is never told the
  // payment failed outright (issue #54's tri-state, kept).
  assert.equal(parsed.paid, 'unknown');
  assert.equal(parsed.authorization_sent, true);
  assert.equal(parsed.served, false);
  assert.equal(parsed.cost_usdc, 0.01, 'the counted amount is the signed amount, never 0');
  assert.match(parsed.reasons?.[0]?.message ?? '', /do not retry blindly/i);
  const row = ledgerLines().slice(before).find((r: any) => r.url === s.url);
  assert.ok(row, 'the timed-out attempt is audited like any other paid attempt');
  assert.equal(row.status, 'authorized_unserved', 'the send counts, it is not failed/0');
  assert.equal(row.amount_usdc, 0.01);
  assert.equal(row.tx_hash, undefined, 'no settlement evidence — no tx hash');
  assert.equal(typeof row.expires_at, 'string', 'the counted row carries the sent payload’s validity');
  assert.equal(s.recorded.length, 2, 'probe + exactly one paid leg (the SDK first request rides the probe replay, issue #61)');
  assert.equal(s.recorded.filter((r) => r.signed).length, 1, 'exactly one signed request — never retried');
  return { s, before };
}

// The ONE 30 s case (the documented default, unset env): keep exactly one.
it('issue #80 (R1a): a paid request that never answers refuses PAID_TIMEOUT at the documented 30000 ms default (unset env)', { timeout: 45_000 }, async () => {
  await assertDeadlineFires('never_answers', undefined);
});

it('issue #80 (R1a): a paid request that never answers refuses PAID_TIMEOUT at a configured 3000 ms', { timeout: 15_000 }, async () => {
  await assertDeadlineFires('never_answers', 3_000);
});

it('issue #80 (R1a): a paid 200 that stalls the body after the headers refuses PAID_TIMEOUT at 10000 ms (headers AND body share the one deadline)', { timeout: 20_000 }, async () => {
  await assertDeadlineFires('stall_200_body', 10_000);
});

it('issue #80 (R1a): a paid 200 that stalls the body after the headers refuses PAID_TIMEOUT at 3000 ms', { timeout: 15_000 }, async () => {
  await assertDeadlineFires('stall_200_body', 3_000);
});

it('issue #80 (R1a): a paid 402 re-challenge that stalls the body after the headers refuses PAID_TIMEOUT at 10000 ms', { timeout: 20_000 }, async () => {
  await assertDeadlineFires('stall_402_body', 10_000);
});

it('issue #80 (R1a): a paid 402 re-challenge that stalls the body after the headers refuses PAID_TIMEOUT at 3000 ms', { timeout: 15_000 }, async () => {
  await assertDeadlineFires('stall_402_body', 3_000);
});

// ---------------------------------------------------------------------------
// R1b (verify-only — landed by #54/#81): the post-send-timeout row shows the
// signed amount and COUNTS; a following call that would exceed the daily
// budget once that send is counted is refused before signing.
// ---------------------------------------------------------------------------

it('issue #80 (R1b verify): the post-send-timeout ledger row shows the signed amount and counts toward today\'s spend, in-process and after a restart', { timeout: 15_000 }, async () => {
  process.env.X402_PAID_TIMEOUT_MS = '3000';
  const { getDailySpent, isCountedSpend } = await import('../payment-utils.js') as typeof import('../payment-utils.js');
  const spentBefore = getDailySpent();
  const { s } = await assertDeadlineFires('stall_200_body', 3_000);
  const spentAfter = getDailySpent();
  assert.ok(
    Math.abs(spentAfter - spentBefore - 0.01) < 1e-9,
    `the timed-out send counts (+$0.01): ${spentBefore} → ${spentAfter}`,
  );
  const row = ledgerLines().find((r: any) => r.url === s.url);
  assert.equal(row.status, 'authorized_unserved');
  assert.equal(row.amount_usdc, 0.01, 'the signed amount is on the row');
  assert.equal(isCountedSpend(row, Date.now()), true, 'the row counts under the one counted-spend predicate');
  // Restart parity: a fresh module against the SAME ledger must count EXACTLY
  // the rows the one predicate counts right now (older tests' sent rows
  // legitimately release when their own payload validity expires — the
  // assertion derives the expectation from the predicate instead of assuming
  // every earlier row still counts).
  const restarted = await import(`../payment-utils.js?r1b=${Date.now()}`) as typeof import('../payment-utils.js');
  const today = new Date().toISOString().slice(0, 10);
  const expectedRestarted = ledgerLines()
    .filter((r: any) => typeof r.chain === 'string' && r.chain !== 'casper' && r.timestamp.slice(0, 10) === today && isCountedSpend(r, Date.now()))
    .reduce((sum: number, r: any) => sum + (r.amount_usdc ?? 0), 0);
  assert.ok(
    Math.abs(restarted.getDailySpent() - expectedRestarted) < 1e-9,
    'the restarted counters count exactly the rows the predicate counts (this test\'s row included)',
  );
});

it('issue #80 (R1b verify): once the timed-out send counts, a following call that crosses the budget is refused BEFORE signing (zero signed requests)', { timeout: 15_000 }, async () => {
  process.env.X402_PAID_TIMEOUT_MS = '3000';
  const { getDailySpent } = await import('../payment-utils.js') as typeof import('../payment-utils.js');
  // Budget exactly covers the first send plus nothing: earlier tests in this
  // file already counted spend, so derive the cap from the live counter.
  const spentSoFar = getDailySpent();
  process.env.MAX_PAYMENT_PER_CALL = '1';
  process.env.MAX_DAILY_SPEND = (spentSoFar + 0.015).toFixed(4);
  // First flow: a paid send that stalls post-headers — counts $0.01.
  const first = await assertDeadlineFires('stall_200_body', 3_000);
  assert.ok(Math.abs(getDailySpent() - spentSoFar - 0.01) < 1e-9, 'the first send now counts');
  void first;
  // Second flow: same-price endpoint — the policy gate reads the counted
  // spend and refuses BEFORE any payload is signed.
  const s2 = await scenarioSeller('never_answers');
  const before2 = ledgerLines().length;
  const parsed2 = JSON.parse((await runPaidFlow({ url: s2.url }, 10_000)).content[0].text);
  assert.equal(parsed2.policy_decision, 'DENY', `the counted send closes the budget, got: ${JSON.stringify(parsed2)}`);
  assert.ok(parsed2.reasons.some((r: any) => r.code === 'DAILY_LIMIT_EXCEEDED'), 'the daily-budget rule names the counted spend');
  assert.equal(s2.recorded.length, 1, 'the probe ran once — the paid leg never left');
  assert.equal(s2.recorded.filter((r) => r.signed).length, 0, 'ZERO signed requests: refused before signing');
  const rows2 = ledgerLines().slice(before2).filter((r: any) => r.url === s2.url);
  assert.equal(rows2.filter((r: any) => r.status === 'success' || r.status === 'authorized_unserved').length, 0, 'no counted row for a refused call');
});

it('issue #80 (R1a): paidLegDeadline is a repo-owned AbortController + timer — the race rejects with a TimeoutError-named error at the bound, end() clears it', { timeout: 10_000 }, async () => {
  assert.equal(typeof paidLegDeadline, 'function', 'replay.paidLegDeadline exists');
  {
    const d = paidLegDeadline!(250);
    assert.ok(d.signal instanceof AbortSignal, 'exposes the controller signal');
    const t0 = Date.now();
    await assert.rejects(
      d.race(new Promise(() => { /* never settles */ })),
      (err: any) => err?.name === 'TimeoutError',
      'the race rejects with a TimeoutError-named error',
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 200 && elapsed <= 1_000, `the deadline fired near 250 ms (took ${elapsed} ms)`);
    assert.equal(d.signal.aborted, true, 'the controller aborted as well (the signal carries the same bound)');
    assert.equal((d.signal.reason as any)?.name, 'TimeoutError', 'the abort reason carries the TimeoutError name');
    d.end(); // idempotent cleanup after the fire
  }
  {
    const d = paidLegDeadline!(250);
    const result = await d.race(Promise.resolve('settled well before the deadline'));
    assert.equal(result, 'settled well before the deadline', 'work settling first wins the race');
    assert.equal(d.signal.aborted, false);
    d.end();
    d.end(); // idempotent
    // With the timer cleared, the race of late work settles with the work —
    // the deadline must not fire after end(). This await is un-raced on
    // purpose: if the timer still fired, the race would reject and fail here.
    const late = await d.race(new Promise((resolve) => setTimeout(() => resolve('late work settled'), 500)));
    assert.equal(late, 'late work settled');
  }
  assert.throws(() => paidLegDeadline!(0), RangeError, 'non-positive bound refuses (fail closed)');
  assert.throws(() => paidLegDeadline!(-1), RangeError);
  assert.throws(() => paidLegDeadline!(1.5), RangeError);
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
