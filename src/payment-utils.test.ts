import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { isCountedSpend } from './payment-utils.js';

// ---------------------------------------------------------------------------
// Issue #54 (Option A) — ONE counted-spend predicate, shared by every
// accounting consumer (ledger rehydration, the in-process add in logPayment,
// and policy/budget-store.ts rehydration). The four ledger statuses:
//
//   success              200 — counts (as today);
//   settled_unserved     non-200 WITH a decodable success receipt carrying a
//                        tx hash — counts permanently;
//   authorized_unserved  a signed payload was sent WITHOUT settlement
//                        evidence — the outcome is UNKNOWN, so the row
//                        counts for the whole UTC day it was written (rows
//                        carry no expires_at; the counter rolls over at the
//                        UTC day boundary). A LEGACY row that still carries
//                        a past expires_at keeps its old release semantics.
//   failed               nothing signed/sent, or a clear pre-settlement
//                        refusal — never counts.
//
// Fail-closed direction: an authorized_unserved row with NO (or an
// unparseable) expires_at COUNTS — over-counting is the safe direction; a
// missing expiry must never silently un-count a signed-and-sent payment.
// ---------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse('2026-10-25T12:00:00.000Z');

it('isCountedSpend: a success row counts (the pre-#54 rule, unchanged)', () => {
  assert.equal(isCountedSpend({ status: 'success' }, NOW), true);
  assert.equal(isCountedSpend({ status: 'success' }, NOW + 86_400_000 * 365), true, 'success never expires');
});

it('isCountedSpend: a settled_unserved row counts forever (settlement evidence settled it)', () => {
  assert.equal(isCountedSpend({ status: 'settled_unserved' }, NOW), true);
  assert.equal(isCountedSpend({ status: 'settled_unserved' }, NOW + 86_400_000 * 365), true, 'no expiry exists for settled spend');
});

it('isCountedSpend: an authorized_unserved row with a legacy expires_at counts until it, then releases', () => {
  const row = { status: 'authorized_unserved', expires_at: iso(NOW + 60_000) };
  assert.equal(isCountedSpend(row, NOW), true, 'a legacy expiry row counts while its expiry is in the future');
  assert.equal(isCountedSpend(row, NOW + 59_999), true, 'counted up to (not including) the expiry instant');
  assert.equal(isCountedSpend(row, NOW + 60_000), false, 'released AT the expiry instant');
  assert.equal(isCountedSpend(row, NOW + 61_000), false, 'a legacy row with a past expiry still releases');
});

it('isCountedSpend: an authorized_unserved row with no expires_at counts at send time, +150 s and +20 h alike (fail closed to the UTC day rollover)', () => {
  const row = { status: 'authorized_unserved' };
  assert.equal(isCountedSpend(row, NOW), true, 'counts at the send instant');
  assert.equal(isCountedSpend(row, NOW + 150_000), true, 'no ~150 s release exists any more — the outcome is still unknown');
  assert.equal(isCountedSpend(row, NOW + 20 * 3_600_000), true, 'still counting twenty hours on — nothing under the UTC day rollover un-counts');
  assert.equal(isCountedSpend(row, NOW + 86_400_000 * 365), true, 'the predicate has no expiry for a no-expiry row (the day rollover is the counter’s own reset)');
});

it('isCountedSpend: an authorized_unserved row with an unparseable expires_at counts (same fail-closed direction)', () => {
  assert.equal(isCountedSpend({ status: 'authorized_unserved', expires_at: 'not-a-date' }, NOW), true);
});

it('isCountedSpend: a failed row never counts (nothing signed/sent, or a clear refusal)', () => {
  assert.equal(isCountedSpend({ status: 'failed' }, NOW), false);
  assert.equal(isCountedSpend({ status: 'failed', expires_at: iso(NOW + 60_000) }, NOW), false, 'an expiry field never makes a failed row spend');
});

it('isCountedSpend: unknown/legacy status strings never count', () => {
  assert.equal(isCountedSpend({ status: 'unknown-status' }, NOW), false);
  assert.equal(isCountedSpend({}, NOW), false, 'a row with no status counts nothing');
  assert.equal(isCountedSpend({ status: undefined }, NOW), false);
});
