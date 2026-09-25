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

/** Recipient gate policy (issue #26). Two modes, both fail-closed:
 * - "allowlist": ACTIVE always — a payment may only be made to a recipient on
 *   the effective allowlist for the host (perService[host] REPLACES the global
 *   `allowed` list for that host when present). An EMPTY effective list denies
 *   every recipient; a missing/unusable probed recipient denies too (membership
 *   can never be proven).
 * - "change-detect": ACTIVE only for a host with a recorded baseline in `known`
 *   — denies only when the probed recipient differs from the baseline (no
 *   baseline ⇒ nothing to compare ⇒ no reason emitted; that is what keeps the
 *   compat default inactive). */
export interface RecipientPolicy {
  mode: "allowlist" | "change-detect";
  /** Global allowlist (allowlist mode). */
  allowed: string[];
  /** host (lowercase) -> allowed recipients, REPLACING `allowed` for that host. */
  perService: Record<string, string[]>;
  /** host (lowercase) -> baseline recipient (change-detect mode). */
  known: Record<string, string>;
}

/** Per-service settled-amount statistics for rule 4.6 (issue #30). The
 * baseline is an INPUT to the engine — built and maintained by the I/O layer
 * (src/policy/anomaly-store.ts, ledger-backed) and passed in by the caller;
 * the pure core never reads the ledger or the directory itself. */
export interface PriceBaseline {
  /** The last N settled amounts for the service, oldest first. */
  samples: number[];
  mean: number;
  /** Population standard deviation of `samples` (0 for fewer than 2 samples). */
  stdev: number;
}

/** Price-anomaly configuration (issue #30). File-only — there is deliberately
 * no X402_POLICY_* env override (the `recipients` precedent). Thresholds for
 * the z-score rule plus the fallback multiplier used while the baseline is too
 * thin to trust statistically (conflict D in the issue's plan). */
export interface AnomalyConfig {
  /** Operator opt-in. The behavior-compat default ships `false` — an
   * always-on anomaly gate could hard-deny a previously allowed payment (a
   * legitimate provider price rise looks exactly like an attack), so enabling
   * it is a deliberate tightening, never the default. */
  enabled: boolean;
  /** Baseline window: the last N settled amounts. */
  window: number;
  /** z-score threshold entering the approval band (inclusive). */
  warnZ: number;
  /** z-score threshold entering the deny band (inclusive). */
  denyZ: number;
  /** Minimum baseline size before the z-score path is trusted at all; below
   * it (or when stdev is 0) the rule falls back to the defaultTolerance
   * multiplier and can only reach the approval band, never hard-deny. */
  minSamples: number;
  /** Seed a first sample from the advertised directory price when the host
   * has no settled baseline yet (soft-protects the very first paid call). */
  seedFromDirectory: boolean;
  /** Fallback multiplier (>= 1) applied to the reference price while the
   * baseline is too thin for statistics. */
  defaultTolerance: number;
}

/** Caller-supplied inputs for rule 4.6 (issue #30). Baselines are a distinct
 * input class from spend — they are not today's spend — so the engine takes
 * them as their own optional parameter instead of overloading
 * PolicyBudgetState. All fields optional: callers without anomaly data pass
 * nothing and rule 4.6 degrades to its seed band or its disabled default. */
export interface AnomalyInputs {
  /** The host's settled-amount baseline (from the ledger-backed store). */
  baseline?: PriceBaseline;
  /** The directory's advertised price for the endpoint (seed/fallback
   * reference — an input, never fetched inside the engine). */
  directoryPriceUsd?: number;
}

/** Rule 4.6 outcome band. "seed" = no baseline yet (allow, never annotated);
 * the band decides routing: "approval" ⇒ APPROVAL_REQUIRED, "deny" ⇒ a hard
 * deny (PRICE_ANOMALY is deliberately not a DENY_CODES member — conflict C). */
export type AnomalyBand = "none" | "seed" | "approval" | "deny";

/** EVM settlement policy (issue #32). The shared pure CAIP-2 vocabulary
 * lives in src/evm/networks.ts. `facilitatorNetworks` is the fail-closed
 * settle-allowlist consulted by rule 3 ONLY after a chain passed
 * networks.allowed: an EVM chain the configured facilitator does not settle
 * is denied (CHAIN_NOT_ALLOWED), and the Ethereum L1 is denied ALWAYS. *
 * Keeping this list separate from networks.allowed is deliberate: widening
 * the alias vocabulary never implies the facilitator can settle the chain. */
export interface EvmPolicyConfig {
  /** CAIP-2 ids (eip155:<chainId>) the configured facilitator settles. */
  facilitatorNetworks: string[];
}

/** Liveness probe classification (issue #34). Mirrors LivenessRecord.status
 * on directory entries (src/directory.ts); "never_probed" exists only on the
 * verdict side, for an entry that carries no record. */
export type LivenessStatus = "live_402" | "no_402" | "error";

/** Explicit liveness pin-set entry (issue #34, L2): directory rows whose
 * ORIGIN (scheme://host[:port], trailing slash normalised) matches base_url
 * are pinned; when `paths` is given, a target URL's pathname must be listed
 * (and `paths` drives which URL the refresh probes). */
export interface LivenessAllowlistEntry {
  base_url: string;
  paths?: string[];
}

/** The liveness gate block (issue #34, L8/L10). `require_fresh_402` defaults
 * to true and `max_age_seconds` to 3600 — the fail-closed defaults, never
 * softened. `allowlist` ABSENT is load-bearing and distinct from []: absent
 * pins the directory's seed rows (L2); [] pins nothing and puts the gate in
 * strict mode (L3). FILE-ONLY: there is deliberately no X402_POLICY_* env
 * override for this block (the `recipients`/`anomaly` precedent). */
export interface LivenessConfig {
  require_fresh_402: boolean;
  max_age_seconds: number;
  allowlist?: LivenessAllowlistEntry[];
}

/** The caller-supplied liveness verdict (issue #34, L1): computed OUTSIDE the
 * engine by buildPolicyContext (from the directory row, the config and the
 * injected clock) and injected on the PolicyContext — the pure core never
 * reads the directory itself. `reason` is the human-readable message the
 * engine emits verbatim as the ENDPOINT_NOT_LIVE reason message (rule 4.7). */
export interface EndpointLiveness {
  ok: boolean;
  status: LivenessStatus | "never_probed";
  stale: boolean;
  on_allowlist: boolean;
  reason?: string;
}

/** Policy configuration model (issue Phase 2, JSON per the ratified decision —
 * loaded/validated in src/policy/config.ts; this is the shape the engine uses).
 * Service keys mirror the issue's config example (lowercase trust levels); the
 * engine maps TrustLevel → key case-insensitively. `recipients` is REQUIRED so
 * every construction site (including test fixtures) must state a recipient
 * policy — fail-closed at compile time (issue #26). `anomaly` is REQUIRED for
 * the same reason (issue #30), `evm` likewise (issue #32), and `liveness`
 * likewise (issue #34). */
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
  recipients: RecipientPolicy;
  anomaly: AnomalyConfig;
  evm: EvmPolicyConfig;
  liveness: LivenessConfig;
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
  /** Issue #34 (L1): the caller-supplied liveness verdict for the target URL,
   * computed by buildPolicyContext — never by the engine — from the directory
   * row + liveness config + injected clock. Rule 4.7 fires only when
   * liveness.require_fresh_402 is on and this verdict is present and not ok;
   * an absent verdict leaves the gate inert (existing callers unchanged). */
  endpointLiveness?: EndpointLiveness;
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
 * RECIPIENT_NOT_ALLOWED is emitted by rule 4.5 (issue #26): the recipient gate
 * (allowlist / change-detect modes, see RecipientPolicy). PRICE_ANOMALY is
 * emitted by rule 4.6 (issue #30): the price anomaly gate — deliberately NOT a
 * DENY code (the band decides routing; see src/policy/engine.ts).
 * ENDPOINT_NOT_LIVE is emitted by rule 4.7 (issue #34): the fail-closed
 * endpoint liveness gate — it IS a DENY code (a liveness refusal has no
 * approval band). CONFIG_INVALID is the fail-closed marker for unusable policy
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
  | "PRICE_ANOMALY"
  | "ENDPOINT_NOT_LIVE"
  | "CONFIG_INVALID";

export interface PolicyReason {
  code: ReasonCode;
  message: string;
  /** Optional structured payload (issue #30): every PRICE_ANOMALY reason
   * carries the z-score (or fallback ratio) plus baseline stats here for the
   * audit log. Backward-compatible: absent on all other codes, and consumers
   * must treat it as optional. */
  detail?: Record<string, unknown>;
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