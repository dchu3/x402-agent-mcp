import { boundedText } from "./casper-fetch.js";

/** A signed header is not proof of settlement; after-send failures are ambiguous. */
export class PaidTransportFailure extends Error {
  constructor(
    public readonly code:
      | "timeout_before_payment"
      | "timeout_after_payment"
      | "redirect_blocked"
      | "response_too_large"
      | "payment_header_too_large"
      | "transport_failed",
    public readonly paid: false | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "PaidTransportFailure";
  }
}

export type TransportLimits = {
  probeTimeoutMs: number;
  preSignTimeoutMs: number;
  paidTimeoutMs: number;
  maxBodyBytes: number;
};

function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(name + " must be an integer in the configured range");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(name + " must be an integer in the configured range");
  return parsed;
}

export function transportLimitsFromEnv(): TransportLimits {
  return {
    probeTimeoutMs: integerSetting("X402_PROBE_TIMEOUT_MS", 30000, 50, 120000),
    preSignTimeoutMs: integerSetting("X402_PRE_SIGN_TIMEOUT_MS", 30000, 50, 120000),
    paidTimeoutMs: integerSetting("X402_PAID_TIMEOUT_MS", 60000, 50, 180000),
    maxBodyBytes: integerSetting("X402_PAID_MAX_BODY_BYTES", 1048576, 512, 1048576),
  };
}

const paymentHeaders = ["payment-signature", "x-payment", "payment"];
const boundedHeaders = ["payment-required", "payment-response", "x-payment-response"];
const maximumHeaderLength = 65536;

/** A fetch implementation or mocked ReadableStream need not honor a signal.
 * Settle the caller on the deadline in addition to aborting the underlying
 * native HTTP request; never leave the tool awaiting a stalled response. */
async function withinDeadline<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // An async fetch may have rejected in the same microtask that aborted the
    // signal. Always observe it even when the deadline already won the race.
    void pending.catch(() => undefined);
    throw signal.reason;
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

/** Bounds every SDK-initiated HTTP hop, including the 402 and signed request.
 * The pre-sign deadline is anchored at construction, not reset on each fetch. */
export function createSafePaidTransport(
  upstream: typeof fetch,
  options: { totalTimeoutMs: number; preSignTimeoutMs: number; maxBodyBytes: number },
): { fetch: typeof fetch; wasPaymentDispatched: () => boolean; preSignExpired: () => boolean } {
  const wholeDeadline = AbortSignal.timeout(options.totalTimeoutMs);
  const preSignDeadline = AbortSignal.timeout(Math.min(options.preSignTimeoutMs, options.totalTimeoutMs));
  let paymentDispatched = false;

  const safeFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (input instanceof Request)
      for (const [key, value] of input.headers) if (!headers.has(key)) headers.set(key, value);
    const isPaymentRequest = paymentHeaders.some((name) => headers.has(name));
    const ambiguous: false | "unknown" =
      paymentDispatched || isPaymentRequest ? "unknown" : false;
    const deadline = isPaymentRequest ? wholeDeadline : preSignDeadline;
    const signals: AbortSignal[] = [wholeDeadline, deadline];
    if (init?.signal) signals.push(init.signal);
    if (input instanceof Request) signals.push(input.signal);
    const signal = AbortSignal.any(signals);
    if (signal.aborted) {
      throw new PaidTransportFailure(ambiguous === "unknown" ?
        "timeout_after_payment" : "timeout_before_payment", ambiguous,
        "Transport deadline elapsed without a verified response");
    }

    let response: Response;
    try {
      // The fetch implementation itself may not follow a redirect, even
      // inside @x402/fetch. Never replay a payment signature to another host.
      const promise = upstream(input, { ...init, redirect: "error", signal });
      if (isPaymentRequest) paymentDispatched = true;
      response = await withinDeadline(promise, signal);
    } catch (err) {
      const timedOut = signal.aborted ||
        (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));
      const phase: false | "unknown" = paymentDispatched ? "unknown" : false;
      const code = timedOut ? (phase === "unknown" ? "timeout_after_payment" : "timeout_before_payment")
        : err instanceof Error && /redirect/i.test(err.message) ? "redirect_blocked"
        : "transport_failed";
      throw new PaidTransportFailure(code, phase, timedOut
        ? "Transport deadline elapsed without a verified response"
        : code === "redirect_blocked" ? "Redirect refused; no second origin was fetched"
        : "Transport failed without a verified response");
    }

    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch { /* cleanup only */ }
      throw new PaidTransportFailure("redirect_blocked",
        paymentDispatched ? "unknown" : false, "Redirect refused; no second origin was fetched");
    }

    for (const key of boundedHeaders) {
      if ((response.headers.get(key)?.length ?? 0) > maximumHeaderLength) {
        try { await response.body?.cancel(); } catch { /* cleanup only */ }
        throw new PaidTransportFailure("payment_header_too_large",
          paymentDispatched ? "unknown" : false, "Payment response header exceeds size limit");
      }
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && /^\d+$/.test(contentLength) &&
        Number(contentLength) > options.maxBodyBytes) {
      try { await response.body?.cancel(); } catch { /* cleanup only */ }
      throw new PaidTransportFailure("response_too_large",
        paymentDispatched ? "unknown" : false, "Payment response exceeds configured byte limit");
    }

    let body: string;
    try {
      body = await withinDeadline(boundedText(response, options.maxBodyBytes), signal);
    } catch (err) {
      const code = err instanceof Error && /exceeds size limit/i.test(err.message)
        ? "response_too_large"
        : signal.aborted || (err instanceof Error && /AbortError|TimeoutError/.test(err.name))
        ? paymentDispatched ? "timeout_after_payment" : "timeout_before_payment"
        : "transport_failed";
      throw new PaidTransportFailure(code, paymentDispatched ? "unknown" : false,
        code === "response_too_large" ? "Payment response exceeds configured byte limit" :
        "Payment response body could not be read safely");
    }
    return new Response([204, 205, 304].includes(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return { fetch: safeFetch, wasPaymentDispatched: () => paymentDispatched, preSignExpired: () => preSignDeadline.aborted };
}
