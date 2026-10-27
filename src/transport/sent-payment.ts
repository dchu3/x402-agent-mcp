// The outgoing-payment signal: a thin wrapper over the paid transport that
// reads EVERY request the SDK sends and reports whether the outgoing request
// carried a payment header — the exact "the paid request left the client"
// signal (the header names are checked case-insensitively: the v2
// PAYMENT-SIGNATURE and the legacy X-PAYMENT). An unparseable header still
// reports sent: true (the header was there — counting must never depend on
// parse success; fail closed).
//
// The report carries NO on-chain signature: at payload time the client
// cannot know one, by construction. On Solana the wire transaction's first
// signature slot is the FEE PAYER's (the facilitator's) — the client only
// partially signs, so the real transaction signature does not exist until
// the facilitator settles; on every chain, the settlement evidence that
// matters arrives with the response's settlement receipt, not with the
// request. Nothing here mutates the request; the underlying transport
// always receives it verbatim.

/** What the tracking wrapper reports per outgoing request. */
export interface SentPaymentInfo {
  /** An outgoing request carried a payment header. */
  sent: boolean;
}

/** The fetch-like shape of the transport chain this wraps. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Read one outgoing request for the presence of a payment header.
 * Pure with respect to the caller's inputs; never throws. */
export function sentPaymentOf(input: unknown, init?: unknown): SentPaymentInfo {
  try {
    const headers = input instanceof Request
      ? input.headers
      : new Headers((init as { headers?: HeadersInit } | undefined)?.headers ?? (input as { headers?: HeadersInit } | undefined)?.headers ?? undefined);
    const value = headers.get("payment-signature") ?? headers.get("x-payment");
    if (value === null || value === "") return { sent: false };
    return { sent: true };
  } catch {
    return { sent: false };
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
