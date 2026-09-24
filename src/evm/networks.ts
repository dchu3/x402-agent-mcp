// Issue #32 — the EVM chain vocabulary (CAIP-2 ↔ alias) shared by the policy
// core, recipient normalization and the fetch tool's chain detection/signing
// registration. Mirrors the src/casper/networks.ts precedent: ONE pure module,
// no per-chain directories (the issue forbids src/polygon/ and friends).
//
// Purity contract (identical to the policy core): no fs, no env, no network,
// no clock, no randomness — types and constants only. src/policy/* (the pure
// engine) and src/tools/probe-utils.ts both import this module, so it may not
// import them back: tool code would otherwise leak into the pure core.
//
// The single invariant this module exists for: NEVER map an unknown
// eip155:* network to "base". The pre-#32 detector returned "base" for
// anything merely containing "eip155" or "8453", discarding the real CAIP-2
// id — every function below fails closed instead (undefined / "" / verbatim).

/** Recognised EVM chain aliases. `ethereum` (the L1) is in the vocabulary so
 * the policy engine can name it — rule 3 hard-denies it regardless of the
 * allowlist (src/policy/engine.ts). */
export const CHAIN_ALIASES = ["base", "base-sepolia", "polygon", "arbitrum", "ethereum"] as const;
export type ChainAlias = (typeof CHAIN_ALIASES)[number];

/** Alias → CAIP-2 id. */
export const EVM_CAIP2: Record<ChainAlias, string> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  ethereum: "eip155:1",
};

/** The Ethereum L1 CAIP-2 id — the policy engine refuses it ALWAYS (rule 3's
 * L1 hard deny), even if an operator lists it in networks.allowed. */
export const L1_CAIP2 = "eip155:1";

/** The CAIP-2 ids the configured facilitator settles by default. Fail-closed
 * settle-allowlist consulted ONLY after networks.allowed has passed (rule 3)
 * — it widens nothing by itself. */
export const DEFAULT_FACILITATOR_NETWORKS = ["eip155:8453", "eip155:137", "eip155:42161"];

const EVM_CAIP2_RE = /^eip155:(\d+)$/;
const CAIP2_ALIAS: Record<string, ChainAlias> = Object.fromEntries(
  (Object.entries(EVM_CAIP2) as Array<[ChainAlias, string]>).map(([alias, caip2]) => [caip2, alias]),
);

/** Issue #32 review follow-up — canonical numeric form of an EVM CAIP-2 id:
 * any well-formed `eip155:<digits>` id normalises to `eip155:<n>` where n is
 * `parseInt(digits, 10).toString()`, so the padded spellings 'eip155:01' /
 * 'eip155:001' collapse onto 'eip155:1' — the id the x402 SDK itself parses
 * (chainId 1). This keeps literal string comparisons airtight: the L1 hard
 * deny matches only 'eip155:1', allowlist membership and the SDK
 * registration must never see a padded form. Non-EVM (solana, casper,
 * aliases) and malformed inputs pass through UNCHANGED. */
export function normalizeCaip2Evm(n: string): string {
  const m = typeof n === "string" ? n.match(EVM_CAIP2_RE) : null;
  return m ? `eip155:${parseInt(m[1], 10).toString()}` : n;
}

/** True when `n` names an EVM network: any well-formed eip155:<digits> CAIP-2
 * id (recognised or not) or a known alias. Everything else is false — no
 * substring matching, no guessing. */
export function isEvmNetwork(n: string): boolean {
  if (typeof n !== "string" || n === "") return false;
  return EVM_CAIP2_RE.test(n) || (CHAIN_ALIASES as readonly string[]).includes(n);
}

/** Normalise an EVM network spelling to its CAIP-2 id: alias → its CAIP-2,
 * eip155:<digits> → its canonical numeric form ('eip155:01' → 'eip155:1'),
 * anything else → undefined (fail closed: an unrecognised chain has no CAIP-2
 * here, ever). The canonical result is what the policy engine compares and
 * what the fetch tool registers with the SDK — a padded form never reaches
 * either. */
export function caip2Of(n: string): string | undefined {
  if (typeof n !== "string" || n === "") return undefined;
  if ((CHAIN_ALIASES as readonly string[]).includes(n)) return EVM_CAIP2[n as ChainAlias];
  return EVM_CAIP2_RE.test(n) ? normalizeCaip2Evm(n) : undefined;
}

/** The vocabulary name for a network string: a known alias stays the alias; a
 * known CAIP-2 id (canonical or padded — 'eip155:08453' resolves like
 * 'eip155:8453') maps to its alias; an UNKNOWN eip155:* id returns its
 * canonical form VERBATIM — never "base". Non-EVM strings yield "" (the
 * caller falls through to its other chain checks). */
export function aliasForCaip2(n: string): string {
  if (typeof n !== "string" || n === "") return "";
  if ((CHAIN_ALIASES as readonly string[]).includes(n)) return n;
  if (!EVM_CAIP2_RE.test(n)) return "";
  const canonical = normalizeCaip2Evm(n);
  return CAIP2_ALIAS[canonical] ?? canonical;
}

/** True for the USD-settled legs of x402_fetch: Solana plus any EVM network.
 * Casper is deliberately excluded (its fetch path is casper-fetch.ts). */
export function isUsdChain(n: string): boolean {
  return n === "solana" || isEvmNetwork(n);
}
