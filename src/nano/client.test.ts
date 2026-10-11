import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createNanoScheme, createRpcWalletSender, type NanoRpc } from "./client.js";

const SOURCE = "nano_1111111111111111111111111111111111111111111111111111hifc8npp";
const DEST = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";
const WALLET = "00".repeat(32);
const HASH = "AB".repeat(32);
const AMOUNT = 10n ** 27n;

/** A scripted node: records every call, answers send + block_info. */
function node(info: (call: number) => any, sendReply: any = { block: HASH }) {
  const calls: any[] = [];
  let infoCalls = 0;
  const rpc: NanoRpc = async (body) => {
    calls.push(body);
    if (body.action === "send") return sendReply;
    if (body.action === "block_info") return info(++infoCalls);
    throw new Error("unexpected action");
  };
  return { rpc, calls };
}
const blockInfo = (confirmed: string, changes: any = {}) => ({
  block_account: SOURCE, amount: AMOUNT.toString(), subtype: "send", confirmed,
  contents: { type: "state", link_as_account: DEST }, ...changes,
});
const fast = { sleep: async () => {}, pollIntervalMs: 1 };

describe("node wallet RPC sender", () => {
  it("sends exact raw with an idempotency id and returns the confirmed hash", async () => {
    const { rpc, calls } = node((n) => blockInfo(n < 3 ? "false" : "true"));
    const sender = createRpcWalletSender({ rpc, wallet: WALLET, source: SOURCE, ...fast });
    let published = "";
    const hash = await sender.send({ destination: DEST, amountRaw: AMOUNT, id: "x402-test", onPublished: (h) => { published = h; } });
    assert.equal(hash, HASH);
    assert.equal(published, HASH);
    assert.deepEqual(calls[0], { action: "send", wallet: WALLET, source: SOURCE, destination: DEST, amount: AMOUNT.toString(), id: "x402-test" });
    assert.equal(calls.filter((c) => c.action === "block_info").length, 3);
  });
  it("refuses a block that does not match the requested payment", async () => {
    for (const changes of [{ amount: "1" }, { subtype: "receive" }, { block_account: DEST }, { contents: { link_as_account: SOURCE } }]) {
      const { rpc } = node(() => blockInfo("true", changes));
      const sender = createRpcWalletSender({ rpc, wallet: WALLET, source: SOURCE, ...fast });
      await assert.rejects(sender.send({ destination: DEST, amountRaw: AMOUNT, id: "x" }), /does not match/);
    }
  });
  it("fails when confirmation does not arrive in time, after reporting the published hash", async () => {
    let t = 0;
    const { rpc } = node(() => blockInfo("false"));
    const sender = createRpcWalletSender({ rpc, wallet: WALLET, source: SOURCE, confirmTimeoutMs: 5, now: () => t++, ...fast });
    let published = "";
    await assert.rejects(sender.send({ destination: DEST, amountRaw: AMOUNT, id: "x", onPublished: (h) => { published = h; } }), /not confirmed in time/);
    assert.equal(published, HASH);
  });
  it("surfaces a node send error without a hash", async () => {
    const { rpc } = node(() => blockInfo("true"), { error: "Insufficient balance" });
    const sender = createRpcWalletSender({ rpc, wallet: WALLET, source: SOURCE, ...fast });
    await assert.rejects(sender.send({ destination: DEST, amountRaw: AMOUNT, id: "x" }), /did not return a send block hash/);
  });
  it("validates its own configuration", () => {
    const { rpc } = node(() => ({}));
    assert.throws(() => createRpcWalletSender({ rpc, wallet: WALLET, source: "nano_bad" }), /NANO_SOURCE_ACCOUNT/);
    assert.throws(() => createRpcWalletSender({ rpc, wallet: "xyz", source: SOURCE }), /NANO_WALLET_ID/);
  });
});

describe("nano exact scheme", () => {
  it("pays the offer's payTo the offer's raw amount and returns {blockHash}", async () => {
    const seen: any[] = [];
    const scheme = createNanoScheme({ send: async (req) => { seen.push(req); return HASH; } });
    const result = await scheme.createPaymentPayload(2, { scheme: "exact", network: "nano:mainnet", asset: "XNO", payTo: DEST, amount: AMOUNT.toString() });
    assert.deepEqual(result, { x402Version: 2, payload: { blockHash: HASH } });
    assert.equal(seen[0].destination, DEST);
    assert.equal(seen[0].amountRaw, AMOUNT);
    assert.match(seen[0].id, /^x402-/);
  });
  it("rejects a sender that returns something other than a block hash", async () => {
    const scheme = createNanoScheme({ send: async () => "not-a-hash" });
    await assert.rejects(scheme.createPaymentPayload(2, { network: "nano:mainnet", payTo: DEST, amount: "1" }), /invalid block hash/);
  });
});
