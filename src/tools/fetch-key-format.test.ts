import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Issue #67 (req 6, plan C6 line 50) — fixed key-format refusals: when a
// configured key cannot be decoded, the thrown refusal carries EXACTLY ONE
// fixed message ("SOLANA key must be a base58 string (not a JSON array)" /
// "EVM key must be 0x-prefixed hex"), contains NO fragment of the value, and
// no log line (stderr or ledger failed-row) carries the value either. The
// raw decoder/viem errors could carry value fragments; they must never
// surface. Valid keys keep today's behaviour byte-identically.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-key-format-test-'));
process.env.X402_NETWORK_MODE = 'mainnet';
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
process.env.X402_STATE_DIR = join(dir, 'state');

const KEYS_STATE = {
  solanaKey: '["a","b","c"]',
  evmKey: 'garbage-non-hex-key-value',
};

process.env.EVM_PRIVATE_KEY = KEYS_STATE.evmKey;
env.EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;

const { registerFetchTool } = await import('./fetch.js') as typeof import('./fetch.js');

const BASE_CAIP2 = 'eip155:8453';
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_PAYTO = '0x2222222222222222222222222222222222222222';
// solana mainnet CAIP-2 (the exact id @x402/svm ships).
const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8AsPWAHn6y2qkZtCA1hnbA2';

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
const originalConsoleError = console.error;
after(() => {
  for (const s of liveSellers) s.server.close();
  console.error = originalConsoleError;
  process.env = env;
  rmSync(dir, { recursive: true, force: true });
});

async function seller(respond402: boolean): Promise<{ url: string }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const signed = req.headers['x-payment'] !== undefined || req.headers['payment-signature'] !== undefined;
      if (!signed && respond402) {
        const payload = JSON.stringify({
          x402Version: 2,
          resource: { url: `http://${req.headers.host}${req.url}`, description: '', mimeType: 'text/plain' },
          accepts: [{ scheme: 'exact', network: req.url === '/solana' ? SOLANA_MAINNET_CAIP2 : BASE_CAIP2, asset: req.url === '/solana' ? BASE_USDC_ADDRESS : BASE_USDC_ADDRESS, amount: '10000', payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
        });
        res.writeHead(402, { 'content-type': 'application/json', 'payment-required': b64url(payload) });
        res.end('Payment Required');
        return;
      }
      res.writeHead(503); res.end('no body');
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
  return { url: `http://127.0.0.1:${port}/api` };
}

let stderrLines: string[] = [];

/** Run one x402_fetch call with a given malformed key, capturing stderr.
 * Returns the parsed response, the ledger failed row, and the captured
 * stderr text for the no-fragment assertions. */
async function fetchWithKey(keyEnv: string, chain: 'base' | 'solana'): Promise<{ parsed: any; failedRow: any; stderrText: string }> {
  console.error = (...args: unknown[]) => { stderrLines.push(String(args[0])); };
  stderrLines = [];
  if (chain === 'base') process.env.EVM_PRIVATE_KEY = keyEnv;
  else {
    process.env.SOLANA_PRIVATE_KEY = keyEnv;
    delete process.env.EVM_PRIVATE_KEY;
  }
  const { url } = await seller(true);
  const result = await handler()({ url, chain });
  const rows = ledgerLines();
  return {
    parsed: JSON.parse(result.content[0].text),
    failedRow: rows[rows.length - 1],
    stderrText: stderrLines.join('\n'),
  };
}

const SOLANA_MESSAGE = 'SOLANA key must be a base58 string (not a JSON array)';
const EVM_MESSAGE = 'EVM key must be 0x-prefixed hex';

afterEach(() => {
  console.error = originalConsoleError;
  // Restore the env capture but keep the throwaway base key usable for the
  // other scenarios; each test sets its own malformed key.
  process.env = { ...env, X402_NETWORK_MODE: 'mainnet', PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), X402_DIRECTORY_PATH: join(dir, 'endpoints.json'), X402_STATE_DIR: join(dir, 'state'), EVM_PRIVATE_KEY: KEYS_STATE.evmKey };
  delete process.env.SOLANA_PRIVATE_KEY;
});

it('a JSON-array-shaped SOLANA key is refused with exactly the fixed message and no value fragment', async () => {
  const value = '["a","b","c"]';
  const { parsed, failedRow, stderrText } = await fetchWithKey(value, 'solana');
  assert.equal(failedRow.status, 'failed');
  assert.equal(failedRow.error, SOLANA_MESSAGE, `ledger must carry the fixed message verbatim, got: ${failedRow.error}`);
  // The response must not echo the value; the fixed message may surface.
  assert.ok(!JSON.stringify(parsed).includes(value), 'the response never carries the key value');
  // No log line carries the value (or any fragment of it).
  assert.ok(!stderrText.includes(value), `stderr must not carry the key value, got: ${stderrText}`);
  assert.ok(!stderrText.includes('["a"'));
  assert.ok(stderrText.includes(SOLANA_MESSAGE), 'the fixed message is what the operator sees');
});

it('a truncation-invalid SOLANA key (decodable base58, wrong byte length) gets the same fixed message', async () => {
  const value = 'abcd0123';
  const { failedRow, stderrText } = await fetchWithKey(value, 'solana');
  assert.equal(failedRow.error, SOLANA_MESSAGE);
  assert.ok(!stderrText.includes(value), `stderr must not carry the truncated key, got: ${stderrText}`);
});

it('a non-0x EVM key is refused with exactly the fixed message and no value fragment', async () => {
  const value = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b7869';
  const { parsed, failedRow, stderrText } = await fetchWithKey(value, 'base');
  assert.equal(failedRow.status, 'failed');
  assert.equal(failedRow.error, EVM_MESSAGE, `ledger must carry the fixed message verbatim, got: ${failedRow.error}`);
  assert.ok(!JSON.stringify(parsed).includes(value), 'the response never carries the key value');
  assert.ok(!stderrText.includes(value), `stderr must not carry the key value, got: ${stderrText}`);
  assert.ok(!stderrText.includes('59c6995e'));
  assert.ok(stderrText.includes(EVM_MESSAGE), 'the fixed message is what the operator sees');
});

it('a totally non-hex EVM key gets the same fixed EVM message', async () => {
  const value = 'garbage-non-hex-key-value';
  const { failedRow, stderrText } = await fetchWithKey(value, 'base');
  assert.equal(failedRow.error, EVM_MESSAGE);
  assert.ok(!stderrText.includes(value), `stderr must not carry the garbage key, got: ${stderrText}`);
});

it('valid keys keep working: a valid EVM key signs (the wrap never refuses a good key)', async () => {
  process.env.EVM_PRIVATE_KEY = generatePrivateKey();
  // A paid flow against a seller that 402s and then would settle: the key
  // wrap must not interfere — reach PAST key construction (the mismatch
  // selector abort or the payment attempt) without the fixed key message.
  const { url } = await seller(true);
  const result = await handler()({ url, chain: 'base' });
  const text = result.content[0].text;
  assert.ok(!text.includes(EVM_MESSAGE), 'a valid key must never be refused by the key-format wrap');
  assert.ok(!text.includes(SOLANA_MESSAGE));
});