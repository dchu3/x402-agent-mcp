import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Issue #54 (Option A) — x402_fetch LEDGERS the true signed-and-sent outcome.
// A payment that was SIGNED AND SENT is spend the budget must count — never a
// silent `failed`/0 — and the agent is never told `paid: false` after a send:
//
//   200                                → status "success"            paid: true,  served: true
//   non-200 + success receipt (tx)     → status "settled_unserved"   paid: true,  served: false
//   non-200, no receipt, no refusal    → status "authorized_unserved" paid: "unknown", served: false
//                                        (+ expires_at: the sent payload's own validity)
//   402/4xx rejection, no receipt      → status "failed"             paid: false (acceptance test 6:
//                                        a refusal before settlement is not a send, nothing counts)
//
// Across every counted branch: cost_usdc equals the counted amount, the
// per-service store moves identically, a restart rehydrates the same totals,
// and there is exactly ONE paid request per call (no retry, ever — req 5).
//
// Hermetic per the established convention (fetch.test.ts): temp
// PAYMENT_LOG_PATH + X402_DIRECTORY_PATH, a globalThis.fetch mock as the
// seller, a throwaway runtime EVM key (EIP-3009 signing is fully local — no
// network, no RPC).
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-fetch-ledger-'));
process.env.X402_NETWORK_MODE = 'mainnet'; // issue #59: name the MAINNET mode explicitly — BEFORE the env capture
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-25' }), 'utf8');
// Throwaway runtime key only; the EVM leg signs fully locally.
process.env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
env.EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY; // survive the afterEach env restore

const { registerFetchTool } = await import('./fetch.js');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_DIRECTORY_PATH: join(dir, 'endpoints.json') }; });
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

function ledgerLines(): any[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

let bust = 0;
function handler() {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

// Public protocol identifiers (same convention as fetch.test.ts): the USDC
// contract on Base and a fake-but-well-formed payTo — identifiers, not secrets.
const BASE_CAIP2 = 'eip155:8453';
const BASE_USDC_ADDRESS = '0x833589fCD6Edb6E08f4c7C32D4f71b54bdA02913';
const BASE_PAYTO = '0x2222222222222222222222222222222222222222';

const b64url = (s: string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** v2 challenge the EVM scheme signs fully locally (EIP-3009 signTypedData)
 * — extra.name/version are the EIP-712 domain parameters the scheme requires.
 * Amount 10000 atomic at 6 decimals = $0.01. */
function chargeableBaseChallenge(requestUrl: string) {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{ scheme: 'exact', network: BASE_CAIP2, asset: BASE_USDC_ADDRESS, amount: '10000', payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': b64url(payload) } });
}

/** has-semantics: true ⇔ a payment-signature header is present. */
function signed(input: unknown, init: unknown): boolean {
  const headers = new Headers(input instanceof Request ? input.headers : (init as any)?.headers);
  return headers.has('payment-signature');
}

const SUCCESS_RECEIPT_B64 = Buffer.from(JSON.stringify({ success: true, transaction: 'ab'.repeat(32) })).toString('base64');

/** Mock seller: the unsigned probe gets the chargeable challenge (the SDK's
 * first request rides the probe replay — it never touches the network); the
 * single SIGNED leg gets `onSigned`. Returns the call log. */
function mockSeller(url: string, onSigned: () => Response) {
  const calls: Array<{ signed: boolean }> = [];
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const urlStr = input instanceof Request ? input.url : String(input);
    assert.equal(urlStr, url, 'no other endpoint call may happen');
    if (signed(input, init)) { calls.push({ signed: true }); return onSigned(); }
    calls.push({ signed: false });
    return chargeableBaseChallenge(url);
  }) as any;
  return calls;
}

it('200 on the signed leg → success: paid true, served true, authorization_sent true, counted at the signed amount', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const url = 'https://ledger-200-test.invalid/api';
  const calls = mockSeller(url, () => new Response('{"result":"ok"}', { status: 200, headers: { 'PAYMENT-RESPONSE': SUCCESS_RECEIPT_B64 } }));
  const before = ledgerLines();
  const result = await handler()({ url, chain: 'base' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 200, `the flow reached the accounting block, got: ${JSON.stringify(parsed)}`);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.served, true);
  assert.equal(parsed.authorization_sent, true);
  assert.equal(parsed.cost_usdc, 0.01, 'cost equals the counted (signed) amount');
  assert.equal(calls.filter((c) => c.signed).length, 1, 'exactly ONE paid request per call');
  const row = ledgerLines().slice(before.length).find((e: any) => e.url === url);
  assert.equal(row?.status, 'success');
  assert.equal(row?.amount_usdc, 0.01);
  assert.equal(row?.tx_hash, 'ab'.repeat(32));
});

it('502 with a success receipt → settled_unserved: counted, paid true, served false, authorization_sent true', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const host = 'ledger-502-test.invalid';
  const url = `https://${host}/api`;
  const calls = mockSeller(url, () => new Response('bad gateway', { status: 502, headers: { 'PAYMENT-RESPONSE': SUCCESS_RECEIPT_B64 } }));
  const { getDailySpent } = await import('../payment-utils.js') as typeof import('../payment-utils.js');
  const store = await import('../policy/budget-store.js') as typeof import('../policy/budget-store.js');
  const dailyBefore = getDailySpent();
  const serviceBefore = store.getPerServiceSpent(host);
  const before = ledgerLines();
  const result = await handler()({ url, chain: 'base' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 502, `the flow reached the accounting block, got: ${JSON.stringify(parsed)}`);
  // Settlement EVIDENCE exists (the decodable success receipt with a tx
  // hash): the payment counts and the agent is told so — never paid: false
  // after a send. The request itself was NOT served.
  assert.equal(parsed.paid, true);
  assert.equal(parsed.served, false);
  assert.equal(parsed.authorization_sent, true);
  assert.equal(parsed.cost_usdc, 0.01, 'cost_usdc equals the counted amount in every branch');
  assert.equal(calls.filter((c) => c.signed).length, 1, 'exactly ONE paid request per call — no retry');
  const row = ledgerLines().slice(before.length).find((e: any) => e.url === url);
  assert.equal(row?.status, 'settled_unserved', 'the ledger keeps the true outcome');
  assert.equal(row?.amount_usdc, 0.01, 'the row COUNTS the signed amount');
  assert.equal(row?.tx_hash, 'ab'.repeat(32));
  assert.equal(row?.http_status, 502, 'the non-200 detail is still audited (#45)');
  assert.ok(!('expires_at' in row), 'settled spend never releases — no expiry field');
  assert.equal(getDailySpent(), dailyBefore + 0.01, 'the daily budget counts the settled send');
  assert.equal(store.getPerServiceSpent(host), serviceBefore + 0.01, 'the per-service budget counts it too');
  // Restart parity: a fresh module over the same ledger rehydrates the same.
  const restarted = await import(`../payment-utils.js?ledger54=${++bust}`) as typeof import('../payment-utils.js');
  assert.equal(restarted.getDailySpent(), getDailySpent(), 'PARITY: settled_unserved rehydrates identically after a restart');
});

it('500 without a receipt → authorized_unserved + expires_at: counted until the sent payload expires, paid "unknown"', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const host = 'ledger-500-test.invalid';
  const url = `https://${host}/api`;
  const calls = mockSeller(url, () => new Response('server error', { status: 500 }));
  const { getDailySpent } = await import('../payment-utils.js') as typeof import('../payment-utils.js');
  const store = await import('../policy/budget-store.js') as typeof import('../policy/budget-store.js');
  const dailyBefore = getDailySpent();
  const serviceBefore = store.getPerServiceSpent(host);
  const before = ledgerLines();
  const result = await handler()({ url, chain: 'base' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 500, `the flow reached the accounting block, got: ${JSON.stringify(parsed)}`);
  // The signed payment was SENT; nothing proves settlement or refusal —
  // that is the UNKNOWN case: counted (never a bare failure), never served,
  // and the text says do not retry blindly (req 5).
  assert.equal(parsed.paid, 'unknown', 'an agent is never told paid: false after a send');
  assert.equal(parsed.served, false);
  assert.equal(parsed.authorization_sent, true);
  assert.equal(parsed.cost_usdc, 0.01, 'paid "unknown" reports the counted amount, never 0');
  assert.match(String(parsed.note ?? ''), /do not retry blindly/i, 'the unknown text carries the no-retry guidance');
  assert.equal(calls.filter((c) => c.signed).length, 1, 'exactly ONE paid request per call — no retry');
  const row = ledgerLines().slice(before.length).find((e: any) => e.url === url);
  assert.equal(row?.status, 'authorized_unserved', 'the ledger keeps the true outcome');
  assert.equal(row?.amount_usdc, 0.01, 'the row COUNTS the signed amount');
  assert.equal(row?.tx_hash, undefined, 'no settlement evidence exists — no tx hash');
  assert.equal(row?.http_status, 500, 'the non-200 detail is still audited (#45)');
  assert.equal(row?.error, 'HTTP 500', 'the reason field is never absent on a non-200 row');
  assert.equal(typeof row?.expires_at, 'string', 'the row carries the sent payload’s own validity');
  assert.ok(Date.parse(row.expires_at) > Date.now(), 'the validity is in the future at send time (it is what bounds the count)');
  assert.equal(getDailySpent(), dailyBefore + 0.01, 'the daily budget counts the sent authorization');
  assert.equal(store.getPerServiceSpent(host), serviceBefore + 0.01, 'the per-service budget counts it too');
  // Restart parity through the SAME predicate.
  const restarted = await import(`../payment-utils.js?ledger54=${++bust}`) as typeof import('../payment-utils.js');
  const restartedStore = await import(`../policy/budget-store.js?ledger54=${bust}`) as typeof import('../policy/budget-store.js');
  assert.equal(restarted.getDailySpent(), getDailySpent(), 'PARITY: authorized_unserved rehydrates identically after a restart');
  assert.equal(restartedStore.getPerServiceSpent(host), serviceBefore + 0.01, 'PARITY: per-service rehydration counts the sent authorization');
});

it('402 with a rejection and no receipt → failed, paid false (acceptance test 6: a pre-settlement refusal is not a send)', async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const host = 'ledger-402-test.invalid';
  const url = `https://${host}/api`;
  const calls = mockSeller(url, () => new Response(
    // The verified seller-rejection shape (the refusal happens before
    // settlement, at the gateway — nothing settled, nothing was "sent" in
    // the accounting sense).
    JSON.stringify({ x402Version: 2, error: 'Payment verification failed — invalid or insufficient payment', accepts: [] }),
    { status: 402 },
  ));
  const { getDailySpent } = await import('../payment-utils.js') as typeof import('../payment-utils.js');
  const store = await import('../policy/budget-store.js') as typeof import('../policy/budget-store.js');
  const dailyBefore = getDailySpent();
  const serviceBefore = store.getPerServiceSpent(host);
  const before = ledgerLines();
  const result = await handler()({ url, chain: 'base' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 402, `the flow reached the accounting block, got: ${JSON.stringify(parsed)}`);
  assert.equal(parsed.paid, false, 'a clear refusal keeps paid: false');
  assert.equal(parsed.served, false);
  assert.equal(parsed.authorization_sent, true, 'a payload WAS signed here — the refusal is at the seller, the count is still zero');
  assert.equal(parsed.cost_usdc, 0, 'nothing counted against the budget');
  assert.equal(calls.filter((c) => c.signed).length, 1, 'exactly ONE paid request per call — the refusal is not retried');
  const row = ledgerLines().slice(before.length).find((e: any) => e.url === url);
  assert.equal(row?.status, 'failed', 'a pre-settlement refusal is failed/0 — the #54 rejection control');
  assert.equal(row?.amount_usdc, 0);
  assert.equal(row?.http_status, 402);
  assert.equal(row?.error, 'Payment verification failed — invalid or insufficient payment');
  assert.equal(row?.attempted_amount_usdc, 0.01, 'the attempted price stays on the audit trail (#45)');
  assert.equal(getDailySpent(), dailyBefore, 'a refused payment must not move the daily spend');
  assert.equal(store.getPerServiceSpent(host), serviceBefore, 'a refused payment must not move per-service spend');
});

// ---------------------------------------------------------------------------
// C4: a dropped socket AFTER the send — the generic catch path's variant of
// "unknown": the connection died mid-answer, settlement cannot be ruled out,
// so the send is counted (authorized_unserved, no tx hash), never reported as
// a bare failure, and NEVER retried. Loopback mock seller (the loopback-only
// convention of fetch-paid-limits.test.ts); the socket is destroyed after
// the signed header arrives, exactly as a dead peer would behave.
// ---------------------------------------------------------------------------

it('a dropped socket after the signed send → paid "unknown", counted row, no second paid request', { timeout: 20_000 }, async () => {
  process.env.MAX_PAYMENT_PER_CALL = '50';
  process.env.MAX_DAILY_SPEND = '50';
  const { createServer } = await import('node:http');
  const recorded: Array<{ signed: boolean }> = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const isSigned = req.headers['payment-signature'] !== undefined || req.headers['x-payment'] !== undefined;
      recorded.push({ signed: isSigned });
      if (isSigned) {
        // The seller dies mid-flight after the signed request arrived.
        req.socket.destroy();
        return;
      }
      const challenge = chargeableBaseChallenge(`http://${req.headers.host ?? ''}${req.url}`);
      res.writeHead(challenge.status, Object.fromEntries((challenge.headers as Headers).entries()));
      res.end('Payment Required');
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr!.port : 0);
    });
  });
  process.env.X402_ALLOW_PRIVATE_HOSTS = `127.0.0.1:${port}`;
  const url = `http://127.0.0.1:${port}/api`;
  try {
    const before = ledgerLines();
    const result = await handler()({ url, chain: 'base' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error, 'x402 payment failed', `the fixed failure text, got: ${JSON.stringify(parsed)}`);
    assert.equal(parsed.paid, 'unknown', 'a send that then failed is unknown spend, not a bare failure');
    assert.equal(parsed.authorization_sent, true);
    assert.equal(parsed.served, false);
    assert.equal(parsed.cost_usdc, 0.01, 'paid "unknown" reports the counted amount, never 0');
    assert.match(String(parsed.note ?? ''), /do not retry blindly/i, 'the unknown text carries the no-retry guidance');
    assert.equal(recorded.filter((r) => r.signed).length, 1, 'exactly ONE paid request — no second paid request after the drop');
    const row = ledgerLines().slice(before.length).find((e: any) => e.url === url);
    assert.equal(row?.status, 'authorized_unserved', 'the counted row keeps the true outcome');
    assert.equal(row?.amount_usdc, 0.01);
    assert.equal(row?.tx_hash, undefined, 'no settlement evidence exists — no tx hash');
    assert.equal(typeof row?.expires_at, 'string', 'the counted row carries the sent payload’s validity');
  } finally {
    server.close();
  }
});
