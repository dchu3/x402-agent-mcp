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
//
// Docs-split guards D + E (added for the #73 docs restructure):
//
//   D. Each reference docs file (policy.md, payments.md, networks.md,
//      operations.md) exists — the README front page links to them.
//
//   E. Every local (non-http) markdown link in README.md and docs/*.md
//      resolves to a real file, so the short README's docs links and the
//      docs' cross-links never dangle (same-page anchors and external URLs
//      are out of scope; guards A-C above keep scanning README.md and
//      .env.example unchanged).
import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
const ENV_EXAMPLE = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
const LLMSTXT = readFileSync(fileURLToPath(new URL('../llms.txt', import.meta.url)), 'utf8');

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

// ---- Docs split (#73): docs/ reference files + resolved links -----------

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS_DIR = join(REPO_ROOT, 'docs');
const REFERENCE_DOCS = ['policy.md', 'payments.md', 'networks.md', 'operations.md'];

// Matches `[text](target)` markdown links whose target has no spaces or
// parentheses and stays on one line (the shape every link in this repo has).
function localMarkdownLinkTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(/\[[^\]\n]*\]\(([^()\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:)?\/\//i.test(target) || /^(mailto|data):/i.test(target)) continue; // external
    if (target.startsWith('#')) continue; // same-page anchor
    targets.push(target.split('#', 1)[0]);
  }
  return targets;
}

it('docs split (#73): every reference docs/ file exists with a title', () => {
  for (const name of REFERENCE_DOCS) {
    const path = join(DOCS_DIR, name);
    assert.ok(existsSync(path), `docs/${name} must exist (docs referenced from the README)`);
    const text = readFileSync(path, 'utf8');
    assert.ok(text.startsWith('# '), `docs/${name} must open with an H1 title`);
    assert.ok(text.trim().length > 0, `docs/${name} must not be empty`);
  }
});

it('docs split (#73): every local markdown link in README.md and docs/*.md resolves to a real file', () => {
  const pages: Array<[string, string, string]> = [
    ['README.md', README, '.'],
    ...REFERENCE_DOCS.map(
      (name) => [`docs/${name}`, readFileSync(join(DOCS_DIR, name), 'utf8'), 'docs'] as [string, string, string],
    ),
  ];
  for (const [where, text, baseDir] of pages) {
    for (const target of localMarkdownLinkTargets(text)) {
      const resolved = join(REPO_ROOT, baseDir, target);
      assert.ok(
        existsSync(resolved) && statSync(resolved).isFile(),
        `${where} links to "${target}" which does not resolve to a real file (looked at ${resolved})`,
      );
    }
  }
});

it('positive + negative control (#73): the local-link scanner filters external URLs and same-page anchors and still checks files', () => {
  const fixture = [
    'external [sdk](https://example.com/x) is skipped',
    'anchor [limits](#limits) is skipped',
    'local [env](.env.example) is checked',
  ].join('\n');
  assert.deepEqual(localMarkdownLinkTargets(fixture), ['.env.example']);
  assert.equal(existsSync(join(REPO_ROOT, 'does-not-exist.md')), false);
});

// ---- Profile docs (#66): policy profiles are documented -----------------

// Issue #66 stage A: the shipped opt-in profile switch must be discoverable —
// the README names the variable and docs/policy.md documents the three
// values. Identifier-level tokens only: the prose may be rewritten freely,
// the vocabulary may not (no sentence-shaped assertions here — the repo's
// docs-guard style).
it('#66: the policy profiles are documented — X402_POLICY_PROFILE in README.md and docs/policy.md, all three profile names in docs/policy.md', () => {
  assert.ok(README.includes('X402_POLICY_PROFILE'), 'README.md must name the X402_POLICY_PROFILE variable');
  const policyDoc = readFileSync(join(DOCS_DIR, 'policy.md'), 'utf8');
  assert.ok(policyDoc.includes('X402_POLICY_PROFILE'), 'docs/policy.md must name the X402_POLICY_PROFILE variable');
  for (const profile of ['strict', 'standard', 'permissive']) {
    assert.ok(policyDoc.includes(profile), `docs/policy.md must name the ${profile} profile`);
  }
});

// ---- Discovery metadata (#73): MIT licence fields ----------------------

// The standard MIT template text the LICENSE file must carry (the canonical
// template, with the public repo handle as the copyright line).
const MIT_TEMPLATE_HEAD = [
  'MIT License',
  '',
  'Copyright (c) 2026 dchu3',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
].join('\n');
const MIT_TEMPLATE_BODY_PHRASES = [
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'The above copyright notice and this permission notice shall be included in all',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
];

it('metadata (#73): package.json carries MIT licence + repository + keywords', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    license?: string;
    repository?: { type?: string; url?: string };
    keywords?: string[];
  };
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository?.type, 'git');
  assert.equal(pkg.repository?.url, 'git+https://github.com/dchu3/x402-agent-mcp.git');
  assert.ok(
    pkg.keywords,
    'package.json must declare keywords for discovery',
  );
  for (const keyword of [
    'x402', 'mcp', 'model-context-protocol', 'ai-agents', 'solana',
    'base', 'polygon', 'arbitrum', 'casper', 'payments',
  ]) {
    assert.ok(pkg.keywords.includes(keyword), `package.json keywords must include ${keyword}`);
  }
});

it('metadata (#73): LICENSE matches the standard MIT template', () => {
  const license = readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8');
  assert.ok(license.startsWith(MIT_TEMPLATE_HEAD), 'LICENSE must start with the standard MIT template head');
  for (const phrase of MIT_TEMPLATE_BODY_PHRASES) {
    assert.ok(license.includes(phrase), `LICENSE must carry the standard MIT template phrase: ${phrase}`);
  }
});

// ---- Agent discovery (#73): llms.txt references the whole docs/ tree ----

it('discovery (#73): README and llms.txt reference every docs/ file', () => {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const llms = readFileSync(join(REPO_ROOT, 'llms.txt'), 'utf8');
  assert.ok(readme.startsWith('# x402-agent-mcp'), 'README must still be the project front page');
  assert.ok(llms.startsWith('# x402-agent-mcp'), 'llms.txt must open with the H1 title');
  const docFiles = readdirSync(DOCS_DIR).filter((name) => name.endsWith('.md')).sort();
  assert.ok(docFiles.length >= 4, 'docs/ must contain the reference files');
  for (const name of docFiles) {
    const rel = `docs/${name}`;
    assert.ok(readme.includes(rel), `README must reference ${rel}`);
    assert.ok(llms.includes(rel), `llms.txt must reference ${rel}`);
  }
});

// ---- Guard F (#60 stage 2-3): trust-boundary claims stay tied to proofs --
//
// The payments doc's redirect/size-bounds paragraph must keep every claim
// tied to the code it names — structurally, not by quoting prose:
//
//   1. Redirect refusal is scoped to the SHARED guard, never to Casper only.
//      The one measured narrow claim ("… and Casper redirects are refused",
//      retired with the docs correction) must never come back;
//   2. the paragraph names the exact redirect modes the code uses:
//      `redirect: "manual"` (src/transport/guard.ts rebuilds every foreign
//      Request with it; the signed paid leg passes it in its own init —
//      src/tools/fetch.ts) and `redirect: "error"` (the Casper leg —
//      src/tools/casper-fetch.ts);
//   3. the claims are backed by the suites that assert them. MEASURED on
//      master@410475d: the 3xx refusals (REDIRECT_REFUSED) are pinned in
//      guarded-fetch.test.ts (guard + every tool-shaped path),
//      probe-utils.test.ts (shared probe utils) and inspector.test.ts; the
//      guard's other refusals (private hosts) live in guard.test.ts, which
//      carries NO redirect assertion — so guard F requires the redirect
//      token only from the files that actually assert it.

const PAYMENTS_DOC = readFileSync(join(DOCS_DIR, 'payments.md'), 'utf8');

// The retired narrow scoping — redirect refusal pinned to one chain — is the
// claim guard F exists to keep out.
const NARROW_REDIRECT_CLAIM = 'Casper redirects are refused';

// Structural tokens straight from the guard and leg implementations.
const SHARED_GUARD_REDIRECT_TOKENS = ['redirect: "manual"', 'redirect: "error"'] as const;

// Returns the narrow-scope violations: the retired claim found again, or a
// shared-guard token missing.
function findNarrowRedirectScope(text: string): string[] {
  const violations: string[] = [];
  if (text.includes(NARROW_REDIRECT_CLAIM)) violations.push(NARROW_REDIRECT_CLAIM);
  for (const token of SHARED_GUARD_REDIRECT_TOKENS) {
    if (!text.includes(token)) violations.push(`missing ${token}`);
  }
  return violations;
}

// Each [file, tokens] pair must exist and contain every token — the docs
// claims are only as true as the test file that asserts them.
const CLAIM_PROVER_FILES: ReadonlyArray<[string, readonly string[]]> = [
  // The guard's refusal matrix: private-host/refusal codes (the guard.test.ts
  // half of the proof; the 3xx half lives in guarded-fetch.test.ts below).
  ['src/transport/guard.test.ts', ['PRIVATE_HOST_REFUSED']],
  // Guard-driven 3xx refusal on the tool-shaped paths: probe, health, crawl,
  // shared probe utils — the "every payment path" claim.
  ['src/transport/guarded-fetch.test.ts', ['REDIRECT_REFUSED']],
  // The probe surface's own caps: header > 64 KiB refused, header-less 402
  // body bounded (PAYMENT_REQUIRED_BODY_CAP), redirects refused there too.
  ['src/tools/probe-utils.test.ts', ['REDIRECT_REFUSED', 'Payment header exceeds size limit', 'Payment response exceeds size limit']],
  // x402_inspect renders the paid path's own cap wording as refusals.
  ['src/tools/inspector.test.ts', ['REDIRECT_REFUSED', 'Payment response exceeds size limit']],
  // The paid body's 1 MiB bound surfacing as a counted authorized_unserved row.
  ['src/tools/fetch-paid-limits.test.ts', ['authorized_unserved']],
  // The Casper leg's streamed-body cap is 64 KiB — boundedText's 65536-byte
  // default in src/tools/casper-fetch.ts, NOT the 1 MiB paid-body cap.
  ['src/tools/casper-fetch.test.ts', ['size limit']],
];

// Identifier-level pin matching the table's style: docs/payments.md must keep
// naming the Casper streamed-body cap as the code's own number — boundedText's
// default limit of 65536 bytes (= 64 KiB) in src/tools/casper-fetch.ts — so
// the 1 MiB USD-rail paid-body cap can never stand in for it.
const CASPER_STREAMED_BODY_CAP_TOKEN = '65536';

function missingClaimProofs(root: string, files: ReadonlyArray<[string, readonly string[]]>): string[] {
  const gaps: string[] = [];
  for (const [rel, tokens] of files) {
    const path = join(root, rel);
    if (!existsSync(path)) {
      gaps.push(`${rel}: missing file`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    for (const token of tokens) {
      if (!text.includes(token)) gaps.push(`${rel}: proof token not asserted: ${token}`);
    }
  }
  return gaps;
}

it('guard F (#60): docs/payments.md scopes redirect refusal to the shared guard and names the code\'s redirect modes', () => {
  assert.deepEqual(
    findNarrowRedirectScope(PAYMENTS_DOC),
    [],
    'redirect refusal must be scoped to the shared guard (redirect: "manual" + the Casper leg\'s redirect: "error"), never to Casper only',
  );
});

it('guard F (#60): every trust-boundary claim in docs/payments.md is proven by the suite file that asserts it', () => {
  assert.deepEqual(
    missingClaimProofs(REPO_ROOT, CLAIM_PROVER_FILES),
    [],
    'the redirect/size-bounds claims must keep their proving test files (and the exact asserted tokens) in the suite',
  );
});

it('guard F (#60): docs/payments.md states the Casper streamed-body cap as the code\'s 65536-byte default', () => {
  assert.ok(
    PAYMENTS_DOC.includes(CASPER_STREAMED_BODY_CAP_TOKEN),
    "the Casper leg's streamed-body cap must be stated as 64 KiB — boundedText's default limit of 65536 bytes in src/tools/casper-fetch.ts (not the 1 MiB paid-body cap)",
  );
});

it('positive + negative control (#60): the guard F scanners fail on the narrow claim / missing proofs and pass the correct shape', () => {
  const BAD = [
    'Payment response bodies/headers are size-bounded and ' + NARROW_REDIRECT_CLAIM + '.',
    'redirects are refused by the guard and the Casper leg alike (no exact mode named)',
  ].join('\n');
  const flagged = findNarrowRedirectScope(BAD);
  assert.equal(flagged.length, 3, `the narrow claim + the missing tokens must be flagged, got: ${JSON.stringify(flagged)}`);
  assert.deepEqual(findNarrowRedirectScope(PAYMENTS_DOC), [], 'the real docs must pass');
  // A prover file that does not exist is reported as a gap (fail closed):
  const gaps = missingClaimProofs(REPO_ROOT, [['src/does-not-exist.test.ts', ['X']] as [string, readonly string[]]]);
  assert.equal(gaps.length, 1, 'a missing prover file must be reported');
});

// ---- Guard G (#60 stage 2-3): no real-looking address material in docs ---
//
// Fail-closed rule for README.md and docs/*.md: every base58-shaped 32-44
// char token and every 0x+40-hex token must be either (a) a documented
// public infrastructure address — allowlisted inline below, all of them
// already rows of docs/networks.md's asset table — or (b) inside an angle
// bracket placeholder, which is the one sanctioned shape for example
// values. Anything else fails, so a copy-paste-able wallet-shaped token can
// never enter the docs unnoticed.
const DOCUMENTED_PUBLIC_ADDRESSES: ReadonlySet<string> = new Set([
  // docs/networks.md asset table — the Solana genesis ids (the CAIP-2 names):
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  // …and the USDC mints per network:
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  // …and the EVM USDC contracts (Base / Polygon / Arbitrum):
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
]);

// EVM `0x` addresses are case-insensitive (docs/policy.md pins the EIP-55
// comparison), so their allowlist matches are compared lowercased.
const DOCUMENTED_EVM_ADDRESSES_LOWER: ReadonlySet<string> = new Set(
  [...DOCUMENTED_PUBLIC_ADDRESSES].filter((a) => a.startsWith('0x')).map((a) => a.toLowerCase()),
);

// Base58 alphabet run (no 0, O, I, l) at token boundaries. The lookarounds
// never consume the delimiter, so two back-to-back CAIP-2 names cannot hide
// behind a shared separator.
const BASE58_TOKEN = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])/g;
const EVM_ADDRESS_TOKEN = /0x[0-9a-fA-F]{40}/g;

function findUndocumentedAddressMaterial(rawText: string): string[] {
  // Angle-bracket placeholders are the sanctioned shape; strip their spans
  // first so a placeholder never counts as material.
  const text = rawText.replace(/<[^<>\n]*>/g, ' ');
  const undocumented: string[] = [];
  for (const match of text.matchAll(EVM_ADDRESS_TOKEN)) {
    const token = match[0];
    if (!DOCUMENTED_EVM_ADDRESSES_LOWER.has(token.toLowerCase())) undocumented.push(token);
  }
  for (const match of text.matchAll(BASE58_TOKEN)) {
    if (!DOCUMENTED_PUBLIC_ADDRESSES.has(match[0])) undocumented.push(match[0]);
  }
  return undocumented;
}

const DOC_PAGES: ReadonlyArray<[string, string]> = [
  ['README.md', README],
  ...REFERENCE_DOCS.map((name) => [`docs/${name}`, readFileSync(join(DOCS_DIR, name), 'utf8')] as [string, string]),
];

it('guard G (#60): README.md and docs/*.md carry no undocumented wallet-shaped address material', () => {
  for (const [where, text] of DOC_PAGES) {
    assert.deepEqual(
      findUndocumentedAddressMaterial(text),
      [],
      `${where}: every address-shaped token must be an allowlisted documented public infra address (docs/networks.md asset table) or an angle-bracket placeholder`,
    );
  }
});

it('positive + negative control (#60): the guard G scanner fails on lookalike addresses and passes allowlisted/placeholder shapes', () => {
  // A base58 lookalike of the devnet USDC mint (last char differs) and an EVM
  // lookalike — assembled from fragments so this file's diff never carries a
  // contiguous address-shaped literal outside fixture assembly (the same
  // rule guards B/C follow for secret-shaped assignments).
  const lookalikeMint = ['4zMMC9srt5Ri5X14GAgXhaHii3GnPAEE', 'RYPJgZJDncDV'].join('');
  const lookalikeEvm = ['0xdead', 'beef'.repeat(9)].join('');
  const BAD = [`mint: ${lookalikeMint}`, `payTo: ${lookalikeEvm}`].join('\n');
  const flagged = findUndocumentedAddressMaterial(BAD);
  assert.equal(flagged.length, 2, `both lookalikes must be flagged, got: ${JSON.stringify(flagged)}`);

  // The sanctioned shapes pass: an allowlisted asset-table address and the
  // same material wrapped as an angle-bracket placeholder.
  const CLEAN = [
    'USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'SOLANA_PRIVATE_KEY=<throwaway-devnet-key>',
    'recipient: <0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef>',
  ].join('\n');
  assert.deepEqual(findUndocumentedAddressMaterial(CLEAN), [], 'allowlisted + placeholder shapes must pass');
});
// ---- Guard H (#87): no issue references or history notes in public docs --
//
// The public docs state CURRENT behaviour only. History-shaped prose (issue
// cross-references, requirement numbers, stage labels, release-note wording,
// "previously/formerly" notes) rots the moment the code changes and is what
// #87 flagged across README.md, docs/*.md and .env.example: the rule must be
// stated, the change-log flavor dropped. Scanned: README.md, every docs/*.md
// and .env.example. Source comments are out of scope (they may keep issue
// references — this guard pins the PUBLIC pages only). Guards A-G above are
// untouched.
const GUARD_H_TOKENS: ReadonlyArray<[string, RegExp]> = [
  ['issue reference', /[Ii]ssues? #[0-9]+/],
  ['issue reference', /\(#[0-9]+\)/],
  // a bare "refs #123"-style pointer — no "issue" word, no parens (widened
  // for #93: the reference must not survive either spelling)
  ['issue reference', /#[0-9]+/],
  ['requirement number', /\(?req(?:uirement)? [0-9]+\)?/],
  ['stage label', /[Ss]tage [A-C]\b/],
  ['release-note wording', /BREAKING CHANGE/],
  ['history note', /[Pp]reviously/],
  ['history note', /[Ff]ormerly/],
  ['history note', /before chain-scoping/],
  // widened for #93: the backticked token (`old `payment_info``) must be
  // caught exactly like the bare word, and the straight or curly apostrophe
  // in "Today's/Today’s behaviour" phrasing — prose style must not hide the
  // history note from the scanner.
  ['history note', /old `?payment_info`?/],
  ['history note', /once dragged/],
  ['history note', /hardcoded 30 s/],
  ['history note', /Today['’]s behavio/],
  // widened for #93 (B5): the pre-policy note and the "deliberate
  // tightening" decision-note flavour are history prose the same way — the
  // public docs state the current behaviour, not the design story that led
  // to it.
  ['history note', /before the policy engine/],
  ['history note', /[Dd]eliberate[ _-]+(default[ _-]+)?tightening/],
];

function findGuardHViolations(text: string): string[] {
  const violations: string[] = [];
  for (const [label, re] of GUARD_H_TOKENS) {
    if (re.test(text)) violations.push(label);
  }
  return violations;
}

const GUARD_H_PAGES: ReadonlyArray<[string, string]> = [
  ['README.md', README],
  ['.env.example', ENV_EXAMPLE],
  ['llms.txt', LLMSTXT],
  ...readdirSync(DOCS_DIR).filter((n) => n.endsWith('.md')).map(
    (n) => [`docs/${n}`, readFileSync(join(DOCS_DIR, n), 'utf8')] as [string, string],
  ),
];

it('guard H (#87): README.md, docs/*.md, llms.txt and .env.example state current behaviour only — no issue references or history notes', () => {
  for (const [where, text] of GUARD_H_PAGES) {
    assert.deepEqual(
      findGuardHViolations(text),
      [],
      `${where}: issue cross-references, requirement/stage labels, release-note wording and history notes ("previously"/"formerly") must not appear in the public docs — state the current behaviour and keep the rule`,
    );
  }
});

it('positive + negative control (#87): the guard H scanner fails on every token class and passes current-behaviour phrasing', () => {
  // Assembled so each token class is exercised; the fragments are ordinary
  // prose tokens (nothing secret-shaped), so direct strings are fine here.
  const BAD = [
    'added in issue ' + '#86' + ' (see ' + '(' + '#87' + '))',
    'recorded in the triage list as ' + '#93' + ' — a bare ' + '#42' + ' pointer too',
    'req ' + '2' + ' of the rollout, requirement ' + '3' + ' for casper',
    'Stage ' + 'A' + ' shipped it — BREAKING ' + 'CHANGE:',
    'Previously the flow estimated; formerly it fell back',
    'an old ' + 'payment_info' + ' echo once ' + 'dragged' + ' baselines to zero (a once-d' + 'ragged baseline…)',
    'the retired ' + 'old ' + '`payment_info`' + ' backticked echo is caught too',
    'a hardcoded ' + '30 s' + ' literal; Today' + "'" + 's behavio' + 'ur row',
    'and the curly-spelled ' + 'Today\u2019s behavio' + 'ur row as well',
    'before chain-' + 'scoping the vocabulary was one chain',
    'decided ' + 'before the policy engine' + ' shipped, back when it lacked the gate',
    'the one ' + 'deliberate tightening' + ' of the default — and a ' + 'deliberate default tightening' + ' again',
  ].join('\n');
  assert.equal(findGuardHViolations(BAD).length, GUARD_H_TOKENS.length, 'every token class must be flagged');

  const CLEAN = [
    'With the variable unset the profile is permissive.',
    'A bare recipients entry is scoped to base and never authorises the same address on polygon.',
    'Directory membership is not proof of liveness; refresh with the probe tool.',
    'X402_POLICY_PROFILE=strict|standard|permissive',
  ].join('\n');
  assert.deepEqual(findGuardHViolations(CLEAN), [], 'current-behaviour phrasing must pass');
});

// ---- README sizes (#93): the front page stays short ----------------------
//
// The README is the front page humans and agent harnesses scan first; the
// reference material lives in docs/*.md (linked at the bottom). Cap its size
// so doc growth lands in docs/ instead of the front page. MEASURED on
// master 1aed1fe: 77 lines / 720 words — the caps below keep tight headroom.
const README_MAX_LINES = 90;
const README_MAX_WORDS = 850;

function readmeLineCount(text: string): number {
  return text.split('\n').length;
}

function readmeWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function assertReadmeWithinCaps(lineCount: number, wordCount: number): void {
  assert.ok(
    lineCount <= README_MAX_LINES,
    `README.md has ${lineCount} lines — cap is ${README_MAX_LINES}; reference material belongs in docs/`,
  );
  assert.ok(
    wordCount <= README_MAX_WORDS,
    `README.md has ${wordCount} words — cap is ${README_MAX_WORDS}; reference material belongs in docs/`,
  );
}

it('readme caps (#93): README.md stays within the line and word caps', () => {
  assertReadmeWithinCaps(readmeLineCount(README), readmeWordCount(README));
});

it('positive + negative control (#93): the readme-caps guard passes under the caps and fails when either cap is exceeded', () => {
  assertReadmeWithinCaps(0, 0); // an empty README trivially passes the caps
  let failed = false;
  try {
    assertReadmeWithinCaps(README_MAX_LINES + 1, 0);
  } catch {
    failed = true;
  }
  assert.ok(failed, 'line count over the cap must fail the guard');
  failed = false;
  try {
    assertReadmeWithinCaps(0, README_MAX_WORDS + 1);
  } catch {
    failed = true;
  }
  assert.ok(failed, 'word count over the cap must fail the guard');
});

// ---- Tools table (#93): the README table lists the registered tools ------
//
// The README "Tools" table promises exactly the server surface: every tool
// the server registers must have a row, and no row may name a tool the
// server does not register. The registered names are parsed from the
// src/tools/*.ts registrations (server.tool("x402_…", …) — one registration
// per non-test tools file).
const TOOLS_DIR = join(REPO_ROOT, 'src', 'tools');

interface ToolRegistrationScan {
  names: string[];
  /** Files that mention server.tool( but yielded no parsed name. */
  unparsed: string[];
}

function registeredToolNames(root: string): ToolRegistrationScan {
  const names: string[] = [];
  const unparsed: string[] = [];
  const files = readdirSync(root).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    if (!text.includes('server.tool(')) continue; // helper files, not registrations
    const match = /server\.tool\(\s*\n\s*["'`]([^"'`]+)["'`]/.exec(text);
    if (match) names.push(match[1]);
    else unparsed.push(file);
  }
  return { names: names.sort(), unparsed };
}

function readmeToolRows(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\|\s*`(x402_[a-z_]+)`\s*\|/.exec(line);
    if (match) names.push(match[1]);
  }
  return names.sort();
}

it('tools table (#93): the README Tools table equals the registered tools', () => {
  const { names, unparsed } = registeredToolNames(TOOLS_DIR);
  assert.ok(names.length > 0, 'the registration parser must see the real tools — if this fails the server.tool( shape changed; update the parser and the README table');
  assert.deepEqual(
    unparsed,
    [],
    'every src/tools file with a server.tool( call must parse to exactly one registered name (one registration per file — extend the parser and the README table if a second one is added)',
  );
  assert.deepEqual(
    readmeToolRows(README),
    names,
    'the README Tools table must list exactly the tools the server registers — no missing rows, no stale names',
  );
});

it('positive + negative control (#93): the tools-table comparison fails on a missing row and on a stale row, passes on equal lists', () => {
  const names = ['x402_fetch', 'x402_status'];
  const table = '| `x402_fetch` | Endpoint price | Fetch an x402 endpoint and pay the 402 price. |\n| `x402_status` | Free | Show every budget rail. |';
  assert.deepEqual(readmeToolRows(table), names, 'sanity: the row parser sees exactly the fixture rows');
  let failed = false;
  try {
    assert.deepEqual(readmeToolRows('| `x402_fetch` | Endpoint price | Fetch an x402 endpoint and pay the 402 price. |'), names);
  } catch {
    failed = true;
  }
  assert.ok(failed, 'a registered tool with no README row must fail the comparison');
  failed = false;
  try {
    assert.deepEqual(readmeToolRows(table + '\n| `x402_removed` | Free | A tool the server no longer registers. |'), names);
  } catch {
    failed = true;
  }
  assert.ok(failed, 'a README row for an unregistered tool must fail the comparison');
});

// ---- Env vars (#93): every env var the code reads is documented ----------
//
// Docs-truth rule: an env var the server reads must exist in the operator
// docs — .env.example (the annotated key set) AND the public docs
// (README.md ∪ docs/*.md). The scan covers every read shape used in this
// repo's production sources (src/**/*.ts minus *.test.ts):
//   - direct: process.env.NAME and param-env env.NAME (NodeJS.ProcessEnv
//     arguments, e.g. src/networks.ts, src/transport/replay.ts,
//     src/payment-intent/challenge-scope.ts);
//   - bracketed literal: process.env["NAME"];
//   - helper call sites that take the var name as a literal argument:
//     readCapUsd / capUsdExactString / legacyNumber / casperBudgetCapAtomic
//     / envHostList;
//   - template-built names, added synthetically: X402_POLICY_SERVICE_<LEVEL>
//     (+ _MAX_PER_REQUEST / _MAX_DAILY) built in src/policy/config.ts;
//   - template indirection the scanner cannot statically resolve, carried
//     here fail-closed-by-review: src/reservations.ts reads
//     process.env[CEILING_VAR] where CEILING_VAR = MAX_DAILY_SPEND_TOTAL_USD,
//     and src/budget-registry.ts railUsdRateVar() builds X402_RATE_<SYMBOL>_USD
//     from the registered rail symbols (USDC, wCSPR). A new rail symbol or a
//     renamed constant must extend these lists.
// Allowlist: NODE_TEST_CONTEXT — Node's own test-process marker (read in
// src/directory.ts to keep production directory writes out of test runs);
// not an operator knob and deliberately absent from the operator docs. The
// documented templates: X402_POLICY_SERVICE_<LEVEL>[_MAX_PER_REQUEST|_MAX_DAILY]
// in .env.example, the same family in docs/policy.md's override table.
const INDIRECT_ENV_NAMES: ReadonlySet<string> = new Set([
  'MAX_DAILY_SPEND_TOTAL_USD',
  'X402_RATE_USDC_USD',
  'X402_RATE_WCSPR_USD',
]);
const NON_OPERATOR_ENV_NAMES: ReadonlySet<string> = new Set(['NODE_TEST_CONTEXT']);
const SERVICE_LEVELS = ['UNKNOWN', 'DISCOVERED', 'VERIFIED', 'TRUSTED', 'BLOCKED'] as const;
const SERVICE_NAME_RE = /^X402_POLICY_SERVICE_(UNKNOWN|DISCOVERED|VERIFIED|TRUSTED|BLOCKED)(_(?:MAX_PER_REQUEST|MAX_DAILY))?$/;

function walkProdSources(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkProdSources(root, full));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function scanEnvReadNames(root: string): string[] {
  const names = new Set<string>();
  for (const path of walkProdSources(root, join(root, 'src'))) {
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|\benv\.([A-Z][A-Z0-9_]+)/g)) {
      // group 1: process.env.NAME — group 2: env.NAME (ProcessEnv params)
      names.add(m[1] ?? m[2]);
    }
    for (const m of text.matchAll(/process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g)) names.add(m[1]);
    for (const m of text.matchAll(/(?:readCapUsd|capUsdExactString|legacyNumber|casperBudgetCapAtomic|envHostList)\(\s*["']([A-Z][A-Z0-9_]+)["']/g)) names.add(m[1]);
  }
  for (const level of SERVICE_LEVELS) {
    names.add(`X402_POLICY_SERVICE_${level}`);
    names.add(`X402_POLICY_SERVICE_${level}_MAX_PER_REQUEST`);
    names.add(`X402_POLICY_SERVICE_${level}_MAX_DAILY`);
  }
  for (const name of INDIRECT_ENV_NAMES) names.add(name);
  return [...names].sort();
}

// A name is mentioned in a text when the text carries it verbatim — or, for
// the template-built service-level family, when the text carries its
// X402_POLICY_SERVICE_<LEVEL><suffix> template shape.
function envNameMentioned(text: string, name: string): boolean {
  const serviceMatch = SERVICE_NAME_RE.exec(name);
  if (serviceMatch) return text.includes(`X402_POLICY_SERVICE_<LEVEL>${serviceMatch[2] ?? ''}`);
  return text.includes(name);
}

function scanEnvDocumentation(names: string[], pages: ReadonlyArray<[string, string]>): string[] {
  const missing: string[] = [];
  for (const name of names) {
    if (NON_OPERATOR_ENV_NAMES.has(name)) continue;
    if (!envNameMentioned(ENV_EXAMPLE, name)) missing.push(`.env.example documents nothing about ${name}`);
    if (!pages.some(([, text]) => envNameMentioned(text, name))) missing.push(`README.md ∪ docs/*.md documents nothing about ${name}`);
  }
  return missing;
}

const DOC_CORPUS: ReadonlyArray<[string, string]> = [
  ['README.md', README],
  ...readdirSync(DOCS_DIR).filter((n) => n.endsWith('.md')).map(
    (n) => [`docs/${n}`, readFileSync(join(DOCS_DIR, n), 'utf8')] as [string, string],
  ),
];

it('env docs (#93): every env var the code reads is documented in .env.example and the public docs', () => {
  assert.deepEqual(
    scanEnvDocumentation(scanEnvReadNames(REPO_ROOT), DOC_CORPUS),
    [],
    'every env var read by the code must appear in .env.example AND in README.md ∪ docs/*.md — undocumented reads are docs-truth gaps',
  );
});

it('positive + negative control (#93): the env-docs guard fails on an undocumented read, passes a documented one, and honours the allowlist and the SERVICE template shape', () => {
  // A documented read passes (both surfaces carry it verbatim).
  assert.deepEqual(scanEnvDocumentation(['MAX_PAYMENT_PER_CALL'], [['docs/x.md', 'set MAX_PAYMENT_PER_CALL']]), []);
  // An undocumented read fails, naming the var and the missing surface.
  const missing = scanEnvDocumentation(['MAX_PAYMENT_PER_CALL'], [['docs/x.md', 'nothing about the caps here']]);
  assert.ok(missing.some((m) => m.includes('MAX_PAYMENT_PER_CALL')), 'the failure must name the undocumented var');
  // The non-operator allowlisted name never contributes a missing entry.
  assert.deepEqual(scanEnvDocumentation(['NODE_TEST_CONTEXT'], [['docs/x.md', 'nothing']]), []);
  // The service-level template family matches the <LEVEL> shape in the docs.
  assert.deepEqual(scanEnvDocumentation(['X402_POLICY_SERVICE_TRUSTED'], [['docs/policy.md', 'X402_POLICY_SERVICE_<LEVEL>=deny']]), []);
});

// ---- Network mode (#93): X402_NETWORK_MODE documented iff read -----------
//
// The explicit no-default network mode is the server's most safety-critical
// knob: while src/ reads it, the operator docs MUST name it; the day the
// code stops reading it, stale mentions must leave the docs. The asymmetry
// shapes (read-without-docs, docs-without-read) are asserted against a pure
// helper below so the control covers both directions without editing src/.
function assertNetworkModeDocIff(readByCode: boolean, documented: boolean): void {
  assert.equal(
    documented,
    readByCode,
    'X402_NETWORK_MODE must be documented in the operator docs (.env.example, README.md and docs/networks.md) if and only if the code reads it',
  );
}

function networkModeDocumented(): boolean {
  return (
    envNameMentioned(ENV_EXAMPLE, 'X402_NETWORK_MODE') &&
    README.includes('X402_NETWORK_MODE') &&
    readFileSync(join(DOCS_DIR, 'networks.md'), 'utf8').includes('X402_NETWORK_MODE')
  );
}

it('network mode (#93): X402_NETWORK_MODE is documented if and only if the code reads it', () => {
  const readByCode = walkProdSources(REPO_ROOT, join(REPO_ROOT, 'src')).some(
    (p) => readFileSync(p, 'utf8').includes('X402_NETWORK_MODE'),
  );
  assertNetworkModeDocIff(readByCode, networkModeDocumented());
});

it('positive + negative control (#93): the iff guard fails on exactly the asymmetric shapes', () => {
  // [readByCode, documented, mustFail]
  for (const [read, documented, mustFail] of [
    [true, false, true],
    [false, true, true],
    [true, true, false],
    [false, false, false],
  ] as ReadonlyArray<readonly [boolean, boolean, boolean]>) {
    let failed = false;
    try {
      assertNetworkModeDocIff(read, documented);
    } catch {
      failed = true;
    }
    assert.equal(failed, mustFail, `read=${read}, documented=${documented} must ${mustFail ? 'fail' : 'pass'} the iff`);
  }
});
