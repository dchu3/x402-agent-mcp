import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Issue #66 (D1, D5): the shipped POLICY PROFILES must refuse real x402_fetch
// paid flows through the whole flow layer, not only at engine level:
//   D1 — mock-seller refusals per profile with ZERO signed requests reaching
//        the seller: strict (unknown service), standard (unlisted payee),
//        and the pair that proves the refusals are profile-scoped, not
//        blanket tightening — standard still pays a payee the operator lists
//        (overlay first, file second), and the permissive default still pays
//        the exact parameters the profiles refuse.
//   D5 — an invalid profile fails CLOSED at the paid layer (CONFIG_INVALID +
//        PAYMENTS_DISABLED, zero signed requests) while the FREE tool
//        (x402_status) keeps working: a misconfigured profile must never take
//        down the agent, only its payments.
//
// Hermetic per the established pattern (fetch-accounting.test.ts /
// fetch-bucket-gate.test.ts): an in-process mock transport serves the 402
// challenge, the EVM leg signs fully locally with a throwaway runtime key,
// the ledger and directory live in temp paths, and no network happens.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-fetch-profile-'));
process.env.X402_NETWORK_MODE = 'mainnet'; // name the mode BEFORE the env capture
const env = { ...process.env };
const LEDGER_PATH = join(dir, 'ledger.jsonl');
process.env.PAYMENT_LOG_PATH = LEDGER_PATH;
// Hermetic empty directory ⇒ the test host is UNKNOWN for every profile.
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-25' }), 'utf8');
// The inner reservation knobs stay out of the way: 50/50 so the ONLY binding
// caps in these scenarios are the profile overlay's.
process.env.MAX_PAYMENT_PER_CALL = '50';
process.env.MAX_DAILY_SPEND = '50';
// Throwaway runtime key — EIP-3009 signing is fully local.
process.env.EVM_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
env.EVM_PRIVATE_KEY = `0x${'22'.repeat(32)}`; // survive the afterEach env restore

const { registerFetchTool } = await import('./fetch.js');
const { registerStatusTool } = await import('./status.js') as typeof import('./status.js');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = {
    ...env,
    PAYMENT_LOG_PATH: LEDGER_PATH,
    X402_DIRECTORY_PATH: join(dir, 'endpoints.json'),
    MAX_PAYMENT_PER_CALL: '50',
    MAX_DAILY_SPEND: '50',
  };
});
after(() => { process.env = env; globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });

function handler(): (args: Record<string, unknown>) => Promise<any> {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

function statusHandler(): (args?: Record<string, never>) => Promise<any> {
  let callback: any;
  registerStatusTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}

function ledgerLines(): string[] {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, 'utf-8').split('\n').filter((l) => l.trim() !== '');
}

// Well-known public protocol identifiers (not secrets): the Base mainnet USDC
// contract/CAIP-2 and a placeholder payee, same convention as fetch.test.ts.
const BASE_CAIP2 = 'eip155:8453';
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_PAYTO = '0x3333333333333333333333333333333333333333';

/** v2 Base challenge the EVM exact scheme signs fully locally. */
function chargeableBaseChallenge(requestUrl: string): Response {
  const payload = JSON.stringify({
    x402Version: 2,
    resource: { url: requestUrl, description: '', mimeType: 'text/plain' },
    accepts: [{
      scheme: 'exact', network: BASE_CAIP2, asset: BASE_USDC_ADDRESS, amount: '10000',
      payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' },
    }],
  });
  return new Response('Payment Required', {
    status: 402,
    headers: { 'payment-required': Buffer.from(payload).toString('base64') },
  });
}

function noSignatureHeader(input: unknown, init: unknown): boolean {
  const headers = new Headers(input instanceof Request ? input.headers : (init as any)?.headers);
  return !headers.has('x-payment') && !headers.has('payment-signature');
}

interface FlowOutcome { parsed: any; probes: number; signedRetries: number }

/** Drive a real x402_fetch against the mock: a 402 challenge on the probe,
 * a receipt on the signed leg. Under #61's probe replay the seller sees the
 * probe and — when the flow is ALLOWED to sign — exactly one signed retry. */
async function runFlow(url: string): Promise<FlowOutcome> {
  let probes = 0, signedRetries = 0;
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const u = input instanceof Request ? input.url : String(input);
    assert.equal(u, url, 'no other endpoint call may happen');
    if (noSignatureHeader(input, init)) {
      probes++;
      return chargeableBaseChallenge(url);
    }
    signedRetries++;
    return new Response('{"result":"ok"}', { status: 200, headers: { 'payment-response': Buffer.from(JSON.stringify({ success: true })).toString('base64') } });
  }) as any;
  const result = await handler()({ url });
  const parsed = JSON.parse(result.content[0].text);
  return { parsed, probes, signedRetries };
}

/** A standard-profile policy file that lists exactly the test payee. */
function writeAllowlistPolicy(): void {
  const policyPath = join(dir, 'policy-listed.json');
  writeFileSync(policyPath, JSON.stringify({
    payments: { enabled: true, maxPerRequest: 0.5, maxDaily: 10 },
    recipients: { mode: 'allowlist', allowed: [BASE_PAYTO], perService: {}, known: {} },
  }), 'utf8');
  process.env.POLICY_CONFIG_PATH = policyPath;
}

// ---------------------------------------------------------------------------
// D1 — per-profile refusals at the flow layer with zero signed requests
// ---------------------------------------------------------------------------

it('D1 strict: a paid fetch to an unknown host is refused (policy_decision DENY, reason UNKNOWN_SERVICE, zero signed requests, ledger untouched)', async () => {
  process.env.X402_POLICY_PROFILE = 'strict';
  delete process.env.POLICY_CONFIG_PATH;
  const url = 'https://profile-strict-test.invalid/api';
  const before = ledgerLines();
  const { parsed, probes, signedRetries } = await runFlow(url);
  assert.equal(parsed.policy_decision, 'DENY', 'strict must refuse the unknown service at the policy layer');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'UNKNOWN_SERVICE'), 'the refusal must name the unknown service');
  assert.equal(probes, 1, 'only the 402 probe may hit the network');
  assert.equal(signedRetries, 0, 'strict must sign NOTHING on an unknown host');
  assert.deepEqual(ledgerLines(), before, 'a refused flow writes nothing to the ledger');
});

it('D1 standard: an unlisted payee on an unknown host is refused (RECIPIENT_NOT_ALLOWED, zero signed requests)', async () => {
  process.env.X402_POLICY_PROFILE = 'standard';
  delete process.env.POLICY_CONFIG_PATH;
  const url = 'https://profile-standard-unlisted.invalid/api';
  const before = ledgerLines();
  const { parsed, probes, signedRetries } = await runFlow(url);
  assert.equal(parsed.policy_decision, 'DENY');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'RECIPIENT_NOT_ALLOWED'), 'standard flips the recipient gate to allowlist — the unlisted payee must be refused');
  assert.equal(probes, 1);
  assert.equal(signedRetries, 0);
  assert.deepEqual(ledgerLines(), before);
});

it('D1 standard + operator file: the listed payee still pays (overlay first, file second — the profile never severs operator listing)', async () => {
  process.env.X402_POLICY_PROFILE = 'standard';
  writeAllowlistPolicy();
  const url = 'https://profile-standard-listed.invalid/api';
  const before = ledgerLines();
  const { parsed, probes, signedRetries } = await runFlow(url);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.cost_usdc, 0.01);
  assert.equal(parsed.policy_decision, undefined, 'ALLOW adds no policy keys to the success output');
  assert.equal(probes, 1, 'only the 402 probe may hit the network — the SDK rides the probe replay');
  assert.equal(signedRetries, 1, 'the listed payee must be signed and paid exactly once');
  const rows = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.equal(rows.find((r: any) => r.url === url)?.status, 'success');
});

it('D1 permissive default: the SAME unknown host + unlisted payee pays (the profiles refuse profile-scoped things, the default stays compatible)', async () => {
  delete process.env.X402_POLICY_PROFILE;
  delete process.env.POLICY_CONFIG_PATH;
  const url = 'https://profile-permissive-test.invalid/api';
  const before = ledgerLines();
  const { parsed, probes, signedRetries } = await runFlow(url);
  assert.equal(parsed.status, 200, 'the permissive stage-A default keeps today\'s behaviour');
  assert.equal(parsed.paid, true);
  assert.equal(parsed.cost_usdc, 0.01);
  assert.equal(probes, 1);
  assert.equal(signedRetries, 1);
  const rows = ledgerLines().slice(before.length).map((l) => JSON.parse(l));
  assert.equal(rows.find((r: any) => r.url === url)?.status, 'success');
});

// ---------------------------------------------------------------------------
// D5 — an invalid profile: paid paths fail CLOSED, the free tool still works
// ---------------------------------------------------------------------------

it('D5 invalid profile: the paid flow is refused with CONFIG_INVALID + PAYMENTS_DISABLED and signs nothing', async () => {
  process.env.X402_POLICY_PROFILE = 'bogus';
  delete process.env.POLICY_CONFIG_PATH;
  const url = 'https://profile-invalid-test.invalid/api';
  const before = ledgerLines();
  const { parsed, probes, signedRetries } = await runFlow(url);
  assert.equal(parsed.policy_decision, 'DENY');
  assert.ok(parsed.reasons.some((r: any) => r.code === 'CONFIG_INVALID'));
  assert.ok(parsed.reasons.some((r: any) => r.code === 'PAYMENTS_DISABLED'));
  assert.equal(probes, 1);
  assert.equal(signedRetries, 0, 'an invalid profile must never reach a signature');
  assert.deepEqual(ledgerLines(), before);
});

it('D5 invalid profile: the FREE tool still answers (x402_status lists the rails, zero network calls)', async () => {
  process.env.X402_POLICY_PROFILE = 'bogus';
  delete process.env.POLICY_CONFIG_PATH;
  let statusFetchCalls = 0;
  globalThis.fetch = (async () => { statusFetchCalls++; throw new Error('x402_status must make ZERO network calls'); }) as any;
  const result = await statusHandler()({});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(statusFetchCalls, 0, 'the free tool must not touch the network');
  assert.ok(Array.isArray(parsed.rails) && parsed.rails.length > 0, 'the status listing is intact under a broken profile');
  assert.equal(parsed.network_mode, 'mainnet');
  assert.match(parsed.note ?? '', /Read-only/);
});