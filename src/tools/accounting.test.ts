import { strict as assert } from 'node:assert';
import { it } from 'node:test';

// ---------------------------------------------------------------------------
// Issues #65 + #67 (plan C1) — exact atomic formatting for every printed
// amount. The USD leg prices money in integer atomic units; a printed amount
// must be the EXACT decimal string of its atomic integer (never a float
// round trip, never a small value rounded to zero — the live defect was a
// $0.001 check printing "0.00" via toFixed(2)). These helpers are pure and
// shared by x402_check_payment, the new x402_status / x402_inspect tools and
// the budget registry's adapters.
//
// No network, no ledger, no env: the money math itself is the contract.
// ---------------------------------------------------------------------------

const { formatAtomic, exactUsdString, atomicStringFromUsdString } = await import('./accounting.js') as typeof import('./accounting.js');

it('formatAtomic renders the exact decimal string of the integer atomic amount', () => {
  assert.equal(formatAtomic(0n, 6), '0.000000', 'zero stays zero');
  assert.equal(formatAtomic(1n, 6), '0.000001', 'one micro-unit is NOT rounded to zero (#65 req 3)');
  assert.equal(formatAtomic(1000n, 6), '0.001000', 'the live $0.001 case (#67 req 4)');
  assert.equal(formatAtomic(50000n, 6), '0.050000', 'fraction digits are zero-padded to the exact width');
  assert.equal(formatAtomic(12250000n, 6), '12.250000', 'whole units carry the padded fraction');
  assert.equal(formatAtomic(1000000n, 6), '1.000000');
  assert.equal(formatAtomic(1000000000n, 9), '1.000000000', '9-decimal Casper motes render exactly');
  assert.equal(formatAtomic(1001n, 9), '0.000001001', 'sub-unit precision survives at 9 decimals');
  assert.equal(formatAtomic(0n, 0), '0', 'decimals 0 renders the whole string only');
  assert.equal(formatAtomic(42n, 0), '42');
  assert.equal(formatAtomic(-1000n, 6), '-0.001000', 'negative amounts render with sign and exact fraction');
});

it('formatAtomic is exact for every 18-decimal value the domain allows', () => {
  assert.equal(formatAtomic(1n, 18), '0.000000000000000001');
  assert.equal(formatAtomic(123456789012345678n, 18), '0.123456789012345678');
  const value = 98765432100000000000n;
  assert.equal(formatAtomic(value, 18), '98.765432100000000000', 'BigInt math — no float ever enters the rendering');
});

it('formatAtomic stays exact through the display domain’s top (a 30-decimal Nano-shaped rail)', () => {
  assert.equal(formatAtomic(1n, 30), '0.000000000000000000000000000001', 'a single atomic unit at 30 decimals refuses to vanish');
  assert.equal(formatAtomic(1500000000000000000000000000000n, 30), '1.500000000000000000000000000000');
});

it('formatAtomic refuses out-of-domain decimals (programmer error, fail loud)', () => {
  for (const decimals of [-1, 31, 2.5, NaN]) {
    assert.throws(() => formatAtomic(1n, decimals as number), /decimals/, `decimals ${decimals} must be refused`);
  }
});

it('exactUsdString renders a USD float through the exact atomic path — small values never vanish', () => {
  assert.equal(exactUsdString(0.001, 6), '0.001000', 'the confirmed live defect: a $0.001 check printed "0.00"');
  assert.equal(exactUsdString(0.000001, 6), '0.000001', 'plan C1 pins $0.000001 at 6 decimals as non-zero');
  assert.equal(exactUsdString(0.05, 6), '0.050000');
  assert.equal(exactUsdString(0, 6), '0.000000');
  assert.equal(exactUsdString(2.5, 6), '2.500000');
  assert.equal(exactUsdString(10, 6), '10.000000');
  assert.equal(exactUsdString(-0.5, 6), '-0.500000', 'signed values carry the sign');
});

it('exactUsdString fails closed on non-finite input (never a NaN string)', () => {
  assert.equal(exactUsdString(NaN, 6), '0.000000');
  assert.equal(exactUsdString(Infinity, 6), '0.000000');
  assert.equal(exactUsdString(-Infinity, 6), '-0.000000');
});

it('atomicStringFromUsdString converts a configured USD cap string to exact atomic units', () => {
  assert.equal(atomicStringFromUsdString('0.50', 6), '500000', 'MAX_PAYMENT_PER_CALL default at micro-USDC');
  assert.equal(atomicStringFromUsdString('10.00', 6), '10000000', 'MAX_DAILY_SPEND default');
  assert.equal(atomicStringFromUsdString('5', 6), '5000000', 'a whole-unit string carries no fraction');
  assert.equal(atomicStringFromUsdString('1', 9), '1000000000', '9-decimal units scale exactly');
  assert.equal(atomicStringFromUsdString('1', 30), '1000000000000000000000000000000', 'the 30-decimal display domain scales exactly too');
  assert.equal(atomicStringFromUsdString('0', 6), '0', 'the fail-closed cap 0 stays 0');
  assert.equal(
    atomicStringFromUsdString('0.0000001', 6),
    '0',
    'a cap with more fraction digits than the unit has floors (only integer atomic amounts exist)',
  );
});

it('atomicStringFromUsdString refuses malformed strings (never a silent NaN budget)', () => {
  for (const bad of ['abc', '1e3', '', '1,5', '0x10', '-0.5']) {
    assert.throws(() => atomicStringFromUsdString(bad, 6), /decimal/, `"${bad}" must be refused`);
  }
});