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