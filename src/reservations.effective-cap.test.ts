import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// The reservation registry must reserve against the EFFECTIVE daily cap —
// the smaller of the legacy MAX_DAILY_SPEND knob and the policy layer's
// payments.maxDaily — and the hold scope must stay the exact existing rule:
// a mainnet hold lives in the 'global' scope, a devnet hold in the devnet
// bucket's own 'net:<id>' scope, never mixed. The policy-file daily cap is
// operator configuration the gate enforces at fetch time; a reservation
// built only from the legacy env knob lets overlapping calls overshoot that
// file cap (the hold must never be looser than the gate that follows it).
// An unusable policy configuration fails closed: the effective cap reads 0
// (the gate refuses the payment anyway on the same broken configuration —
// a reservation must never hold budget the gate will not grant).
//
// Hermetic per the pattern of reservations.test.ts: temp ledger, seeded
// ledger rows, no network. The two new registry functions are imported
// dynamically-by-variable so this file still compiles and runs while they
// do not exist (the assertions are the failing RED step; the compile never
// breaks).
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'x402-reserv-eff-'));
const baseEnv = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.MAX_PAYMENT_PER_CALL = '50';

const RESERVATIONS_PATH = './reservations.js';
const reservationsRaw = await import(RESERVATIONS_PATH).catch(() => undefined) as any;
function requireReservations(): any {
  assert.ok(
    reservationsRaw && typeof reservationsRaw.reserveSpend === 'function',
    'src/reservations.ts must exist and export reserveSpend',
  );
  assert.ok(
    typeof reservationsRaw.effectiveDailyCapUsd === 'function' && typeof reservationsRaw.dailyHoldScope === 'function',
    'src/reservations.ts must export effectiveDailyCapUsd + dailyHoldScope (the effective-cap seam)',
  );
  return reservationsRaw;
}
const reserveSpend = (...a: unknown[]) => requireReservations().reserveSpend(...a);
const reservedUsd = (...a: unknown[]) => requireReservations().reservedUsd(...a);
const effectiveDailyCapUsd = (...a: unknown[]) => requireReservations().effectiveDailyCapUsd(...a);
const dailyHoldScope = (...a: unknown[]) => requireReservations().dailyHoldScope(...a);
const _resetReservationsForTests = () => { if (reservationsRaw?._resetReservationsForTests) reservationsRaw._resetReservationsForTests(); };

const { logPayment, getDailySpent, getDevnetDailySpent, _resetForTests } =
  (await import('./payment-utils.js')) as typeof import('./payment-utils.js');
const { SOLANA_DEVNET_CAIP2 } = (await import('@x402/svm')) as typeof import('@x402/svm');

const PRICE = 0.01;
const settle = () => new Promise((resolve) => setImmediate(resolve));
let seedCounter = 0;

/** Seed a settled mainnet (base) ledger row so the in-memory daily total
 * starts at exactly `amountUsd` (rehydration is a one-shot per process —
 * the reset hook below clears the map and the seed re-adds in memory). */
function seedMainnet(amountUsd: number): void {
  seedCounter++;
  logPayment({
    timestamp: new Date().toISOString(),
    url: `https://eff-seed-mainnet-${seedCounter}.invalid/seed`,
    method: 'GET', chain: 'base',
    amount_usdc: amountUsd, currency: 'USDC', status: 'success',
  });
}

function seedDevnet(amountUsd: number): void {
  seedCounter++;
  logPayment({
    timestamp: new Date().toISOString(),
    url: `https://eff-seed-devnet-${seedCounter}.invalid/seed`,
    method: 'GET', chain: 'solana', network: SOLANA_DEVNET_CAIP2,
    amount_usdc: amountUsd, currency: 'USDC', status: 'success',
  });
}

/** Point the policy loader at a file with the given (possibly malformed)
 * contents. A missing path loads the documented default policy. */
function usePolicyFile(contents: string | undefined): void {
  if (contents === undefined) {
    process.env.POLICY_CONFIG_PATH = join(dir, 'policy-absent.json');
    return;
  }
  const policyPath = join(dir, `policy-${Math.abs(Math.round(Math.random() * 1e9))}.json`);
  writeFileSync(policyPath, contents, 'utf8');
  process.env.POLICY_CONFIG_PATH = policyPath;
}

afterEach(() => {
  process.env = { ...baseEnv, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl'), MAX_PAYMENT_PER_CALL: '50' };
  delete process.env.POLICY_CONFIG_PATH;
  delete process.env.X402_POLICY_MAX_DAILY;
  _resetReservationsForTests();
  _resetForTests();
});
after(() => { process.env = baseEnv; rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// dailyHoldScope — the ONE derivation of a hold's daily-bucket scope
// ---------------------------------------------------------------------------

it('dailyHoldScope maps absent bucket to global and a bucket to its net:<bucket> scope', () => {
  requireReservations();
  assert.equal(dailyHoldScope(), 'global');
  assert.equal(dailyHoldScope(SOLANA_DEVNET_CAIP2), `net:${SOLANA_DEVNET_CAIP2}`);
  assert.equal(dailyHoldScope('any-network-id'), 'net:any-network-id');
});

// ---------------------------------------------------------------------------
// effectiveDailyCapUsd — min(MAX_DAILY_SPEND, policy payments.maxDaily)
// ---------------------------------------------------------------------------

it('without a policy file the effective cap is the legacy MAX_DAILY_SPEND knob (default policy mirrors it)', () => {
  process.env.MAX_DAILY_SPEND = '50';
  usePolicyFile(undefined); // missing path → documented default policy
  assert.equal(effectiveDailyCapUsd(), 50);
  delete process.env.POLICY_CONFIG_PATH; // unset entirely — same default rule
  assert.equal(effectiveDailyCapUsd(), 50);
});

it('a policy-file daily cap tightens the effective cap (min)', () => {
  process.env.MAX_DAILY_SPEND = '50';
  usePolicyFile(JSON.stringify({ payments: { enabled: true, maxPerRequest: 50, maxDaily: 5 } }));
  assert.equal(effectiveDailyCapUsd(), 5, 'payments.maxDaily 5 binds over the 50 env knob');
});

it('the legacy env knob still binds when the policy file is looser (min, never a widening)', () => {
  process.env.MAX_DAILY_SPEND = '5';
  usePolicyFile(JSON.stringify({ payments: { enabled: true, maxPerRequest: 50, maxDaily: 50 } }));
  assert.equal(effectiveDailyCapUsd(), 5, 'the file cap must never widen past the env knob');
});

it('the X402_POLICY_MAX_DAILY override keeps its documented precedence in the effective cap', () => {
  process.env.MAX_DAILY_SPEND = '50';
  usePolicyFile(JSON.stringify({ payments: { enabled: true, maxPerRequest: 50, maxDaily: 5 } }));
  process.env.X402_POLICY_MAX_DAILY = '2';
  assert.equal(effectiveDailyCapUsd(), 2);
});

it('a broken policy configuration fails the effective cap closed to 0', () => {
  process.env.MAX_DAILY_SPEND = '50';
  usePolicyFile('{ this is not a config');
  assert.equal(effectiveDailyCapUsd(), 0, 'an unusable configuration must not read as a usable cap');
  usePolicyFile(JSON.stringify({ payments: { enabled: true, maxPerRequest: 50, maxDaily: 5 } }));
  process.env.X402_POLICY_MAX_DAILY = 'not-a-number';
  assert.equal(effectiveDailyCapUsd(), 0, 'a malformed override corrupts the load and fails closed');
});

// ---------------------------------------------------------------------------
// reserveSpend against the effective cap
// ---------------------------------------------------------------------------

it('reserveSpend refuses a hold that would exceed the policy-file daily cap', async () => {
  process.env.MAX_DAILY_SPEND = '50'; // the legacy knob alone would allow this
  usePolicyFile(JSON.stringify({ payments: { enabled: true, maxPerRequest: 50, maxDaily: 5 } }));
  seedMainnet(4.99);
  const r = reserveSpend({ amountUsd: 0.02 });
  assert.equal(r.ok, false, '4.99 spent + 0.02 exceeds the effective cap of 5');
  const reason = r.ok === true ? '' : String(r.reason);
  assert.ok(reason.includes('effective daily cap $5'), `the refusal names the effective cap: ${reason}`);
  assert.ok(reason.includes('MAX_DAILY_SPEND $50'), `the refusal names both cap sources (the unbinding one too): ${reason}`);
  assert.ok(reason.includes('spent $4.9900'), `the refusal states today's spent total: ${reason}`);
  assert.ok(Math.abs(reservedUsd('global')) < 1e-9, 'a refused reservation holds nothing');
});

it('overlapping reservations cannot squeeze past the effective cap (interleaved calls)', async () => {
  process.env.MAX_DAILY_SPEND = '50';
  usePolicyFile(JSON.stringify({ payments: { enabled: true, maxPerRequest: 50, maxDaily: 5 } }));
  seedMainnet(4.98);
  const first = reserveSpend({ amountUsd: PRICE });
  assert.ok(first.ok, 'the first call holds its $0.01 under the 5-cap');
  const granted: string[] = [];
  const refused: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = reserveSpend({ amountUsd: PRICE });
    if (r.ok) granted.push(r.id);
    else refused.push(String(r.reason));
    await settle(); // yield exactly as overlapping tool calls do
  }
  assert.equal(granted.length, 0, 'with $4.98 spent + $0.01 held, no further $0.01 fits under the $5 cap');
  assert.equal(refused.length, 3);
  assert.ok(Math.abs(reservedUsd('global') - PRICE) < 1e-9, 'only the granted hold remains outstanding');
});

it('reserveSpend fails closed when the policy configuration is broken', () => {
  process.env.MAX_DAILY_SPEND = '50';
  usePolicyFile('{ this is not a config');
  const r = reserveSpend({ amountUsd: PRICE });
  assert.equal(r.ok, false, 'effective cap 0 — nothing may be reserved on an unusable configuration');
  assert.ok(Math.abs(reservedUsd('global')) < 1e-9, 'a failed-closed refusal holds nothing');
});

it('a devnet reservation reads the devnet bucket and the effective cap (bucket separation unchanged)', async () => {
  process.env.MAX_DAILY_SPEND = '50';
  usePolicyFile(JSON.stringify({ payments: { enabled: true, maxPerRequest: 50, maxDaily: 5 } }));
  seedDevnet(4.99);
  assert.ok(Math.abs(getDevnetDailySpent() - 4.99) < 1e-9, 'test isolation: the devnet bucket holds the seeded $4.99');
  assert.ok(Math.abs(getDailySpent()) < 1e-9, 'test isolation: the mainnet total is unchanged by devnet spend');
  const r = reserveSpend({ amountUsd: 0.02, networkBucket: SOLANA_DEVNET_CAIP2 });
  assert.equal(r.ok, false, 'the devnet hold is checked against the effective cap over the devnet bucket');
  assert.ok(Math.abs(reservedUsd(`net:${SOLANA_DEVNET_CAIP2}`)) < 1e-9, 'a devnet refusal never lands in the devnet scope');
  assert.ok(Math.abs(reservedUsd('global')) < 1e-9, 'a devnet hold must never touch the mainnet global scope');

  const ok = reserveSpend({ amountUsd: PRICE, networkBucket: SOLANA_DEVNET_CAIP2 });
  assert.ok(ok.ok, 'the devnet hold that fits still holds');
  assert.ok(Math.abs(reservedUsd(dailyHoldScope(SOLANA_DEVNET_CAIP2)) - PRICE) < 1e-9, 'the devnet hold sits in the devnet bucket scope');
  assert.ok(Math.abs(reservedUsd('global')) < 1e-9, 'and never in the mainnet global scope');
});