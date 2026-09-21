import { strict as assert } from 'node:assert';
import { beforeEach, it } from 'node:test';
import { createHash } from 'node:crypto';
import type { PolicyResult } from '../policy/types.js';
import {
  createFromOffer,
  validate,
  beginAttempt,
  consume,
  matchesRequirements,
  _resetRegistryForTests,
  INTENT_DEFAULT_TTL_MS,
} from './manager.js';
import type { PaymentIntent } from './types.js';

const ALLOW: PolicyResult = {
  decision: 'ALLOW',
  reasons: [],
  limits: { trustLevel: 'UNKNOWN', maxPerRequest: 0.5, maxDaily: 10 },
};
const DENY: PolicyResult = { ...ALLOW, decision: 'DENY' };
const APPROVAL: PolicyResult = { ...ALLOW, decision: 'APPROVAL_REQUIRED' };

const NOW = 1_760_000_000_000; // fixed clock for deterministic expiry tests

/** A bindable base-chain offer (fake identifiers — an asset id is not a secret). */
function offer(overrides: Record<string, unknown> = {}) {
  return {
    decision: ALLOW,
    url: 'https://pay.example.com/api',
    chain: 'base',
    token: 'USDC',
    asset: 'FakeBaseUsdcAsset',
    amountAtomic: '10000',
    decimals: 6,
    recipient: 'FakeRecipientAccount',
    network: 'eip155:8453',
    scheme: 'exact',
    amountUsdEstimate: 0.01,
    ttlMs: 5000,
    now: NOW,
    ...overrides,
  } as Parameters<typeof createFromOffer>[0];
}

function created(args = offer()): PaymentIntent {
  const res = createFromOffer(args);
  if (res.ok === false) assert.fail(`creation must succeed: ${res.message}`);
  return res.intent;
}

beforeEach(() => { _resetRegistryForTests(); });

it('ALLOW creates a valid executable intent bound to the evaluated params', () => {
  const intent = created();
  assert.match(intent.id, /^[0-9a-f-]{36}$/, 'id is a randomUUID');
  assert.equal(intent.serviceId, 'pay.example.com', 'serviceId = lowercased hostname (policy service key)');
  assert.equal(intent.serviceUrl, 'https://pay.example.com/api');
  assert.equal(intent.chain, 'base');
  assert.equal(intent.network, 'eip155:8453');
  assert.equal(intent.token, 'USDC');
  assert.equal(intent.asset, 'FakeBaseUsdcAsset');
  assert.equal(intent.amountAtomic, '10000');
  assert.equal(intent.decimals, 6);
  assert.equal(intent.amountUsdEstimate, 0.01, 'USD estimate is informational only, never the binding');
  assert.equal(intent.recipient, 'FakeRecipientAccount');
  assert.equal(intent.scheme, 'exact');
  assert.equal(intent.policyDecision, 'ALLOW');
  assert.match(intent.paramsHash, /^[0-9a-f]{64}$/);
  assert.match(intent.policyDecisionId, /^[0-9a-f]{64}$/);
  assert.equal(intent.createdAt, new Date(NOW).toISOString());
  assert.equal(intent.expiresAt, new Date(NOW + 5000).toISOString());
  assert.deepEqual(validate(intent, NOW), { valid: true });
});

it('DENY produces no executable intent (NOT_AUTHORISED)', () => {
  const res = createFromOffer(offer({ decision: DENY }));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.code === 'NOT_AUTHORISED');
  assert.ok(!res.ok && typeof res.message === 'string' && res.message.length > 0);
});

it('APPROVAL_REQUIRED produces no executable intent (NOT_AUTHORISED)', () => {
  const res = createFromOffer(offer({ decision: APPROVAL }));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.code === 'NOT_AUTHORISED');
});

// ---------------------------------------------------------------------------
// Tampering matrix — one `it` per binding field, per the issue.
// ---------------------------------------------------------------------------
const BINDING_FIELDS = [
  'amountAtomic', 'recipient', 'token', 'asset', 'chain', 'network', 'serviceId', 'serviceUrl', 'scheme',
] as const;
for (const field of BINDING_FIELDS) {
  it(`tampering ${field} after issuance ⇒ PARAM_MISMATCH`, () => {
    const intent = created();
    (intent as any)[field] = field === 'amountAtomic' ? '99999' : `tampered-${field}`;
    const v = validate(intent, NOW);
    assert.equal(v.valid, false, `tampered ${field} must not validate`);
    assert.ok(!v.valid && v.code === 'PARAM_MISMATCH');
  });
}

it('tampering decision/identity metadata after issuance ⇒ PARAM_MISMATCH', () => {
  const intent = created();
  (intent as any).policyDecision = 'ALLOW-to-DENY-swap';
  const v = validate(intent, NOW);
  assert.equal(v.valid, false);
  assert.ok(!v.valid && v.code === 'PARAM_MISMATCH');
});

it('expired intent ⇒ EXPIRED (injected clock)', () => {
  const intent = created(offer({ ttlMs: 5000 }));
  assert.deepEqual(validate(intent, NOW + 5000), { valid: true }, 'exactly at TTL boundary still valid');
  const v = validate(intent, NOW + 7000);
  assert.equal(v.valid, false);
  assert.ok(!v.valid && v.code === 'EXPIRED');
});

it('replay: second beginAttempt / consume / late validate are rejected ALREADY_USED', () => {
  const intent = created();
  assert.deepEqual(beginAttempt(intent, NOW), { valid: true });
  const second = beginAttempt(intent, NOW);
  assert.equal(second.valid, false);
  assert.ok(!second.valid && second.code === 'ALREADY_USED', 'a second execution of the same intent is refused');
  assert.deepEqual(consume(intent), { valid: true });
  const third = consume(intent);
  assert.equal(third.valid, false);
  assert.ok(!third.valid && third.code === 'ALREADY_USED');
  const v = validate(intent, NOW);
  assert.equal(v.valid, false);
  assert.ok(!v.valid && v.code === 'ALREADY_USED', 'consumed intents never validate again');
});

it('hook-driven consume from issued state succeeds once (Casper path has no beginAttempt)', () => {
  const intent = created();
  assert.deepEqual(consume(intent), { valid: true });
  const again = consume(intent);
  assert.equal(again.valid, false);
  assert.ok(!again.valid && again.code === 'ALREADY_USED');
});

it('malformed / unbindable offers fail closed at creation — never guess, never default a price', () => {
  for (const amountAtomic of [undefined, '', '0', '000', '-5', '1.5', 'abc', '1e6', ' 10000 ']) {
    const res = createFromOffer(offer({ amountAtomic }));
    assert.equal(res.ok, false, `amountAtomic=${String(amountAtomic)} must not create`);
    assert.ok(!res.ok && res.code === 'AMOUNT_UNBINDABLE');
  }
  for (const overrides of [
    { recipient: '' }, { recipient: undefined }, { network: '' }, { network: undefined },
    { url: '::not a url' }, { url: '' },
  ]) {
    const res = createFromOffer(offer(overrides));
    assert.equal(res.ok, false, `${JSON.stringify(overrides)} must not create`);
    assert.ok(!res.ok && res.code === 'MALFORMED');
  }
});

it('asset is bound as the offer declared it: absent asset is NOT fatal at creation (fatal at signing)', () => {
  const res = createFromOffer(offer({ asset: undefined }));
  assert.ok(res.ok, 'a v1-shaped offer without asset still mints an intent (it can never match a v2 requirement)');
  assert.equal(res.intent.asset, '');
  // …and such an intent can never pay: a real SDK-selected requirement has a
  // non-empty asset, so the comparator aborts on the asset field.
  const m = matchesRequirements(res.intent, { scheme: 'exact', network: 'eip155:8453', asset: 'AnyRealAsset', amount: '10000', payTo: 'FakeRecipientAccount' });
  assert.equal(m.match, false);
  assert.ok(!m.match && m.field === 'asset');
});

it('deterministic hashing: same offer ⇒ same paramsHash; different offer ⇒ different hash', () => {
  const a = created();
  const b = created();
  assert.equal(a.paramsHash, b.paramsHash, 'paramsHash is a pure function of the binding fields');
  assert.notEqual(a.id, b.id, 'identity is unique per issuance');
  assert.equal(a.policyDecisionId, b.policyDecisionId, 'decision reference derives from decision + paramsHash');
  const manual = createHash('sha256').update(`ALLOW:${a.paramsHash}`).digest('hex');
  assert.equal(a.policyDecisionId, manual, 'policyDecisionId = sha256(decision + ":" + paramsHash)');
  const c = created(offer({ amountAtomic: '10001' }));
  assert.notEqual(a.paramsHash, c.paramsHash, 'any binding-field change changes the hash');
});

it('unknown and malformed intents fail closed at validate (never throws)', () => {
  // Shape-valid but never issued (foreign id).
  const intent = created();
  const foreign = { ...intent, id: '00000000-0000-0000-0000-000000000000' };
  const v = validate(foreign, NOW);
  assert.equal(v.valid, false);
  assert.ok(!v.valid && v.code === 'UNKNOWN_INTENT');
  // Garbage shapes.
  for (const garbage of [null, undefined, 'x', 42, {}, { id: 5 }, []]) {
    const r = validate(garbage as any, NOW);
    assert.equal(r.valid, false);
    assert.ok(!r.valid && r.code === 'MALFORMED');
  }
  assert.doesNotThrow(() => validate({} as any));
});

it('X402_INTENT_TTL_MS overrides the default TTL; invalid values fall back to the default', () => {
  const saved = process.env.X402_INTENT_TTL_MS;
  try {
    process.env.X402_INTENT_TTL_MS = '1234';
    let res = createFromOffer(offer({ ttlMs: undefined }));
    assert.ok(res.ok);
    assert.equal(Date.parse(res.intent.expiresAt) - Date.parse(res.intent.createdAt), 1234);
    process.env.X402_INTENT_TTL_MS = 'nope';
    res = createFromOffer(offer({ ttlMs: undefined }));
    assert.ok(res.ok);
    assert.equal(Date.parse(res.intent.expiresAt) - Date.parse(res.intent.createdAt), INTENT_DEFAULT_TTL_MS);
    process.env.X402_INTENT_TTL_MS = '0';
    res = createFromOffer(offer({ ttlMs: undefined }));
    assert.ok(res.ok);
    assert.equal(Date.parse(res.intent.expiresAt) - Date.parse(res.intent.createdAt), INTENT_DEFAULT_TTL_MS, 'non-positive TTL is ignored');
  } finally {
    if (saved === undefined) delete process.env.X402_INTENT_TTL_MS;
    else process.env.X402_INTENT_TTL_MS = saved;
  }
});

it('createFromOffer never throws, even on pathological input (fail closed)', () => {
  for (const args of [{}, { decision: null }, { decision: { decision: 'ALLOW' } }]) {
    let res: ReturnType<typeof createFromOffer> | undefined;
    assert.doesNotThrow(() => { res = createFromOffer(args as any); });
    assert.ok(res, 'returns a result object');
    assert.equal(res.ok, false);
  }
});

// ---------------------------------------------------------------------------
// matchesRequirements — the hook comparator. Exact equality on the five
// security-critical fields; Casper networks compared via toCasperCaip2.
// ---------------------------------------------------------------------------

function req(overrides: Record<string, unknown> = {}) {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: 'FakeBaseUsdcAsset',
    amount: '10000',
    payTo: 'FakeRecipientAccount',
    ...overrides,
  };
}

it('comparator: exact match passes; any single-field difference aborts with that field name', () => {
  const intent = created();
  assert.deepEqual(matchesRequirements(intent, req()), { match: true });
  const cases: Array<[Record<string, unknown>, string]> = [
    [req({ amount: '10001' }), 'amount'],
    [req({ amount: '010000' }), 'amount'], // atomic strings compare exactly, no numeric repair
    [req({ payTo: 'AttackerControlled' }), 'payTo'],
    [req({ asset: 'DifferentAsset' }), 'asset'],
    [req({ scheme: 'upto' }), 'scheme'],
    [req({ network: 'eip155:1' }), 'network'],
    [req({ asset: '' }), 'asset'], // requirement with empty asset ⇒ abort (never match '')
    [req({ asset: undefined }), 'asset'], // missing requirement field ⇒ abort
    [req({ payTo: undefined }), 'payTo'],
  ];
  for (const [r, field] of cases) {
    const m = matchesRequirements(intent, r);
    assert.equal(m.match, false, `${JSON.stringify(r)} must not match`);
    assert.ok(!m.match && m.field === field, `expected mismatch field ${field}`);
  }
});

it('comparator: Casper networks normalise via toCasperCaip2; everything else stays exact', () => {
  const intent = created(offer({
    chain: 'casper', token: 'wCSPR', asset: 'FakeWcsprPackage', amountAtomic: '1000000000',
    decimals: 9, recipient: 'FakeCasperAccountHash', network: 'casper:casper',
  }));
  assert.deepEqual(
    matchesRequirements(intent, req({ network: 'casper', asset: 'FakeWcsprPackage', amount: '1000000000', payTo: 'FakeCasperAccountHash' })),
    { match: true },
    'bare facilitator spellings normalise to the CAIP-2 id',
  );
  const m = matchesRequirements(intent, req({ network: 'casper:casper-test', asset: 'FakeWcsprPackage', amount: '1000000000', payTo: 'FakeCasperAccountHash' }));
  assert.equal(m.match, false);
  assert.ok(!m.match && m.field === 'network');
});
