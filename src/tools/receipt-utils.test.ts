import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { extractSettlementReceipt } from './receipt-utils.js';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

// Case-insensitive lookup, mirroring real HTTP header semantics.
const getterOf = (entries: Record<string, string>) => (name: string) => entries[name.toLowerCase()] ?? null;

it('v2 receipt in PAYMENT-RESPONSE header (Headers) -> receipt non-null, txHash from "transaction"', () => {
  const raw = b64({ success: true, transaction: '0xabc', network: 'eip155:8453' });
  const result = extractSettlementReceipt(new Headers({ 'payment-response': raw }));
  assert.equal(result.receipt, raw);
  assert.equal(result.txHash, '0xabc');
});

it('legacy receipt in X-PAYMENT-RESPONSE header (getter) -> txHash from "transactionHash"', () => {
  const raw = b64({ success: true, transactionHash: '0xdef' });
  const result = extractSettlementReceipt(getterOf({ 'x-payment-response': raw }));
  assert.equal(result.receipt, raw);
  assert.equal(result.txHash, '0xdef');
});

it('malformed base64 / non-JSON receipt -> receipt preserved, txHash undefined, never throws', () => {
  const garbage = extractSettlementReceipt(new Headers({ 'payment-response': '!!!not-base64-json!!!' }));
  assert.equal(garbage.receipt, '!!!not-base64-json!!!');
  assert.equal(garbage.txHash, undefined);

  const notJson = extractSettlementReceipt(new Headers({ 'payment-response': Buffer.from('hello world').toString('base64') }));
  assert.equal(notJson.txHash, undefined);
  assert.ok(notJson.receipt !== null);
});

it('success:false receipt -> receipt string returned, txHash undefined', () => {
  const raw = b64({ success: false, error: 'settlement failed' });
  const result = extractSettlementReceipt(new Headers({ 'payment-response': raw }));
  assert.equal(result.receipt, raw);
  assert.equal(result.txHash, undefined);
});

it('no receipt headers at all -> receipt null, txHash undefined', () => {
  assert.deepEqual(extractSettlementReceipt(new Headers()), { receipt: null, txHash: undefined });
  assert.deepEqual(extractSettlementReceipt(() => null), { receipt: null, txHash: undefined });
});

it('PAYMENT-RESPONSE takes precedence when both spellings are present', () => {
  const v2 = b64({ success: true, transaction: '0xv2' });
  const legacy = b64({ success: true, transactionHash: '0xlegacy' });
  const result = extractSettlementReceipt(getterOf({ 'payment-response': v2, 'x-payment-response': legacy }));
  assert.equal(result.receipt, v2);
  assert.equal(result.txHash, '0xv2');
});

it('legacy nested settlement.txHash fallback still works', () => {
  const raw = b64({ success: true, settlement: { txHash: '0x999' } });
  const result = extractSettlementReceipt(new Headers({ 'x-payment-response': raw }));
  assert.equal(result.txHash, '0x999');
});

it('success:true with missing/empty/non-string transaction -> txHash undefined', () => {
  for (const payload of [
    { success: true },
    { success: true, transaction: '' },
    { success: true, transaction: 123 },
  ]) {
    const result = extractSettlementReceipt(new Headers({ 'payment-response': b64(payload) }));
    assert.equal(result.txHash, undefined, JSON.stringify(payload));
    assert.ok(result.receipt !== null);
  }
});
