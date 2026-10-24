// Issue #55 — the challenge-scope boundary.
//
// RED commit by design (plan C1): this file pins the contract that a 402
// challenge/offer must satisfy BEFORE the agent will ever bind it into a
// PaymentIntent or sign for it. The boundary does not exist yet, so this
// file fails to compile until the implementation commit adds
// ./challenge-scope.ts — that is the stated failure, not a bug.
//
// The tests are hermetic: throwaway base58 placeholders (no key material,
// no network), the SDK's well-known protocol constants for assets/networks,
// and no clocks — the boundary API must be explicit-config-only so the
// scope itself is deterministic for a given challenge.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  configFromEnv,
  scopeOf,
  DEFAULT_ALLOWED_EXTENSIONS,
  DEFAULT_CHALLENGE_MAX_TIMEOUT_SECONDS,
  KNOWN_SAFE_EXTRA_KEYS,
  type ChallengeScopeConfig,
  type ScopeResult,
  type ScopeRefusalCode,
} from "./challenge-scope.js";

/** Throwaway base58 placeholders — never real key or wallet material. */
const PAYER_B58 = "2" + "3".repeat(43);
const STRANGER_FEE_PAYER_B58 = "4" + "5".repeat(43);
const OTHER_B58 = "6" + "7".repeat(43);

const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzBCKp7DvX";

function baseConfig(overrides: Partial<ChallengeScopeConfig> = {}): ChallengeScopeConfig {
  return {
    allowedExtensions: [...DEFAULT_ALLOWED_EXTENSIONS],
    maxTimeoutSeconds: DEFAULT_CHALLENGE_MAX_TIMEOUT_SECONDS,
    allowSelfFeePayer: false,
    feePayerAllowlist: [],
    maxMemoBytes: 64,
    allowedExtraKeys: [],
    ...overrides,
  };
}

interface AcceptPatch {
  [key: string]: unknown;
}

function solanaAccept(patch: AcceptPatch = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: SOLANA_CAIP2,
    amount: "10000",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payTo: STRANGER_FEE_PAYER_B58,
    maxTimeoutSeconds: 60,
    ...patch,
  };
}

/** Narrow an accepted result to its bound scope, naming refusals loudly.
 * (The tsconfig runs with strict:false, which disables union narrowing —
 * shape casts are explicit here.) */
function boundScope(result: ScopeResult): Record<string, unknown> {
  const refusal = result as unknown as { ok: unknown; code: string; field: string };
  if (refusal.ok !== true) {
    throw new Error(`expected a bound scope, got refusal ${refusal.code} (${refusal.field})`);
  }
  return (result as unknown as { scope: Record<string, unknown> }).scope;
}

/** Assert a refusal with an exact fixed code (and field when given). */
function mustRefuse(result: ScopeResult, code: ScopeRefusalCode, field?: string): void {
  const refusal = result as unknown as { ok: unknown; code: string; field: string };
  if (refusal.ok === true) {
    assert.fail(`expected refusal ${code}, got ok`);
  }
  assert.equal(refusal.code, code);
  if (field !== undefined) assert.equal(refusal.field, field);
}

describe("challenge scope boundary (issue #55)", () => {
  describe("extensions", () => {
    it("binds the extension key set that will be signed, sorted", () => {
      const scope = boundScope(
        scopeOf(
          { ...solanaAccept(), extensions: { bazaar: { info: { x: 1 } } } },
          { payerAddress: PAYER_B58, config: baseConfig() },
        ),
      );
      assert.deepEqual(scope.extensionKeys, ["bazaar"]);
    });

    it("sorts extension keys so the intent hash is order-independent", () => {
      const scope = boundScope(
        scopeOf(
          { ...solanaAccept(), extensions: { bazaar: {}, zeta: {} } },
          { payerAddress: PAYER_B58, config: baseConfig({ allowedExtensions: ["bazaar", "zeta"] }) },
        ),
      );
      assert.deepEqual(scope.extensionKeys, ["bazaar", "zeta"]);
    });

    it("an accept without extensions carries an empty extension set", () => {
      const scope = boundScope(scopeOf(solanaAccept(), { payerAddress: PAYER_B58, config: baseConfig() }));
      assert.deepEqual(scope.extensionKeys, []);
    });

    it("an unknown extension is refused with a fixed code and the offending key", () => {
      const result = scopeOf(
        { ...solanaAccept(), extensions: { bazaar: {}, "not-allowed": {} } },
        { payerAddress: PAYER_B58, config: baseConfig() },
      );
      mustRefuse(result, "EXTENSION_NOT_ALLOWED", "not-allowed");
    });

    it("allowed extensions are configurable but defaults never widen", () => {
      const refused = scopeOf(
        { ...solanaAccept(), extensions: { extra: {} } },
        { payerAddress: PAYER_B58, config: baseConfig() },
      );
      mustRefuse(refused, "EXTENSION_NOT_ALLOWED", "extra");
      const ok = scopeOf(
        { ...solanaAccept(), extensions: { extra: {} } },
        { payerAddress: PAYER_B58, config: baseConfig({ allowedExtensions: ["bazaar", "extra"] }) },
      );
      assert.equal(ok.ok, true);
    });
  });

  describe("validity window", () => {
    it("maxTimeoutSeconds must be a finite positive number", () => {
      for (const bad of [0, -5, NaN, Infinity, "60", null]) {
        const result = scopeOf(solanaAccept({ maxTimeoutSeconds: bad }), {
          payerAddress: PAYER_B58,
          config: baseConfig(),
        });
        mustRefuse(result, "VALIDITY_WINDOW_INVALID", "maxTimeoutSeconds");
      }
    });

    it("maxTimeoutSeconds above the configured cap is refused (VALIDITY_WINDOW_TOO_LONG)", () => {
      mustRefuse(
        scopeOf(solanaAccept({ maxTimeoutSeconds: 301 }), { payerAddress: PAYER_B58, config: baseConfig() }),
        "VALIDITY_WINDOW_TOO_LONG",
        "maxTimeoutSeconds",
      );
    });

    it("maxTimeoutSeconds at or under the cap is accepted and bound", () => {
      for (const okSeconds of [300, 60, 1]) {
        const scope = boundScope(
          scopeOf(solanaAccept({ maxTimeoutSeconds: okSeconds }), {
            payerAddress: PAYER_B58,
            config: baseConfig(),
          }),
        );
        assert.equal(scope.maxTimeoutSeconds, okSeconds);
      }
    });

    it("a tightened operator cap refuses longer windows and never clamps them", () => {
      mustRefuse(
        scopeOf(solanaAccept({ maxTimeoutSeconds: 60 }), {
          payerAddress: PAYER_B58,
          config: baseConfig({ maxTimeoutSeconds: 30 }),
        }),
        "VALIDITY_WINDOW_TOO_LONG",
        "maxTimeoutSeconds",
      );
    });
  });

  describe("extra keys", () => {
    it("unknown extra keys are refused (TRANSFER_METHOD_NOT_ALLOWED)", () => {
      mustRefuse(
        scopeOf(solanaAccept({ extra: { recentBlockhash: "BHB", name: "USD Coin", version: "2" } }), {
          payerAddress: PAYER_B58,
          config: baseConfig(),
        }),
        "TRANSFER_METHOD_NOT_ALLOWED",
        "extra.recentBlockhash",
      );
    });

    it("a call-site-allowlisted extra key (the payload block hint) is accepted", () => {
      const result = scopeOf(solanaAccept({ extra: { recentBlockhash: "BHB", name: "USDC" } }), {
        payerAddress: PAYER_B58,
        config: baseConfig({ allowedExtraKeys: ["recentBlockhash"] }),
      });
      assert.equal(result.ok, true);
    });

    it("known-safe extra keys never need configuration", () => {
      assert.deepEqual([...KNOWN_SAFE_EXTRA_KEYS].sort(), [
        "feePayer",
        "lastValidBlockHeight",
        "memo",
        "name",
        "version",
      ]);
      const result = scopeOf(
        solanaAccept({
          extra: { name: "USD Coin", version: "2", feePayer: OTHER_B58, memo: "m" },
        }),
        { payerAddress: PAYER_B58, config: baseConfig() },
      );
      assert.equal(result.ok, true);
    });

    it("a non-object extra is refused", () => {
      mustRefuse(scopeOf(solanaAccept({ extra: "x" }), { payerAddress: PAYER_B58, config: baseConfig() }),
        "TRANSFER_METHOD_NOT_ALLOWED");
    });
  });

  describe("fee payer rule", () => {
    it("a self fee payer is refused (the agent never pays its own fee)", () => {
      mustRefuse(
        scopeOf(solanaAccept({ extra: { feePayer: PAYER_B58 } }), { payerAddress: PAYER_B58, config: baseConfig() }),
        "FEE_PAYER_REFUSED",
        "extra.feePayer",
      );
    });

    it("a self fee payer is allowed only when the operator opted in", () => {
      const result = scopeOf(solanaAccept({ extra: { feePayer: PAYER_B58 } }), {
        payerAddress: PAYER_B58,
        config: baseConfig({ allowSelfFeePayer: true }),
      });
      assert.equal(result.ok, true);
    });

    it("a fee payer outside a non-empty operator allowlist is refused", () => {
      mustRefuse(
        scopeOf(solanaAccept({ extra: { feePayer: OTHER_B58 } }), {
          payerAddress: PAYER_B58,
          config: baseConfig({ feePayerAllowlist: [STRANGER_FEE_PAYER_B58] }),
        }),
        "FEE_PAYER_REFUSED",
      );
      const allowed = scopeOf(solanaAccept({ extra: { feePayer: STRANGER_FEE_PAYER_B58 } }), {
        payerAddress: PAYER_B58,
        config: baseConfig({ feePayerAllowlist: [STRANGER_FEE_PAYER_B58] }),
      });
      assert.equal(allowed.ok, true);
    });

    it("an empty allowlist accepts any well-formed non-self fee payer and binds it", () => {
      const result = scopeOf(solanaAccept({ extra: { feePayer: OTHER_B58 } }), {
        payerAddress: PAYER_B58,
        config: baseConfig({ feePayerAllowlist: [] }),
      });
      assert.equal(boundScope(result).solanaFeePayer, OTHER_B58);
    });

    it("a malformed fee payer value is refused", () => {
      for (const bad of ["", "not base58! (0OIl)", 42, null]) {
        mustRefuse(scopeOf(solanaAccept({ extra: { feePayer: bad } }), {
          payerAddress: PAYER_B58,
          config: baseConfig(),
        }), "FEE_PAYER_REFUSED");
      }
    });
  });

  describe("memo rule", () => {
    it("a memo within the byte cap and printable ASCII is accepted and bound", () => {
      const memo = "m".repeat(64);
      const scope = boundScope(
        scopeOf(solanaAccept({ extra: { memo } }), { payerAddress: PAYER_B58, config: baseConfig() }),
      );
      assert.equal(scope.memo, memo);
    });

    it("an over-long or non-printable memo is refused (MEMO_INVALID)", () => {
      for (const bad of ["m".repeat(65), "héllo", "tab\there", "\u0001bell"]) {
        mustRefuse(scopeOf(solanaAccept({ extra: { memo: bad } }), {
          payerAddress: PAYER_B58,
          config: baseConfig(),
        }), "MEMO_INVALID", "memo");
      }
    });
  });

  describe("block hint rule", () => {
    it("a well-formed lastValidBlockHeight is accepted (not bound for equality)", () => {
      for (const good of ["421", 421]) {
        const scope = boundScope(
          scopeOf(solanaAccept({ extra: { lastValidBlockHeight: good } }), {
            payerAddress: PAYER_B58,
            config: baseConfig(),
          }),
        );
        assert.ok(!("lastValidBlockHeight" in scope), "a volatile block hint is never bound");
      }
    });

    it("a bad block hint is refused (BLOCK_HINT_INVALID)", () => {
      for (const bad of ["", "abc", "12.5", -1, 1.5, NaN, Infinity, {}]) {
        mustRefuse(scopeOf(solanaAccept({ extra: { lastValidBlockHeight: bad } }), {
          payerAddress: PAYER_B58,
          config: baseConfig(),
        }), "BLOCK_HINT_INVALID", "lastValidBlockHeight");
      }
    });
  });

  describe("transfer method", () => {
    it("only the exact scheme is accepted", () => {
      for (const bad of ["ujwt", "", undefined]) {
        mustRefuse(
          scopeOf(solanaAccept({ scheme: bad }), { payerAddress: PAYER_B58, config: baseConfig() }),
          "TRANSFER_METHOD_NOT_ALLOWED",
        );
      }
    });

    it("a non-object accept is refused, never defaulted", () => {
      for (const bad of [null, undefined, 42, "x"]) {
        mustRefuse(scopeOf(bad, { payerAddress: PAYER_B58, config: baseConfig() }), "TRANSFER_METHOD_NOT_ALLOWED");
      }
    });
  });

  describe("bound scope contents", () => {
    it("binds exactly the declared fields and nothing else", () => {
      const scope = boundScope(
        scopeOf(
          {
            ...solanaAccept(),
            extra: {
              name: "USD Coin",
              version: "2",
              feePayer: OTHER_B58,
              memo: "hello",
              lastValidBlockHeight: "421",
            },
          },
          { payerAddress: PAYER_B58, config: baseConfig() },
        ),
      );
      assert.deepEqual(scope, {
        extensionKeys: [],
        maxTimeoutSeconds: 60,
        evmDomainName: "USD Coin",
        evmDomainVersion: "2",
        solanaFeePayer: OTHER_B58,
        memo: "hello",
      });
    });

    it("omits (does not null) optional fields the challenge did not carry", () => {
      const scope = boundScope(scopeOf(solanaAccept(), { payerAddress: PAYER_B58, config: baseConfig() }));
      assert.ok(!("evmDomainName" in scope));
      assert.ok(!("evmDomainVersion" in scope));
      assert.ok(!("solanaFeePayer" in scope));
      assert.ok(!("memo" in scope));
      assert.deepEqual(Object.keys(scope).sort(), ["extensionKeys", "maxTimeoutSeconds"]);
    });

    it("the scope is a pure function of the accept and the explicit config", () => {
      const accept = { ...solanaAccept(), extra: { name: "USD Coin" } };
      const a = scopeOf(accept, { payerAddress: PAYER_B58, config: baseConfig() });
      const b = scopeOf(accept, { payerAddress: PAYER_B58, config: baseConfig() });
      assert.deepEqual(a, b, "same inputs, same scope — no hidden clock or env reads");
    });
  });

  describe("configFromEnv", () => {
    it("defaults match the shipped policy", () => {
      const config = configFromEnv({}, {});
      assert.deepEqual([...config.allowedExtensions], ["bazaar"]);
      assert.equal(config.maxTimeoutSeconds, DEFAULT_CHALLENGE_MAX_TIMEOUT_SECONDS);
      assert.equal(config.allowSelfFeePayer, false);
      assert.deepEqual([...config.feePayerAllowlist], []);
      assert.equal(config.maxMemoBytes, 64);
      assert.deepEqual([...config.allowedExtraKeys], []);
    });

    it("parses operator configuration", () => {
      const config = configFromEnv(
        {
          X402_ALLOWED_EXTENSIONS: "bazaar,extra",
          X402_MAX_CHALLENGE_TIMEOUT_SECONDS: "120",
          X402_ALLOW_SELF_FEE_PAYER: "1",
          X402_FEE_PAYER_ALLOWLIST: `${STRANGER_FEE_PAYER_B58},${OTHER_B58}`,
          X402_MAX_MEMO_BYTES: "32",
        },
        { extraAllowedKeys: ["recentBlockhash"] },
      );
      assert.deepEqual([...config.allowedExtensions], ["bazaar", "extra"]);
      assert.equal(config.maxTimeoutSeconds, 120);
      assert.equal(config.allowSelfFeePayer, true);
      assert.deepEqual([...config.feePayerAllowlist], [STRANGER_FEE_PAYER_B58, OTHER_B58]);
      assert.equal(config.maxMemoBytes, 32);
      assert.ok(config.allowedExtraKeys.includes("recentBlockhash"));
    });

    it("throws on malformed numbers and flags (fail closed)", () => {
      for (const [key, value] of [
        ["X402_MAX_CHALLENGE_TIMEOUT_SECONDS", "abc"],
        ["X402_MAX_CHALLENGE_TIMEOUT_SECONDS", "300.5"],
        ["X402_MAX_CHALLENGE_TIMEOUT_SECONDS", "-1"],
        ["X402_MAX_MEMO_BYTES", "abc"],
        ["X402_MAX_MEMO_BYTES", "6.5"],
        ["X402_ALLOWED_EXTENSIONS", "bazaar,,x"],
        ["X402_FEE_PAYER_ALLOWLIST", "a,,b"],
        ["X402_ALLOW_SELF_FEE_PAYER", "yes"],
        ["X402_ALLOW_SELF_FEE_PAYER", "enabled"],
        ["X402_ALLOWED_EXTRA_KEYS", "a,,b"],
      ] as const) {
        assert.throws(() => configFromEnv({ [key]: value }, {}), `throws on ${key}=${value}`);
      }
    });
  });
});