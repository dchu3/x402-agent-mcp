import { strict as assert } from 'node:assert';
import { beforeEach, it } from 'node:test';
import type { PolicyResult } from '../policy/types.js';
import { createFromOffer, intentManager, _resetRegistryForTests } from './manager.js';
import {
  intentEnforcement,
  blockingEnforcement,
  executeGuarded,
  type BeforePaymentCreationHook,
} from './executor.js';
import type { PaymentIntent } from './types.js';

const NOW = 1_760_000_000_000; // fixed clock for registry-level checks only

// Hooks validate with the REAL clock, so intents exercised through hooks are
// minted against Date.now(); only pure before-run refusals inject `now`.

const ALLOW: PolicyResult = {
  decision: 'ALLOW',
  reasons: [],
  limits: { trustLevel: 'UNKNOWN', maxPerRequest: 0.5, maxDaily: 10 },
};
const DENY: PolicyResult = { ...ALLOW, decision: 'DENY' };
const APPROVAL: PolicyResult = { ...ALLOW, decision: 'APPROVAL_REQUIRED' };

function offerArgs(overrides: Record<string, unknown> = {}) {
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
    ttlMs: 60_000,
    now: Date.now(),
    ...overrides,
  } as Parameters<typeof createFromOffer>[0];
}

function makeIntent(overrides: Record<string, unknown> = {}): PaymentIntent {
  const res = createFromOffer(offerArgs(overrides));
  if (res.ok === false) assert.fail(res.message);
  return res.intent;
}

/** Fake x402Client: captures onBeforePaymentCreation hooks the way the real
 * client does; the sdkLikeRun helper then invokes them the way the real
 * createPaymentPayload does (hooks run BEFORE signing; abort throws). */
function fakeClient() {
  const hooks: BeforePaymentCreationHook[] = [];
  return {
    hooks,
    onBeforePaymentCreation(hook: BeforePaymentCreationHook) {
      hooks.push(hook);
      return this;
    },
  };
}
type FakeClient = ReturnType<typeof fakeClient>;

const matchingCtx = {
  paymentRequired: { x402Version: 2, accepts: [] },
  selectedRequirements: {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: 'FakeBaseUsdcAsset',
    amount: '10000',
    payTo: 'FakeRecipientAccount',
    maxTimeoutSeconds: 60,
    extra: {},
  },
};

function ctx(selected: Record<string, unknown>) {
  return { ...matchingCtx, selectedRequirements: { ...matchingCtx.selectedRequirements, ...selected } } as any;
}

/** Mimics @x402/core createPaymentPayload + the fetch wrapper: hooks before
 * signing; an abort throws; only then could a signed payload exist. Returns
 * the paid response. */
function sdkLikeRun(client: FakeClient, context: any, onSign: () => void) {
  return async () => {
    for (const hook of client.hooks) {
      const r = await hook(context);
      if (r && typeof r === 'object' && (r as any).abort) {
        throw new Error(`Payment creation aborted: ${(r as any).reason}`);
      }
    }
    onSign();
    return 'PAID_RESPONSE';
  };
}

beforeEach(() => { _resetRegistryForTests(); });

// ---------------------------------------------------------------------------
// The issue's integration matrix
// ---------------------------------------------------------------------------

it('DENY → run never called: no intent can be minted, and even a forged intent is refused', async () => {
  const res = createFromOffer(offerArgs({ decision: DENY }));
  assert.equal(res.ok, false);
  assert.ok(res.ok === false && res.code === 'NOT_AUTHORISED');
  // Defence in depth: even a hand-constructed "intent" can never execute —
  // the registry is the authority and it was never issued there.
  const forged = { ...makeIntent(), id: 'forged-id-never-issued' };
  let runCalls = 0;
  const outcome = await executeGuarded({
    intent: forged,
    manager: intentManager,
    client: fakeClient(),
    label: 'deny-test',
    run: async () => { runCalls++; return 'x'; },
  });
  assert.equal(runCalls, 0, 'the payment layer must be unreachable');
  assert.equal(outcome.ok, false);
  assert.ok(outcome.ok === false && outcome.code === 'UNKNOWN_INTENT');
});

it('APPROVAL_REQUIRED → run never called: cannot mint an intent', async () => {
  const res = createFromOffer(offerArgs({ decision: APPROVAL }));
  assert.equal(res.ok, false);
  assert.ok(res.ok === false && res.code === 'NOT_AUTHORISED', 'no human-approval channel ⇒ never executable');
  let runCalls = 0;
  const outcome = await executeGuarded({
    intent: { ...makeIntent(), id: 'forged-for-approval' },
    manager: intentManager,
    client: fakeClient(),
    label: 'approval-test',
    run: async () => { runCalls++; return 'x'; },
  });
  assert.equal(runCalls, 0);
  assert.equal(outcome.ok, false);
});

it('intent:null registers a blocking hook — the HTTP request passes through, signing can never happen', async () => {
  // Amendment 1: the boundary is at signing/payload creation, never at the
  // HTTP request. An endpoint that does not actually charge answers the paid
  // leg with a non-402, so the SDK never creates a payload and the hook never
  // runs — the response passes through unchanged.
  const client = fakeClient();
  const free = await executeGuarded({
    intent: null,
    blockedCode: 'AMOUNT_UNBINDABLE',
    manager: intentManager,
    client,
    label: 'x402_fetch',
    run: async () => 'FREE_RESPONSE',
  });
  assert.ok(free.ok === true && free.result === 'FREE_RESPONSE', 'unpaid responses pass through unchanged');
  assert.equal(client.hooks.length, 1, 'the blocking hook is registered even on unpaid flows');

  // …but an endpoint that DOES charge reaches payload creation, where the
  // blocking hook aborts BEFORE any signature exists.
  const client2 = fakeClient();
  let signCalls = 0;
  await assert.rejects(
    executeGuarded({
      intent: null,
      blockedCode: 'AMOUNT_UNBINDABLE',
      manager: intentManager,
      client: client2,
      label: 'x402_fetch',
      run: sdkLikeRun(client2, matchingCtx, () => signCalls++),
    }),
    /Payment creation aborted: INTENT_UNAUTHORISED:AMOUNT_UNBINDABLE/,
  );
  assert.equal(signCalls, 0, 'payment-payload creation never happens for an unauthorised offer');
});

it('tampered intent → validate fails closed → run is never called', async () => {
  const intent = makeIntent();
  intent.amountAtomic = '99999'; // in-place tampering of a binding field
  let runCalls = 0;
  const client = fakeClient();
  const outcome = await executeGuarded({
    intent, manager: intentManager, client, label: 'x402_fetch',
    run: async () => { runCalls++; return 'x'; },
  });
  assert.equal(runCalls, 0);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.ok === false && outcome.code === 'PARAM_MISMATCH');
  assert.equal(client.hooks.length, 0, 'no hook is even registered for a refused intent');
});

it('expired intent → run is never called (injected clock)', async () => {
  const intent = makeIntent({ ttlMs: 1_000 });
  let runCalls = 0;
  const outcome = await executeGuarded({
    intent, now: Date.now() + 10_000, manager: intentManager, client: fakeClient(), label: 'x402_fetch',
    run: async () => { runCalls++; return 'x'; },
  });
  assert.equal(runCalls, 0);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.ok === false && outcome.code === 'EXPIRED');
});

it('valid intent → run called exactly once, signing happens once, intent consumed; replay refused', async () => {
  const intent = makeIntent();
  const client = fakeClient();
  let runCalls = 0;
  let signCalls = 0;
  const outcome = await executeGuarded({
    intent, manager: intentManager, client, label: 'x402_fetch',
    run: () => { runCalls++; return sdkLikeRun(client, matchingCtx, () => signCalls++)(); },
  });
  assert.ok(outcome.ok === true && outcome.result === 'PAID_RESPONSE');
  assert.equal(runCalls, 1);
  assert.equal(signCalls, 1, 'exactly one payload creation reached signing');
  const after = intentManager.validate(intent);
  assert.equal(after.valid, false);
  assert.ok(after.valid === false && after.code === 'ALREADY_USED', 'consume happened during the guarded run');

  // Replay: a second execution of the same intent is refused before run.
  const replay = await executeGuarded({
    intent, manager: intentManager, client, label: 'x402_fetch',
    run: () => { runCalls++; return sdkLikeRun(client, matchingCtx, () => signCalls++)(); },
  });
  assert.equal(replay.ok, false);
  assert.ok(replay.ok === false && replay.code === 'ALREADY_USED');
  assert.equal(runCalls, 1, 'replay must not invoke the payment layer again');
  assert.equal(signCalls, 1);
});

// ---------------------------------------------------------------------------
// The enforcement hook itself
// ---------------------------------------------------------------------------

it('the enforcement hook passes through on an exact match and consumes the intent', async () => {
  const intent = makeIntent();
  const hook = intentEnforcement({ intent, manager: intentManager, executorLabel: 'x402_fetch' });
  const res = await hook(matchingCtx as any);
  assert.equal(res, undefined, 'match ⇒ no abort');
  const after = intentManager.validate(intent);
  assert.equal(after.valid, false);
  assert.ok(after.valid === false && after.code === 'ALREADY_USED');
});

it('the enforcement hook aborts on each security-critical drift: amount / payTo / asset / network / scheme', async () => {
  const cases: Array<[string, unknown, string]> = [
    ['amount', '20000', 'amount'],
    ['payTo', 'AttackerControlled', 'payTo'],
    ['asset', 'AttackerAsset', 'asset'],
    ['asset', '', 'asset'],
    ['network', 'eip155:1', 'network'],
    ['scheme', 'upto', 'scheme'],
  ];
  for (const [key, value, field] of cases) {
    _resetRegistryForTests();
    const intent = makeIntent();
    const hook = intentEnforcement({ intent, manager: intentManager, executorLabel: 'x402_fetch' });
    const res = await hook(ctx({ [key]: value }));
    assert.deepEqual(
      res,
      { abort: true, reason: `INTENT_OFFER_MISMATCH:${field}` },
      `drifted ${key} must abort before signing`,
    );
    const still = intentManager.validate(intent);
    assert.ok(still.valid === true, 'a mismatched offer must not consume (burn) the intent');
  }
});

it('the hook aborts INTENT_PARAM_MISMATCH for a tampered intent and INTENT_EXPIRED for an elapsed TTL', async () => {
  const tampered = makeIntent();
  tampered.recipient = 'AttackerControlled';
  const hookA = intentEnforcement({ intent: tampered, manager: intentManager, executorLabel: 't' });
  assert.deepEqual(await hookA(matchingCtx as any), { abort: true, reason: 'INTENT_PARAM_MISMATCH' });

  _resetRegistryForTests();
  // Backdated issuance: expired by the real clock, no sleeping required.
  const stale = makeIntent({ now: Date.now() - 120_000, ttlMs: 60_000 });
  const hookB = intentEnforcement({ intent: stale, manager: intentManager, executorLabel: 't' });
  assert.deepEqual(await hookB(matchingCtx as any), { abort: true, reason: 'INTENT_EXPIRED' });
});

it('the blocking hook always aborts with INTENT_UNAUTHORISED:<code>, regardless of the offer', async () => {
  const hook = blockingEnforcement({ code: 'AMOUNT_UNBINDABLE', executorLabel: 'x402_fetch' });
  assert.deepEqual(await hook(matchingCtx as any), { abort: true, reason: 'INTENT_UNAUTHORISED:AMOUNT_UNBINDABLE' });
  assert.deepEqual(await hook(undefined as any), { abort: true, reason: 'INTENT_UNAUTHORISED:AMOUNT_UNBINDABLE' });
});
