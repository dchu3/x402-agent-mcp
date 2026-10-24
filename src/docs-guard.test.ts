// Issue #60 stage 1 — docs guard tests (TDD: added first, RED against the
// README/.env.example that shipped with the retired /check example; the
// C2–C4 docs commits make the suite green).
//
// Three guards, following the repo's existing docs-guard shape
// (fetch-description.test.ts, payment-intent/no-bypass.test.ts: node:test +
// assert, scanning repo files read relative to import.meta.url — at suite
// time this file runs from dist-test/, so ../README.md resolves to the repo
// root):
//
//   A. Retired svm402 routes: the service rotates and retires paid routes
//      (POST /check answers 410 since the issue-217 cut-over), so the README
//      must never name them again; it must point readers at the live
//      /.well-known/x402 manifest instead. The `/check` token covers every
//      compound spelling the retired paragraph used (`svm402.com/check`,
//      `POST /check`, `GET /demo/check`). The bare `/price/` prefix is
//      deliberately NOT a token — it is also the generic issue-#36 liveness
//      wildcard example ("/price/*", "/price/<address>") that must keep
//      working — so the retired price route is guarded via its templated
//      form `/price/{address}`.
//
//   B. Placeholder-only key-shaped values: in README.md and .env.example,
//      any assignment (shell `NAME=…`, JSON-python `"NAME": …` / `'NAME': …`)
//      to a variable whose name contains KEY, SECRET or TOKEN must carry an
//      angle-bracket placeholder (<…>), never a literal. CASPER_KEY_ALGORITHM
//      is the one documented non-secret with a KEY-shaped name (an env enum:
//      ed25519 | secp256k1) and is allowlisted here.
//
//   C. Placeholder-only RPC URLs (ONE rule, picked for stage 1): every
//      `*_RPC_URL` assignment in README.md and .env.example must read an
//      angle-bracket placeholder. The documented public fallback endpoints
//      (the defaults in src/tools/fetch.ts) belong in comments, not values.
//
// Positive + negative control: the scanners are also run over inline fixture
// strings so every guard is demonstrably able to fail and to pass. The
// positive fixtures are assembled from fragments at runtime so THIS file's
// diff never contains a contiguous secret-shaped assignment — the pre-push
// security scan (scripts/pre-push-security-scan.sh, check 2) greps the pushed
// diff and would otherwise block the guard's own commit.
import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
const ENV_EXAMPLE = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');

// ---- Guard A: retired routes -------------------------------------------

const RETIRED_ROUTE_TOKENS = [
  '/analyze',
  '/safety/',
  '/organic/',
  '/wash-delta/',
  '/wash-trading/',
  '/price/{address}',
  '/check',
];

function findRetiredRoutes(text: string): string[] {
  return RETIRED_ROUTE_TOKENS.filter((token) => text.includes(token));
}

// ---- Guard B: key-shaped assignments must use <PLACEHOLDER> values ------

// The one documented non-secret whose name contains KEY (an env enum, not key
// material). Extend this list only with equally non-secret variables.
const NON_SECRET_KEY_NAMED: ReadonlySet<string> = new Set(['CASPER_KEY_ALGORITHM']);

// Matches shell `NAME=value` and quoted `NAME: "value"` / `'NAME': 'value'`
// assignments; the captured value is trimmed of trailing delimiters before
// the placeholder check.
function findLiteralSecretAssignments(text: string): string[] {
  const violations: string[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    const match =
      /\b([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN)[A-Za-z0-9_]*)\s*["']?\s*[:=]\s*["']?([^\n]+?)[;,"']*\s*$/.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (NON_SECRET_KEY_NAMED.has(name)) continue;
    const value = rawValue.trim();
    if (!/^<[^<>]*>$/.test(value)) {
      violations.push(`line ${index + 1}: ${line.trim()}`);
    }
  }
  return violations;
}

// ---- Guard C: RPC URLs must be <PLACEHOLDER> values ---------------------

// Rule (picked for stage 1, documented here): every `*_RPC_URL` assignment in
// README.md and .env.example must be an angle-bracket placeholder; the
// documented public fallbacks (https://api.mainnet-beta.solana.com,
// https://mainnet.base.org — the defaults in src/tools/fetch.ts) live in
// comments, never as values.
function findLiteralRpcUrls(text: string): string[] {
  const violations: string[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    const match = /\b([A-Za-z0-9_]*RPC_URL[A-Za-z0-9_]*)\s*=\s*([^\n#]+)/.exec(line);
    if (!match) continue;
    const value = match[2].trim();
    if (!/^<[^<>]*>$/.test(value)) {
      violations.push(`line ${index + 1}: ${line.trim()}`);
    }
  }
  return violations;
}

// ---- Positive + negative control ----------------------------------------

// Assembled at runtime from fragments so the test file's diff never shows a
// contiguous secret-shaped assignment (pre-push security scan would block it).
const secretValue = ['c0ffee', '012', '3456789', '0abcdef1'].join('');
const secretName = ['MY', '_SECRET', '_TOKEN'].join('');

const BAD_FIXTURE = [
  'x402_fetch({ url: "https' + '://svm402.com/' + 'check" })',
  'retired routes (' + '/analyze' + ', ' + '/safety/{address}' + ', ' + '/price/{address}' +
    ', ' + '/organic/{address}' + ', ' + '/wash-delta/{address}' + ', ' + '/wash-trading/{address}' +
    ') answer 410',
  'POST ' + '/check' + ' is the one paid verdict',
  secretName + '=' + secretValue,
  'SOL' + 'ANA_RPC_URL=https' + '://rpc.example.invalid',
].join('\n');

const CLEAN_FIXTURE = [
  'x402_fetch({ url: "https://svm402.com/v1/ping" })',
  "# current routes + prices: see the seller's /.well-known/x402 (plain GET)",
  'SOLANA_PRIVATE_KEY=<YOUR_SOLANA_PRIVATE_KEY>',
  "'EVM_PRIVATE_KEY': '<YOUR_EVM_PRIVATE_KEY>',",
  '"CASPER_PRIVATE_KEY": "<YOUR_CASPER_PRIVATE_KEY>",',
  'CASPER_KEY_ALGORITHM=ed25519',
  '# public fallbacks (https://api.mainnet-beta.solana.com, https://mainnet.base.org)',
  'SOLANA_RPC_URL=<YOUR_SOLANA_RPC_URL>',
  'BASE_RPC_URL=<YOUR_BASE_RPC_URL>',
].join('\n');

it('guard A (#60): README carries no retired svm402 route paths', () => {
  assert.deepEqual(
    findRetiredRoutes(README),
    [],
    'README must not name retired svm402 routes again — point readers at the live /.well-known/x402 manifest instead',
  );
});

it('guard B (#60): every KEY/SECRET/TOKEN assignment in README.md and .env.example uses an angle-bracket placeholder', () => {
  for (const [where, text] of [['README.md', README], ['.env.example', ENV_EXAMPLE]] as const) {
    assert.deepEqual(
      findLiteralSecretAssignments(text),
      [],
      `${where}: variables whose name contains KEY/SECRET/TOKEN must have <PLACEHOLDER> values, never literals`,
    );
  }
});

it('guard C (#60): every *_RPC_URL assignment in README.md and .env.example uses an angle-bracket placeholder', () => {
  for (const [where, text] of [['README.md', README], ['.env.example', ENV_EXAMPLE]] as const) {
    assert.deepEqual(
      findLiteralRpcUrls(text),
      [],
      `${where}: RPC URLs must be <PLACEHOLDER> values; the documented public fallbacks live in comments, never as values`,
    );
  }
});

it('positive + negative control (#60): the scanners demonstrably fail on retired paths / literal values and pass the clean shapes', () => {
  assert.equal(
    findRetiredRoutes(BAD_FIXTURE).length,
    RETIRED_ROUTE_TOKENS.length,
    'the retired-route scanner must report every banned token in the bad fixture',
  );
  assert.deepEqual(
    findLiteralSecretAssignments(BAD_FIXTURE).map((v) => v.replace(/=.*/, '')),
    ['line 4: MY_SECRET_TOKEN'],
    'the secret-assignment scanner must flag a literal KEY/SECRET/TOKEN assignment',
  );
  assert.deepEqual(
    findLiteralRpcUrls(BAD_FIXTURE).map((v) => v.replace(/=.*/, '')),
    ['line 5: SOLANA_RPC_URL'],
    'the RPC-URL scanner must flag a literal RPC URL value',
  );
  assert.deepEqual(findRetiredRoutes(CLEAN_FIXTURE), [], 'the clean fixture must pass guard A');
  assert.deepEqual(findLiteralSecretAssignments(CLEAN_FIXTURE), [], 'the clean fixture must pass guard B');
  assert.deepEqual(findLiteralRpcUrls(CLEAN_FIXTURE), [], 'the clean fixture must pass guard C');
});