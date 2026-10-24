import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Issue #53 req 5 — structural guard (in the spirit of the no-bypass.test.ts
// source scan): spend accounting keeps deriving from the SIGNED payment.
// The behavioural tests in fetch-accounting.test.ts lock the values; this
// guard locks the MECHANISM so a future edit cannot quietly reintroduce a
// body-derived amount at any accounting call site:
//
//   (a) the ledger writers (logPayment / recordServicePayment /
//       recordSettledAmount) receive the signed-amount variable;
//   (b) no body-derived identifier (the parsed seller body, the extracted
//       seller_reported_cost, meta.cost accessors) appears in an accounting
//       call's arguments, in the row's amount/cost fields, or in a
//       paid/status expression — the seller body may enter ONLY the
//       deliberate #45 error-echo on failed rows and the informational
//       body echo in the tool output;
//   (c) the retired body-derived cost variable (actualCost) no longer
//       exists anywhere in the flow;
//   (d) positive control: the SAME scanner, run over a fixture that does
//       route a body value into the ledger, MUST report a violation — the
//       guard is demonstrably able to fail.
// ---------------------------------------------------------------------------

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));
const FETCH_SRC = join(SRC_ROOT, 'tools', 'fetch.ts');

/** The ledger-writing call sites the signed amount must flow into. */
const LEDGER_WRITERS = ['logPayment', 'recordServicePayment', 'recordSettledAmount'] as const;

/** Identifiers that must never enter an accounting value: the parsed seller
 * body, the informational seller report, direct meta.cost accessors, and the
 * retired body-derived cost variable. */
const BODY_DERIVED = /bodyResult|sellerReported|seller_reported|meta\s*\.\s*cost|actualCost|\bparsed\b\s*\.\s*\bcost\b/;

/** Extract every call-site argument span for `fnName` by balancing parens
 * from the opening `(` (crude: no string literals inside these spans carry
 * unbalanced parens — the accounting arguments are plain expressions). */
function callArgSlices(src: string, fnName: string): string[] {
  const out: string[] = [];
  let idx = src.indexOf(`${fnName}(`);
  while (idx !== -1) {
    let depth = 0;
    for (let i = idx + fnName.length; i < src.length; i++) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          out.push(src.slice(idx + fnName.length + 1, i));
          break;
        }
      }
    }
    idx = src.indexOf(`${fnName}(`, idx + 1);
  }
  return out;
}

/** The scan: violations of the (a)/(b) rules for one source text, reported as
 * strings. Pure — no sanity asserts — so it is reusable over fixtures (the
 * positive control below). */
function accountingViolations(src: string): string[] {
  const violations: string[] = [];
  for (const fn of LEDGER_WRITERS) {
    for (const slice of callArgSlices(src, fn)) {
      if (BODY_DERIVED.test(slice)) {
        violations.push(`${fn} argument span carries a body-derived value: ${slice.slice(0, 120)}`);
      }
      // (a): every ledger-writing span must reference one of the signed-
      // amount variables (the recorded amount or the signed candidate), or
      // the literal 0 used by the failure/catch rows.
      const SIGNED_SOURCES = /recordedAmountUsdc|signedRecordedUsdc|signedAmountUsdc|\b0\b/;
      if (!SIGNED_SOURCES.test(slice)) {
        violations.push(`${fn} argument span does not reference a signed-amount value: ${slice.slice(0, 120)}`);
      }
    }
  }
  // (b) continues: the row fields that move spend (amount_usdc / cost_usdc)
  // and the paid/status decision expressions must not carry a body value.
  for (const line of src.split('\n')) {
    if (/(amount_usdc|cost_usdc|paid:|status:)/.test(line) && BODY_DERIVED.test(line) && !line.trim().startsWith('//')) {
      violations.push(`row/decision field on a body-derived value: ${line.trim().slice(0, 120)}`);
    }
  }
  return violations;
}

it('accounting guard: fetch.ts records only signed amounts — never seller-body values', () => {
  const src = readFileSync(FETCH_SRC, 'utf8');
  for (const fn of LEDGER_WRITERS) {
    const found = callArgSlices(src, fn);
    assert.ok(found.length > 0, `sanity: fetch.ts must still contain ${fn} call sites`);
  }
  const violations = accountingViolations(src);
  assert.deepEqual(violations, [], `issue #53 guard violations:\n  ${violations.join('\n  ')}`);
});

it('accounting guard: the retired body-derived cost variable no longer exists', () => {
  const src = readFileSync(FETCH_SRC, 'utf8');
  assert.ok(!src.includes('actualCost'), 'the pre-#53 body-derived actualCost must be gone from fetch.ts');
});

it('accounting guard: the scan demonstrably fails on a violating fixture (positive control)', () => {
  // A violating flow: the ledger amount routes from the seller's own body.
  const violatingFixture = `
      const sellerBody = await resp.text();
      const parsedBody = JSON.parse(sellerBody);
      const recordedAmountUsdc = parsedBody.meta.cost.usd;
      recordServicePayment(url, parsedBody.meta.cost.usd);
      logPayment({
        url,
        amount_usdc: parsedBody.meta.cost.usd,
        status: resp.status === 200 ? "success" : "failed",
        paid: parsedBody.meta.cost.usd > 0,
      });
  `;
  const violations = accountingViolations(violatingFixture);
  assert.ok(violations.length > 0, 'the scanner must flag a body-derived ledger amount');
  for (const v of violations) {
    assert.match(v, /body-derived value|does not reference/, `violation must name the rule: ${v}`);
  }
  // And a control fixture that mirrors the sanctioned flow must scan clean.
  const cleanFixture = `
      recordServicePayment(url, recordedAmountUsdc);
      recordSettledAmount(url, recordedAmountUsdc);
      logPayment({ url, amount_usdc: recordedAmountUsdc, status: isSuccessfulPayment ? "success" : "failed" });
  `;
  assert.deepEqual(accountingViolations(cleanFixture), [], 'the sanctioned-shape fixture must scan clean');
});

it('accounting guard: the informational seller report never reaches an accounting call (its only uses are output keys)', () => {
  const src = readFileSync(FETCH_SRC, 'utf8');
  // seller_reported_cost may appear ONLY as the informational output key —
  // every OTHER occurrence of the identifier must be inside the same
  // statements, never an argument to the ledger writers (covered above) and
  // never inside a cap/limits call.
  for (const slice of callArgSlices(src, 'checkSpendingLimit')) {
    assert.ok(!BODY_DERIVED.test(slice), 'the cap check is not fed the seller report');
  }
  // The informational key itself must exist in the output shape (and only
  // there — the ledger-writer scan above already barred it from the writers):
  assert.ok(/seller_reported_cost\s*:/.test(src), 'the informational output key remains present');
});