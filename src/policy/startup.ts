// Pure startup-line builder for the policy profile (post-merge review #86).
//
// The server's stderr profile report used to be two inline blocks in
// src/index.ts that keyed on resolvePolicyProfile() ALONE: an invalid
// X402_POLICY_PROFILE was announced as `policy_profile=strict` (indistinguish-
// able from a deliberate strict choice), and the permissive warning printed
// whenever the profile resolved permissive — even when a POLICY_CONFIG_PATH
// file had tightened `services.unknown` to deny, contradicting the effective
// config the engine actually runs. Both lines now derive from a single
// PolicyEngineState (loadPolicyConfig's exact output), which makes them PURE
// (state in → lines out, no env, no clock, no I/O) and unit-testable without
// spawning the server: index.ts calls loadPolicyConfig() once and prints
// profileStartupLines(state) verbatim, so the log can never disagree with the
// engine state built from the same load.
//
// Rendered lines:
//   1. `policy_profile=<profile>` — or `policy_profile=invalid` when the state
//      carries a profileError (the resolver's message; the fail-closed engine
//      behaviour is unchanged and nothing reads permissive off a bad value).
//   2. `policy_profile_error=<message>` next to the invalid line, with
//      newlines stripped (a log line is one line — the raw value is operator
//      input and must never be able to forge a second log line).
//   3. For a permissive profile only, when configErrors is empty AND the
//      EFFECTIVE `services.unknown` is still "allow": the permissive warning.
//      When a policy file has tightened `services.unknown`, that warning would
//      lie about the effective state — the line becomes the tightened
//      announcement instead. A fail-closed state (configErrors non-empty)
//      prints no advisory at all; the engine short-circuits on configErrors.
import type { PolicyEngineState } from "./types.js";
import { DEFAULT_POLICY_PROFILE } from "./profile.js";

/** The permissive warning — unchanged wording from the pre-#86 startup log
 * (the message operators already grep for), now emitted only when the
 * effective config actually makes unknown services payable. */
const PERMISSIVE_WARNING =
  "policy_profile=permissive: unknown services are payable up to the global caps — tighten with X402_POLICY_PROFILE=strict or X402_POLICY_PROFILE=standard (a POLICY_CONFIG_PATH file overrides the profile)";

/** The line printed when the permissive default survived profile resolution
 * but a POLICY_CONFIG_PATH file tightened `services.unknown` past it — the
 * truthful rendering of "permissive profile, tightened file". */
const TIGHTENED_BY_CONFIG = "policy_profile=permissive (tightened by policy config)";

/** One line per element, printed verbatim on stderr by src/index.ts. Pure:
 * deterministic in the state alone, never reads env or a clock (test-pinned). */
export function profileStartupLines(state: PolicyEngineState): string[] {
  const profile = state.profileError !== undefined ? "invalid" : (state.profile ?? DEFAULT_POLICY_PROFILE);
  const lines: string[] = [`policy_profile=${profile}`];
  if (state.profileError !== undefined) {
    // One line per log line: strip any newline the raw value or message
    // carries — the value is operator input and must never forge a log line.
    lines.push(`policy_profile_error=${state.profileError.replace(/\s*\n\s*/g, " ").trim()}`);
    return lines;
  }
  if (state.configErrors.length === 0 && state.profile === "permissive") {
    if (state.config.services.unknown.action === "allow") {
      lines.push(PERMISSIVE_WARNING);
    } else {
      // A policy file (or env override) tightened unknown services past the
      // permissive profile — announce the effective state, not the blanket
      // default (the profile alone would lie here).
      lines.push(TIGHTENED_BY_CONFIG);
    }
  }
  return lines;
}