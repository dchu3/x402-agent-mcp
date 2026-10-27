import { strict as assert } from 'node:assert';
import { afterEach, after, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WCSPR_ASSETS } from '../casper/accepts.js';
const dir = mkdtempSync(join(tmpdir(), 'x402-test-'));
process.env.X402_NETWORK_MODE = 'mainnet'; // issue #59: these suites must name the MAINNET mode explicitly — set BEFORE the env capture so every afterEach restore keeps it
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
// Hermetic directory (issue #37): this suite set no X402_DIRECTORY_PATH, so
// the #34 liveness gate read the operator's LIVE gitignored endpoints.json —
// whose FAILED seed row for https://example.invalid hard-DENYed every fixture
// here (ENDPOINT_NOT_LIVE) before any assertion ran. An empty temp directory
// (the fetch.test.ts repo pattern) keeps the suite off operator data.
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-09-25' }), 'utf8');
const { registerFetchTool } = await import('./fetch.js');
const { boundedText } = await import('./casper-fetch.js');
const { logPayment, getDailySpent, isCountedSpend } = await import('../payment-utils.js');
const { casperBudget } = await import('../casper/budget.js');
const { getPerServiceSpent } = await import('../policy/budget-store.js');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_DIRECTORY_PATH: join(dir, 'endpoints.json') }; });
after(() => { process.env = env; rmSync(dir, {recursive:true, force:true}); });
function handler() {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}
const offer = { scheme: 'exact', network: 'casper:casper', asset: WCSPR_ASSETS['casper:casper'], payTo: '00'+'ab'.repeat(32), amount: '1000000000', maxTimeoutSeconds: 60, extra: { name: 'Wrapped CSPR', version: '1' } };
function challenge(changes={}) {
  const payload = JSON.stringify({x402Version:2, resource:{url:'https://example.invalid',description:'',mimeType:'text/plain'},accepts:[{...offer,...changes}]});
  return new Response(payload,{status:402,headers:{'payment-required':Buffer.from(payload).toString('base64')}});
}
it('forced Casper probes and refuses unset budgets before any paid request', async () => {
  delete process.env.CASPER_MAX_PAYMENT_PER_CALL; delete process.env.CASPER_MAX_DAILY_SPEND;
  process.env.CASPER_PRIVATE_KEY = '11'.repeat(32);
  let calls=0; globalThis.fetch=async () => {calls++; return challenge();};
  const result=await handler()({url:'https://example.invalid',chain:'casper'});
  assert.match(result.content[0].text,/disabled/); assert.equal(calls,1);
});
it('forced Casper refuses absent offers instead of a default price', async () => {
  globalThis.fetch=async () => new Response(JSON.stringify({accepts:[]}),{status:402});
  const result=await handler()({url:'https://example.invalid',chain:'casper'});
  assert.match(result.content[0].text,/No matching/);
});
it('actual SDK challenge cannot increase price beyond the checked limit', async () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL='1'; process.env.CASPER_MAX_DAILY_SPEND='10'; process.env.CASPER_PRIVATE_KEY='11'.repeat(32);
  let calls=0;
  globalThis.fetch=async input => {calls++; if(input instanceof Request) assert.equal(input.headers.has('payment-signature'),false); return challenge({amount:calls===1?'1000000000':'2000000000'});};
  const before=casperBudget.getDailySpent();
  const result=await handler()({url:'https://example.invalid',chain:'casper'});
  assert.match(result.content[0].text,/failed/); assert.equal(calls,2); assert.equal(casperBudget.getDailySpent(),before);
});
it('sub-mote budgets are hard rejected through the real tool', async () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL='1.0000000001'; process.env.CASPER_MAX_DAILY_SPEND='10';
  let calls=0; globalThis.fetch=async () => {calls++;return challenge();};
  const result=await handler()({url:'https://example.invalid',chain:'casper'});
  assert.match(result.content[0].text,/sub-mote/); assert.equal(calls,1);
});
it('valid offer signs with the real SDK and records exact motes', async () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL='1'; process.env.CASPER_MAX_DAILY_SPEND='10'; process.env.CASPER_PRIVATE_KEY='11'.repeat(32);
  let calls=0;
  globalThis.fetch=async (input, init) => {
    calls++;
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (calls <= 2) return challenge();
    const payload = JSON.parse(Buffer.from(headers.get('payment-signature')!, 'base64').toString());
    assert.equal(payload.payload.authorization.value, '1000000000');
    assert.ok(payload.payload.signature.length > 0);
    return new Response('{"ok":true}', {status:200, headers:{'payment-response':Buffer.from(JSON.stringify({success:true, transaction:'ab'.repeat(32), network:'casper:casper'})).toString('base64')}});
  };
  const before=casperBudget.getDailySpent();
  const result=JSON.parse((await handler()({url:'https://example.invalid',chain:'casper'})).content[0].text);
  assert.equal(result.paid,true); assert.equal(calls,3);
  assert.equal(casperBudget.getDailySpent(),before+1000000000n);
  assert.equal(result.authorized_motes,'1000000000');
});
it('streaming payment bodies are bounded', async () => {
  await assert.rejects(boundedText(new Response('a'.repeat(65537))),/size limit/);
});
it('Casper and USD counters remain independent in one ledger', () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL='2'; process.env.CASPER_MAX_DAILY_SPEND='10';
  const usd=getDailySpent(), motes=casperBudget.getDailySpent();
  casperBudget.reserve(1n);
  logPayment({timestamp:new Date().toISOString(),url:'https://example.invalid',method:'GET',chain:'casper',currency:'wCSPR',amount_motes:'1',status:'success'});
  assert.equal(getDailySpent(),usd); assert.equal(casperBudget.getDailySpent(),motes+1n);
  logPayment({timestamp:new Date().toISOString(),url:'https://example.invalid',method:'GET',chain:'base',amount_usdc:0.01,status:'success'});
  assert.equal(getDailySpent(),usd+0.01); assert.equal(casperBudget.getDailySpent(),motes+1n);
  const rows=readFileSync(join(dir,'ledger.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(rows.slice(-2).map(row=>row.chain),['casper','base']);
  assert.equal(rows.at(-2).amount_usdc,undefined); assert.equal(rows.at(-2).amount_motes,'1');
});

// ---------------------------------------------------------------------------
// Issue #80 (B1): per-call narrowing arguments bind the CASPER leg too.
// Pre-fix the tool returned fetchCasper(...) BEFORE the USD-leg narrowing
// block, so x402_fetch({url, chain:'casper', allowed_chains:['base']}), a
// non-matching expected_pay_to, or ANY max_price_usd still SIGNED AND SENT on
// the mote rail. The Casper branch now enforces before fetchCasper runs:
// allowed_chains without 'casper' => CHAIN_NOT_ALLOWED; expected_pay_to !=
// the SELECTED Casper accept's payTo => PAY_TO_MISMATCH; max_price_usd (the
// rail is mote-priced — it has no USD price) => PER_CALL_LIMIT_UNSUPPORTED;
// malformed values => PER_CALL_LIMIT_INVALID, never silently ignored. Every
// refusal signs NOTHING and writes no ledger row / per-service record.
// Hermetic: this file's globalThis.fetch recording mock, throwaway key.
// ---------------------------------------------------------------------------
function ledgerLines(): any[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!,'utf8').split('\n').filter(l=>l.trim()!=='').map(l=>JSON.parse(l));
}
function casperPaidEnv(): void { process.env.CASPER_MAX_PAYMENT_PER_CALL='1'; process.env.CASPER_MAX_DAILY_SPEND='10'; process.env.CASPER_PRIVATE_KEY='11'.repeat(32); }
/** Recording mock: counts requests and SIGNED ones; signed requests are
 * passed to onSigned (default: serve another challenge). */
function signedRecorder(onSigned?: (headers: Headers, init: any) => Promise<Response>) {
  const rec = { calls: 0, signed: 0 };
  globalThis.fetch = async (input: any, init: any) => {
    rec.calls++;
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (headers.get('payment-signature') !== null) {
      rec.signed++;
      if (onSigned) return onSigned(headers, init);
    }
    return challenge();
  };
  return rec;
}
/** Shared per-call refusal assertions: the exact code, ZERO signed requests,
 * the free probe only, no ledger row, no per-service record. */
function assertCasperNarrowingRefusal(result: any, rec: {calls:number;signed:number}, beforeRows: number, beforeService: number, code: string) {
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.chain, 'casper');
  assert.ok((parsed.reasons ?? []).some((r: any) => r.code === code), `the refusal names ${code}, got: ${JSON.stringify(parsed)}`);
  assert.equal(rec.signed, 0, 'ZERO signed requests — the refusal happens before any signing');
  assert.equal(rec.calls, 1, 'only the free 402 probe touched the network');
  assert.equal(ledgerLines().length, beforeRows, 'no ledger row for a per-call refusal (nothing was paid)');
  assert.equal(getPerServiceSpent('example.invalid'), beforeService, 'no per-service record for a refused call');
  return parsed;
}

it('issue #80 (B1): a forced Casper call honours allowed_chains — CHAIN_NOT_ALLOWED before signing', async () => {
  casperPaidEnv();
  const rec = signedRecorder();
  const before = ledgerLines().length, beforeService = getPerServiceSpent('example.invalid');
  assertCasperNarrowingRefusal(await handler()({url:'https://example.invalid',chain:'casper',allowed_chains:['base']}), rec, before, beforeService, 'CHAIN_NOT_ALLOWED');
});
it('issue #80 (B1): an AUTO-DETECTED Casper offer honours allowed_chains too (no explicit chain arg)', async () => {
  casperPaidEnv();
  const rec = signedRecorder(); // the offer carries only the casper accept — detection resolves it
  const before = ledgerLines().length, beforeService = getPerServiceSpent('example.invalid');
  assertCasperNarrowingRefusal(await handler()({url:'https://example.invalid',allowed_chains:['base','solana','polygon','arbitrum']}), rec, before, beforeService, 'CHAIN_NOT_ALLOWED');
});
it('issue #80 (B1): expected_pay_to unequal to the selected Casper accept is PAY_TO_MISMATCH before signing', async () => {
  casperPaidEnv();
  const rec = signedRecorder();
  const before = ledgerLines().length, beforeService = getPerServiceSpent('example.invalid');
  assertCasperNarrowingRefusal(await handler()({url:'https://example.invalid',chain:'casper',expected_pay_to:'00'+'cd'.repeat(32)}), rec, before, beforeService, 'PAY_TO_MISMATCH');
});
it('issue #80 (B1): expected_pay_to equal to the selected Casper accept pays exactly as before', async () => {
  casperPaidEnv();
  const rec = signedRecorder(async () => new Response('{"ok":true}',{status:200,headers:{'payment-response':Buffer.from(JSON.stringify({success:true,transaction:'ab'.repeat(32),network:'casper:casper'})).toString('base64')}}));
  const parsed = JSON.parse((await handler()({url:'https://example.invalid',chain:'casper',expected_pay_to:'00'+'ab'.repeat(32)})).content[0].text);
  assert.equal(parsed.paid, true, `a matching expectation never refuses: ${JSON.stringify(parsed)}`);
  assert.equal(rec.signed, 1, 'signed exactly once');
});
it('issue #80 (B1): max_price_usd on the mote-priced rail is PER_CALL_LIMIT_UNSUPPORTED — refused, never ignored', async () => {
  casperPaidEnv();
  const rec = signedRecorder();
  const before = ledgerLines().length, beforeService = getPerServiceSpent('example.invalid');
  const parsed = assertCasperNarrowingRefusal(await handler()({url:'https://example.invalid',chain:'casper',max_price_usd:0.000001}), rec, before, beforeService, 'PER_CALL_LIMIT_UNSUPPORTED');
  const reason = (parsed.reasons as any[]).find((r: any) => r.code === 'PER_CALL_LIMIT_UNSUPPORTED');
  assert.match(reason.message, /max_price_usd is not supported on the Casper \(mote-priced\) rail and the call was not signed/);
});
it('issue #80 (B1): malformed narrowing values on the Casper leg are PER_CALL_LIMIT_INVALID, never silently ignored', async () => {
  casperPaidEnv();
  const rec = signedRecorder();
  const before = ledgerLines().length, beforeService = getPerServiceSpent('example.invalid');
  for (const args of [{max_price_usd:0},{allowed_chains:[]},{expected_pay_to:''}] as const) {
    const parsed = JSON.parse((await handler()({url:'https://example.invalid',chain:'casper',...(args as any)})).content[0].text);
    assert.ok((parsed.reasons ?? []).some((r: any) => r.code === 'PER_CALL_LIMIT_INVALID'), `${JSON.stringify(args)} must be refused, never ignored: ${JSON.stringify(parsed)}`);
  }
  assert.equal(rec.signed, 0, 'ZERO signed requests across all malformed args');
  assert.equal(rec.calls, 3, 'one probe per call, nothing more');
  assert.equal(ledgerLines().length, before, 'no ledger rows');
  assert.equal(getPerServiceSpent('example.invalid'), beforeService);
});

// ---------------------------------------------------------------------------
// Issue #80 (B2): the Casper catch path reports the SAME tri-state paid flag
// the USD leg uses. A leg that throws AFTER the authorization was sent (a
// paid-leg transport error) must report paid:'unknown' with
// authorization_sent and the authorized motes — never a bare failure the
// caller could retry blindly; the ledger keeps the counted authorized_unserved
// row (output and ledger agree). Nothing authorized => paid:false, unchanged.
// ---------------------------------------------------------------------------
it('issue #80 (B2): a throw AFTER the authorization reports paid unknown and keeps the counted row', async () => {
  casperPaidEnv();
  const rec = signedRecorder(async () => { throw new TypeError('terminated'); });
  const before = ledgerLines().length, spentBefore = casperBudget.getDailySpent();
  const parsed = JSON.parse((await handler()({url:'https://example.invalid',chain:'casper',method:'POST',body:'{}'})).content[0].text);
  assert.equal(parsed.paid, 'unknown', `a sent-but-unserved authorization is never paid:false: ${JSON.stringify(parsed)}`);
  assert.equal(parsed.authorization_sent, true);
  assert.equal(parsed.authorized_motes, '1000000000');
  assert.match(parsed.error, /Casper payment failed/);
  assert.equal(rec.signed, 1, 'exactly one signed request left the mock');
  const rows = ledgerLines();
  assert.equal(rows.length, before + 1, 'the ledger keeps the counted row');
  const row = rows.at(-1);
  assert.equal(row.status, 'authorized_unserved');
  assert.equal(row.amount_motes, '1000000000');
  assert.equal(casperBudget.getDailySpent(), spentBefore + 1000000000n, 'the mote budget retains the debit — output and ledger agree');
});
it('issue #80 (B2): a throw BEFORE any authorization reports paid false (the unchanged case)', async () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL='1'; process.env.CASPER_MAX_DAILY_SPEND='10'; process.env.CASPER_PRIVATE_KEY='11'.repeat(32);
  // The probe's offer is affordable, but the SDK's own request is re-challenged
  // at a HIGHER amount — the guard hook refuses at signing, so payment
  // creation aborts with NOTHING authorized and nothing signed (the leg
  // reaches fetchCasper's catch, which is the path under test).
  let calls = 0;
  const rec = { calls: 0, signed: 0 };
  globalThis.fetch = async (input: any, init: any) => {
    calls++;
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (headers.get('payment-signature') !== null) rec.signed++;
    rec.calls++;
    return challenge({amount: calls === 1 ? '1000000000' : '2000000000'});
  };
  const before = ledgerLines().length, spentBefore = casperBudget.getDailySpent();
  const parsed = JSON.parse((await handler()({url:'https://example.invalid',chain:'casper'})).content[0].text);
  assert.equal(parsed.paid, false, `nothing authorized => paid:false: ${JSON.stringify(parsed)}`);
  assert.equal(parsed.authorization_sent, false);
  assert.equal(parsed.authorized_motes, '0');
  assert.equal(rec.signed, 0, 'ZERO signed requests — refused before signing');
  assert.equal(casperBudget.getDailySpent(), spentBefore, 'no debit when nothing was authorized');
  assert.equal(ledgerLines().length, before, 'no ledger row when nothing was authorized');
});

// ---------------------------------------------------------------------------
// Issue #80: X402_PAID_TIMEOUT_MS bounds the CASPER paid leg too (no more
// hardcoded 30 s literal). A stalled seller aborts at the configured bound;
// the sent authorization surfaces the tri-state and the counted row.
// ---------------------------------------------------------------------------
it('issue #80: a small X402_PAID_TIMEOUT_MS aborts a stalled Casper paid leg', { timeout: 20_000 }, async () => {
  casperPaidEnv();
  process.env.X402_PAID_TIMEOUT_MS = '100';
  const rec = signedRecorder(async (_headers: Headers, init: any) => new Promise<Response>((_resolve, reject) => {
    const sig = init?.signal as AbortSignal;
    // The pending read keeps the event loop alive UNTIL the abort rejects —
    // AbortSignal.timeout's own timer is unref'd, so without this the runner
    // would report a stranded promise instead of the real 100 ms bound.
    const keepAlive = setInterval(() => undefined, 50);
    sig.addEventListener('abort', () => { clearInterval(keepAlive); reject(sig.reason); }, { once: true });
  }));
  const before = ledgerLines().length;
  const started = Date.now();
  const parsed = JSON.parse((await handler()({url:'https://example.invalid',chain:'casper'})).content[0].text);
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 15_000, `the configured paid bound fired (${elapsedMs} ms) — the pre-fix hardcoded 30000 ms would hang this test`);
  assert.equal(parsed.paid, 'unknown');
  assert.equal(parsed.authorization_sent, true);
  assert.notEqual(parsed.authorized_motes, '0');
  const rows = ledgerLines();
  assert.equal(rows.length, before + 1, 'the stalled send stays a counted row — output and ledger agree');
  assert.equal(rows.at(-1).status, 'authorized_unserved');
  assert.equal(rows.at(-1).amount_motes, '1000000000');
});

// ---------------------------------------------------------------------------
// Issue #97: a held (sent-but-unproven) Casper authorization is spend with an
// UNKNOWN outcome — it may already have settled. The row is written with NO
// expires_at and counts until the UTC day rollover, exactly like the USD and
// Solana rails' rows: nothing releases it at the ~60 s payment-intent TTL,
// and a restarted process rehydrates the identical held total (fail-closed
// over-count direction). Hermetic end to end: the file's globalThis.fetch
// mock, a throwaway key generated in the test, the temp ledger, a fake clock
// on the pure isCountedSpend predicate, and the restart simulated by a
// cache-busted rehydration.
// ---------------------------------------------------------------------------
let holdBust = 0;
it('issue #97: a held unserved authorization is written with NO expires_at — it counts past the intent TTL and rehydrates', async () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL = '1';
  process.env.CASPER_MAX_DAILY_SPEND = '10';
  process.env.CASPER_PRIVATE_KEY = randomBytes(32).toString('hex');
  const rec = signedRecorder(async () => { throw new TypeError('terminated'); });
  const before = ledgerLines().length, spentBefore = casperBudget.getDailySpent();
  const restartBefore = ((await import(`../casper/budget.js?hold97=${++holdBust}`)) as typeof import('../casper/budget.js')).casperBudget.getDailySpent();
  const parsed = JSON.parse((await handler()({ url: 'https://example.invalid', chain: 'casper', method: 'POST', body: '{}' })).content[0].text);
  assert.equal(parsed.paid, 'unknown', `a sent-but-unproven authorization is an unknown outcome: ${JSON.stringify(parsed)}`);
  assert.equal(parsed.authorization_sent, true);
  assert.equal(rec.signed, 1, 'exactly one signed request left the mock');
  const rows = ledgerLines();
  assert.equal(rows.length, before + 1, 'the ledger keeps the row');
  const row = rows.at(-1);
  assert.equal(row.status, 'authorized_unserved');
  assert.equal(row.amount_motes, '1000000000');
  assert.ok(!('expires_at' in row), `the hold carries no expiry — nothing under the UTC day rollover releases it: ${JSON.stringify(row)}`);
  assert.equal(isCountedSpend(row, Date.now()), true);
  assert.equal(isCountedSpend(row, Date.now() + 61_000), true, 'past the ~60 s intent TTL the row still counts — the outcome is still unknown');
  assert.equal(isCountedSpend(row, Date.now() + 12 * 3_600_000), true, 'still counting half a day on — the UTC day rollover is the only bound');
  assert.equal(casperBudget.getDailySpent(), spentBefore + 1000000000n, 'the mote budget counts the hold');
  const restartAfter = ((await import(`../casper/budget.js?hold97=${++holdBust}`)) as typeof import('../casper/budget.js')).casperBudget.getDailySpent();
  assert.equal(restartAfter, restartBefore + 1000000000n, 'across a rehydration the hold still counts — a restart never drops it');
});
