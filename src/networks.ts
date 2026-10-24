// Issue #59 — the EXPLICIT network mode: `X402_NETWORK_MODE` (`mainnet` or
// `devnet`, no default). This is the network counterpart of src/evm/networks.ts
// (the chain vocabulary): types, constants and pure resolvers. It reads its one
// env var on the caller's clock (the callers re-read per call — the MCP is a
// long-lived stdio process, and an operator's env change must never be
// silently cached), and everything else is pure.
//
// Operator decision on record (2026-10-24, issue #59, Option A): the mode is
// SHIPPED EXPLICIT with NO DEFAULT and it FAILS CLOSED — with a payment key
// loaded and no (valid) mode set, every x402_fetch call is refused with the
// stable code NETWORK_NOT_CONFIGURED before the probe; there is no
// mainnet-by-accident. Free tools keep working (immunity — the gate lives in
// the paid tool only).

import { SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2, SOLANA_TESTNET_CAIP2, DEVNET_RPC_URL } from "@x402/svm";
import { CASPER_MAINNET_CAIP2, CASPER_TESTNET_CAIP2 } from "./casper/networks.js";
import { normalizeCaip2Evm } from "./evm/networks.js";

export { SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2 } from "@x402/svm";

/** The mode env variable (documented in README + .env.example). */
export const NETWORK_MODE_VAR = "X402_NETWORK_MODE";

export type NetworkMode = "mainnet" | "devnet";

export interface NetworkModeState {
  mode?: NetworkMode;
  /** The raw, invalid value (already length-capped) — the gate's error detail. */
  invalid?: string;
}

/** Issue #59 (req 1, Option A): the mode is EXPLICIT. Anything other than
 * "mainnet"/"devnet" (case/whitespace tolerant) is an INVALID value — never a
 * default. An unset or empty variable means "no mode set"; whether that
 * refuses a paid call is the gate's and caller's decision (keys loaded ⇒
 * refuse; no keys ⇒ nothing is payable anyway). */
export function parseNetworkMode(env: NodeJS.ProcessEnv = process.env): NetworkModeState {
  const raw = env.X402_NETWORK_MODE;
  if (raw === undefined || raw === "") return {};
  const normalized = raw.trim().toLowerCase();
  if (normalized === "mainnet") return { mode: "mainnet" };
  if (normalized === "devnet") return { mode: "devnet" };
  return { invalid: raw.length > 60 ? raw.slice(0, 60) : raw };
}

export const NETWORK_MODE_ERROR =
  "X402_NETWORK_MODE must be \"mainnet\" or \"devnet\" — there is no default, so no paid call runs until the operator picks one (issue #59, fail closed)";

export interface NetworkModeResolved {
  mode?: NetworkMode;
  error?: string;
  /** True when the variable was unset/empty (the migration hint's condition). */
  unset: boolean;
}

/** Resolve the run's mode: a valid value wins; an invalid value or an unset
 * variable over a LOADED payment key is a NETWORK_NOT_CONFIGURED config error
 * (the code the gate returns — issue #59 req 1). With no mode and no key,
 * free operation continues exactly as before. */
export function resolveNetworkMode(env: NodeJS.ProcessEnv = process.env): NetworkModeResolved {
  const parsed = parseNetworkMode(env);
  if (parsed.mode) return { mode: parsed.mode, unset: false };
  const keyLoaded = Boolean(env.SOLANA_PRIVATE_KEY || env.EVM_PRIVATE_KEY || env.BASE_PRIVATE_KEY || env.CASPER_PRIVATE_KEY);
  if (parsed.invalid !== undefined) {
    return { error: `${NETWORK_MODE_ERROR} (read "${parsed.invalid}")`, unset: false };
  }
  if (keyLoaded) {
    return { error: NETWORK_MODE_ERROR, unset: true };
  }
  return { unset: true };
}

/** Known EVM testnet/devnet chain ids: a payable offer on one is a
 * mainnet-mode refusal (the chain vocabulary cannot say "testnet" — the exact
 * id can). The policy may still allow them for a MODE-LESS run exactly as
 * today (devnet mode is the Solana devnet only, per the issue's devnet scope). */
const EVM_TESTNET_CAIP2S = new Set([
  "eip155:11155111", // ethereum sepolia
  "eip155:84532", // base sepolia
  "eip155:84531", // base goerli
  "eip155:80002", // polygon amoy
  "eip155:421614", // arbitrum sepolia
  "eip155:11155420", // optimism sepolia
  "eip155:17000", // holesky
]);

/** Issue #59 (req 4): the exact network of a payable offer must be the run
 * mode's network. Solana: the exact mainnet CAIP-2 in mainnet mode, the exact
 * devnet CAIP-2 in devnet mode (the chain vocabulary collapses both to
 * "solana" by design — the REGISTRATION is what makes the difference, and
 * these ids decide the boundary). EVM: non-testnet eip155 ids in mainnet
 * mode; nothing in devnet mode (the devnet surface is the Solana devnet —
 * the devnet asset table has no EVM entries and devnet mode must never
 * widen). An offer without a network string (the legacy asset-less path)
 * passes — it keeps today's behavior and is unpayable downstream. Casper ids
 * are NOT decided here: the Casper leg runs the D6 agreement check
 * (casperNetworkResolved) instead. */
export function modeAllowsNetwork(mode: NetworkMode, network: string): boolean {
  if (network === "") return true; // legacy asset-less offers (unpayable later)
  if (network === SOLANA_DEVNET_CAIP2 || network === SOLANA_TESTNET_CAIP2) return mode === "devnet";
  if (mode === "devnet") return false;
  if (network === SOLANA_MAINNET_CAIP2) return true;
  if (!network.startsWith("eip155:")) return network === "casper" || network === CASPER_MAINNET_CAIP2 || network === CASPER_TESTNET_CAIP2;
  const canon = normalizeCaip2Evm(network);
  return !EVM_TESTNET_CAIP2S.has(canon);
}

/** Issue #59 (req 5/devnet): the Solana registration network and RPC of the
 * run's mode. Mainnet keeps today's exact values; devnet registers the SDK's
 * SOLANA_DEVNET_CAIP2 and uses SOLANA_DEVNET_RPC_URL with its documented
 * public fallback (the SDK's DEVNET_RPC_URL). */
export const SOLANA_MAINNET_RPC_FALLBACK = "https://api.mainnet-beta.solana.com";
export function solanaNetworkForMode(mode: NetworkMode): string {
  return mode === "devnet" ? SOLANA_DEVNET_CAIP2 : SOLANA_MAINNET_CAIP2;
}
export function solanaRpcUrlForMode(mode: NetworkMode, env: NodeJS.ProcessEnv = process.env): string {
  if (mode === "devnet") return env.SOLANA_DEVNET_RPC_URL || DEVNET_RPC_URL;
  return env.SOLANA_RPC_URL || SOLANA_MAINNET_RPC_FALLBACK;
}

/** Issue #59 (req 3) + plan D6: the Casper leg must agree with the mode.
 * - An explicit mode resolves the env's Casper network (the 'casper'/'casper-test'
 *   names or the exact CAIP-2 ids) and REFUSES a disagreement;
 * - an explicit mode with the env unset FOLLOWS the mode (mainnet mode works
 *   the Casper mainnet; devnet mode the Casper testnet);
 * - a mode-less run (legacy) passes the env value through today's behavior.
 * The refused variant is the stable gate signal CasperNetworkResolved's
 * callers render as CHAIN_NOT_ALLOWED. */
export function casperNetworkResolved(
  mode: NetworkMode | undefined,
  envNetwork: string | undefined,
): { ok: true; network: string } | { ok: false } {
  const wanted = mode === "mainnet" ? CASPER_MAINNET_CAIP2 : mode === "devnet" ? CASPER_TESTNET_CAIP2 : undefined;
  const nameToCaip2 = (value: string): string | undefined =>
    value === "casper" ? CASPER_MAINNET_CAIP2
    : value === "casper-test" ? CASPER_TESTNET_CAIP2
    : value === CASPER_MAINNET_CAIP2 || value === CASPER_TESTNET_CAIP2 ? value
    : undefined;
  const raw = (envNetwork ?? "").trim();
  const resolved = raw === "" ? undefined : nameToCaip2(raw) ?? raw; // an operator's own value passes through (today's semantics)
  if (wanted === undefined) return { ok: true, network: resolved ?? "" };
  if (resolved === undefined) return { ok: true, network: wanted };
  if (resolved !== wanted) return { ok: false };
  return { ok: true, network: resolved };
}