import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import {
  CasperFacilitatorClient,
  DEFAULT_CASPER_FACILITATOR_URL,
  defaultCasperKinds,
  getCasperFacilitatorUrl,
} from "./facilitator.js";

interface Call {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

/** Minimal fetch stub — records calls and replays queued responses. */
function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body, headers: init.headers });
    const next = responses.shift() ?? { status: 200, body: {} };
    const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      statusText: "",
      text: async () => text,
    } as any;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

afterEach(() => {
  delete process.env.CASPER_FACILITATOR_URL;
  delete process.env.CASPER_FACILITATOR_API_KEY;
});

describe("casper facilitator url", () => {
  it("defaults to the hosted facilitator", () => {
    assert.equal(getCasperFacilitatorUrl(), DEFAULT_CASPER_FACILITATOR_URL);
    assert.equal(DEFAULT_CASPER_FACILITATOR_URL, "https://x402-facilitator.cspr.cloud");
  });

  it("is overridable via CASPER_FACILITATOR_URL and strips trailing slashes", () => {
    process.env.CASPER_FACILITATOR_URL = "https://facilitator.internal/";
    assert.equal(getCasperFacilitatorUrl(), "https://facilitator.internal");
    assert.equal(new CasperFacilitatorClient().baseUrl, "https://facilitator.internal");
  });
});

describe("casper facilitator client", () => {
  it("GETs /supported and unwraps kinds", async () => {
    const { impl, calls } = stubFetch([
      { body: { kinds: [{ scheme: "exact", network: "casper:casper" }] } },
    ]);
    const client = new CasperFacilitatorClient({ url: "https://f.test", fetchImpl: impl });

    const kinds = await client.supported();

    assert.equal(calls[0].url, "https://f.test/supported");
    assert.equal(calls[0].method, "GET");
    assert.deepEqual(kinds, [{ scheme: "exact", network: "casper:casper" }]);
  });

  it("POSTs /verify with the payload and requirements", async () => {
    const { impl, calls } = stubFetch([{ body: { isValid: true, payer: "00ab" } }]);
    const client = new CasperFacilitatorClient({ url: "https://f.test", fetchImpl: impl });

    const result = await client.verify({ scheme: "exact" }, { network: "casper:casper" });

    assert.equal(calls[0].url, "https://f.test/verify");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(JSON.parse(calls[0].body as string), {
      paymentPayload: { scheme: "exact" },
      paymentRequirements: { network: "casper:casper" },
    });
    assert.equal(result.isValid, true);
    assert.equal(result.payer, "00ab");
  });

  it("POSTs /settle and returns the transaction hash", async () => {
    const { impl, calls } = stubFetch([{ body: { success: true, transaction: "deadbeef", network: "casper:casper" } }]);
    const client = new CasperFacilitatorClient({ url: "https://f.test", fetchImpl: impl });

    const result = await client.settle({}, {});

    assert.equal(calls[0].url, "https://f.test/settle");
    assert.equal(result.success, true);
    assert.equal(result.transaction, "deadbeef");
  });

  it("sends the API key when one is configured", async () => {
    const { impl, calls } = stubFetch([{ body: { kinds: [] } }]);
    const client = new CasperFacilitatorClient({ url: "https://f.test", apiKey: "secret", fetchImpl: impl });

    await client.supported();

    assert.equal(calls[0].headers?.Authorization, "secret");
  });

  it("surfaces HTTP errors with the facilitator's reason", async () => {
    const { impl } = stubFetch([{ status: 401, body: { error: "authorization is not provided" } }]);
    const client = new CasperFacilitatorClient({ url: "https://f.test", fetchImpl: impl });

    await assert.rejects(() => client.supported(), /\/supported failed \(401\): authorization is not provided/);
  });

  it("reports network support from /supported", async () => {
    const { impl } = stubFetch([{ body: { kinds: [{ scheme: "exact", network: "casper:casper-test" }] } }]);
    const client = new CasperFacilitatorClient({ url: "https://f.test", fetchImpl: impl });

    assert.equal(await client.supportsNetwork("casper:casper-test"), true);
  });

  it("falls back to the known networks when the facilitator is unreachable", async () => {
    const failing = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new CasperFacilitatorClient({ url: "https://f.test", fetchImpl: failing });

    assert.equal(await client.supportsNetwork("casper:casper"), true);
    assert.equal(await client.supportsNetwork("eip155:8453"), false);
  });
});

describe("default casper kinds", () => {
  it("advertises exact on both networks with wCSPR at 9 decimals", () => {
    const kinds = defaultCasperKinds();
    assert.deepEqual(
      kinds.map((k) => k.network),
      ["casper:casper", "casper:casper-test"],
    );
    assert.ok(kinds.every((k) => k.scheme === "exact"));
    assert.deepEqual(kinds[0].extra, { asset: "wCSPR", decimals: 9 });
  });
});
