// The outgoing-payment signal: a thin wrapper over the paid transport that
// reads EVERY request the SDK sends and reports (a) whether the outgoing
// request carried a payment header — the exact "the paid request left the
// client" signal (the header names are checked case-insensitively: the v2
// PAYMENT-SIGNATURE and the legacy X-PAYMENT) — and (b) the on-chain
// signature of the sent payment when the payload envelope carries one, so
// the ledger row can later be reconciled against the chain:
//   - an EVM exact payload's `signature` (a 0x-prefixed hex string) passes
//     through verbatim;
//   - a Solana exact payload's `transaction` (the base64 wire transaction)
//     decodes to bytes whose FIRST 64 are the ed25519 signature — reported
//     base58-encoded, the chain's canonical signature spelling;
//   - an unparseable envelope still reports sent: true (the header was
//     there — counting must never depend on parse success) with no
//     signature (fail closed: the row then counts to expiry, unreconcilable).
//
// The envelope is the v2 payment header value: base64url-encoded JSON of
// { x402Version, payload, resource, accepted }. Only the payload is
// consulted. Nothing here mutates the request; the underlying transport
// always receives it verbatim.

import bs58 from "bs58";

/** What the tracking wrapper reports per outgoing request. */
export interface SentPaymentInfo {
  /** An outgoing request carried a payment header. */
  sent: boolean;
  /** The on-chain signature when it could be captured (else undefined). */
  signature?: string;
}

/** The fetch-like shape of the transport chain this wraps. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Read one outgoing request's payment header and decode its payload.
 * Pure with respect to the caller's inputs; never throws. */
export function sentPaymentOf(input: unknown, init?: unknown): SentPaymentInfo {
  try {
    const headers = input instanceof Request
      ? input.headers
      : new Headers((init as { headers?: HeadersInit } | undefined)?.headers ?? (input as { headers?: HeadersInit } | undefined)?.headers ?? undefined);
    const value = headers.get("payment-signature") ?? headers.get("x-payment");
    if (value === null || value === "") return { sent: false };
    const info: SentPaymentInfo = { sent: true };
    const signature = signatureFromPaymentHeader(value);
    if (signature !== undefined) info.signature = signature;
    return info;
  } catch {
    return { sent: false };
  }
}

/** Decode the base64url envelope and extract the on-chain signature:
 * the EVM payload carries its hex signature directly; the Solana payload
 * carries the base64 wire transaction whose first 64 bytes are the
 * ed25519 signature. Anything unexpected yields undefined (never throws). */
export function signatureFromPaymentHeader(headerValue: string): string | undefined {
  try {
    const json = Buffer.from(headerValue, "base64").toString("utf-8");
    const envelope = JSON.parse(json) as { payload?: { signature?: unknown; transaction?: unknown } };
    const payload = envelope.payload;
    if (!payload || typeof payload !== "object") return undefined;
    if (typeof payload.signature === "string" && payload.signature.startsWith("0x") && payload.signature.length > 10) {
      return payload.signature;
    }
    if (typeof payload.transaction === "string" && payload.transaction.length > 0) {
      const txBytes = Buffer.from(payload.transaction, "base64");
      if (txBytes.length >= 64) return bs58.encode(txBytes.subarray(0, 64));
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Wrap the paid transport: every outgoing request is inspected BEFORE the
 * underlying transport sees it (so a refusal further down the chain — a
 * guard refusal, a network failure — still counts as an outgoing payment
 * attempt that left this wrapper; the fail-closed direction) and the report
 * callback runs synchronously while the request is in flight. */
export function sentPaymentTracking(next: FetchLike, onOutgoing: (info: SentPaymentInfo) => void): FetchLike {
  return async (input, init) => {
    try {
      onOutgoing(sentPaymentOf(input, init));
    } catch {
      // Reporting must never break the request; a report failure keeps
      // today's counting semantics (payload-signed → counted).
    }
    return next(input, init);
  };
}