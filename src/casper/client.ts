import { ExactCasperScheme, toClientCasperSigner } from "@make-software/casper-x402";
// casper-js-sdk ships CommonJS — import the default export so the compiled ESM
// output resolves KeyAlgorithm/PrivateKey at runtime as well as at type time.
import casperSdk from "casper-js-sdk";
import type { KeyAlgorithm as KeyAlgorithmType, PrivateKey as PrivateKeyType } from "casper-js-sdk";
import { readFileSync } from "fs";
import { CASPER_MAINNET_CAIP2, toCasperCaip2 } from "./networks.js";

const { KeyAlgorithm, PrivateKey } = casperSdk;

/**
 * Loads the Casper payer key and registers the exact-scheme client on an
 * x402Client — the Casper equivalent of the Solana ExactSvmScheme wiring.
 *
 * CASPER_PRIVATE_KEY accepts either:
 *   - a raw hex secret key (ed25519 by default, secp256k1 via CASPER_KEY_ALGORITHM)
 *   - a path to a PEM file, or the PEM contents themselves
 */

export type CasperKeyAlgorithm = "ed25519" | "secp256k1";

export function getCasperKeyAlgorithm(): KeyAlgorithmType {
  const raw = (process.env.CASPER_KEY_ALGORITHM || "ed25519").toLowerCase().replace(/[-_]/g, "");
  if (raw === "secp256k1") return KeyAlgorithm.SECP256K1;
  if (raw === "ed25519") return KeyAlgorithm.ED25519;
  throw new Error(`Unsupported CASPER_KEY_ALGORITHM: ${process.env.CASPER_KEY_ALGORITHM} (use ed25519 or secp256k1)`);
}

/** Classify a CASPER_PRIVATE_KEY value so we know how to load it. */
export function classifyCasperKey(value: string): "pem" | "pem-path" | "hex" {
  const trimmed = (value || "").trim();
  if (!trimmed) throw new Error("CASPER_PRIVATE_KEY is empty");
  if (trimmed.includes("-----BEGIN")) return "pem";
  if (/^(0x)?[0-9a-fA-F]{64,68}$/.test(trimmed)) return "hex";
  if (/\.pem$/i.test(trimmed) || trimmed.includes("/")) return "pem-path";
  throw new Error("CASPER_PRIVATE_KEY must be a hex secret key, a PEM file path, or PEM contents");
}

export function loadCasperPrivateKey(
  value: string,
  algorithm: KeyAlgorithmType = getCasperKeyAlgorithm(),
): PrivateKeyType {
  const trimmed = value.trim();
  switch (classifyCasperKey(trimmed)) {
    case "hex":
      return PrivateKey.fromHex(trimmed.replace(/^0x/, ""), algorithm);
    case "pem":
      return PrivateKey.fromPem(trimmed, algorithm);
    case "pem-path":
      return PrivateKey.fromPem(readFileSync(trimmed, "utf-8"), algorithm);
  }
}

/** Build the exact-scheme Casper client from CASPER_PRIVATE_KEY. */
export function createCasperScheme(privateKeyValue: string): ExactCasperScheme {
  const privateKey = loadCasperPrivateKey(privateKeyValue);
  return new ExactCasperScheme(toClientCasperSigner(privateKey));
}

/**
 * Register the Casper exact scheme on an x402Client for the given network.
 * Mirrors `client.register(SOLANA_MAINNET_CAIP2, new ExactSvmScheme(...))`.
 */
export function registerCasperScheme(
  client: { register: (network: `${string}:${string}`, scheme: any) => unknown },
  privateKeyValue: string,
  network: string = CASPER_MAINNET_CAIP2,
): void {
  const caip2 = toCasperCaip2(network);
  client.register(caip2 as `${string}:${string}`, createCasperScheme(privateKeyValue));
}
