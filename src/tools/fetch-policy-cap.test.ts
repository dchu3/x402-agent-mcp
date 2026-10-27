import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// The policy file's payments.maxDaily is the operator's daily budget; the
// whole spend path must respect it as a FLOOR semantics: with offers priced
// at $0.01 and a file cap of $N, exactly floor(N / 0.01) payments sign and
// every further one is refused by the policy gate (DAILY_LIMIT_EXCEEDED)
// with no row and no counted spend.
//
// The reservation layer knows the effective cap (min with the legacy knob),
// but the GATE's daily figure must ALSO see the holds overlapping calls
// placed after the gate's ledger read: with the first calls' payloads in
// flight (signed, un-settled — their holds still outstanding), a further
// call must refuse AT THE GATE with the policy reason, not land on the
// reservation layer's backstop and not sign past the file cap. These tests
// drive the REAL x402_fetch flow against a loopback mock seller (same
// hermetic pattern as fetch-accounting.test.ts: a boundable Base offer
// signed fully locally with a throwaway key; no live network, no RPC).
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-policy-cap-'));
const LEDGER_PATH = join(dir, 'ledger.jsonl');
const POLICY_PATH = join(dir, 'policy.json');

// Isolate every accounting surface BEFORE importing fetch.js (capture-at-load).
process.env.X402_NETWORK_MODE = 'mainnet'; // the EVM/base leg — local signing only
process.env.PAYMENT_LOG_PATH = LEDGER_PATH;
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-27' }), 'utf8');
process.env.X402_STATE_DIR = join(dir, 'state');
process.env.MAX_PAYMENT_PER_CALL = '50';
process.env.MAX_DAILY_SPEND = '50'; // wide on purpose: the POLICY file's cap is the only binding cap here
process.env.POLICY_CONFIG_PATH = POLICY_PATH;

// Throwaway runtime key — the exact-base EVM leg signs locally (EIP-712).
process.env.EVM_PRIVATE_KEY = `0x${'11'.repeat(32)}`;

const { registerFetchTool } = await import('./fetch.js');
const PM = (await import('../payment-utils.js')) as typeof import('../payment-utils.js');

const BASE_CAIP2 = 'eip155:8453';
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_PAYTO = '0x2222222222222222222222222222222222222222';
const PRICE_ATOMIC = '10000'; // $0.01

const env = { ...process.env }; // captured AFTER the runtime key
// Fetch the reservation registry's reset hook (holds must never leak across
// scenarios — same underscore convention as the other test seams).
const RESERVATIONS_PATH = '../reservations.js';
const reservations = (await import(RESERVATIONS_PATH)) as typeof import('../reservations.js');

afterEach(() => {
  process.env = { ...env, PAYMENT_LOG_PATH: LEDGER_PATH, POLICY_CONFIG_PATH: POLICY_PATH };
  globalThis.fetch = realFetch;
  // Fresh in-memory accounting per scenario: the ledger FILE keeps every
  // earlier scenario's rows (nothing re-reads them mid-process), but the
  // daily map and any outstanding holds must start empty — the cap compares
  // ABSOLUTE figures, not deltas.
  PM._resetForTests();
  reservations._resetReservationsForTests();
});
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

const realFetch = globalThis.fetch.bind(globalThis);

function handler() {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

function ledgerRows(): any[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function writePolicyFile(maxDaily: number): void {
  writeFileSync(POLICY_PATH, JSON.stringify({ payments: { enabled: true, maxPerRequest: 50, maxDaily } }), 'utf8');
}

function challenge402(requestUrl: string): Response {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{ scheme: 'exact', network: BASE_CAIP2, asset: BASE_USDC_ADDRESS, amount: PRICE_ATOMIC, payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
  });
  return new Response('Payment Required', { status: 402, headers: { 'payment-required': Buffer.from(payload).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') } });
}

function hasPaymentHeader(input: unknown, init: unknown): boolean {
  const headers = new Headers(input instanceof Request ? input.headers : (init as any)?.headers);
  return headers.has('payment-signature') || headers.has('x-payment');
}

/** Install a seller mock whose SIGNED contacts can be parked: each parked
 * request registers its resolver so a test releases responses in a chosen
 * order (in-flight payloads = outstanding holds). */
const parked = new Map<string, Array<(r: Response) => void>>();
const seenSigned = new Set<string>();
function installParkedSeller(): void {
  parked.clear();
  seenSigned.clear();
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const u = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (!hasPaymentHeader(input, init)) {
      return challenge402(u);
    }
    seenSigned.add(u);
    return new Promise<Response>((resolve) => {
      const queue = parked.get(u) ?? [];
      queue.push(resolve);
      parked.set(u, queue);
    }) as unknown as Response;
  }) as typeof fetch;
}

/** A seller that answers every signed leg immediately (no parking). */
function installPlainSeller(): void {
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const u = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (!hasPaymentHeader(input, init)) {
      return challenge402(u);
    }
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
}

function releaseSigned(url: string): void {
  const queue = parked.get(url);
  assert.ok(queue && queue.length > 0, `a parked signed request must exist for ${url}`);
  const resolve = queue!.shift()!;
  resolve(new Response('{"ok":true}', { status: 200 }));
}

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(false, `timed out waiting for ${what}`);
}

const tool = handler();

// ---------------------------------------------------------------------------
// Sequential: the file cap is a floor in the plain sense — three $0.01
// payments under a $0.03 cap all sign; the fourth is refused AT THE GATE.
// Green before and after (this is the boundary the gate already enforced).
// ---------------------------------------------------------------------------
it('sequential paid calls sign exactly floor(cap/price) under the policy-file cap', async () => {
  writePolicyFile(0.03);
  installPlainSeller();
  const urlPrefix = 'https://seq-policy-cap.invalid/api';
  const rowsBefore = ledgerRows().length;
  const paidBefore = PM.getDailySpent();

  for (let i = 1; i <= 3; i++) {
    const url = `${urlPrefix}-${i}`;
    const result = await tool({ url });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, 200, `call ${i} must pay (got: ${parsed.error ?? parsed.status})`);
    assert.equal(parsed.paid, true);
  }
  assert.ok(Math.abs(PM.getDailySpent() - paidBefore - 0.03) < 1e-9, 'three $0.01 payments settle in the daily total');

  const fourth = await tool({ url: `${urlPrefix}-4` });
  const parsed4 = JSON.parse(fourth.content[0].text);
  assert.equal(parsed4.error, 'Payment refused by policy (DAILY_LIMIT_EXCEEDED)', `the 4th call is refused at the gate (got: ${parsed4.error ?? parsed4.status})`);
  assert.equal(parsed4.paid, undefined, 'a gate refusal is not a payment outcome');
  const newRows = ledgerRows().slice(rowsBefore);
  assert.equal(newRows.length, 3, 'exactly the three settled payments wrote rows (the refusal writes none)');
  assert.equal(newRows.filter((r) => r.amount_usdc === 0.01).length, 3);
});

// ---------------------------------------------------------------------------
// Concurrent: with the file cap at $0.025 (floor = 2 payments) the first two
// calls sign and park IN FLIGHT — their payloads are signed, their holds are
// outstanding, nothing settled yet. A third overlapping call must refuse
// AT THE POLICY GATE (DAILY_LIMIT_EXCEEDED) because the gate's daily figure
// sees both holds; it must not sign (else the file cap is overshot: floor is
// a FLOOR, not a target) and must not merely fall through to the reservation
// backstop. Then the two parked payments settle: $0.02 in the ledger, exactly
// floor($0.025 / $0.01) rows.
// ---------------------------------------------------------------------------
it('overlapping calls refuse at the policy gate while earlier payloads hold (floor semantics)', async () => {
  writePolicyFile(0.025);
  installParkedSeller();
  const urlA = 'https://conc-policy-cap.invalid/a';
  const urlB = 'https://conc-policy-cap.invalid/b';
  const urlC = 'https://conc-policy-cap.invalid/c';
  const rowsBefore = ledgerRows().length;
  const dailyBefore = PM.getDailySpent();

  const runA = tool({ url: urlA });
  await waitUntil(() => seenSigned.has(urlA), 'call A to reach its signed paid leg');
  const runB = tool({ url: urlB });
  await waitUntil(() => seenSigned.has(urlB), 'call B to reach its signed paid leg');

  // A and B hold $0.01 each; nothing settled. The overlapping third call
  // must be refused by the gate — the ONLY layer that reports the policy
  // reason code — before any reserve, sign or row.
  const resultC = await tool({ url: urlC });
  const parsedC = JSON.parse(resultC.content[0].text);
  assert.equal(
    typeof parsedC.reasons === 'object' && (parsedC.reasons as any[]).some((r) => r.code === 'DAILY_LIMIT_EXCEEDED'),
    true,
    `the overlapping call must be refused at the policy gate (got: ${JSON.stringify(parsedC)})`,
  );
  assert.equal(parsedC.error, 'Payment refused by policy (DAILY_LIMIT_EXCEEDED)');
  assert.equal(parsedC.policy_decision, 'DENY');

  // Now settle A and B.
  releaseSigned(urlA);
  releaseSigned(urlB);
  const parsedA = JSON.parse((await runA).content[0].text);
  const parsedB = JSON.parse((await runB).content[0].text);
  assert.equal(parsedA.paid, true, 'call A pays once its response is released');
  assert.equal(parsedB.paid, true, 'call B pays once its response is released');

  const newRows = ledgerRows().slice(rowsBefore);
  assert.equal(newRows.length, 2, 'exactly floor(cap/price) = 2 payments wrote rows — the gate saved the third before it signed');
  assert.equal(newRows.filter((r) => r.url === urlA && r.status === 'success').length, 1);
  assert.equal(newRows.filter((r) => r.url === urlB && r.status === 'success').length, 1);
  assert.ok(Math.abs(PM.getDailySpent() - dailyBefore - 0.02) < 1e-9, 'the daily total rose by exactly the two settled payments');
});