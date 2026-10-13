import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { blake2b, isValidNanoAddress, nanoAddressToPublicKey, normalizeNanoAddress, publicKeyToNanoAddress } from "./address.js";

// Published ledger constants: the genesis account and the all-zero burn account.
const GENESIS_KEY = "E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA";
const GENESIS = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";
const BURN = "nano_1111111111111111111111111111111111111111111111111111hifc8npp";

describe("blake2b", () => {
  it("matches node's blake2b512 across block boundaries", () => {
    for (const len of [0, 1, 64, 127, 128, 129, 256, 300]) {
      const input = Buffer.alloc(len, len & 0xff);
      assert.equal(Buffer.from(blake2b(input, 64)).toString("hex"), createHash("blake2b512").update(input).digest("hex"), `len ${len}`);
    }
  });
  it("rejects invalid digest lengths", () => {
    assert.throws(() => blake2b(new Uint8Array(1), 0));
    assert.throws(() => blake2b(new Uint8Array(1), 65));
  });
});

describe("nano address codec", () => {
  it("encodes known public keys to their published addresses", () => {
    assert.equal(publicKeyToNanoAddress(Buffer.from(GENESIS_KEY, "hex")), GENESIS);
    assert.equal(publicKeyToNanoAddress(new Uint8Array(32)), BURN);
  });
  it("decodes back to the same key", () => {
    assert.equal(Buffer.from(nanoAddressToPublicKey(GENESIS)!).toString("hex").toUpperCase(), GENESIS_KEY);
  });
  it("rejects a wrong checksum, never repairs it", () => {
    assert.equal(isValidNanoAddress(GENESIS.slice(0, -1) + "4"), false);
    assert.equal(normalizeNanoAddress(GENESIS.slice(0, -1) + "4"), undefined);
  });
  it("rejects a flipped key character even with the original checksum", () => {
    assert.equal(isValidNanoAddress(GENESIS.replace("nano_3t6k", "nano_3t6m")), false);
  });
  it("rejects characters outside the alphabet, bad prefixes, lengths and padding", () => {
    for (const bad of [
      GENESIS.replace("nano_3t6k", "nano_3t0k"), // 0 is not in the alphabet
      GENESIS.replace("nano_3t6k", "nano_3t2k"), // nor is 2
      GENESIS.toUpperCase(),
      GENESIS.replace("nano_", "ban_"),
      GENESIS.slice(0, -2),
      GENESIS + "1",
      "nano_4" + GENESIS.slice(6), // top 4 bits must be zero
      "",
    ]) assert.equal(isValidNanoAddress(bad), false, bad);
  });
  it("accepts the legacy xrb_ prefix and canonicalises it to nano_", () => {
    assert.equal(normalizeNanoAddress(GENESIS.replace("nano_", "xrb_")), GENESIS);
    assert.equal(normalizeNanoAddress(`  ${GENESIS}  `), GENESIS);
  });
});
