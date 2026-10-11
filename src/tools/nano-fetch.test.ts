import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'x402-nano-test-'));
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
// Hermetic directory (issue #37 pattern): never read the operator's live endpoints.json.
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-11' }), 'utf8');
const { registerFetchTool } = await import('./fetch.js');
const { _setNanoSenderForTests } = await import('../nano/client.js');
const { nanoBudget } = await import('../nano/budget.js');
const { getDailySpent } = await import('../payment-utils.js');
const { normalizeRecipient } = await import('../policy/recipient.js');
const { parseChainFromNetwork } = await import('./probe-utils.js');
const { selectNanoAccept } = await import('../nano/accepts.js');
const { NANO_MAINNET_CAIP2 } = await import('../nano/networks.js');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; _setNanoSenderForTests(undefined); process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_DIRECTORY_PATH: join(dir, 'endpoints.json') }; });
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });
function handler() {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}
// The Nano genesis account — a real, checksum-valid nano_ address.
const PAY_TO = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const offer = { scheme: 'exact', network: 'nano:mainnet', asset: 'XNO', payTo: PAY_TO, amount: '1000000000000000000000000000', maxTimeoutSeconds: 60, extra: {} };
function challenge(changes = {}) {
  const payload = JSON.stringify({ x402Version: 2, resource: { url: 'https://example.invalid', description: '', mimeType: 'text/plain' }, accepts: [{ ...offer, ...changes }] });
  return new Response(payload, { status: 402, headers: { 'payment-required': Buffer.from(payload).toString('base64') } });
}

it('a 402 whose accepts[0] is nano:mainnet is detected as chain nano, not refused as undetectable', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return challenge(); };
  const result = JSON.parse((await handler()({ url: 'https://example.invalid' })).content[0].text);
  assert.doesNotMatch(String(result.error), /Could not auto-detect chain/);
  assert.equal(result.chain, 'nano');
  // Nano is opt-in: the compat default policy does not list it, so nothing is paid.
  assert.equal(result.policy_decision, 'DENY');
  assert.ok(result.reasons.some((r: any) => r.code === 'CHAIN_NOT_ALLOWED'));
  assert.equal(calls, 1);
});

const HASH = 'C0FFEE'.repeat(10) + 'ABCD';
/** Operator opt-in: Nano in the policy allowlists, both raw budgets set. */
function enableNano(call = '0.001', daily = '0.01') {
  process.env.X402_POLICY_NETWORKS = 'base,solana,casper,nano';
  process.env.X402_POLICY_TOKENS = 'USDC,wCSPR,XNO';
  process.env.NANO_MAX_PAYMENT_PER_CALL = call;
  process.env.NANO_MAX_DAILY_SPEND = daily;
}
function recordingSender(hash = HASH) {
  const sends: any[] = [];
  _setNanoSenderForTests({ send: async (req) => { sends.push(req); req.onPublished?.(hash); return hash; } });
  return sends;
}
/** Server: 402 until it sees a PAYMENT-SIGNATURE carrying a block hash, then 200. */
function server(seen: any[] = []) {
  let calls = 0;
  globalThis.fetch = async (input: any, init?: any) => {
    calls++;
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const sig = headers.get('payment-signature');
    if (!sig) return challenge();
    seen.push(JSON.parse(Buffer.from(sig, 'base64').toString()));
    return new Response('{"ok":true}', { status: 200 });
  };
  return () => calls;
}
function ledgerRows() {
  return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

it('auto-detected Nano offer is paid once with the confirmed block hash as the payload', async () => {
  enableNano();
  const sends = recordingSender();
  const seen: any[] = [];
  const calls = server(seen);
  const usdBefore = getDailySpent(); const rawBefore = nanoBudget.getDailySpent();
  const result = JSON.parse((await handler()({ url: 'https://example.invalid' })).content[0].text);
  assert.equal(result.chain, 'nano');
  assert.equal(result.paid, true); assert.equal(result.accepted, true);
  assert.equal(result.block_hash, HASH);
  assert.equal(result.authorized_raw, '1000000000000000000000000000');
  assert.equal(result.authorized_xno, '0.001');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].destination, PAY_TO); assert.equal(sends[0].amountRaw, 10n ** 27n);
  assert.deepEqual(seen[0].payload, { blockHash: HASH });
  assert.equal(seen[0].accepted.network, 'nano:mainnet');
  assert.equal(calls(), 3); // probe, SDK 402, paid retry
  assert.equal(nanoBudget.getDailySpent(), rawBefore + 10n ** 27n);
  assert.equal(getDailySpent(), usdBefore, 'XNO never enters the USD counters');
  const row = ledgerRows().at(-1);
  assert.equal(row.chain, 'nano'); assert.equal(row.currency, 'XNO'); assert.equal(row.amount_raw, '1000000000000000000000000000');
  assert.equal(row.tx_hash, HASH); assert.equal(row.status, 'success'); assert.equal(row.amount_usdc, undefined);
});

it('forced chain nano finds the Nano offer even when accepts[0] is another chain', async () => {
  enableNano(); const sends = recordingSender();
  const base = { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x' + 'ab'.repeat(20), amount: '10000' };
  globalThis.fetch = async (input: any, init?: any) => {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (headers.get('payment-signature')) return new Response('{"ok":true}', { status: 200 });
    const payload = JSON.stringify({ x402Version: 2, resource: { url: 'https://example.invalid', description: '', mimeType: 'text/plain' }, accepts: [base, offer] });
    return new Response(payload, { status: 402, headers: { 'payment-required': Buffer.from(payload).toString('base64') } });
  };
  const result = JSON.parse((await handler()({ url: 'https://example.invalid', chain: 'nano' })).content[0].text);
  assert.equal(result.paid, true); assert.equal(sends.length, 1);
});

it('forced chain nano selects the offer with the nano:mainnet pin the scheme uses', async () => {
  enableNano(); const sends = recordingSender();
  const seen: any[] = [];
  const base = { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x' + 'ab'.repeat(20), amount: '10000' };
  globalThis.fetch = async (input: any, init?: any) => {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const sig = headers.get('payment-signature');
    if (sig) { seen.push(JSON.parse(Buffer.from(sig, 'base64').toString())); return new Response('{"ok":true}', { status: 200 }); }
    const payload = JSON.stringify({ x402Version: 2, resource: { url: 'https://example.invalid', description: '', mimeType: 'text/plain' }, accepts: [base, { ...offer, scheme: 'upto' }, offer] });
    return new Response(payload, { status: 402, headers: { 'payment-required': Buffer.from(payload).toString('base64') } });
  };
  const result = JSON.parse((await handler()({ url: 'https://example.invalid', chain: 'nano' })).content[0].text);
  assert.equal(result.paid, true); assert.equal(sends.length, 1);
  assert.equal(seen[0].accepted.network, 'nano:mainnet');
  assert.equal(seen[0].accepted.scheme, 'exact');
  // The probe selection and the scheme agree on the same pin.
  assert.equal(selectNanoAccept({ accepts: [base, offer] }, NANO_MAINNET_CAIP2)?.network, 'nano:mainnet');
  const src = readFileSync(new URL('./fetch.js', import.meta.url), 'utf8');
  assert.match(src, /selectNanoAccept\(paymentInfo, NANO_MAINNET_CAIP2\)/, 'forced/auto Nano selection must pass the mainnet pin, not an empty hint');
});

it('unset Nano budgets refuse before any send', async () => {
  enableNano(); delete process.env.NANO_MAX_DAILY_SPEND;
  const sends = recordingSender(); const calls = server();
  const result = JSON.parse((await handler()({ url: 'https://example.invalid' })).content[0].text);
  assert.match(result.error, /disabled/); assert.equal(sends.length, 0); assert.equal(calls(), 1);
});

it('a price above the per-call budget is refused before any send', async () => {
  enableNano('0.0001'); const sends = recordingSender(); server();
  const result = JSON.parse((await handler()({ url: 'https://example.invalid' })).content[0].text);
  assert.match(result.error, /per-call/); assert.equal(sends.length, 0);
});

it('a bad-checksum payTo is refused before any send', async () => {
  enableNano(); const sends = recordingSender();
  globalThis.fetch = async () => challenge({ payTo: PAY_TO.slice(0, -1) + '4' });
  const result = JSON.parse((await handler()({ url: 'https://example.invalid' })).content[0].text);
  assert.match(result.error, /checksum-valid/); assert.equal(sends.length, 0);
});

it('a price raised between probe and payment is refused at send time', async () => {
  enableNano('0.001'); const sends = recordingSender();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return challenge({ amount: calls === 1 ? '1000000000000000000000000000' : '2000000000000000000000000000' }); };
  const before = nanoBudget.getDailySpent();
  const result = JSON.parse((await handler()({ url: 'https://example.invalid' })).content[0].text);
  assert.match(result.error, /Nano payment failed/); assert.equal(sends.length, 0);
  assert.equal(nanoBudget.getDailySpent(), before);
});

it('no sender configured refuses with a configuration error, not a payment', async () => {
  enableNano(); delete process.env.NANO_RPC_URL; delete process.env.NANO_WALLET_ID; delete process.env.NANO_SOURCE_ACCOUNT;
  server();
  const result = JSON.parse((await handler()({ url: 'https://example.invalid' })).content[0].text);
  assert.match(result.error, /NANO_RPC_URL, NANO_WALLET_ID and NANO_SOURCE_ACCOUNT not set/);
});

it('a send that confirms but is then refused by the server is recorded as spent, with the HTTP status', async () => {
  enableNano(); recordingSender();
  globalThis.fetch = async (input: any, init?: any) => {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (headers.get('payment-signature')) return new Response('{"error":"unknown block"}', { status: 500 });
    return challenge();
  };
  const result = JSON.parse((await handler()({ url: 'https://example.invalid' })).content[0].text);
  assert.equal(result.paid, true); assert.equal(result.accepted, false); assert.equal(result.status, 500);
  const row = ledgerRows().at(-1);
  assert.equal(row.status, 'success'); assert.equal(row.http_status, 500); assert.equal(row.tx_hash, HASH);
});

it('policy recipient gate and probe vocabulary know Nano', () => {
  assert.equal(normalizeRecipient('nano', PAY_TO.replace('nano_', 'xrb_')), PAY_TO);
  assert.equal(normalizeRecipient('nano', PAY_TO.slice(0, -1) + '4'), undefined);
  assert.equal(parseChainFromNetwork('nano:mainnet'), 'nano');
});
