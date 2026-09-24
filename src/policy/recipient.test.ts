import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import bs58 from 'bs58';
import { normalizeRecipient, parseRecipientEntry } from './recipient.js';

// Issue #26 — chain-aware recipient normalization for the recipient gate.
// normalizeRecipient is total and pure: undefined means "not a valid address
// for that chain" — never guess, never repair. The canonical form is what the
// engine compares, so the same logical recipient must compare equal regardless
// of formatting (checksummed vs lowercase EVM, account-hash- vs bare Casper).

const EVM_CHECKSUMMED = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // viem-valid checksum
const EVM_LOWER = EVM_CHECKSUMMED.toLowerCase(); // all-lower hex is valid (checksum applies to mixed case only)

// A valid Solana wallet is exactly 32 bytes base58-encoded.
const sol32 = (fill: number) => bs58.encode(Buffer.alloc(32, fill));
const SOL_WALLET = sol32(0x07);
const SOL_OTHER = sol32(0x08);

const casperLower = '00' + 'ab'.repeat(32);
const casperUpper = '00' + 'AB'.repeat(32);
const casperPrefixed = 'account-hash-' + casperUpper;

it('normalises a lowercase EVM address verbatim', () => {
  assert.equal(normalizeRecipient('base', EVM_LOWER), EVM_LOWER);
  assert.equal(normalizeRecipient('eip155:8453', EVM_LOWER), EVM_LOWER);
});

it('accepts a checksummed EVM address and canonicalises to lowercase', () => {
  assert.equal(normalizeRecipient('base', EVM_CHECKSUMMED), EVM_CHECKSUMMED.toLowerCase());
  assert.equal(normalizeRecipient('eip155:8453', EVM_CHECKSUMMED), EVM_CHECKSUMMED.toLowerCase());
});

it('rejects a wrong-checksum EVM spelling — including an all-uppercase re-spelling (never repairs)', () => {
  // EIP-55: an all-upper spelling of a mixed-checksum address fails viem's
  // isAddress (the checksum is case-sensitive) — it is undefined, never fixed.
  assert.equal(normalizeRecipient('base', EVM_CHECKSUMMED.toUpperCase().replace('0X', '0x')), undefined);
  assert.equal(normalizeRecipient('eip155:8453', EVM_CHECKSUMMED.toUpperCase().replace('0X', '0x')), undefined);
});

it('rejects invalid EVM recipients: too short, non-hex, wrong checksum, empty', () => {
  assert.equal(normalizeRecipient('base', '0x2222'), undefined, 'too short');
  assert.equal(normalizeRecipient('base', '0xzz22222222222222222222222222222222222222'), undefined, 'non-hex');
  assert.equal(normalizeRecipient('base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bDA02913'), undefined, 'wrong EIP-55 checksum');
  assert.equal(normalizeRecipient('base', ''), undefined, 'empty');
  assert.equal(normalizeRecipient('base', '   '), undefined, 'whitespace');
  assert.equal(normalizeRecipient('eip155:8453', 'not-an-address'), undefined);
});

it('round-trips a valid 32-byte Solana wallet', () => {
  assert.equal(normalizeRecipient('solana', SOL_WALLET), SOL_WALLET);
  // Re-encoding the decoded bytes is the canonical form — stable under repeat.
  assert.equal(normalizeRecipient('solana', bs58.encode(bs58.decode(SOL_WALLET))), SOL_WALLET);
});

it('rejects non-32-byte or non-base58 Solana recipients (never guesses)', () => {
  assert.equal(normalizeRecipient('solana', bs58.encode(Buffer.alloc(31, 0x07))), undefined, '31 bytes');
  assert.equal(normalizeRecipient('solana', bs58.encode(Buffer.alloc(33, 0x07))), undefined, '33 bytes');
  assert.equal(normalizeRecipient('solana', 'SoLWallet'), undefined, 'legacy test fixture is not a real wallet');
  assert.equal(normalizeRecipient('solana', 'a+aaaaaaa'), undefined, '+ is not in the base58 alphabet');
  assert.equal(normalizeRecipient('solana', '0Oaaaaaa'), undefined, '0 and O are not in the base58 alphabet');
  assert.equal(normalizeRecipient('solana', ''), undefined);
  assert.equal(normalizeRecipient('solana', '  '), undefined);
});

it('canonicalises Casper account hashes: 00 + 64 hex, case-insensitive, optional account-hash- prefix', () => {
  assert.equal(normalizeRecipient('casper', casperLower), casperLower);
  assert.equal(normalizeRecipient('casper', casperUpper), casperLower, 'uppercase hex canonicalises to lowercase');
  assert.equal(normalizeRecipient('casper', casperPrefixed), casperLower, 'account-hash- prefix is stripped');
});

it('rejects malformed Casper recipients: wrong prefix, odd length, missing 00, empty', () => {
  assert.equal(normalizeRecipient('casper', '01' + 'ab'.repeat(32)), undefined, 'wrong 2-byte prefix');
  assert.equal(normalizeRecipient('casper', 'account-hash-' + 'ab'.repeat(32)), undefined, 'prefix-stripped value must still be 00-prefixed');
  assert.equal(normalizeRecipient('casper', '00' + 'ab'.repeat(31) + 'a'), undefined, '63 hex digits');
  assert.equal(normalizeRecipient('casper', '0' + 'ab'.repeat(32)), undefined, '65 hex digits');
  assert.equal(normalizeRecipient('casper', '00zz' + 'ab'.repeat(31)), undefined, 'non-hex');
  assert.equal(normalizeRecipient('casper', ''), undefined);
});

it('returns undefined for an unknown chain (fail-closed: nothing matches by accident)', () => {
  // Issue #32 note: 'ethereum' is no longer unknown — it is a recognised EVM
  // alias (rule 3 hard-denies it ALWAYS, so it can never be PAID, but its
  // addresses normalise). Truly unrecognised chains still yield undefined.
  assert.equal(normalizeRecipient('optimism', EVM_LOWER), undefined, 'optimism is not in the chain vocabulary');
  assert.equal(normalizeRecipient('casper-test', casperLower), undefined);
  assert.equal(normalizeRecipient('', EVM_LOWER), undefined);
});

it('the same logical recipient compares equal regardless of formatting (the normalization criterion)', () => {
  // EVM: checksummed == lowercase (the two valid spellings share one canonical
  // form; an all-uppercase or wrong-checksum spelling is undefined, not a third form).
  const evmForms = [EVM_CHECKSUMMED, EVM_LOWER];
  const evmCanonicals = new Set(evmForms.map((f) => normalizeRecipient('eip155:8453', f)));
  assert.equal(evmCanonicals.size, 1, `all EVM spellings must share one canonical form (got ${[...evmCanonicals].join(', ')})`);
  // Casper: bare vs account-hash- prefixed, upper vs lower hex.
  const casperForms = [casperLower, casperUpper, casperPrefixed];
  const casperCanonicals = new Set(casperForms.map((f) => normalizeRecipient('casper', f)));
  assert.equal(casperCanonicals.size, 1, 'all Casper spellings must share one canonical form');
  // Different recipients must still differ (normalization never collides them).
  assert.notEqual(normalizeRecipient('base', EVM_LOWER), normalizeRecipient('base', '0x2222222222222222222222222222222222222222'));
  assert.notEqual(normalizeRecipient('solana', SOL_WALLET), normalizeRecipient('solana', SOL_OTHER));
  assert.notEqual(normalizeRecipient('casper', casperLower), normalizeRecipient('casper', '00' + 'cd'.repeat(32)));
});

it('is total: undefined chain or non-string inputs never throw', () => {
  assert.equal(normalizeRecipient(undefined as unknown as string, EVM_LOWER), undefined);
  assert.equal(normalizeRecipient('base', undefined as unknown as string), undefined);
  assert.equal(normalizeRecipient('solana', 42 as unknown as string), undefined);
});

// ---------------------------------------------------------------------------
// Issue #32 (R6) — chain-scoped recipient entries and the wider EVM alias
// vocabulary in normalization. The entry grammar: "<alias>:<address>" (the
// EVM aliases or "*" = any chain); a BARE address is the legacy unqualified
// form scoped to base; an unrecognised qualifier makes the entry unusable.
// ---------------------------------------------------------------------------

it('normalizeRecipient canonicalises EVM addresses on every EVM alias and any eip155:* id', () => {
  for (const chain of ['polygon', 'arbitrum', 'base-sepolia', 'ethereum', 'eip155:137', 'eip155:42161', 'eip155:10']) {
    assert.equal(normalizeRecipient(chain, EVM_CHECKSUMMED), EVM_LOWER, `${chain} must canonicalise like base`);
    assert.equal(normalizeRecipient(chain, EVM_CHECKSUMMED.toUpperCase().replace('0X', '0x')), undefined, `${chain} still rejects wrong checksums`);
    assert.equal(normalizeRecipient(chain, SOL_WALLET), undefined, `${chain} must not accept a Solana address`);
  }
});

it('parseRecipientEntry: bare addresses are the legacy base-scoped form; known aliases and * parse', () => {
  assert.deepEqual(parseRecipientEntry(EVM_CHECKSUMMED), { chain: 'base', address: EVM_CHECKSUMMED }, 'bare EVM ⇒ base scope');
  assert.deepEqual(parseRecipientEntry(SOL_WALLET), { chain: 'base', address: SOL_WALLET }, 'bare Solana ⇒ base scope label (address form still governs on non-EVM chains)');
  assert.deepEqual(parseRecipientEntry(`polygon:${EVM_CHECKSUMMED}`), { chain: 'polygon', address: EVM_CHECKSUMMED });
  assert.deepEqual(parseRecipientEntry(`arbitrum:${EVM_CHECKSUMMED}`), { chain: 'arbitrum', address: EVM_CHECKSUMMED });
  assert.deepEqual(parseRecipientEntry(`base:${EVM_CHECKSUMMED}`), { chain: 'base', address: EVM_CHECKSUMMED });
  assert.deepEqual(parseRecipientEntry(`*:${EVM_CHECKSUMMED}`), { chain: '*', address: EVM_CHECKSUMMED });
  assert.deepEqual(parseRecipientEntry(` *:${EVM_CHECKSUMMED} `), { chain: '*', address: EVM_CHECKSUMMED }, 'whitespace is trimmed');
});

it('parseRecipientEntry: unrecognised qualifiers and empty parts are unusable (fail closed)', () => {
  assert.equal(parseRecipientEntry(`optimism:${EVM_CHECKSUMMED}`), undefined, 'unknown alias; policy would deny it anyway');
  assert.equal(parseRecipientEntry(`eip155:137:${EVM_CHECKSUMMED}`), undefined, 'CAIP-2 prefixes are not entry qualifiers');
  assert.equal(parseRecipientEntry(`solana:${SOL_WALLET}`), undefined, 'solana is not an entry qualifier in the #32 grammar');
  assert.equal(parseRecipientEntry('polygon:'), undefined, 'empty address part');
  assert.equal(parseRecipientEntry(''), undefined);
  assert.equal(parseRecipientEntry('   '), undefined);
  assert.equal(parseRecipientEntry(undefined as unknown as string), undefined);
});

// ---------------------------------------------------------------------------
// Structural purity guard (mirrors src/payment-intent/no-bypass.test.ts):
// the policy core (engine.ts + recipient.ts) must contain no env reads, no
// file I/O, no clock, no randomness, no network. dist-test mirrors src/, so
// the SOURCE tree is ../../src from this file.
// ---------------------------------------------------------------------------

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

it('the policy core stays pure: engine.ts + recipient.ts contain no env/IO/clock/randomness/network', () => {
  for (const rel of ['policy/engine.ts', 'policy/recipient.ts']) {
    const content = readFileSync(join(SRC_ROOT, rel), 'utf8');
    for (const forbidden of ['process.env', 'readFileSync', 'Date.now', 'Math.random', 'fetch(']) {
      assert.ok(!content.includes(forbidden), `${rel} must not contain "${forbidden}" — the policy core stays pure (issue #19, engine purity)`);
    }
  }
});