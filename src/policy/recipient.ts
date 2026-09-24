// Issue #26 — chain-aware recipient normalization for the policy engine's
// recipient gate (rule 4.5, src/policy/engine.ts). Pure like the engine
// itself: no env, no FS, no clock, no randomness, no network — same input ⇒
// same output, always. Only src/policy/config.ts may touch env/FS (issue #19
// purity split); this module imports address codecs (viem, bs58) and the pure
// EVM chain vocabulary (src/evm/networks.ts, issue #32) — no I/O anywhere.
//
// Canonicalisation contract: `undefined` means "not a valid address for that
// chain" — never guess, never repair. A wrong-checksum mixed-case EVM string
// is rejected rather than fixed; a non-32-byte base58 string is rejected
// rather than re-encoded; an unrecognised chain yields undefined so nothing
// can match by accident. The canonical form is what the engine compares, so
// the same logical recipient compares equal regardless of formatting.

import { isAddress } from "viem";
import bs58 from "bs58";
import { CHAIN_ALIASES, isEvmNetwork } from "../evm/networks.js";

/** Canonicalise a recipient for a payment chain; undefined = not a valid
 * address for that chain (never guess, never repair). Total, pure, never
 * throws. Chains: the EVM aliases ('base' | 'base-sepolia' | 'polygon' |
 * 'arbitrum' | 'ethereum') or any 'eip155:<digits>' id → EVM (EIP-55 checked,
 * canonical lowercase — issue #32: the aliases, not just Base); 'solana' →
 * 32-byte base58 (canonical re-encode); 'casper' → '00' + 64 hex (optional
 * 'account-hash-' prefix stripped, canonical lowercase). Anything else
 * (unknown chain, empty/whitespace raw) ⇒ undefined. */
export function normalizeRecipient(chain: string, raw: string): string | undefined {
  if (typeof chain !== "string" || typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value === "") return undefined;

  // EVM (every eip155:* chain uses the same address form; issue #32 extends
  // the pre-#32 `base`/`eip155` check to the full alias vocabulary via the
  // shared pure table — without it, allowlist mode would deny every Polygon
  // recipient as "not a valid address for that chain").
  if (isEvmNetwork(chain)) {
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

/** The wildcard chain qualifier for recipient entries (any chain). */
export const RECIPIENT_ANY_CHAIN = "*";

/** Parse one recipient allowlist/baseline entry (issue #32, R6): the grammar
 * is `"<chain>:<address>"` where `<chain>` is an alias in the EVM vocabulary
 * (src/evm/networks.ts CHAIN_ALIASES) or "*" (any chain); anything with an
 * unrecognised qualifier is UNUSABLE — undefined, never matches (fail closed,
 * no guessing). Anything else — including a BARE address — is the legacy
 * unqualified form, returned scoped to "base": pre-#32 `base` was the only
 * EVM chain in the vocabulary, so an operator's existing bare Base approval
 * keeps exactly its old meaning and can never silently widen onto Polygon or
 * Arbitrum. Entries are stored verbatim (no rewriting at load); only the
 * comparison interprets the qualifier. */
export function parseRecipientEntry(entry: string): { chain: string; address: string } | undefined {
  if (typeof entry !== "string" || entry.trim() === "") return undefined;
  const trimmed = entry.trim();
  const colon = trimmed.indexOf(":");
  if (colon === -1) return { chain: "base", address: trimmed };
  const qualifier = trimmed.slice(0, colon);
  const address = trimmed.slice(colon + 1);
  if (address === "") return undefined;
  if (qualifier === RECIPIENT_ANY_CHAIN || (CHAIN_ALIASES as readonly string[]).includes(qualifier)) {
    return { chain: qualifier, address };
  }
  // Unrecognised qualifier (incl. bare CAIP-2 prefixes like "eip155:137:0x…") —
  // fail closed: the entry never matches anything.
  return undefined;
}
