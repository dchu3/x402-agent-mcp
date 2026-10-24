import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isNanoNetwork, MAX_RAW, NANO_MAINNET_CAIP2, rawToXno, toNanoCaip2, xnoToRaw } from "./networks.js";

describe("nano network detection", () => {
  it("recognises the CAIP-2 id and the bare name", () => {
    assert.equal(isNanoNetwork("nano:mainnet"), true);
    assert.equal(isNanoNetwork("NANO:MAINNET"), true);
    assert.equal(isNanoNetwork("nano"), true);
  });
  it("does not claim other chains or invented networks", () => {
    for (const n of ["casper:casper", "eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "nano:beta", "nanonano", ""]) {
      assert.equal(isNanoNetwork(n), false, n);
    }
  });
  it("normalises to CAIP-2 and rejects unknown spellings", () => {
    assert.equal(toNanoCaip2("nano"), NANO_MAINNET_CAIP2);
    assert.throws(() => toNanoCaip2("nano:testnet"), /Unknown Nano network/);
  });
});

describe("raw conversion (1 XNO = 10^30 raw)", () => {
  it("converts whole and fractional XNO exactly", () => {
    assert.equal(xnoToRaw("1"), 10n ** 30n);
    assert.equal(xnoToRaw("0.001"), 10n ** 27n);
    assert.equal(xnoToRaw("0.000000000000000000000000000001"), 1n);
    assert.equal(xnoToRaw(2n), 2n * 10n ** 30n);
  });
  it("refuses a JS number instead of formatting float noise into raw", () => {
    for (const n of [2.5, 0.1, 1, 0, 1e-7, Number.NaN]) {
      assert.throws(() => xnoToRaw(n as any), /decimal string or bigint/, String(n));
    }
    assert.throws(() => xnoToRaw(undefined as any), /decimal string or bigint/);
    assert.throws(() => xnoToRaw(-1n), /negative/);
    assert.throws(() => xnoToRaw(1n << 100n), /128-bit/);
  });
  it("refuses sub-raw precision instead of rounding, but allows trailing zeros", () => {
    assert.throws(() => xnoToRaw("0.0000000000000000000000000000001"), /sub-raw/);
    assert.equal(xnoToRaw("1.0000000000000000000000000000000000"), 10n ** 30n);
  });
  it("rejects malformed, negative and over-uint128 amounts", () => {
    assert.throws(() => xnoToRaw("abc"), /Invalid XNO amount/);
    assert.throws(() => xnoToRaw("-1"), /negative/);
    assert.throws(() => xnoToRaw("1e3"), /Invalid XNO amount/);
    assert.throws(() => xnoToRaw("340282366920939"), /128-bit/);
  });
  it("round-trips raw back to XNO without precision loss", () => {
    assert.equal(rawToXno(10n ** 30n), "1");
    assert.equal(rawToXno(1n), "0.000000000000000000000000000001");
    assert.equal(rawToXno("1234567890123456789012345678901"), "1.234567890123456789012345678901");
    assert.equal(rawToXno(0n), "0");
    assert.equal(xnoToRaw(rawToXno(MAX_RAW)), MAX_RAW);
  });
});
