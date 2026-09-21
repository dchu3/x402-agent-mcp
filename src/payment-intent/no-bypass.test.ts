import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';

// Issue #25 property 6 — structural no-bypass guard.
//
// The payment-intent boundary only holds if every payment primitive flows
// through the sanctioned path. This test reads the SOURCE tree (dist-test
// mirrors src/, so ../../src from this file) and asserts:
//
//   1. `wrapFetchWithPayment(` and `new x402Client(` appear only in the
//      allowlisted non-test files below — the places that legitimately build
//      paying clients today.
//   2. Every file containing a `wrapFetchWithPayment(` call site also
//      references the intent enforcement (`executeGuarded` / the
//      `intentEnforcement` hook), i.e. every paid fetch is guarded.
//
// A new payment path added anywhere else fails this test — that is the point.

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

/** Files allowed to contain the payment primitives (none may be extended
 * without touching this test). casper/budget.ts stays outside on purpose: it
 * hooks a client it is GIVEN, it never constructs payment transport. */
const ALLOWLIST = [
  'payment-intent/executor.ts',
  'tools/fetch.ts',
  'tools/casper-fetch.ts',
  'casper/client.ts',
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const SENSITIVE = [/wrapFetchWithPayment\(/, /new x402Client\(/];

it('payment primitives appear only in the allowlisted files', () => {
  const violations: string[] = [];
  const hits: Array<{ rel: string; content: string }> = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const rel = file.slice(SRC_ROOT.length + 1).split(sep).join('/');
    const content = readFileSync(file, 'utf8');
    if (SENSITIVE.some((pattern) => pattern.test(content))) {
      hits.push({ rel, content });
      if (!ALLOWLIST.includes(rel)) violations.push(rel);
    }
  }
  assert.deepEqual(violations, [], `payment primitive used outside the allowlist: ${violations.join(', ')}`);
  assert.ok(hits.length > 0, 'sanity: the known call sites must be found by the scan');
});

it('every wrapFetchWithPayment call site is inside intent-enforced code', () => {
  const unguarded: string[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const rel = file.slice(SRC_ROOT.length + 1).split(sep).join('/');
    const content = readFileSync(file, 'utf8');
    if (!/wrapFetchWithPayment\(/.test(content)) continue;
    if (!/executeGuarded|intentEnforcement/.test(content)) unguarded.push(rel);
  }
  assert.deepEqual(unguarded, [], `unguarded paid-fetch call sites: ${unguarded.join(', ')}`);
});

it('the sanctioned call sites are wired exactly where expected', () => {
  const fetchSrc = readFileSync(join(SRC_ROOT, 'tools', 'fetch.ts'), 'utf8');
  const casperSrc = readFileSync(join(SRC_ROOT, 'tools', 'casper-fetch.ts'), 'utf8');
  assert.ok(fetchSrc.includes('executeGuarded('), 'x402_fetch must run the paid fetch through executeGuarded');
  assert.ok(casperSrc.includes('intentEnforcement('), 'the Casper leg must register the intent enforcement hook');
  // The enforcement hook must be registered BEFORE guardCasperPayments so
  // intent validation precedes budget reserve().
  assert.ok(
    casperSrc.indexOf('intentEnforcement(') < casperSrc.indexOf('guardCasperPayments('),
    'intent enforcement precedes the Casper budget guard',
  );
  // The payment layer itself was not modified: no intent code in policy/casper internals.
  for (const forbidden of ['casper/budget.ts', 'casper/accepts.ts', 'casper/client.ts', 'payment-utils.ts']) {
    const content = readFileSync(join(SRC_ROOT, ...forbidden.split('/')), 'utf8');
    assert.ok(!content.includes('payment-intent'), `${forbidden} must stay independent of the intent layer`);
  }
});
