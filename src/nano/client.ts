import { randomUUID } from "node:crypto";
import { normalizeNanoAddress } from "./address.js";
import { NANO_MAINNET_CAIP2, toNanoCaip2 } from "./networks.js";
import { nanoAmountRaw } from "./accepts.js";

/**
 * Nano exact-scheme client.
 *
 * Nano has no off-chain authorization to hand a facilitator: the payer
 * publishes a send block, waits for network confirmation, and presents the
 * confirmed block hash as the x402 payload — `{ blockHash: "<64 hex>" }`.
 * The resource server verifies that block on its own node.
 *
 * Signing and proof-of-work are delegated to an injectable `NanoSender`, so
 * tests need no network and operators can bring their own signer. The
 * shipped sender drives the `send` action of a Nano node's wallet RPC (the
 * node holds the key and generates work) and then polls `block_info` until
 * the block is confirmed and matches the requested destination and amount.
 */

export interface NanoSendRequest {
  /** Checksummed nano_ address taken from the validated offer. */
  destination: string;
  /** Exact integer raw. */
  amountRaw: bigint;
  /** Idempotency key — a node that sees the same id twice does not send twice. */
  id: string;
  /** Called with the block hash as soon as it is published, before confirmation. */
  onPublished?: (blockHash: string) => void;
}

export interface NanoSender {
  /** Publish a send and resolve with the CONFIRMED send block hash (64 hex). */
  send(request: NanoSendRequest): Promise<string>;
}

/** A JSON-RPC call against a Nano node: POST the action body, return the parsed reply. */
export type NanoRpc = (body: Record<string, unknown>) => Promise<any>;

export interface RpcWalletSenderOptions {
  rpc: NanoRpc;
  /** Node wallet id (64 hex) holding the source account's key. */
  wallet: string;
  /** Account the send is published from. */
  source: string;
  /** How long to wait for confirmation before failing (default 30s). */
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const BLOCK_HASH = /^[0-9A-Fa-f]{64}$/;

/** Default HTTP transport for the node RPC: bounded, redirect-refusing, JSON only. */
export function httpNanoRpc(url: string, timeoutMs = 15000): NanoRpc {
  return async (body) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (text.length > 65536) throw new Error("Nano RPC response exceeds size limit");
    if (!response.ok) throw new Error(`Nano RPC HTTP ${response.status}`);
    return JSON.parse(text);
  };
}

/** Sender backed by a Nano node's wallet RPC (`send` + `block_info`). */
export function createRpcWalletSender(options: RpcWalletSenderOptions): NanoSender {
  const source = normalizeNanoAddress(options.source);
  if (!source) throw new Error("NANO_SOURCE_ACCOUNT must be a checksum-valid nano_ address");
  if (!/^[0-9A-Fa-f]{64}$/.test(options.wallet)) throw new Error("NANO_WALLET_ID must be 64 hex characters");
  const timeout = options.confirmTimeoutMs ?? 30000;
  const interval = options.pollIntervalMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  return {
    async send({ destination, amountRaw, id, onPublished }) {
      const to = normalizeNanoAddress(destination);
      if (!to) throw new Error("Nano destination is not a valid address");
      const sent = await options.rpc({
        action: "send", wallet: options.wallet, source, destination: to, amount: amountRaw.toString(), id,
      });
      const hash = sent?.block;
      if (typeof hash !== "string" || !BLOCK_HASH.test(hash)) throw new Error("Nano node did not return a send block hash");
      onPublished?.(hash.toUpperCase());
      const deadline = now() + timeout;
      for (;;) {
        const info = await options.rpc({ action: "block_info", json_block: "true", hash });
        if (info && !info.error) {
          // A node reply that disagrees with what we asked for is never presented as payment.
          if (info.subtype !== "send" || normalizeNanoAddress(info.block_account) !== source ||
              normalizeNanoAddress(info.contents?.link_as_account) !== to || info.amount !== amountRaw.toString()) {
            throw new Error("Nano send block does not match the requested payment");
          }
          if (info.confirmed === "true" || info.confirmed === true) return hash.toUpperCase();
        }
        if (now() >= deadline) throw new Error(`Nano send block ${hash.toUpperCase()} not confirmed in time`);
        await sleep(interval);
      }
    },
  };
}

/**
 * Build the exact-scheme client for one fetch. `onPublished` receives the
 * block hash as soon as it exists (even if confirmation then times out), and
 * `onConfirmed` once the sender returns it confirmed, so the ledger can record
 * a send even when the paid request fails afterwards.
 */
export function createNanoScheme(
  sender: NanoSender,
  onPublished: (blockHash: string) => void = () => {},
  onConfirmed: (blockHash: string) => void = () => {},
) {
  return {
    scheme: "exact" as const,
    async createPaymentPayload(x402Version: number, requirements: any) {
      toNanoCaip2(requirements.network);
      const blockHash = await sender.send({
        destination: requirements.payTo,
        amountRaw: nanoAmountRaw(requirements),
        id: `x402-${randomUUID()}`,
        onPublished,
      });
      if (typeof blockHash !== "string" || !BLOCK_HASH.test(blockHash)) throw new Error("Nano sender returned an invalid block hash");
      onPublished(blockHash);
      onConfirmed(blockHash);
      return { x402Version, payload: { blockHash } };
    },
  };
}

/** Register the Nano exact scheme on an x402Client for the given network. */
export function registerNanoScheme(
  client: { register: (network: `${string}:${string}`, scheme: any) => unknown },
  sender: NanoSender,
  network: string = NANO_MAINNET_CAIP2,
  onPublished?: (blockHash: string) => void,
  onConfirmed?: (blockHash: string) => void,
): void {
  client.register(toNanoCaip2(network) as `${string}:${string}`, createNanoScheme(sender, onPublished, onConfirmed));
}

let senderOverride: NanoSender | undefined;

/** Test/integration seam: replace the env-configured sender (undefined restores it). */
export function _setNanoSenderForTests(sender: NanoSender | undefined): void {
  senderOverride = sender;
}

/** True when a sender is available — injected, or the wallet RPC env is complete. */
export function nanoSenderConfigured(): boolean {
  return senderOverride !== undefined ||
    Boolean(process.env.NANO_RPC_URL?.trim() && process.env.NANO_WALLET_ID?.trim() && process.env.NANO_SOURCE_ACCOUNT?.trim());
}

/** The sender for this call: the injected one, else the node wallet RPC from env. */
export function resolveNanoSender(): NanoSender {
  if (senderOverride) return senderOverride;
  return createRpcWalletSender({
    rpc: httpNanoRpc(process.env.NANO_RPC_URL!.trim()),
    wallet: process.env.NANO_WALLET_ID!.trim(),
    source: process.env.NANO_SOURCE_ACCOUNT!.trim(),
  });
}
