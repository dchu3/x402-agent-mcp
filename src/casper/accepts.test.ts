import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertPayableCasperAccept, findCasperAccepts, selectCasperAccept } from "./accepts.js";

const wcspr = "0f2a1cd0c2a2f4e6a0b8d1e2f3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6";

function response(...accepts: any[]) {
  return { x402Version: 2, accepts };
}

const solanaAccept = {
  scheme: "exact",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  maxAmountRequired: "3000",
  payTo: "8Y7...",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

const casperMainnet = {
  scheme: "exact",
  network: "casper:casper",
  maxAmountRequired: "1000000000",
  payTo: "00a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  asset: wcspr,
  maxTimeoutSeconds: 60,
};

const casperTestnet = { ...casperMainnet, network: "casper:casper-test", maxAmountRequired: "250000000" };

describe("casper accepts parsing", () => {
  it("finds only the casper entries", () => {
    const found = findCasperAccepts(response(solanaAccept, casperMainnet, casperTestnet));
    assert.equal(found.length, 2);
    assert.deepEqual(
      found.map((a) => a.network),
      ["casper:casper", "casper:casper-test"],
    );
  });

  it("returns nothing when no casper option is offered", () => {
    assert.deepEqual(findCasperAccepts(response(solanaAccept)), []);
    assert.deepEqual(findCasperAccepts({}), []);
  });

  it("supports the legacy singular accept field", () => {
    assert.equal(findCasperAccepts({ accept: casperMainnet }).length, 1);
  });

  it("ignores schemes other than exact", () => {
    assert.deepEqual(findCasperAccepts(response({ ...casperMainnet, scheme: "upto" })), []);
  });

  it("prefers mainnet when both networks are offered", () => {
    const picked = selectCasperAccept(response(casperTestnet, casperMainnet));
    assert.equal(picked?.network, "casper:casper");
  });

  it("honours an explicit network hint", () => {
    const picked = selectCasperAccept(response(casperMainnet, casperTestnet), "casper-test");
    assert.equal(picked?.network, "casper:casper-test");
    assert.equal(picked?.maxAmountRequired, "250000000");
  });

  it("falls back to what is on offer when the hint is unavailable", () => {
    const picked = selectCasperAccept(response(casperTestnet), "casper:casper");
    assert.equal(picked?.network, "casper:casper-test");
  });

  it("returns undefined when there is nothing to pay", () => {
    assert.equal(selectCasperAccept(response(solanaAccept)), undefined);
  });
});

describe("casper accepts validation", () => {
  it("accepts a complete requirement", () => {
    assert.doesNotThrow(() => assertPayableCasperAccept(casperMainnet));
  });

  it("rejects incomplete requirements", () => {
    assert.throws(() => assertPayableCasperAccept({ ...casperMainnet, payTo: undefined }), /payTo/);
    assert.throws(() => assertPayableCasperAccept({ ...casperMainnet, asset: undefined }), /wCSPR asset/);
    assert.throws(
      () => assertPayableCasperAccept({ ...casperMainnet, maxAmountRequired: undefined }),
      /maxAmountRequired/,
    );
  });
});
