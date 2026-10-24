import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertPayableNanoAccept, findNanoAccepts, nanoAmountRaw, selectNanoAccept } from "./accepts.js";

const PAY_TO = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";
const nano = { scheme: "exact", network: "nano:mainnet", asset: "XNO", payTo: PAY_TO, amount: "1000000000000000000000000000", maxTimeoutSeconds: 60 };
const base = { scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x" + "ab".repeat(20), amount: "10000" };

describe("nano accepts parsing", () => {
  it("finds only exact nano entries, in server order", () => {
    assert.deepEqual(findNanoAccepts({ accepts: [base, nano, { ...nano, scheme: "upto" }] }), [nano]);
    assert.deepEqual(findNanoAccepts({}), []);
    assert.equal(findNanoAccepts({ accept: nano }).length, 1);
  });
  it("selects nano even when it is not accepts[0]", () => {
    assert.equal(selectNanoAccept({ accepts: [base, nano] })?.network, "nano:mainnet");
  });
  it("never falls back across an explicit network hint", () => {
    assert.equal(selectNanoAccept({ accepts: [nano] }, "nano:beta"), undefined);
    assert.equal(selectNanoAccept({ accepts: [nano] }, "nano")?.payTo, PAY_TO);
  });
});

describe("nano accepts validation", () => {
  it("accepts a complete requirement", () => {
    assert.doesNotThrow(() => assertPayableNanoAccept(nano));
    assert.equal(nanoAmountRaw(nano), 10n ** 27n);
  });
  it("rejects a bad payee, asset, scheme and amount", () => {
    assert.throws(() => assertPayableNanoAccept({ ...nano, payTo: PAY_TO.slice(0, -1) + "4" }), /checksum-valid/);
    assert.throws(() => assertPayableNanoAccept({ ...nano, payTo: undefined }), /payTo/);
    assert.throws(() => assertPayableNanoAccept({ ...nano, asset: "USDC" }), /asset "XNO"/);
    assert.throws(() => assertPayableNanoAccept({ ...nano, asset: undefined }), /asset "XNO"/);
    assert.throws(() => assertPayableNanoAccept({ ...nano, scheme: "upto" }), /exact/);
    for (const amount of ["0", "-1", "0.5", "1e30", "340282366920938463463374607431768211456", ""]) {
      assert.throws(() => assertPayableNanoAccept({ ...nano, amount }), /raw/, amount);
    }
    assert.throws(() => assertPayableNanoAccept({ ...nano, amount: 5 as any }), /raw/);
    assert.throws(() => nanoAmountRaw({ ...nano, maxAmountRequired: "2" }), /Conflicting/);
  });
});
