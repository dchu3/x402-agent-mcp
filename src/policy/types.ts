// Issue #19 — policy engine types. Phase 1 scope: the stable vocabulary the
// whole safety boundary is built from. Nothing here touches payment mechanics
// or MCP registration; the engine stays independently testable.

/** The three decisions the issue requires. Phase 1 note: APPROVAL_REQUIRED is
 * surfaced as a real decision by the engine, but x402_fetch treats it as a
 * refusal (stdio MCP has no human-approval channel — fail-closed, see README). */
export type PolicyDecision = "ALLOW" | "DENY" | "APPROVAL_REQUIRED";

/** Trust levels backed by directory provenance + operator env allowlists
 * (see src/policy/config.ts resolveTrustLevel). No reputation system. */
export type TrustLevel = "TRUSTED" | "VERIFIED" | "DISCOVERED" | "UNKNOWN" | "BLOCKED";

/** Per-trust-level service policy. `action: "deny"` refuses every payment for
 * the level; `action: "approval"` yields APPROVAL_REQUIRED (refused in Phase 1
 * tooling); `action: "allow"` applies the limits below. Limits are optional:
 * maxPerRequest overrides payments.maxPerRequest for this level when set;
 * maxDaily is a per-service daily cap in USD for this level. */
export interface ServicePolicy {
  action: "allow" | "deny" | "approval";
  maxPerRequest?: number;
  maxDaily?: number;
}

/** Policy configuration model (issue Phase 2, JSON per the ratified decision —
 * loaded/validated in src/policy/config.ts; this is the shape the engine uses).
 * Service keys mirror the issue's config example (lowercase trust levels); the
 * engine maps TrustLevel → key case-insensitively. */
export interface PolicyConfig {
  payments: { enabled: boolean; maxPerRequest: number; maxDaily: number };
  services: {
    unknown: ServicePolicy;
    discovered: ServicePolicy;
    verified: ServicePolicy;
    trusted: ServicePolicy;
    blocked: ServicePolicy;
  };
  networks: { allowed: string[] };
  tokens: { allowed: string[] };
}

/** The request a payment decision is made about. `trustLevel` is supplied by
 * the caller (buildPolicyContext) so the engine stays pure — it never reads
 * the directory or env itself. */
export interface PolicyContext {
  /** Service hostname, e.g. "example.com". */
  service: string;
  chain: string;
  token: string;
  /** USD estimate of the payment (0 for mote-denominated Casper offers —
   * their spend control is casper/budget.ts, untouched by the policy layer). */
  amount: number;
  currency?: string;
  recipient?: string;
  purpose?: string;
  agentContext?: string;
  trustLevel: TrustLevel;
}

/** Today's spend, supplied by the caller (ledger-backed stores) so the engine
 * stays a pure function of (engine state, context, budget state). */
export interface PolicyBudgetState {
  /** Global USD spend so far today, all chains settled in USD. */
  dailySpentUsd?: number;
  /** USD spend so far today for ctx.service specifically. */
  perServiceSpentUsd?: number;
}

/** Machine-readable reason codes (issue Phase 6). Stable contract for coding
 * agents and future UIs — never rely on the human-readable message alone.
 * RECIPIENT_NOT_ALLOWED is reserved: recipient allowlisting is an explicitly
 * deferred future extension (issue "Future extensions"); no Phase 1 rule
 * emits it. CONFIG_INVALID is the fail-closed marker for unusable policy
 * configuration (operator-ratified addition to the issue's list). */
export type ReasonCode =
  | "PAYMENTS_DISABLED"
  | "REQUEST_LIMIT_EXCEEDED"
  | "DAILY_LIMIT_EXCEEDED"
  | "SERVICE_LIMIT_EXCEEDED"
  | "CHAIN_NOT_ALLOWED"
  | "TOKEN_NOT_ALLOWED"
  | "SERVICE_BLOCKED"
  | "UNKNOWN_SERVICE"
  | "APPROVAL_REQUIRED"
  | "RECIPIENT_NOT_ALLOWED"
  | "CONFIG_INVALID";

export interface PolicyReason {
  code: ReasonCode;
  message: string;
}

/** The limits that produced the decision — included in every result so agents
 * can see the boundary without triggering it. */
export interface PolicyLimits {
  trustLevel: TrustLevel;
  /** Effective per-request cap: services[level].maxPerRequest ?? payments.maxPerRequest. */
  maxPerRequest: number;
  /** Global daily cap. */
  maxDaily: number;
  /** Per-service daily cap when configured for the level. */
  perServiceDaily?: number;
}

export interface PolicyResult {
  decision: PolicyDecision;
  /** All triggered reasons in fixed rule order — accumulate, not first-only. */
  reasons: PolicyReason[];
  limits: PolicyLimits;
}

/** Engine input. configErrors non-empty ⇒ fail-closed engine: evaluate()
 * returns DENY with CONFIG_INVALID + PAYMENTS_DISABLED regardless of context. */
export interface PolicyEngineState {
  config: PolicyConfig;
  configErrors: string[];
}