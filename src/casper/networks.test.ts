import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  CASPER_MAINNET_CAIP2,
  CASPER_TESTNET_CAIP2,
  casperChainName,
  csprToMotes,
  isCasperNetwork,
  motesToCspr,
  parseMaxAmountRequired,
  toCasperCaip2,
} from "./networks.js";

describe("casper network detection", () => {
  it("recognises the CAIP-2 network ids", () => {
    assert.equal(isCasperNetwork("casper:casper"), true);
    assert.equal(isCasperNetwork("casper:casper-test"), true);
  });

  it("recognises bare network names", () => {
    assert.equal(isCasperNetwork("casper"), true);
    assert.equal(isCasperNetwork("casper-test"), true);
    assert.equal(isCasperNetwork("CASPER:CASPER-TEST"), true);
  });

  it("does not claim other chains", () => {
    assert.equal(isCasperNetwork("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), false);
    assert.equal(isCasperNetwork("eip155:8453"), false);
    assert.equal(isCasperNetwork(""), false);
  });

  it("normalises to CAIP-2", () => {
    assert.equal(toCasperCaip2("casper"), CASPER_MAINNET_CAIP2);
    assert.equal(toCasperCaip2("casper:casper"), CASPER_MAINNET_CAIP2);
    assert.equal(toCasperCaip2("casper-test"), CASPER_TESTNET_CAIP2);
    assert.equal(toCasperCaip2("casper:casper-test"), CASPER_TESTNET_CAIP2);
  });

  it("rejects unknown casper networks", () => {
    assert.throws(() => toCasperCaip2("casper:dev"), /Unknown Casper network/);
  });

  it("maps CAIP-2 ids to node chain names", () => {
    assert.equal(casperChainName("casper:casper"), "casper");
    assert.equal(casperChainName("casper:casper-test"), "casper-test");
  });
});

describe("mote conversion", () => {
  it("converts whole CSPR to motes", () => {
    assert.equal(csprToMotes("1"), 1_000_000_000n);
    assert.equal(csprToMotes("0"), 0n);
    assert.equal(csprToMotes(2.5), 2_500_000_000n);
  });

  it("keeps full 9-decimal precision", () => {
    assert.equal(csprToMotes("0.000000001"), 1n);
    assert.equal(csprToMotes("1.234567891"), 1_234_567_891n);
  });

  it("handles amounts too large for a JS number exactly", () => {
    assert.equal(csprToMotes("9007199254.740993"), 9_007_199_254_740_993_000n);
  });

  it("throws on sub-mote precision instead of rounding", () => {
    assert.throws(() => csprToMotes("0.0000000001"), /sub-mote precision/);
    assert.throws(() => csprToMotes("1.1234567891"), /sub-mote precision/);
  });

  it("allows trailing zeros beyond 9 decimals", () => {
    assert.equal(csprToMotes("1.2345678910000"), 1_234_567_891n);
  });

  it("rejects malformed and negative amounts", () => {
    assert.throws(() => csprToMotes("abc"), /Invalid CSPR amount/);
    assert.throws(() => csprToMotes(""), /Invalid CSPR amount/);
    assert.throws(() => csprToMotes("-1"), /cannot be negative/);
  });

  it("round-trips motes back to CSPR", () => {
    assert.equal(motesToCspr(1_000_000_000n), "1");
    assert.equal(motesToCspr(1n), "0.000000001");
    assert.equal(motesToCspr(1_234_567_891n), "1.234567891");
    assert.equal(motesToCspr("2500000000"), "2.5");
    assert.equal(motesToCspr(0n), "0");
  });
});

describe("maxAmountRequired parsing", () => {
  it("parses integer motes", () => {
    assert.equal(parseMaxAmountRequired("1000000000"), 1_000_000_000n);
    assert.equal(parseMaxAmountRequired(500), 500n);
  });

  it("rejects decimal or missing values", () => {
    assert.throws(() => parseMaxAmountRequired("0.5"), /integer amount of motes/);
    assert.throws(() => parseMaxAmountRequired(undefined), /missing/);
  });
});
