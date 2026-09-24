import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  CHAIN_ALIASES,
  EVM_CAIP2,
  L1_CAIP2,
  DEFAULT_FACILITATOR_NETWORKS,
  isEvmNetwork,
  caip2Of,
  aliasForCaip2,
  isUsdChain,
} from './networks.js';

// Issue #32 — the shared EVM chain vocabulary. The contract that matters most
// (the whole point of the issue): an unknown eip155:* network is NEVER mapped
// to "base" — every helper fails closed or returns the CAIP-2 verbatim.

it('the alias vocabulary is base / base-sepolia / polygon / arbitrum / ethereum', () => {
  assert.deepEqual([...CHAIN_ALIASES], ['base', 'base-sepolia', 'polygon', 'arbitrum', 'ethereum']);
});

it('EVM_CAIP2 maps every alias to its CAIP-2 id', () => {
  assert.equal(EVM_CAIP2.base, 'eip155:8453');
  assert.equal(EVM_CAIP2['base-sepolia'], 'eip155:84532');
  assert.equal(EVM_CAIP2.polygon, 'eip155:137');
  assert.equal(EVM_CAIP2.arbitrum, 'eip155:42161');
  assert.equal(EVM_CAIP2.ethereum, 'eip155:1');
});

it('the L1 id and the default facilitator list are the documented constants', () => {
  assert.equal(L1_CAIP2, 'eip155:1');
  // The facilitator default covers base + polygon + arbitrum — a fail-closed
  // settle-allowlist that only applies to chains that already passed the
  // networks.allowed membership check (engine rule 3).
  assert.deepEqual(DEFAULT_FACILITATOR_NETWORKS, ['eip155:8453', 'eip155:137', 'eip155:42161']);
});

it('isEvmNetwork: known aliases and any eip155:<digits> id, nothing else', () => {
  for (const n of ['base', 'base-sepolia', 'polygon', 'arbitrum', 'ethereum', 'eip155:8453', 'eip155:10', 'eip155:999999']) {
    assert.equal(isEvmNetwork(n), true, `${n} must name an EVM network`);
  }
  for (const n of ['solana', 'casper', 'casper:casper', '', 'eip155', 'eip155:', 'eip155:1:2', '8453', 'not-eip155:8453', 'optimism']) {
    assert.equal(isEvmNetwork(n), false, `${n} must NOT name an EVM network (no substring matching)`);
  }
});

it('caip2Of: alias → CAIP-2, eip155:<n> → itself, anything else → undefined (fail closed)', () => {
  assert.equal(caip2Of('base'), 'eip155:8453');
  assert.equal(caip2Of('base-sepolia'), 'eip155:84532');
  assert.equal(caip2Of('polygon'), 'eip155:137');
  assert.equal(caip2Of('arbitrum'), 'eip155:42161');
  assert.equal(caip2Of('ethereum'), 'eip155:1');
  // Unknown-but-well-formed EVM ids pass through verbatim — never aliased.
  assert.equal(caip2Of('eip155:10'), 'eip155:10');
  assert.equal(caip2Of('eip155:8453'), 'eip155:8453');
  for (const n of ['solana', 'casper', '', 'eip155', 'eip155:', '8453', 'optimism']) {
    assert.equal(caip2Of(n), undefined, `caip2Of(${n}) must be undefined`);
  }
});

it('aliasForCaip2: known CAIP-2 → alias; unknown eip155:* → the CAIP-2 verbatim, NEVER "base"', () => {
  assert.equal(aliasForCaip2('eip155:8453'), 'base');
  assert.equal(aliasForCaip2('eip155:84532'), 'base-sepolia');
  assert.equal(aliasForCaip2('eip155:137'), 'polygon');
  assert.equal(aliasForCaip2('eip155:42161'), 'arbitrum');
  assert.equal(aliasForCaip2('eip155:1'), 'ethereum');
  // The bug being fixed: unknown EVM ids keep their real identity.
  assert.equal(aliasForCaip2('eip155:10'), 'eip155:10');
  assert.equal(aliasForCaip2('eip155:56'), 'eip155:56');
  for (const n of ['solana', 'casper:casper', '', 'eip155', 'eip155:', '8453']) {
    assert.equal(aliasForCaip2(n), '', `aliasForCaip2(${n}) must be "" so the caller falls through`);
  }
});

it('alias ↔ CAIP-2 round-trip for every known alias', () => {
  for (const alias of CHAIN_ALIASES) {
    assert.equal(caip2Of(alias), EVM_CAIP2[alias]);
    assert.equal(aliasForCaip2(EVM_CAIP2[alias]), alias);
    assert.equal(aliasForCaip2(alias), alias, 'an alias passed as input stays the alias');
  }
});

it('isUsdChain: solana ∪ EVM — Casper and unknown strings excluded', () => {
  for (const n of ['base', 'base-sepolia', 'polygon', 'arbitrum', 'ethereum', 'eip155:10', 'solana']) {
    assert.equal(isUsdChain(n), true, `${n} is a USD-settled leg`);
  }
  for (const n of ['casper', 'casper:casper', '', 'weird']) {
    assert.equal(isUsdChain(n), false, `${n} is not a USD-settled leg`);
  }
});

// ---------------------------------------------------------------------------
// Structural purity guard (mirrors src/policy/recipient.test.ts): this module
// is imported by the PURE policy core, so it must contain no env reads, no
// file I/O, no clock, no randomness, no network. dist-test mirrors src/, so
// the SOURCE tree is ../../src from this file.
// ---------------------------------------------------------------------------
const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

it('the EVM vocabulary stays pure: no env/IO/clock/randomness/network', () => {
  const content = readFileSync(join(SRC_ROOT, 'evm/networks.ts'), 'utf8');
  for (const forbidden of ['process.env', 'readFileSync', 'Date.now', 'Math.random', 'fetch(']) {
    assert.ok(!content.includes(forbidden), `evm/networks.ts must not contain "${forbidden}" — the vocabulary module stays pure (issue #32, R1)`);
  }
});
