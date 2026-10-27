import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// The outgoing-payment signal: the wrapper around the paid transport reads
// EVERY request the SDK sends and reports (a) whether the outgoing request
// carried a payment header — the exact "the paid request left the client"
// signal the pre-send classification keys on (case-insensitive header names:
// the v2 PAYMENT-SIGNATURE and the legacy X-PAYMENT) — and (b) the on-chain
// signature of the sent payment when the payload envelope carries it, so the
// ledger row can later be reconciled against the chain:
//   - an EVM exact payload's `signature` (a 0x-prefixed hex string) passes
//     through verbatim;
//   - a Solana exact payload's `transaction` (the base64 wire transaction)
//     decodes to bytes whose FIRST 64 are the ed25519 signature — reported
//     base58-encoded, the chain's canonical signature spelling;
//   - an unparseable envelope still reports sent: true (the header was
//     there — counting must never depend on parse success) with no signature.
//
// The module import is deliberately dynamic-by-variable so this file still
// compiles and runs while the module does not exist (RED step of the feat
// commit that lands it).
// ---------------------------------------------------------------------------

const SENT_PAYMENT_PATH = './sent-payment.js';
const sentPaymentRaw = await import(SENT_PAYMENT_PATH).catch(() => undefined) as any;
function requireSentPayment(): any {
  assert.ok(
    sentPaymentRaw && typeof sentPaymentRaw.sentPaymentOf === 'function',
    'src/transport/sent-payment.ts must exist and export sentPaymentOf (the outgoing-payment signal)',
  );
  return sentPaymentRaw;
}

function paymentHeaderValue(payloadJson: unknown): string {
  return Buffer.from(JSON.stringify(payloadJson)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const EVM_PAYLOAD = {
  x402Version: 2,
  payload: { authorization: { from: '0xaaa', nonce: '0xbbb' }, signature: '0x' + 'd'.repeat(130) },
};

const SVM_PAYLOAD = (() => {
  const tx = Buffer.alloc(80);
  Buffer.from('SIG'.repeat(24), 'ascii').copy(tx, 0, 0, 64); // 64-byte signature bytes
  return { x402Version: 2, payload: { transaction: tx.toString('base64') } };
})();

it('an outgoing request carrying PAYMENT-SIGNATURE is reported sent, with the EVM payload signature', () => {
  const { sentPaymentOf } = requireSentPayment();
  const info = sentPaymentOf({ input: 'https://seller.invalid/api', init: { headers: { 'payment-signature': paymentHeaderValue(EVM_PAYLOAD) } } } as never, undefined);
  assert.equal(info.sent, true);
  assert.equal(info.signature, '0x' + 'd'.repeat(130), 'the EVM payload signature passes through verbatim');
});

it('a Solana exact payload decodes the base64 wire transaction to its first-64 base58 signature', () => {
  const { sentPaymentOf } = requireSentPayment();
  const header = paymentHeaderValue(SVM_PAYLOAD);
  const info = sentPaymentOf({ input: 'https://seller.invalid/api', init: { headers: { 'payment-signature': header } } } as never, undefined);
  assert.equal(info.sent, true);
  const raw = Buffer.from(String(SVM_PAYLOAD.payload.transaction), 'base64');
  assert.equal(info.signature, bs58.encode(raw.subarray(0, 64)), 'the chain signature is the first 64 bytes, base58');
});

it('an X-PAYMENT header (legacy name) is equally a send signal', () => {
  const { sentPaymentOf } = requireSentPayment();
  const info = sentPaymentOf({ input: 'https://seller.invalid/api', init: { headers: { 'X-Payment': paymentHeaderValue(EVM_PAYLOAD) } } } as never, undefined);
  assert.equal(info.sent, true);
  assert.equal(info.signature, '0x' + 'd'.repeat(130));
});

it('an unparseable payment header still counts as sent (counting never depends on parse success)', () => {
  const { sentPaymentOf } = requireSentPayment();
  for (const bad of ['!!!not-base64!!!', Buffer.from('{"x402Version":2,"payload":{}}').toString('base64'), '']) {
    const info = sentPaymentOf({ input: 'h', init: { headers: { 'payment-signature': bad } } } as never, undefined);
    assert.equal(info.sent, true, `header value ${bad.slice(0, 20)} still marks the send`);
    assert.equal(info.signature, undefined, `header value ${bad.slice(0, 20)} yields no signature`);
  }
});

it('a request without any payment header is not sent (the unpaid probe is not a send)', () => {
  const { sentPaymentOf } = requireSentPayment();
  const none = sentPaymentOf({ input: 'https://seller.invalid/api', init: { headers: { accept: 'application/json' } } } as never, undefined);
  assert.equal(none.sent, false);
  assert.equal(none.signature, undefined);
});

it('a Request instance carrying the header is read like an (input, init) pair', () => {
  const { sentPaymentOf } = requireSentPayment();
  const request = new Request('https://seller.invalid/api', { headers: { 'payment-signature': paymentHeaderValue(EVM_PAYLOAD) } });
  const info = sentPaymentOf(request, undefined);
  assert.equal(info.sent, true);
  assert.equal(info.signature, '0x' + 'd'.repeat(130));
});