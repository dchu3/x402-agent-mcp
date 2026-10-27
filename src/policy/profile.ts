// Issue #66 stage A — policy profiles (strict | standard | permissive).
//
// Stage A ships an OPT-IN profile switch on top of the behavior-compat
// default (src/policy/config.ts decision 2): X402_POLICY_PROFILE=strict |
// standard | permissive selects a shipped overlay; with the variable UNSET
// the engine keeps today's permissive behavior byte-identical (the compat
// proof is a deep-equality test against defaultPolicyConfig() in
// config.test.ts). Flipping the DEFAULT is the later stage-B/C rollout —
// DEFAULT_POLICY_PROFILE pins stage A.
//
// Decisions implemented here: EXACT lowercase match only ("STRICT"/" strict"
// are errors — a near-miss silently degrading is a fail-OPEN hazard), and an
// unrecognized value returns a non-empty error naming the variable and raw
// value. On the error path the returned profile is "strict": the caller
// (loadPolicyConfig) fails closed with that error in configErrors, so the
// value is irrelevant, and "strict" guarantees no code path can read
// "permissive" off a bad value.
import type { PolicyConfig, TrustLevel } from "./types.js";

export type PolicyProfile = "strict" | "standard" | "permissive";

export const POLICY_PROFILES: readonly PolicyProfile[] = ["strict", "standard", "permissive"];

/** Stage A pins the default to the behavior-compat profile. A later stage
 * flips this constant under the operator's B/C decision — never this release
 * (stage boundary: making standard/strict the default is OUT of scope). */
export const DEFAULT_POLICY_PROFILE: PolicyProfile = "permissive";

/** Exact-match resolve of X402_POLICY_PROFILE. The raw string is an optional
 * argument for direct tests; it defaults to reading env AT CALL TIME (no
 * memoisation — the config.ts loading pattern). unset/empty/whitespace-only
 * → the stage-A default; anything else fails the exact-match check and
 * returns { profile: "strict", error }. */
export function resolvePolicyProfile(raw: string | undefined = process.env.X402_POLICY_PROFILE): { profile: PolicyProfile; error?: string } {
  if (raw === undefined || raw.trim() === "") {
    return { profile: DEFAULT_POLICY_PROFILE };
  }
  if (raw === "strict" || raw === "standard" || raw === "permissive") {
    return { profile: raw };
  }
  return {
    profile: "strict",
    error: `X402_POLICY_PROFILE='${raw}' must be one of strict|standard|permissive`,
  };
}

/** The legacy DEFAULT cap line — the fallbacks config.ts legacyCaps() applies
 * when MAX_PAYMENT_PER_CALL / MAX_DAILY_SPEND are unset (0.5 / 10.0). Every
 * profile cap is min()-ed against this line so an operator's raised legacy
 * env can never lift a shipped profile above today's cap — the profiles
 * tighten, never widen (non-widening by construction; test-pinned in
 * config.test.ts, including the MAX_PAYMENT_PER_CALL=5 case). LEGACY_DEFAULT_MAX_DAILY
 * is also the fallback for a per-host daily cap when the level carries none. */
const LEGACY_DEFAULT_MAX_PER_REQUEST = 0.5;
const LEGACY_DEFAULT_MAX_DAILY = 10.0;

/** The low per-call price line both shipped tightening profiles use:
 * standard lets non-directory hosts through only AT OR BELOW it, and strict
 * writes it on services.discovered as the defense-in-depth second line
 * (capTrustForProfile is the first — see config.ts buildPolicyContext). */
const PROFILE_LOW_PER_REQUEST_CAP = 0.05;

/** The per-host cap line the tightening profiles write on the levels a
 * directory row can never demote into (TRUSTED — and VERIFIED, the level the
 * type system allows even though resolveTrustLevel never returns it): the
 * SAME low per-request line as PROFILE_LOW_PER_REQUEST_CAP, so in strict an
 * explicitly-trusted host is capped exactly like a directory row, and a
 * per-host DAILY line one order of magnitude below the $10 legacy global
 * (config.ts failClosedConfig aside, no per-level maxDaily exists in the
 * defaults — this is the per-host cap that makes the profiles' "cap
 * declared = cap applied" true; the engine projects services.<level>.maxDaily
 * to its perServiceDaily limit and enforces it as SERVICE_LIMIT_EXCEEDED). */
const PROFILE_HOST_PER_REQUEST_CAP = 0.05;
const PROFILE_HOST_DAILY_CAP = 1.0;

/** Overlay the profile's own fields onto a freshly built config — called by
 * loadPolicyConfig BETWEEN defaultPolicyConfig() and applyFileConfig(), which
 * is what makes "a policy file always overrides the profile" true by
 * construction (the file merges afterwards, field-by-field / wholesale, and
 * X402_POLICY_* env overrides run after that).
 *
 * Mutates in place (the applyFileConfig/applyEnvOverrides convention).
 * NON-WIDENING: every cap is Math.min()-ed against the value already in the
 * config and, finally, against the legacy default line — applyProfileDefaults
 * can never raise any cap. `anomaly.enabled` is turned on ONLY inside the
 * strict/standard overlays, never in the permissive default (stage-A hard
 * constraint), and NO chain/token/network default is touched.
 *
 * permissive → a complete no-op: it IS the behavior-compat default, and the
 * deep-equality test against defaultPolicyConfig() is the proof.
 *
 * standard is "otherwise like strict" (both tightening profiles ship): the
 * recipient gate is allowlist in BOTH — with no approval channel the first
 * payment to a new recipient is refused until the operator lists payees via a
 * POLICY_CONFIG_PATH file (file-only, applies after this overlay), and both
 * carry the same per-host cap line on services.trusted / services.verified. */
export function applyProfileDefaults(config: PolicyConfig, profile: PolicyProfile): void {
  if (profile === "permissive") return;
  if (profile === "standard") {
    // Unknown hosts stay payable but only at or below the low per-call price
    // (the issue's "refused unless a per-call price is under a low threshold",
    // expressed entirely in the EXISTING services.<level> schema — no engine
    // change, no new schema). This is a NEW allowance shape that exists only
    // when the operator opts in — called out in the #66 widening statement.
    // Issue #93 (C1): the same line carries the per-host DAILY cap the other
    // levels get (PROFILE_HOST_DAILY_CAP) — with only a per-request cap an
    // unknown host stays payable in unlimited small increments inside one day
    // ($0.04 × N > any daily total), which defeats the profile's per-host
    // budget line. Same min() discipline as every cap in this overlay: an
    // existing tighter value survives, the legacy per-host fallback applies
    // when the level carries none, and a raised legacy env can never lift the
    // profile line.
    config.services.unknown = {
      action: "allow",
      maxPerRequest: Math.min(config.services.unknown.maxPerRequest ?? config.payments.maxPerRequest, PROFILE_LOW_PER_REQUEST_CAP),
      maxDaily: Math.min(config.services.unknown.maxDaily ?? LEGACY_DEFAULT_MAX_DAILY, PROFILE_HOST_DAILY_CAP),
    };
  } else {
    // strict: unknown hosts refused entirely. Directory rows carry NO trust
    // elevation in strict (capTrustForProfile demotes DISCOVERED → UNKNOWN at
    // derivation time); the per-host cap below is the second line for any
    // context that still reaches the engine as DISCOVERED.
    config.services.unknown = { action: "deny" };
    config.services.discovered = {
      ...config.services.discovered,
      maxPerRequest: Math.min(config.services.discovered.maxPerRequest ?? config.payments.maxPerRequest, PROFILE_LOW_PER_REQUEST_CAP),
    };
  }
  // The per-host cap line — BOTH tightening profiles. capTrustForProfile
  // demotes directory rows to UNKNOWN in strict/standard, so TRUSTED (an
  // explicit POLICY_TRUSTED_HOSTS entry) is the level that still pays through
  // untouched defaults — without this line a strict "cap" would never bind
  // anywhere. VERIFIED is unreachable today (resolveTrustLevel never returns
  // it) but is the level the type system allows; capping it costs nothing.
  // The existing action is kept (fail-closed: the overlay never upgrades a
  // configured deny to allow); maxPerRequest falls back through the global
  // per-request cap, maxDaily through the legacy default.
  config.services.trusted = {
    ...config.services.trusted,
    maxPerRequest: Math.min(config.services.trusted.maxPerRequest ?? config.payments.maxPerRequest, PROFILE_HOST_PER_REQUEST_CAP),
    maxDaily: Math.min(config.services.trusted.maxDaily ?? LEGACY_DEFAULT_MAX_DAILY, PROFILE_HOST_DAILY_CAP),
  };
  config.services.verified = {
    ...config.services.verified,
    maxPerRequest: Math.min(config.services.verified.maxPerRequest ?? config.payments.maxPerRequest, PROFILE_HOST_PER_REQUEST_CAP),
    maxDaily: Math.min(config.services.verified.maxDaily ?? LEGACY_DEFAULT_MAX_DAILY, PROFILE_HOST_DAILY_CAP),
  };
  // The issue's "approval required" with no approval channel in this stage:
  // allowlist mode — the first payment to a new recipient is refused (the
  // MCP stdio surface renders APPROVAL_REQUIRED the same way). Fail-closed
  // direction: the operator lists payees (a POLICY_CONFIG_PATH file wins
  // over this overlay); an empty effective list denies every recipient.
  config.recipients = { ...config.recipients, mode: "allowlist" };
  config.anomaly = { ...config.anomaly, enabled: true };
  // The cap line: a profile never rides an operator's raised legacy env caps.
  config.payments.maxPerRequest = Math.min(config.payments.maxPerRequest, LEGACY_DEFAULT_MAX_PER_REQUEST);
  config.payments.maxDaily = Math.min(config.payments.maxDaily, LEGACY_DEFAULT_MAX_DAILY);
}

/** Issue #66 requirement 6, stage A — STRICT/STANDARD ONLY (the permissive
 * default must stay byte-identical, which is exactly why this lives beside
 * the profile and not inside resolveTrustLevel): a directory row may never
 * RAISE trust above UNKNOWN. DISCOVERED → UNKNOWN unless the host is an
 * explicit operator allowlist entry (POLICY_TRUSTED_HOSTS); every other
 * level passes through untouched — BLOCKED stays BLOCKED in every profile,
 * TRUSTED stays TRUSTED (resolveTrustLevel already answers those from the
 * env lists; the `trustedHosts` callback keeps the exception explicit so
 * the cap can never demote an operator-managed entry), and VERIFIED/UNKNOWN
 * are unaffected (resolveTrustLevel never returns VERIFIED — no reputation
 * system).
 *
 * Called from buildPolicyContext so BOTH paying callers (x402_fetch and
 * x402_check_payment) see the same capped level; the engine consumes the
 * capped level unchanged (services.unknown / services.discovered as the
 * profile configured them). */
export function capTrustForProfile(level: TrustLevel, serviceHost: string, profile: PolicyProfile, trustedHosts: (host: string) => boolean): TrustLevel {
  if (profile === "permissive") return level;
  if (level === "DISCOVERED" && !trustedHosts(serviceHost)) return "UNKNOWN";
  return level;
}