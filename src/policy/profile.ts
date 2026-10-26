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
import type { PolicyConfig } from "./types.js";

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
 * config.test.ts, including the MAX_PAYMENT_PER_CALL=5 case). */
const LEGACY_DEFAULT_MAX_PER_REQUEST = 0.5;
const LEGACY_DEFAULT_MAX_DAILY = 10.0;

/** The low per-call price line both shipped tightening profiles use:
 * standard lets non-directory hosts through only AT OR BELOW it, and strict
 * writes it on services.discovered as the defense-in-depth second line
 * (capTrustForProfile is the first — see config.ts buildPolicyContext). */
const PROFILE_LOW_PER_REQUEST_CAP = 0.05;

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
 * deep-equality test against defaultPolicyConfig() is the proof. */
export function applyProfileDefaults(config: PolicyConfig, profile: PolicyProfile): void {
  if (profile === "permissive") return;
  if (profile === "standard") {
    // Unknown hosts stay payable but only at or below the low per-call price
    // (the issue's "refused unless a per-call price is under a low threshold",
    // expressed entirely in the EXISTING services.<level> schema — no engine
    // change, no new schema). This is a NEW allowance shape that exists only
    // when the operator opts in — called out in the #66 widening statement.
    config.services.unknown = {
      action: "allow",
      maxPerRequest: Math.min(config.services.unknown.maxPerRequest ?? config.payments.maxPerRequest, PROFILE_LOW_PER_REQUEST_CAP),
    };
    config.anomaly = { ...config.anomaly, enabled: true };
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
    config.anomaly = { ...config.anomaly, enabled: true };
    // The issue's "approval required" with no approval channel in this stage:
    // allowlist mode — the first payment to a new recipient is refused (the
    // MCP stdio surface renders APPROVAL_REQUIRED the same way). Fail-closed
    // direction: the operator lists payees (a POLICY_CONFIG_PATH file wins
    // over this overlay); an empty effective list denies every recipient.
    config.recipients = { ...config.recipients, mode: "allowlist" };
  }
  // The cap line: a profile never rides an operator's raised legacy env caps.
  config.payments.maxPerRequest = Math.min(config.payments.maxPerRequest, LEGACY_DEFAULT_MAX_PER_REQUEST);
  config.payments.maxDaily = Math.min(config.payments.maxDaily, LEGACY_DEFAULT_MAX_DAILY);
}