import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { parseChainFromNetwork } from './probe-utils.js';

// Issue #32 — parseChainFromNetwork resolves the REAL CAIP-2 id through the
// shared EVM vocabulary instead of collapsing every eip155:* to "base".
// Fail-closed contract: an unknown eip155:* returns VERBATIM (policy then
// denies it — CHAIN_NOT_ALLOWED under the default allowlist), and a string
// merely CONTAINING "8453" never claims EVM at all.

it('known EVM CAIP-2 ids resolve to their aliases', () => {
  assert.equal(parseChainFromNetwork('eip155:8453'), 'base');
  assert.equal(parseChainFromNetwork('eip155:84532'), 'base-sepolia');
  assert.equal(parseChainFromNetwork('eip155:137'), 'polygon');
  assert.equal(parseChainFromNetwork('eip155:42161'), 'arbitrum');
  assert.equal(parseChainFromNetwork('eip155:1'), 'ethereum');
});

it('an unknown eip155:* network returns VERBATIM — never "base" (the #32 bug fix)', () => {
  assert.equal(parseChainFromNetwork('eip155:10'), 'eip155:10', 'Optimism keeps its real identity; policy denies it');
  assert.equal(parseChainFromNetwork('eip155:56'), 'eip155:56');
  assert.equal(parseChainFromNetwork('eip155:999999'), 'eip155:999999');
});

it('8453-containing non-EVM strings never claim EVM (substring collapse removed)', () => {
  assert.equal(parseChainFromNetwork('8453'), '8453');
  assert.equal(parseChainFromNetwork('prefix-8453-suffix'), 'prefix-8453-suffix');
  assert.equal(parseChainFromNetwork('eip155'), 'eip155');
  assert.equal(parseChainFromNetwork('eip155:'), 'eip155:');
  assert.equal(parseChainFromNetwork('not-eip155:8453'), 'not-eip155:8453');
});

it('solana detection is unchanged', () => {
  assert.equal(parseChainFromNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), 'solana');
  assert.equal(parseChainFromNetwork('solana'), 'solana');
  assert.equal(parseChainFromNetwork('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), 'solana');
});

it('casper detection is unchanged', () => {
  assert.equal(parseChainFromNetwork('casper:casper'), 'casper');
  assert.equal(parseChainFromNetwork('casper:casper-test'), 'casper');
  assert.equal(parseChainFromNetwork('casper-test'), 'casper');
});

it('EVM aliases and unrecognised chains pass through the raw fallback unchanged', () => {
  assert.equal(parseChainFromNetwork('polygon'), 'polygon');
  assert.equal(parseChainFromNetwork('arbitrum'), 'arbitrum');
  assert.equal(parseChainFromNetwork('weird-chain'), 'weird-chain');
  assert.equal(parseChainFromNetwork(''), '');
});
