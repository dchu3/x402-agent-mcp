import { strict as assert } from "node:assert";
import { after, afterEach, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The SDK receives synthetic network replies only. This suite generates NO
// live wallet signatures, RPC calls, payments or service connections.
const dir = mkdtempSync(join(tmpdir(), "x402-paid-guard-"));
const oldEnv = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, "ledger.jsonl");
process.env.X402_DIRECTORY_PATH = join(dir, "endpoints.json");
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({
  endpoints: [], categories: [], last_updated: "2026-10-24",
}), "utf8");
const { registerFetchTool } = await import("./fetch.js");
const previousFetch = globalThis.fetch;

function ledger() {
  if (!existsSync(process.env.PAYMENT_LOG_PATH!)) return [];
  return readFileSync(process.env.PAYMENT_LOG_PATH!, "utf8").split("\n")
    .filter(Boolean).map((line) => JSON.parse(line));
}
afterEach(() => {
  globalThis.fetch = previousFetch;
  process.env = {
    ...oldEnv,
    PAYMENT_LOG_PATH: join(dir, "ledger.jsonl"),
    X402_DIRECTORY_PATH: join(dir, "endpoints.json"),
  };
});
after(() => { process.env = oldEnv; rmSync(dir, { recursive: true, force: true }); });

const NETWORK = "eip155:8453";
const ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT = "0x2222222222222222222222222222222222222222";

const challenge = (url: string) => {
  const data = {
    x402Version: 2,
    resource: { url, description: "", mimeType: "text/plain" },
    accepts: [{
      scheme: "exact", network: NETWORK, asset: ADDRESS, amount: "10000",
      payTo: RECIPIENT, maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    }],
  };
  return new Response("Payment Required", {
    status: 402,
    headers: { "payment-required": Buffer.from(JSON.stringify(data)).toString("base64") },
  });
};
const signingHeader = (input: RequestInfo | URL, init?: RequestInit) =>
  new Request(input, init).headers.get("payment-signature");
const handler = () => {
  let call: any;
  registerFetchTool({ tool: (_name: any, _desc: any, _schema: any, fn: any) => {
    call = fn;
  } } as any);
  return call as (args: { url: string; chain?: string }) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
};
const prepare = (opts?: Record<string, string>) => {
  process.env.EVM_PRIVATE_KEY = "0x" + "11".repeat(32); // THROWAWAY: no RPC
  process.env.MAX_PAYMENT_PER_CALL = "50";
  process.env.MAX_DAILY_SPEND = "50";
  process.env.X402_PAID_TIMEOUT_MS = "500";
  process.env.X402_PRE_SIGN_TIMEOUT_MS = "350";
  process.env.X402_PAID_MAX_BODY_BYTES = "512";
  process.env.X402_PROBE_TIMEOUT_MS = "250";
  Object.assign(process.env, opts);
};
const parsedCall = async (u: string) => JSON.parse((await handler()({ url: u, chain: "base" })).content[0].text);

it("SDK-paid 302 cannot forward signed payment header to a redirected host", async () => {
  prepare();
  const u = "https://redirect-guard56.invalid/get";
  let probes = 0, unsigned = 0, signed = 0, leaked = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.redirect, "error");
    const url = new Request(input, init).url;
    if (url !== u) leaked++;
    const sig = signingHeader(input, init);
    if (sig) {
      signed++;
      return Response.redirect("https://untrusted-redirect.invalid/key", 302);
    }
    if (probes++ === 0) return challenge(u);
    unsigned++;
    return challenge(u);
  }) as typeof fetch;
  const prior = ledger().length;
  const { getDailySpent } = await import("../payment-utils.js");
  const { getPerServiceSpent } = await import("../policy/budget-store.js");
  const beforeGlobalReservation = getDailySpent();
  const result = await parsedCall(u);
  assert.equal(result.error_code, "redirect_blocked");
  assert.equal(result.paid, "unknown");
  assert.equal(result.do_not_retry_blindly, true);
  assert.equal(leaked, 0);
  assert.equal(signed, 1);
  assert.equal(unsigned, 1);
  const rows = ledger().slice(prior);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "unknown");
  assert.equal(rows[0].amount_usdc, 0);
  assert.equal(rows[0].attempted_amount_usdc, 0.01);
  assert.ok(Math.abs(getDailySpent() - beforeGlobalReservation - 0.01) < 0.00001,
    "unconfirmed paid request must reserve one attempted amount in global budget");
  assert.equal(getPerServiceSpent("redirect-guard56.invalid"), 0.01);
  const globalRestarted = await import(`../payment-utils.js?unknown-transport56=${Date.now()}`) as typeof import("../payment-utils.js");
  const serviceRestarted = await import(`../policy/budget-store.js?unknown-transport56=${Date.now()}`) as typeof import("../policy/budget-store.js");
  assert.ok(Math.abs(globalRestarted.getDailySpent() - getDailySpent()) < 0.00001,
    "unknown budget must rehydrate identically after process restart");
  assert.equal(serviceRestarted.getPerServiceSpent("redirect-guard56.invalid"), 0.01);
});

it("SDK signed response stall is bounded and flagged as unknown, not unpaid", async () => {
  prepare({ X402_PAID_TIMEOUT_MS: "160", X402_PRE_SIGN_TIMEOUT_MS: "120" });
  const u = "https://paid-stall56.invalid/get";
  let calls = 0, signed = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    if (signingHeader(input, init)) {
      signed++;
      // A stubborn fetch ignores abort; transport must still settle the tool.
      await new Promise((resolve) => setTimeout(resolve, 350));
      return new Response('{"result":"late"}', { status: 200 });
    }
    return challenge(u);
  }) as typeof fetch;
  const prior = ledger().length;
  const result = await parsedCall(u);
  assert.equal(result.error_code, "timeout_after_payment");
  assert.equal(result.paid, "unknown");
  assert.equal(result.do_not_retry_blindly, true);
  assert.equal(signed, 1);
  assert.equal(calls, 3);
  assert.equal(ledger().slice(prior)[0].status, "unknown");
});

it("SDK pre-payment stall aborts without any signed request and zero spend", async () => {
  prepare({ X402_PAID_TIMEOUT_MS: "300", X402_PRE_SIGN_TIMEOUT_MS: "80" });
  const u = "https://pre-sign56.invalid/api";
  let probes = 0, unsigned = 0, signed = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (signingHeader(input, init)) {
      signed++;
      return new Response("unexpected signed", { status: 200 });
    }
    if (probes++ === 0) return challenge(u);
    unsigned++;
    await new Promise((resolve) => setTimeout(resolve, 170));
    return challenge(u);
  }) as typeof fetch;
  const prior = ledger().length;
  const result = await parsedCall(u);
  assert.equal(result.error_code, "timeout_before_payment");
  assert.equal(result.paid, false);
  assert.equal(signed, 0);
  assert.equal(unsigned, 1);
  assert.equal(ledger().slice(prior)[0].status, "failed");
});

it("oversized signed response body is refused and cost remains uncertain", async () => {
  prepare();
  const u = "https://body-bound56.invalid/get";
  let steps = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (signingHeader(input, init)) {
      steps++;
      return new Response("x".repeat(513), { status: 200 });
    }
    return challenge(u);
  }) as typeof fetch;
  const prev = ledger().length;
  const result = await parsedCall(u);
  assert.equal(steps, 1);
  assert.equal(result.error_code, "response_too_large");
  assert.equal(result.paid, "unknown");
  assert.equal(ledger().slice(prev)[0].status, "unknown");
});

it("oversized payment response header is not surfaced unbounded", async () => {
  prepare();
  const u = "https://header-bound56.invalid/get";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (signingHeader(input, init)) return new Response("OK", {
      status: 200, headers: { "payment-response": "X".repeat(65537) },
    });
    return challenge(u);
  }) as typeof fetch;
  const result = await parsedCall(u);
  assert.equal(result.error_code, "payment_header_too_large");
  assert.equal(result.paid, "unknown");
  assert.equal(result.do_not_retry_blindly, true);
});

it("a fast legitimate signed fetch is still successful and logged", async () => {
  prepare();
  const u = "https://happy-bound56.invalid/get";
  let signed = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (signingHeader(input, init)) {
      signed++;
      return new Response('{"result":"approved"}', { status: 200 });
    }
    return challenge(u);
  }) as typeof fetch;
  const prev = ledger().length;
  const result = await parsedCall(u);
  assert.equal(result.status, 200);
  assert.equal(result.paid, true);
  assert.deepEqual(result.body, { result: "approved" });
  assert.equal(signed, 1);
  assert.equal(ledger().slice(prev)[0].status, "success");
});

it("an invalid transport budget fails closed before any HTTP activity", async () => {
  prepare({ X402_PAID_MAX_BODY_BYTES: "10000000000" });
  const u = "https://config-bound56.invalid/api";
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return challenge(u); }) as typeof fetch;
  const result = await parsedCall(u);
  assert.equal(calls, 0);
  assert.equal(result.paid, false);
  assert.match(result.error, /Invalid x402 transport/);
});
