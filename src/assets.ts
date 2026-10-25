// Issue #62 — the per-network asset table.
//
// The USD legs of this agent price everything through ONE table keyed by the
// offer's EXACT network id (CAIP-2, issue #59: no substring matching) and the
// offer's asset id: an asset id maps to (symbol, decimals, USD-peg flag) —
// and only then can an atomic offer amount convert to USD. This module owns
// that table and the conversion:
//
// 1. The shipped table lists every asset the x402 pings use (the measured
//    2026-10-24 challenges: mainnet USDC `2000` atomic and devnet USDC
//    `1000` atomic for the documented $0.001) plus the other mainnet USDC
//    pairs the SDK's default assets resolve to, plus the canonical wCSPR
//    CEP-18 package hashes per Casper network. Solana mainnet and devnet
//    USDC are DIFFERENT asset ids — entries are per network, never per
//    chain.
// 2. Purity contract (mirrors src/evm/networks.ts): types, constants, pure
//    lookups and conversions — no env, fs, network or clock reads. Operators
//    extend the table via the policy config's `assets.extensions` (issue
//    #62, D2 — validated fail-closed in src/policy/config.ts); the caller
//    passes those entries in, this module never reads the config itself.
// 3. The USD conversion is DELEGATED to the existing USD converter,
//    src/tools/accounting.ts usdFromAtomic (BigInt-integer, exact until the
//    single narrowing at the ledger boundary). This module NEVER
//    re-implements that conversion and never assumes a unit or rate: an
//    asset is priced only when the table (or the operator via
//    assets.extensions) gives it a real symbol + decimals and a peg or a
//    positive rate; every other case is refused with a STABLE code:
//    ASSET_NOT_LISTED (no entry for this asset on this network) or
//    ASSET_NO_USD_RATE (listed but unpriced — the USD leg prices in
//    USD-pegged units only; the mote-denominated Casper leg prices in
//    motes via casper/budget.ts and must not reach here).
//
// Fail-closed invariants:
// - unknown/missing/mishaped input → ASSET_NOT_LISTED, never a guess;
// - network-strict: the same asset id on a different network is NOT the
//   listed entry;
// - an asset listed without a price is NOT assumed to be USD-pegged.

import { SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { CASPER_MAINNET_CAIP2, CASPER_TESTNET_CAIP2 } from "./casper/networks.js";
import { WCSPR_ASSETS } from "./casper/accepts.js";
import { normalizeCaip2Evm } from "./evm/networks.js";
import type { OperatorAssetEntry } from "./policy/types.js";
import { usdFromAtomic } from "./tools/accounting.js";

/** Issue #62/#59 visibility (C9): the summary the startup log and
 * x402_check_payment render. Pure: no env reads, no I/O. */
export function assetTableSummary(): { table_entries: number; networks: string[] } {
  return { table_entries: ASSET_TABLE.length, networks: [...new Set(ASSET_TABLE.map((e) => e.network))] };
}

/** Refusal codes of the asset table. Stable contract (issue #62 req 5):
 * ASSET_NOT_LISTED — the asset id has no entry for this network (the asset
 * gate refuses BEFORE the challenge scope, the intent binding and any signing);
 * ASSET_NO_USD_RATE — the asset is listed but unpriced, so the USD leg has no
 * value to enforce caps with (fail closed, never an assumed peg). */
export type AssetRefusalCode = "ASSET_NOT_LISTED" | "ASSET_NO_USD_RATE";

/** One resolved asset entry: exactly what the agent needs to price and bind
 * an offer — the real symbol (policy vocabulary), the real decimals (exact
 * integer USD conversion) and how the table prices it. */
export interface AssetEntry {
  /** Exact CAIP-2 network id the asset belongs to. */
  network: string;
  /** On-chain asset id exactly as offers name it. */
  asset: string;
  /** The asset's real symbol (policy-vocabulary token name). */
  symbol: string;
  /** Integer decimals in usdFromAtomic's domain (0–18). */
  decimals: number;
  /** USD-pegged stablecoin: 1 USD per whole token unit. */
  usdPeg: boolean;
  /** USD per WHOLE token unit for non-pegged assets (positive, finite); a
   * pegged asset carries no rate (it IS the peg). */
  usdRate?: number;
}

/** The shipped per-network asset table (issue #62, D1). Solana mainnet and
 * devnet USDC are distinct mints/asset ids — per network, never per chain.
 * The wCSPR rows use the accepts layer's canonical package hashes so the
 * Casper leg cannot drift from them. */
export const ASSET_TABLE: readonly AssetEntry[] = [
  { network: SOLANA_MAINNET_CAIP2, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6, usdPeg: true },
  { network: SOLANA_DEVNET_CAIP2, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", decimals: 6, usdPeg: true },
  { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6, usdPeg: true },
  { network: "eip155:137", asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", decimals: 6, usdPeg: true },
  { network: "eip155:42161", asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6, usdPeg: true },
  { network: CASPER_MAINNET_CAIP2, asset: WCSPR_ASSETS[CASPER_MAINNET_CAIP2], symbol: "wCSPR", decimals: 9, usdPeg: false },
  { network: CASPER_TESTNET_CAIP2, asset: WCSPR_ASSETS[CASPER_TESTNET_CAIP2], symbol: "wCSPR", decimals: 9, usdPeg: false },
] as const;

/** Resolve an offer's asset through the shipped table PLUS the operator's
 * assets.extensions (issue #62, D2 — caller-supplied; config-validated).
 * Operator entries take priority over the shipped table (a deliberate
 * operator override), and resolution is EXACT: the network id is compared to
 * the entry's network with EVM CAIP-2 ids normalised to their canonical
 * numeric form (eip155:08453 → eip155:8453), asset ids case-insensitively for
 * hex/EVM entries — no substring matching, no "same chain, any asset". */
export function resolveAsset(
  network: string,
  asset: string,
  extensions: readonly OperatorAssetEntry[] = [],
): AssetEntry | undefined {
  if (typeof network !== "string" || typeof asset !== "string") return undefined;
  const normalizedNetwork = normalizeCaip2Evm(network);
  const normalizedAsset = asset.toLowerCase().trim();
  if (normalizedAsset === "") return undefined;

  // Operator extensions first (deliberate override), then the shipped table.
  for (const entry of extensions) {
    if (typeof entry?.network !== "string" || typeof entry?.asset !== "string") continue;
    if (normalizeCaip2Evm(entry.network) !== normalizedNetwork) continue;
    if (entry.asset.toLowerCase().trim() !== normalizedAsset) continue;
    return {
      network: entry.network,
      asset: entry.asset,
      symbol: entry.symbol,
      decimals: entry.decimals,
      usdPeg: entry.usdPeg === true, // an operator entry prices via usdRate or is pegged — never both unknown
      usdRate: entry.usdRate,
    };
  }
  return ASSET_TABLE.find((entry) => entry.network === normalizedNetwork && entry.asset.toLowerCase() === normalizedAsset);
}

/** What priceAtomicAsUsd resolves to: a priced entry, or one of the STABLE
 * refusal codes (ASSET_NOT_LISTED / ASSET_NO_USD_RATE) — never undefined and
 * never a made-up value. */
export type AssetPricing =
  | { ok: true; usd: number; symbol: string; decimals: number; entry: AssetEntry }
  | { ok: false; code: AssetRefusalCode };

/** Convert an OFFER's integer atomic amount into USD through the asset table
 * (issue #62 req 2: real symbol + decimals through the USD converter, exact
 * integer conversion — never a fixed-6 float division, never a made-up value).
 *
 * - An unknown/missing/mishaped asset id is refused ASSET_NOT_LISTED (never
 *   priced, never assumed — review requirement of issue #62).
 * - A listed asset is priced with its REAL entry: usdPeg entries at exactly
 *   1 USD per whole unit; non-pegged listed entries at their configured rate
 *   (shipped rows carry no rate — wCSPR prices nothing on the USD leg and is
 *   refused there, see below); an entry pricing nothing is refused
 *   ASSET_NO_USD_RATE.
 * - The conversion itself is delegated to usdFromAtomic (the
 *   accounting module's BigInt-integer converter, exact until the single
 *   narrowing at the ledger boundary); a conversion that fails closed there
 *   (malformed amount string, out-of-domain decimals) is refused
 *   ASSET_NOT_LISTED — malformed input has no price.
 *
 * `extensions` is the operator's assets.extensions (D2), supplied by the
 * caller so this module stays pure. */
export function priceAtomicAsUsd(
  network: string,
  asset: string,
  amountAtomic: string,
  extensions: readonly OperatorAssetEntry[] = [],
): AssetPricing {
  const entry = resolveAsset(network, asset, extensions);
  if (entry === undefined) return { ok: false, code: "ASSET_NOT_LISTED" };
  const usdPerWholeToken = entry.usdPeg ? 1 : entry.usdRate;
  if (typeof usdPerWholeToken !== "number" || !Number.isFinite(usdPerWholeToken) || usdPerWholeToken <= 0) {
    return { ok: false, code: "ASSET_NO_USD_RATE" }; // listed but unpriced — fail closed, never an assumed peg
  }
  const wholeTokens = usdFromAtomic(amountAtomic, entry.decimals);
  if (wholeTokens === undefined) return { ok: false, code: "ASSET_NOT_LISTED" }; // malformed amount — no price
  const usd = wholeTokens * usdPerWholeToken;
  if (!Number.isFinite(usd)) return { ok: false, code: "ASSET_NO_USD_RATE" }; // narrowing overflow — fail closed
  return { ok: true, usd, symbol: entry.symbol, decimals: entry.decimals, entry };
}