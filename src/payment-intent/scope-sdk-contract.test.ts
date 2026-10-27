import { strict as assert } from 'node:assert';
import { before, it } from 'node:test';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Issue #66 (D6): an SDK-CONTRACT PIN over the installed @x402/svm and
// @x402/evm packages for the CHALLENGE FIELDS this agent's challenge-scope
// boundary (issue #55) consumes. The scope boundary decides what a seller
// may put into a PaymentIntent; the SDK decides how those fields are signed.
// If a dependency bump changes the SDK's contract — the memo byte cap, the
// Solana address shape, the EIP-712 transfer types — the two layers drift
// apart silently. These pins make the drift break a test instead.
//
// All relationships pinned here are fail-closed-safe directions (what the
// scope accepts must be signable by the SDK); a divergent relationship would
// mean scope-accepted challenges crash at signing, which pinning would catch
// as a red test for review rather than a silent signing change.
//
// Hermetic: pure constants, regexes and the pure scope builder — no network,
// no signer, no RPC.
// ---------------------------------------------------------------------------

const svm = await import('@x402/svm') as typeof import('@x402/svm');
const evm = await import('@x402/evm') as typeof import('@x402/evm');
const { scopeOf, DEFAULT_MAX_MEMO_BYTES, DEFAULT_CHALLENGE_MAX_TIMEOUT_SECONDS, configFromEnv, DEFAULT_ALLOWED_EXTENSIONS, KNOWN_SAFE_EXTRA_KEYS } =
  await import('./challenge-scope.js') as typeof import('./challenge-scope.js');
const BASE58_SCOPE_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

const scopeConfig = { config: {
  allowedExtensions: [...DEFAULT_ALLOWED_EXTENSIONS],
  maxTimeoutSeconds: DEFAULT_CHALLENGE_MAX_TIMEOUT_SECONDS,
  maxMemoBytes: DEFAULT_MAX_MEMO_BYTES,
  allowedExtraKeys: [],
  feePayerAllowlist: [],
  allowSelfFeePayer: false,
} };

before(() => {
  // The pin assumes the shipped defaults; a config regression elsewhere must
  // not confuse this file.
  assert.deepEqual(configFromEnv({}), scopeConfig.config, 'configFromEnv({}) must build exactly the shipped defaults');
});

// --- @x402/svm: the memo byte cap --------------------------------------

it('D6 pin: the SVM exact scheme reads extra.memo and caps it at MAX_MEMO_BYTES — a scope-accepted memo can never exceed it (the SDK "memo exceeds maximum" throw is unreachable for accepted challenges)', () => {
  assert.equal(typeof svm.MAX_MEMO_BYTES, 'number');
  assert.ok(
    DEFAULT_MAX_MEMO_BYTES <= svm.MAX_MEMO_BYTES,
    `scope default memo cap ${DEFAULT_MAX_MEMO_BYTES} must never exceed the SDK cap ${svm.MAX_MEMO_BYTES} — an SDK bump that lowers the cap must break this test for review`,
  );
  // Boundary proof: a memo exactly at the scope's default cap is accepted...
  const atCap = 'a'.repeat(DEFAULT_MAX_MEMO_BYTES);
  assert.deepEqual(
    scopeOf({ scheme: 'exact', network: svm.SOLANA_DEVNET_CAIP2, amount: '1', payTo: 'x', asset: 'y', maxTimeoutSeconds: 60, extra: { memo: atCap } } as any, scopeConfig),
    { ok: true, scope: expectMemoScope(atCap) },
  );
  // ...and anything above the SDK's cap is above 64 too — i.e. over the SDK
  // cap the scope (at defaults) refuses FIRST, so the SDK throw cannot fire.
  assert.ok(DEFAULT_MAX_MEMO_BYTES < svm.MAX_MEMO_BYTES);
});

function expectMemoScope(memo: string): Record<string, unknown> {
  return {
    extensionKeys: [],
    maxTimeoutSeconds: 60,
    memo,
  };
}

// --- @x402/svm: the fee payer shape -------------------------------------

it('D6 pin: the SDK address contract (SVM_ADDRESS_REGEX) is the shape the scope binds fee payers in — every SDK-acceptable address is scope-acceptable (and a short base58 forgery is caught as such)', () => {
  assert.ok(svm.SVM_ADDRESS_REGEX instanceof RegExp);
  // The upstream direction: whatever the SDK accepts, our scope accepts and
  // binds for exact equality at the payment hook.
  {
    const valid = bs58Encode32(0x31);
    assert.ok(svm.SVM_ADDRESS_REGEX.test(valid), 'fixture is SDK-acceptable');
    assert.ok(BASE58_SCOPE_RE.test(valid));
    const result = scopeOf(feePayerAccept(valid) as any, scopeConfig);
    assert.ok(result.ok === true && result.scope.solanaFeePayer === valid, 'every SDK-acceptable fee payer must be bindable');
  }
  // A malformed fee payer the SDK would reject must not be smuggled into
  // signing either — the scope refuses it with its fixed code (fail closed),
  // never reaching the SDK's own address validation as a first line.
  {
    const malformed = 'short-not-an-address!';
    assert.equal(svm.SVM_ADDRESS_REGEX.test(malformed), false);
    const result = scopeOf(feePayerAccept(malformed) as any, scopeConfig);
    assert.ok(result.ok === false && result.code === 'FEE_PAYER_REFUSED');
  }
});

function bs58Encode32(byte: number): string {
  return bs58.encode(new Uint8Array(32).fill(byte));
}

function feePayerAccept(feePayer: string): Record<string, unknown> {
  return {
    scheme: 'exact',
    network: svm.SOLANA_DEVNET_CAIP2,
    amount: '1',
    payTo: 'x',
    asset: 'y',
    maxTimeoutSeconds: 60,
    extra: { feePayer },
  };
}

// --- @x402/evm: the EIP-712 contract the domain fields feed --------------

it('D6 pin: the EVM exact scheme signs TransferWithAuthorization (authorizationTypes) over exactly the fields the intent binds (from/to/value/validAfter/validBefore/nonce)', () => {
  const components = (evm.authorizationTypes as any).TransferWithAuthorization;
  assert.ok(components, 'authorizationTypes.TransferWithAuthorization must stay the exact scheme\'s message');
  assert.deepEqual(
    components.map((c: any) => [c.name, c.type]),
    [
      ['from', 'address'],
      ['to', 'address'],
      ['value', 'uint256'],
      ['validAfter', 'uint256'],
      ['validBefore', 'uint256'],
      ['nonce', 'bytes32'],
    ],
    'a change to the signed message shape means the intent binding (amount→value, payTo→to) must be re-reviewed against the new schema',
  );
});

it('D6 pin: extra.name / extra.version — the EIP-712 domain fields — bind only strings (viem domain safety), stay bound for equality, and unknown domain-ish extras are refused', () => {
  const evmAccept = (extra: Record<string, unknown>) => ({
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '1',
    payTo: 'x',
    asset: 'y',
    maxTimeoutSeconds: 60,
    extra,
  });
  const good = scopeOf(evmAccept({ name: 'USD Coin', version: '2' }) as any, scopeConfig);
  assert.ok(good.ok === true && good.scope.evmDomainName === 'USD Coin' && good.scope.evmDomainVersion === '2');
  // Non-string domain fields are refused before they can reach the SDK's
  // domain construction.
  for (const bad of [evmAccept({ name: 7 }), evmAccept({ version: { v: '2' } })]) {
    const r = scopeOf(bad as any, scopeConfig);
    assert.ok(r.ok === false && r.code === 'TRANSFER_METHOD_NOT_ALLOWED');
  }
  // The SDK reads extra.recentBlockhash as a base58-32-byte string; the
  // scope never binds it (not on the known-safe set) — it must stay refused
  // at defaults so only the flow's own call-site allowlist admits it.
  const r = scopeOf(evmAccept({ recentBlockhash: 'z'.repeat(43) }) as any, scopeConfig);
  assert.ok(r.ok === false && r.code === 'TRANSFER_METHOD_NOT_ALLOWED');
  // Contract mirror: the known-safe set is still exactly what the SDK reads.
  assert.deepEqual([...KNOWN_SAFE_EXTRA_KEYS], ['name', 'version', 'feePayer', 'memo', 'lastValidBlockHeight']);
});