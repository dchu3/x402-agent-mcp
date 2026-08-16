import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import casperSdk from "casper-js-sdk";
import { classifyCasperKey, getCasperKeyAlgorithm } from "./client.js";

const { KeyAlgorithm } = casperSdk;

afterEach(() => {
  delete process.env.CASPER_KEY_ALGORITHM;
});

describe("casper key algorithm", () => {
  it("defaults to ed25519", () => {
    assert.equal(getCasperKeyAlgorithm(), KeyAlgorithm.ED25519);
  });

  it("supports secp256k1", () => {
    process.env.CASPER_KEY_ALGORITHM = "secp256k1";
    assert.equal(getCasperKeyAlgorithm(), KeyAlgorithm.SECP256K1);
    process.env.CASPER_KEY_ALGORITHM = "SECP-256K1";
    assert.equal(getCasperKeyAlgorithm(), KeyAlgorithm.SECP256K1);
  });

  it("rejects unknown algorithms", () => {
    process.env.CASPER_KEY_ALGORITHM = "rsa";
    assert.throws(() => getCasperKeyAlgorithm(), /Unsupported CASPER_KEY_ALGORITHM/);
  });
});

describe("casper key classification", () => {
  const hex = "a".repeat(64);

  it("detects raw hex secret keys", () => {
    assert.equal(classifyCasperKey(hex), "hex");
    assert.equal(classifyCasperKey(`0x${hex}`), "hex");
  });

  it("detects inline PEM contents", () => {
    assert.equal(classifyCasperKey("-----BEGIN PRIVATE KEY-----\nMC4C\n-----END PRIVATE KEY-----"), "pem");
  });

  it("detects PEM paths", () => {
    assert.equal(classifyCasperKey("/home/agent/secret_key.pem"), "pem-path");
    assert.equal(classifyCasperKey("keys/secret_key.pem"), "pem-path");
  });

  it("rejects empty or unrecognisable values", () => {
    assert.throws(() => classifyCasperKey(""), /CASPER_PRIVATE_KEY is empty/);
    assert.throws(() => classifyCasperKey("not-a-key"), /hex secret key, a PEM file path, or PEM contents/);
  });
});
