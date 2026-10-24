import { strict as assert } from "node:assert";
import { it, after, afterEach } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createSafePaidTransport, PaidTransportFailure, transportLimitsFromEnv } from "./paid-transport.js";

// AbortSignal.timeout uses an unref'ed native timer; a deliberately hanging
// mock fetch otherwise lets node:test end its event loop before the deadline.
const keepAlive = setInterval(() => {}, 100);
after(() => clearInterval(keepAlive));

const previousEnv = { ...process.env };
afterEach(() => { process.env = { ...previousEnv }; });

const opts = (maxBodyBytes = 512) => ({
  totalTimeoutMs: 500,
  preSignTimeoutMs: 250,
  maxBodyBytes,
});
const signed = () => ({
  headers: { "PAYMENT-SIGNATURE": "local-synthetic-not-cryptographic" },
});
const failure = async (p: Promise<unknown>, code: string, paid: false | "unknown") => {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof PaidTransportFailure);
    assert.equal(err.code, code);
    assert.equal(err.paid, paid);
    return true;
  });
};

it("strict bounded defaults and validated overrides never silently disable a cap", () => {
  const config = transportLimitsFromEnv();
  assert.deepEqual(config, {
    probeTimeoutMs: 30000,
    preSignTimeoutMs: 30000,
    paidTimeoutMs: 60000,
    maxBodyBytes: 1048576,
  });
  process.env.X402_PAID_TIMEOUT_MS = "170";
  process.env.X402_PAID_MAX_BODY_BYTES = "768";
  assert.equal(transportLimitsFromEnv().paidTimeoutMs, 170);
  assert.equal(transportLimitsFromEnv().maxBodyBytes, 768);
  process.env.X402_PAID_TIMEOUT_MS = "-1";
  assert.throws(() => transportLimitsFromEnv(), /X402_PAID_TIMEOUT_MS/);
  process.env.X402_PAID_TIMEOUT_MS = "170";
  process.env.X402_PAID_MAX_BODY_BYTES = "999999999";
  assert.throws(() => transportLimitsFromEnv(), /X402_PAID_MAX_BODY_BYTES/);
});

it("no redirect option can be overridden even by a payment SDK Request", async () => {
  const requests: Array<{ url: string; redirect: RequestRedirect; hasSignature: boolean }> = [];
  const upstream = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push({
      url: req.url, redirect: init?.redirect ?? req.redirect,
      hasSignature: req.headers.has("payment-signature"),
    });
    return new Response("OK", { status: 200 });
  };
  const transport = createSafePaidTransport(upstream as typeof fetch, opts());
  const req = new Request("https://seller.example/api", {
    redirect: "follow", headers: { "PAYMENT-SIGNATURE": "test-only" },
  });
  const res = await transport.fetch(req);
  assert.equal(await res.text(), "OK");
  assert.deepEqual(requests, [{ url: req.url, redirect: "error", hasSignature: true }]);
  assert.equal(transport.wasPaymentDispatched(), true);
});

it("a synthetic HTTP redirect never causes a second fetch before signing", async () => {
  let sent = 0;
  const transport = createSafePaidTransport(async (_url, init) => {
    assert.equal(init?.redirect, "error");
    sent++;
    return Response.redirect("https://offsite.example/headers", 302);
  }, opts());
  await failure(transport.fetch("https://merchant.example/api"), "redirect_blocked", false);
  assert.equal(sent, 1);
  assert.equal(transport.wasPaymentDispatched(), false);
});

it("a signed paid redirect is ambiguous but never follows to a second origin", async () => {
  let sent = 0;
  const transport = createSafePaidTransport(async (_url, init) => {
    assert.equal(init?.redirect, "error");
    sent++;
    return Response.redirect("https://offsite.example/headers", 302);
  }, opts());
  await failure(transport.fetch("https://merchant.example/api", signed()), "redirect_blocked", "unknown");
  assert.equal(sent, 1);
  assert.equal(transport.wasPaymentDispatched(), true);
});

it("a hanging 402 probe times out before payment even when fetch ignores AbortSignal", async () => {
  const transport = createSafePaidTransport(
    (async () => new Promise<Response>(() => {})) as typeof fetch,
    { totalTimeoutMs: 200, preSignTimeoutMs: 50, maxBodyBytes: 512 },
  );
  await failure(transport.fetch("https://never.example/unsigned"), "timeout_before_payment", false);
  assert.equal(transport.wasPaymentDispatched(), false);
  assert.equal(transport.preSignExpired(), true);
});

it("a hanging signed HTTP request times out as unknown, never false unpaid", async () => {
  const transport = createSafePaidTransport(
    (async () => new Promise<Response>(() => {})) as typeof fetch,
    { totalTimeoutMs: 60, preSignTimeoutMs: 50, maxBodyBytes: 512 },
  );
  await failure(transport.fetch("https://never.example/paid", signed()), "timeout_after_payment", "unknown");
  assert.equal(transport.wasPaymentDispatched(), true);
});

it("payment handler knows when the signing window expired without a paid dispatch", async () => {
  const transport = createSafePaidTransport(
    (async () => new Response("ok", { status: 200 })) as typeof fetch,
    { totalTimeoutMs: 500, preSignTimeoutMs: 50, maxBodyBytes: 512 },
  );
  await delay(75);
  assert.equal(transport.preSignExpired(), true);
  assert.equal(transport.wasPaymentDispatched(), false);
  await failure(transport.fetch("https://late.example/unsigned"), "timeout_before_payment", false);
});

it("Content-Length early rejection cannot allocate claimed oversized response", async () => {
  const transport = createSafePaidTransport(
    (async () => new Response("OK", { status: 200, headers: { "content-length": "9000" } })) as typeof fetch,
    opts(),
  );
  await failure(transport.fetch("https://seller.example/huge", signed()), "response_too_large", "unknown");
});

it("a chunked response just below the exact limit is delivered without truncation", async () => {
  const body = "x".repeat(511);
  const transport = createSafePaidTransport(
    (async () => new Response(body, { status: 200 })) as typeof fetch,
    opts(),
  );
  const result = await transport.fetch("https://seller.example/tiny", signed());
  assert.equal(await result.text(), body);
});

it("a streamed response larger than limit is refused without unbounded buffering", async () => {
  const transport = createSafePaidTransport(
    (async () => new Response("x".repeat(513), { status: 200 })) as typeof fetch,
    opts(),
  );
  await failure(transport.fetch("https://seller.example/huge", signed()), "response_too_large", "unknown");
});

it("oversized x402 response headers are rejected independently of body", async () => {
  const transport = createSafePaidTransport(
    (async () => new Response("ok", {
      status: 200, headers: { "payment-response": "x".repeat(65537) },
    })) as typeof fetch, opts(),
  );
  await failure(transport.fetch("https://seller.example/api", signed()), "payment_header_too_large", "unknown");
});

it("normal unsigned 402 challenge stays parseable and is not mislabeled paid", async () => {
  const transport = createSafePaidTransport(
    (async () => new Response("Payment Required", { status: 402 })) as typeof fetch, opts(),
  );
  const resp = await transport.fetch("https://seller.example/api");
  assert.equal(resp.status, 402);
  assert.equal(await resp.text(), "Payment Required");
  assert.equal(transport.wasPaymentDispatched(), false);
});

it("HTTP 204 empty body is represented as a valid empty response", async () => {
  const transport = createSafePaidTransport(
    (async () => new Response(null, { status: 204 })) as typeof fetch, opts(),
  );
  const resp = await transport.fetch("https://seller.example/api");
  assert.equal(resp.status, 204);
  assert.equal(await resp.text(), "");
});

it("abort from a caller never silently retries a signed request", async () => {
  const ac = new AbortController();
  let calls = 0;
  const transport = createSafePaidTransport(
    (async () => { calls++; ac.abort(); throw new DOMException("Aborted", "AbortError"); }) as typeof fetch,
    opts(),
  );
  await failure(transport.fetch("https://seller.example/api", { ...signed(), signal: ac.signal }),
    "timeout_after_payment", "unknown");
  assert.equal(calls, 1);
});

it("URL payment-signature header in init marks the request as paid even without Request wrapper", async () => {
  const transport = createSafePaidTransport(
    (async () => { throw new Error("network unavailable"); }) as typeof fetch,
    opts(),
  );
  await failure(transport.fetch("https://seller.example/api", signed()), "transport_failed", "unknown");
});
