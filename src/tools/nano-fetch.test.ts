import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'x402-nano-test-'));
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
// Hermetic directory (issue #37 pattern): never read the operator's live endpoints.json.
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-11' }), 'utf8');
const { registerFetchTool } = await import('./fetch.js');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_DIRECTORY_PATH: join(dir, 'endpoints.json') }; });
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
