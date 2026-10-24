// Issue #61 (C7): probe-replay transport.
//
// The agent's flow sees the 402 challenge ONCE at the free probe. The SDK's
// own first (unpaid) request to the same method+url used to hit the network
// again — a second chance for the seller to serve a DIFFERENT challenge than
// the one the agent parsed, authorized and bound (the offer-swap window, and
// one wasted request even when the seller plays fair).
//
// The replaying transport answers the SDK's first request to the recorded
// (method, url) with the probe's own bytes — status, headers and body — and
// sends every later request (the signed paid leg) through the supplied next
// transport. The response handed to the SDK is byte-faithful but entirely
// local: no socket is opened for the replayed request, so the signed retry is
// the second (not third) request the seller sees.
//
// The record is produced by the flow itself from its own guardedFetch probe —
// guarded, bounded and refusal-checked exactly like today. This module adds
// no payment primitive: it is a transport that replays a response the tool
// already received.

export interface ProbedResponseRecord {
  /** The probe's request URL (the replay key, matched verbatim). */
  url: string;
  /** The probe's request method, upper-cased (the replay key). */
  method: string;
  /** The probe's response status. */
  status: number;
  /** The probe's response headers as [name, value] pairs (Response-init safe). */
  headers: Array<[string, string]>;
  /** The probe's response body (already read by the caller, bounded). */
  bodyText: string;
}

/**
 * Build a replay record for a response. The caller owns body reading — the
 * flow reads the body only where it already does (bounded), so this takes the
 * resulting text rather than touching the stream itself.
 */
export function recordForReplay(
  resp: { status: number; headers: { forEach: (cb: (value: string, name: string) => void) => void } },
  url: string,
  method: string,
  bodyText: string,
): ProbedResponseRecord {
  const headers: Array<[string, string]> = [];
  resp.headers.forEach((value, name) => headers.push([name, value]));
  return { url, method: method.toUpperCase(), status: resp.status, headers, bodyText };
}

/**
 * Wrap a fetch transport so the FIRST request matching the record's
 * (method, url) is answered from the probe record instead of the network.
 * Every later request — notably the signed paid leg — goes through `next`
 * verbatim. One replay per record (the SDK's single unpaid attempt), then
 * the record is spent.
 */
export function replayFirstProbe(
  record: ProbedResponseRecord,
  next: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  let consumed = false;
  return async (input, init) => {
    if (!consumed) {
      const requestUrl = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      const requestMethod = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (requestUrl === record.url && requestMethod === record.method) {
        consumed = true;
        return new Response(record.bodyText, { status: record.status, headers: record.headers });
      }
    }
    return next(input, init);
  };
}

/** Issue #56: the paid request must not hang forever on a silent seller.
 * Default 30000 ms — the probe already carries a 30 s timeout; the paid leg
 * now carries the same bound unless X402_PAID_TIMEOUT_MS is set. */
export const DEFAULT_PAID_TIMEOUT_MS = 30_000;

/** Parse X402_PAID_TIMEOUT_MS fail-closed: absent/blank ⇒ the documented
 * default; whole-digit positive integers pass through verbatim; anything
 * else (signs, decimals, exponents, junk, values beyond a safe integer)
 * throws a RangeError — never clamped, never silently defaulted. */
export function paidTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.X402_PAID_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PAID_TIMEOUT_MS;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new RangeError(`X402_PAID_TIMEOUT_MS must be a positive integer number of milliseconds, got: ${trimmed.slice(0, 32)}`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`X402_PAID_TIMEOUT_MS must be a positive integer number of milliseconds, got: ${trimmed.slice(0, 32)}`);
  }
  return value;
}