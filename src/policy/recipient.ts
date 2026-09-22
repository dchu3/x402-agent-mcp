// Issue #26 — chain-aware recipient normalization for the policy engine's
// recipient gate (rule 4.5, src/policy/engine.ts). Pure like the engine
// itself: no env, no FS, no clock, no randomness, no network — same input ⇒
// same output, always. Only src/policy/config.ts may touch env/FS (issue #19
// purity split); this module imports address codecs (viem, bs58) — pure
// libraries, no I/O — and nothing else.
//
// Canonicalisation contract: `undefined` means "not a valid address for that
// chain" — never guess, never repair. A wrong-checksum mixed-case EVM string
// is rejected rather than fixed; a non-32-byte base58 string is rejected
// rather than re-encoded; an unrecognised chain yields undefined so nothing
// can match by accident. The canonical form is what the engine compares, so
// the same logical recipient compares equal regardless of formatting.

import { isAddress } from "viem";
import bs58 from "bs58";

/** Canonicalise a recipient for a payment chain; undefined = not a valid
 * address for that chain (never guess, never repair). Total, pure, never
 * throws. Chains: 'base' / 'eip155:*' → EVM (EIP-55 checked, canonical
 * lowercase); 'solana' → 32-byte base58 (canonical re-encode); 'casper' →
 * '00' + 64 hex (optional 'account-hash-' prefix stripped, canonical
 * lowercase). Anything else (unknown chain, empty/whitespace raw) ⇒ undefined. */
export function normalizeRecipient(chain: string, raw: string): string | undefined {
  if (typeof chain !== "string" || typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value === "") return undefined;

  // EVM (Base is eip155:8453; any eip155:* chain uses the same address form).
  if (chain === "base" || chain.startsWith("eip155")) {
    // viem's isAddress validates EIP-55 for mixed-case input and accepts
    // all-lower / all-upper hex; a wrong-checksum string is rejected, never
    // repaired. Canonical form: lowercase.
    return isAddress(value) ? value.toLowerCase() : undefined;
  }

  // Solana: an ed25519 public key is exactly 32 bytes, base58-encoded. Decode
  // must succeed AND yield 32 bytes; the canonical form is the re-encoded
  // bytes (stable for any valid input, rejects lookalike spellings).
  if (chain === "solana") {
    let decoded: Uint8Array;
    try {
      decoded = bs58.decode(value);
    } catch {
      return undefined;
    }
    if (decoded.length !== 32) return undefined;
    return bs58.encode(decoded);
  }

  // Casper: the repo's payTo contract (src/casper/accepts.ts) is a
  // 00-prefixed account hash — /^00[0-9a-fA-F]{64}$/. Accept an optional
  // 'account-hash-' prefix; canonicalise to lowercase. This must NOT weaken
  // the validator: after stripping, the value still has to match exactly.
  if (chain === "casper") {
    const stripped = value.startsWith("account-hash-") ? value.slice("account-hash-".length) : value;
    return /^00[0-9a-fA-F]{64}$/.test(stripped) ? stripped.toLowerCase() : undefined;
  }

  // Unknown chain — never guess.
  return undefined;
}