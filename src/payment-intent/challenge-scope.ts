// Issue #55 — the challenge-scope boundary.
//
// A 402 challenge (or an offer inside `accepts[]`) is SELLER-controlled.
// Before this module existed, the only thing standing between a challenge
// and a signature was the intent record's five field bindings (scheme,
// network, asset, amount, payTo) plus the SDK's own schema checks.
// Everything else a seller shipped in `extra` and `extensions` flowed to
// the signing code unchecked.
//
// This boundary is the contract a challenge must satisfy before the agent
// will ever bind it into a PaymentIntent or sign for it. It refuses with a
// fixed code; it never clamps, defaults or repairs a challenge (fail
// closed — the same rule the money path uses for amounts).
//
// Pure module: no fetch, no ledger, no policy import, no clock and no env
// reads — configuration is supplied explicitly (configFromEnv builds it
// from the environment; the fetch seams pass payment-path defaults that
// match what the SDK's own signing code already accepts). Keeping the
// scope itself free of hidden inputs makes a given challenge either
// always in scope or always refused for a given configuration.

/** Extensions that ship allowed. `bazaar` is the x402 discovery extension
 * (challenge extensions are otherwise unknown to this agent). Defaults
 * never widen: only operators, via X402_ALLOWED_EXTENSIONS, may add more. */
export const DEFAULT_ALLOWED_EXTENSIONS: readonly string[] = ["bazaar"];

/** Operator default for the maximum validity window (in seconds) a
 * challenge may request. Mirrors the shipping SDK's own payment window
 * cap; a challenge above it is refused, never clamped. */
export const DEFAULT_CHALLENGE_MAX_TIMEOUT_SECONDS = 300;

/** Default byte cap for a `extra.memo` the seller may attach. */
export const DEFAULT_MAX_MEMO_BYTES = 64;

/** Keys the SDK's exact-scheme signing code already reads from `extra`.
 * These are always in scope; their values still get the dedicated rules
 * (fee payer, memo, block hint) or are bound for exact equality (name /
 * version), so allowing the KEY never widens what can be signed. */
export const KNOWN_SAFE_EXTRA_KEYS: readonly string[] = [
  // EVM exact scheme: the EIP-712 domain fields — bound for equality.
  "name",
  "version",
  // SVM exact scheme: the sponsor that pays fee — refused when self.
  "feePayer",
  // SVM exact scheme: bound memo — byte-capped, printable ASCII only.
  "memo",
  // SVM exact scheme: a volatile block hint — shape-checked, never bound
  // for equality (it changes per block; pinning it would make honest
  // replays refused).
  "lastValidBlockHeight",
];

export type ScopeRefusalCode =
  | "EXTENSION_NOT_ALLOWED"
  | "TRANSFER_METHOD_NOT_ALLOWED"
  | "VALIDITY_WINDOW_INVALID"
  | "VALIDITY_WINDOW_TOO_LONG"
  | "FEE_PAYER_REFUSED"
  | "MEMO_INVALID"
  | "BLOCK_HINT_INVALID";

/** Fixed-shape refusal: our code, our field label, never seller text. */
export interface ScopeRefusal {
  ok: false;
  code: ScopeRefusalCode;
  field: string;
}

/** The fields a challenge contributes to the intent record (plus the
 * extension key set). Everything here is bound for exact equality at the
 * payment hook, except `maxTimeoutSeconds`/`extensionKeys`, which are
 * compared as values/sets (see payment-intent/manager.ts). */
export interface BoundScope {
  extensionKeys: string[];
  maxTimeoutSeconds: number;
  evmDomainName?: string;
  evmDomainVersion?: string;
  solanaFeePayer?: string;
  memo?: string;
}

export type ScopeResult = { ok: true; scope: BoundScope } | ScopeRefusal;

export interface ChallengeScopeConfig {
  /** Extension keys an accept may carry. Seller keys never widen it. */
  allowedExtensions: readonly string[];
  /** Operator cap on a challenge's maxTimeoutSeconds (fail closed). */
  maxTimeoutSeconds: number;
  /** Whether the agent may pay fee to its own address (issue #28 opt-in). */
  allowSelfFeePayer: boolean;
  /** When non-empty, a challenge's fee payer must be on this list. */
  feePayerAllowlist: readonly string[];
  /** Byte cap for `extra.memo`. */
  maxMemoBytes: number;
  /** Extra keys beyond KNOWN_SAFE_EXTRA_KEYS accepted on `extra`
   * (operator env allowlist merged with call-site additions such as the
   * payload block hint the fetch seam feeds the SDK). */
  allowedExtraKeys: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;
const DIGITS_RE = /^[0-9]+$/;

/** Compute the challenge scope for one accept entry. Refuses anything the
 * boundary does not allow; never clamps, defaults or repairs. */
export function scopeOf(
  accept: unknown,
  ctx: { payerAddress?: string; config: ChallengeScopeConfig },
): ScopeResult {
  const config = ctx.config;

  // 1. The accept must be an object. There is no default shape to fall
  //    back to: a blob we cannot inspect is out of scope.
  if (!isPlainObject(accept)) {
    return { ok: false, code: "TRANSFER_METHOD_NOT_ALLOWED", field: "accept" };
  }

  // 1. Only the exact scheme has a supported transfer method in this agent.
  if (accept.scheme !== "exact") {
    return { ok: false, code: "TRANSFER_METHOD_NOT_ALLOWED", field: "scheme" };
  }

  // 2. Extensions are allowlisted by KEY; the key set (sorted) is bound
  //    into the intent and compared exactly at the payment hook.
  const extensions = accept.extensions;
  if (extensions !== undefined && extensions !== null && !isPlainObject(extensions)) {
    return { ok: false, code: "EXTENSION_NOT_ALLOWED", field: "extensions" };
  }
  const extensionKeys: string[] = extensions
    ? Object.keys(extensions).sort()
    : [];
  for (const key of extensionKeys) {
    if (!config.allowedExtensions.includes(key)) {
      return { ok: false, code: "EXTENSION_NOT_ALLOWED", field: key };
    }
  }

  // 2. The validity window must be a finite positive number and within the
  //    operator's cap. Refused, never clamped.
  const maxTimeoutSeconds = accept.maxTimeoutSeconds;
  if (typeof maxTimeoutSeconds !== "number" || !Number.isFinite(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    return { ok: false, code: "VALIDITY_WINDOW_INVALID", field: "maxTimeoutSeconds" };
  }
  if (maxTimeoutSeconds > config.maxTimeoutSeconds) {
    return { ok: false, code: "VALIDITY_WINDOW_TOO_LONG", field: "maxTimeoutSeconds" };
  }

  // 2. Every extra key must be on the fixed known-safe set or on an
  //    explicit allowlist. An unknown key is refused; the value is never
  //    shipped to a signer.
  const extra = accept.extra;
  if (extra !== undefined && extra !== null && !isPlainObject(extra)) {
    return { ok: false, code: "TRANSFER_METHOD_NOT_ALLOWED", field: "extra" };
  }
  const extraObj: Record<string, unknown> = isPlainObject(extra) ? extra : {};
  for (const key of Object.keys(extraObj)) {
    if (!KNOWN_SAFE_EXTRA_KEYS.includes(key) && !config.allowedExtraKeys.includes(key)) {
      return { ok: false, code: "TRANSFER_METHOD_NOT_ALLOWED", field: `extra.${key}` };
    }
  }

  // 4. Fee payer: present values must be non-empty base58; a self fee
  //    payer is refused unless the operator opted in; an operator
  //    allowlist pins the set. The value is bound for exact equality.
  let solanaFeePayer: string | undefined;
  if (extraObj.feePayer !== undefined) {
    const feePayer = extraObj.feePayer;
    if (typeof feePayer !== "string" || feePayer.length === 0 || !BASE58_RE.test(feePayer)) {
      return { ok: false, code: "FEE_PAYER_REFUSED", field: "extra.feePayer" };
    }
    const isSelf = ctx.payerAddress !== undefined && feePayer === ctx.payerAddress;
    if (isSelf && !config.allowSelfFeePayer) {
      return { ok: false, code: "FEE_PAYER_REFUSED", field: "extra.feePayer" };
    }
    if (config.feePayerAllowlist.length > 0 && !config.feePayerAllowlist.includes(feePayer)) {
      return { ok: false, code: "FEE_PAYER_REFUSED", field: "extra.feePayer" };
    }
    solanaFeePayer = feePayer;
  }

  // 5. Memo: byte-capped printable ASCII; bound for exact equality.
  let memo: string | undefined;
  if (extraObj.memo !== undefined) {
    const value = extraObj.memo;
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > config.maxMemoBytes || !PRINTABLE_ASCII_RE.test(value)) {
      return { ok: false, code: "MEMO_INVALID", field: "memo" };
    }
    memo = value;
  }

  // 6. A block hint (recentBlockhash lives in the SDK's own extra key) is
  //    only shape-checked and NEVER bound for equality: it is volatile.
  const blockHeight = extraObj.lastValidBlockHeight;
  if (blockHeight !== undefined) {
    const okShape =
      (typeof blockHeight === "string" && DIGITS_RE.test(blockHeight)) ||
      (typeof blockHeight === "number" && Number.isSafeInteger(blockHeight) && blockHeight >= 0);
    if (!okShape) {
      return { ok: false, code: "BLOCK_HINT_INVALID", field: "lastValidBlockHeight" };
    }
  }

  // 2. The EIP-712 domain fields are known-safe keys, bound for exact
  //    equality when the challenge carries them.
  let evmDomainName: string | undefined;
  if (extraObj.name !== undefined) {
    const value = extraObj.name;
    if (typeof value !== "string") {
      return { ok: false, code: "TRANSFER_METHOD_NOT_ALLOWED", field: "extra.name" };
    }
    evmDomainName = value;
  }
  let evmDomainVersion: string | undefined;
  if (extraObj.version !== undefined) {
    const value = extraObj.version;
    if (typeof value !== "string") {
      return { ok: false, code: "TRANSFER_METHOD_NOT_ALLOWED", field: "extra.version" };
    }
    evmDomainVersion = value;
  }

  // Assemble the bound scope. Optional fields are omitted (not nulled) so
  // the intent record can carry exactly what the challenge declared.
  const scope: BoundScope = { extensionKeys, maxTimeoutSeconds };
  if (evmDomainName !== undefined) scope.evmDomainName = evmDomainName;
  if (evmDomainVersion !== undefined) scope.evmDomainVersion = evmDomainVersion;
  if (solanaFeePayer !== undefined) scope.solanaFeePayer = solanaFeePayer;
  if (memo !== undefined) scope.memo = memo;
  return { ok: true, scope };
}

function parseList(raw: string | undefined, envName: string): string[] {
  if (raw === undefined) return [];
  const parts = raw.split(",").map((p) => p.trim());
  for (const part of parts) {
    if (part === "") {
      throw new Error(`${envName}: list entries may not be empty (raw=${JSON.stringify(raw)})`);
    }
  }
  return parts;
}

/** Build the challenge-scope configuration from the environment. Malformed
 * operator values throw (the tool call fails loudly — fail closed); they
 * are never repaired into defaults. */
export function configFromEnv(
  env: Record<string, string | undefined>,
  opts: { extraAllowedKeys?: readonly string[] } = {},
): ChallengeScopeConfig {
  let maxTimeoutSeconds = DEFAULT_CHALLENGE_MAX_TIMEOUT_SECONDS;
  if (env.X402_MAX_CHALLENGE_TIMEOUT_SECONDS !== undefined) {
    const value = Number(env.X402_MAX_CHALLENGE_TIMEOUT_SECONDS);
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error(
        `X402_MAX_CHALLENGE_TIMEOUT_SECONDS: expected a non-negative integer number of seconds, got ${JSON.stringify(env.X402_MAX_CHALLENGE_TIMEOUT_SECONDS)}`,
      );
    }
    maxTimeoutSeconds = value;
  }

  let allowSelfFeePayer = false;
  if (env.X402_ALLOW_SELF_FEE_PAYER !== undefined) {
    const raw = env.X402_ALLOW_SELF_FEE_PAYER;
    if (raw !== "0" && raw !== "1") {
      throw new Error(`X402_ALLOW_SELF_FEE_PAYER: expected "0" or "1", got ${JSON.stringify(raw)}`);
    }
    allowSelfFeePayer = raw === "1";
  }

  let maxMemoBytes = DEFAULT_MAX_MEMO_BYTES;
  if (env.X402_MAX_MEMO_BYTES !== undefined) {
    const value = Number(env.X402_MAX_MEMO_BYTES);
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error(`X402_MAX_MEMO_BYTES: expected a non-negative integer, got ${JSON.stringify(env.X402_MAX_MEMO_BYTES)}`);
    }
    maxMemoBytes = value;
  }

  const allowedExtraKeys = new Set<string>();
  for (const key of parseList(env.X402_ALLOWED_EXTRA_KEYS, "X402_ALLOWED_EXTRA_KEYS")) {
    allowedExtraKeys.add(key);
  }
  for (const key of opts.extraAllowedKeys ?? []) {
    allowedExtraKeys.add(key);
  }

  const envExtensions = env.X402_ALLOWED_EXTENSIONS;
  return {
    allowedExtensions: envExtensions === undefined
      ? [...DEFAULT_ALLOWED_EXTENSIONS]
      : parseList(envExtensions, "X402_ALLOWED_EXTENSIONS"),
    maxTimeoutSeconds,
    allowSelfFeePayer,
    feePayerAllowlist: parseList(env.X402_FEE_PAYER_ALLOWLIST, "X402_FEE_PAYER_ALLOWLIST"),
    maxMemoBytes,
    allowedExtraKeys: [...allowedExtraKeys],
  };
}