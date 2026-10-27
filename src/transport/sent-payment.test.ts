import { strict as assert } from 'node:assert';
import { it } from 'node:test';

// ---------------------------------------------------------------------------
// The outgoing-payment signal: the wrapper around the paid transport reads
// EVERY request the SDK sends and reports whether the outgoing request
// carried a payment header — the exact "the paid request left the client"
// signal the pre-send classification keys on (case-insensitive header names:
// the v2 PAYMENT-SIGNATURE and the legacy X-PAYMENT). The report carries NO
// on-chain signature — at payload time the client cannot know one:
//   - an EVM exact payload's `signature` is the EIP-3009 authorization
//     signature, not the settlement transaction — it stays inside the
//     envelope;
//   - a Solana exact payload's `transaction` is the base64 WIRE
//     transaction: shortvec(signature count), then the 64-byte signature
//     slots (index 0 the fee payer's — the facilitator's, added only at
//     settlement — index 1 the client's), then the message. No bytes in it
//     are the on-chain transaction signature, so the report must carry
//     NONE;
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

// The REAL Solana wire format: shortvec(signature count), then the 64-byte
// signatures, then the compiled message (see @solana/transactions). A
// partially-signed x402 client transaction carries TWO slots: index 0 is the
// FEE PAYER's (the facilitator's signature — it does not exist on the client
// and is only added at settlement; zero here), index 1 is the client's own.
// Byte 0 is therefore the count (0x02), NOT a signature byte.
const SVM_PAYLOAD = (() => {
  const message = Buffer.from('compiled-message-bytes', 'ascii');
  const tx = Buffer.concat([
    Buffer.from([0x02]), // shortvec: two signature slots
    Buffer.alloc(64), // the fee-payer slot — the facilitator's own, unknowable here
    Buffer.from('C'.repeat(64), 'ascii'), // the client's own signature bytes
    message,
  ]);
  return { x402Version: 2, payload: { transaction: tx.toString('base64') } };
})();

it('an outgoing request carrying PAYMENT-SIGNATURE is reported sent', () => {
  const { sentPaymentOf } = requireSentPayment();
  const info = sentPaymentOf('https://seller.invalid/api', { headers: { 'payment-signature': paymentHeaderValue(EVM_PAYLOAD) } } as never);
  assert.deepEqual(info, { sent: true }, 'sent — and nothing else: the envelope yields no signature');
});

it('a Solana payload in the real wire format reports sent WITHOUT a signature — never throws, never invents one', () => {
  const { sentPaymentOf } = requireSentPayment();
  const header = paymentHeaderValue(SVM_PAYLOAD);
  const info = sentPaymentOf('https://seller.invalid/api', { headers: { 'payment-signature': header } } as never);
  assert.equal(info.sent, true, 'the paid request left the client regardless of the payload contents');
  // The on-chain signature of a Solana payment is unknowable at payload time
  // — byte 0 is the shortvec count, the fee-payer slot is the facilitator's
  // own signature added at settlement, and the client's slot is not the tx
  // signature. Any bytes read out of the envelope can never spell a real
  // signature, so the report must carry NONE (settle evidence comes from the
  // response receipt later, never from the payload).
  assert.deepEqual(info, { sent: true }, 'no signature can be derived from the payload envelope');
});

it('an X-PAYMENT header (legacy name) is equally a send signal', () => {
  const { sentPaymentOf } = requireSentPayment();
  const info = sentPaymentOf('https://seller.invalid/api', { headers: { 'X-Payment': paymentHeaderValue(EVM_PAYLOAD) } } as never);
  assert.deepEqual(info, { sent: true });
});

it('an unparseable payment header still counts as sent (counting never depends on parse success)', () => {
  const { sentPaymentOf } = requireSentPayment();
  for (const bad of ['!!!not-base64!!!', Buffer.from('{"x402Version":2,"payload":{}}').toString('base64')]) {
    const info = sentPaymentOf('h', { headers: { 'payment-signature': bad } } as never);
    assert.deepEqual(info, { sent: true }, `header value ${bad.slice(0, 20)} still marks the send`);
  }
});

it('a request without any payment header is not sent (the unpaid probe is not a send)', () => {
  const { sentPaymentOf } = requireSentPayment();
  const none = sentPaymentOf('https://seller.invalid/api', { headers: { accept: 'application/json' } } as never);
  assert.deepEqual(none, { sent: false });
});

it('a Request instance carrying the header is read like an (input, init) pair', () => {
  const { sentPaymentOf } = requireSentPayment();
  const request = new Request('https://seller.invalid/api', { headers: { 'payment-signature': paymentHeaderValue(EVM_PAYLOAD) } });
  const info = sentPaymentOf(request, undefined);
  assert.deepEqual(info, { sent: true });
});