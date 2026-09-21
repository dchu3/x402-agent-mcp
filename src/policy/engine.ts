// Issue #19 — pure policy evaluation core. The engine decides whether a
// payment is permitted BEFORE any payment code runs. It is a pure function of
// (engine state, context, budget state): no clocks, no env reads, no I/O, no
// randomness — same input ⇒ same output, always (issue: "deterministic and
// explainable"). Ledger rehydration, day rollover and trust-level derivation
// live in the callers (src/policy/budget-store.ts, src/policy/config.ts).
//
// Fixed rule order (documented contract — do not reorder without a reason-code
// stability review; reasons accumulate in this order, not first-only):
//   1. SERVICE_BLOCKED          — trust level BLOCKED (or level configured deny)
//   2. PAYMENTS_DISABLED        — global payments kill switch
//   3. CHAIN_NOT_ALLOWED        — network allowlist
//   4. TOKEN_NOT_ALLOWED        — token allowlist
//   4.5 RECIPIENT_NOT_ALLOWED   — recipient gate (issue #26): allowlist mode is
//      ACTIVE always (fail-closed on an empty effective list and on a
//      missing/unusable probed recipient); change-detect mode is ACTIVE only
//      for a host with a recorded baseline (denies only when the probed
//      recipient differs from it). Comparison is on normalized recipients.
//   5. UNKNOWN_SERVICE          — services.unknown = deny and level UNKNOWN
//   6. REQUEST_LIMIT_EXCEEDED   — per-request cap (level override ?? global)
//   7. DAILY_LIMIT_EXCEEDED     — global daily cap
//   8. SERVICE_LIMIT_EXCEEDED   — per-service daily cap (level maxDaily)
//   9. APPROVAL_REQUIRED        — trust-level approval gap (refused in Phase 1
//      tooling: stdio MCP has no human-approval channel — fail-closed)
//
// Aggregation: DENY outranks APPROVAL_REQUIRED outranks ALLOW. Cap semantics
// deliberately match src/payment-utils.ts (the belt-and-braces inner check):
// per-request denies when amount > cap; daily denies when spent + amount > cap
// (reaching the cap exactly is allowed).

import { normalizeRecipient } from "./recipient.js";
import type {
  PolicyBudgetState,
  PolicyConfig,
  PolicyContext,
  PolicyEngineState,
  PolicyLimits,
  PolicyReason,
  PolicyResult,
  ReasonCode,
} from "./types.js";

/** Codes whose presence forces a DENY decision. */
const DENY_CODES: ReadonlySet<ReasonCode> = new Set([
  "SERVICE_BLOCKED",
  "PAYMENTS_DISABLED",
  "CHAIN_NOT_ALLOWED",
  "TOKEN_NOT_ALLOWED",
  "UNKNOWN_SERVICE",
  "REQUEST_LIMIT_EXCEEDED",
  "DAILY_LIMIT_EXCEEDED",
  "SERVICE_LIMIT_EXCEEDED",
  "CONFIG_INVALID",
  "RECIPIENT_NOT_ALLOWED", // rule 4.5 (issue #26): the recipient gate — emitted by the engine since #26
]);

export class PolicyEngine {
  constructor(private readonly state: PolicyEngineState) {}

  evaluate(ctx: PolicyContext, budget: PolicyBudgetState = {}): PolicyResult {
    // Fail-closed short circuit: an unusable configuration can never authorise
    // a payment (operator decision — never silently permissive).
    if (this.state.configErrors.length > 0) {
      return {
        decision: "DENY",
        reasons: [
          { code: "CONFIG_INVALID", message: `Policy configuration is invalid and the engine fails closed: ${this.state.configErrors.join("; ")}` },
          { code: "PAYMENTS_DISABLED", message: "Payments are disabled because the policy configuration could not be validated" },
        ],
        limits: { trustLevel: ctx.trustLevel, maxPerRequest: 0, maxDaily: 0 },
      };
    }

    const cfg = this.state.config;
    const svc = cfg.services[ctx.trustLevel.toLowerCase() as keyof PolicyConfig["services"]];
    const reasons: PolicyReason[] = [];

    // Missing per-level service policy is a config defect — fail closed rather
    // than guess (the config loader validates this; the engine defends too).
    if (!svc) {
      return {
        decision: "DENY",
        reasons: [{ code: "CONFIG_INVALID", message: `No service policy configured for trust level ${ctx.trustLevel}` }],
        limits: { trustLevel: ctx.trustLevel, maxPerRequest: 0, maxDaily: 0 },
      };
    }

    const limits: PolicyLimits = {
      trustLevel: ctx.trustLevel,
      maxPerRequest: svc.maxPerRequest ?? cfg.payments.maxPerRequest,
      maxDaily: cfg.payments.maxDaily,
      ...(svc.maxDaily !== undefined ? { perServiceDaily: svc.maxDaily } : {}),
    };

    // Rule 1: blocked service. Trust level BLOCKED is always refused; an
    // operator-configured deny on a named (non-UNKNOWN) level also lands here
    // with the level named in the message. UNKNOWN-level deny is reported by
    // rule 5 as UNKNOWN_SERVICE instead (more precise code, same refusal).
    if (ctx.trustLevel === "BLOCKED") {
      reasons.push({ code: "SERVICE_BLOCKED", message: `Service ${ctx.service} is blocked (trust level BLOCKED)` });
    } else if (svc.action === "deny" && ctx.trustLevel !== "UNKNOWN") {
      reasons.push({ code: "SERVICE_BLOCKED", message: `Service ${ctx.service} is denied by policy at trust level ${ctx.trustLevel}` });
    }

    // Rule 2: global payments kill switch.
    if (!cfg.payments.enabled) {
      reasons.push({ code: "PAYMENTS_DISABLED", message: "Payments are disabled by policy (payments.enabled = false)" });
    }

    // Rule 3: network allowlist.
    if (!cfg.networks.allowed.includes(ctx.chain)) {
      reasons.push({ code: "CHAIN_NOT_ALLOWED", message: `Chain '${ctx.chain}' is not in the allowed networks [${cfg.networks.allowed.join(", ")}]` });
    }

    // Rule 4: token allowlist.
    if (!cfg.tokens.allowed.includes(ctx.token)) {
      reasons.push({ code: "TOKEN_NOT_ALLOWED", message: `Token '${ctx.token}' is not in the allowed tokens [${cfg.tokens.allowed.join(", ")}]` });
    }

    // Rule 4.5: recipient gate (issue #26). Fail-closed in both modes. The
    // rule stays inside the pure core: normalization is a pure helper
    // (src/policy/recipient.ts), host keys are matched lowercase (the context
    // service is already lowercased by buildPolicyContext), and the compared
    // recipient never appears beyond its canonical form in messages.
    const rcpt = cfg.recipients;
    const rcptHost = ctx.service.toLowerCase();
    if (rcpt.mode === "allowlist") {
      // Allowlist mode is ACTIVE always — that is the fail-closed intent of
      // the mode. The per-service list REPLACES the global list for the host.
      const effective = rcpt.perService[rcptHost] ?? rcpt.allowed;
      if (effective.length === 0) {
        reasons.push({ code: "RECIPIENT_NOT_ALLOWED", message: `Recipient allowlist for ${rcptHost} is empty — no recipient is payable (fail-closed allowlist mode)` });
      } else if (!ctx.recipient || ctx.recipient.trim() === "") {
        reasons.push({ code: "RECIPIENT_NOT_ALLOWED", message: `No recipient was probed for ${rcptHost} — allowlist mode cannot prove membership and fails closed` });
      } else {
        const canonical = normalizeRecipient(ctx.chain, ctx.recipient);
        if (canonical === undefined) {
          reasons.push({ code: "RECIPIENT_NOT_ALLOWED", message: `Probed recipient for ${rcptHost} is not a valid address for chain '${ctx.chain}' — allowlist mode fails closed` });
        } else if (!effective.some((entry) => normalizeRecipient(ctx.chain, entry) === canonical)) {
          reasons.push({ code: "RECIPIENT_NOT_ALLOWED", message: `Recipient ${canonical} is not in the allowlist for ${rcptHost} (allowlist mode)` });
        }
      }
    } else {
      // Change-detect mode is ACTIVE only for a host with a recorded baseline:
      // no baseline ⇒ nothing to compare ⇒ no reason emitted (this is what
      // keeps the behavior-compat default inert).
      const baseline = rcpt.known[rcptHost];
      if (baseline !== undefined) {
        if (!ctx.recipient || ctx.recipient.trim() === "") {
          reasons.push({ code: "RECIPIENT_NOT_ALLOWED", message: `No recipient was probed for ${rcptHost} — change-detect cannot compare it against the recorded baseline and fails closed` });
        } else {
          const probed = normalizeRecipient(ctx.chain, ctx.recipient);
          const base = normalizeRecipient(ctx.chain, baseline);
          if (probed === undefined || base === undefined || probed !== base) {
            reasons.push({ code: "RECIPIENT_NOT_ALLOWED", message: `Probed recipient ${probed ?? `(not a valid address for chain '${ctx.chain}')`} differs from the recorded baseline for ${rcptHost} (change-detect mode)` });
          }
        }
      }
    }

    // Rule 5: unknown service (services.unknown = deny refuses non-directory
    // services; the behavior-compat default config allows them — see config.ts).
    if (ctx.trustLevel === "UNKNOWN" && svc.action === "deny") {
      reasons.push({ code: "UNKNOWN_SERVICE", message: `Service ${ctx.service} is not in the directory and services.unknown = deny` });
    }

    // Rule 6: per-request cap (level override takes precedence when set).
    if (!isSpendableAmount(ctx.amount)) {
      reasons.push({ code: "REQUEST_LIMIT_EXCEEDED", message: `Payment amount ${ctx.amount} is not a finite non-negative number — failing closed` });
    } else if (ctx.amount > limits.maxPerRequest) {
      reasons.push({ code: "REQUEST_LIMIT_EXCEEDED", message: `Payment $${ctx.amount} exceeds the per-request cap $${limits.maxPerRequest}` });
    }

    // Rule 7: global daily cap (spent + amount > cap ⇒ deny; reaching exactly
    // the cap is allowed — same boundary as payment-utils.checkSpendingLimit).
    const dailySpent = finiteOrZero(budget.dailySpentUsd);
    if (isSpendableAmount(ctx.amount) && dailySpent + ctx.amount > cfg.payments.maxDaily) {
      reasons.push({ code: "DAILY_LIMIT_EXCEEDED", message: `Payment $${ctx.amount} would exceed the daily cap $${cfg.payments.maxDaily} ($${dailySpent} spent today)` });
    }

    // Rule 8: per-service daily cap (only when configured for the level).
    if (svc.maxDaily !== undefined && isSpendableAmount(ctx.amount)) {
      const perService = finiteOrZero(budget.perServiceSpentUsd);
      if (perService + ctx.amount > svc.maxDaily) {
        reasons.push({ code: "SERVICE_LIMIT_EXCEEDED", message: `Service ${ctx.service} daily limit is $${svc.maxDaily} and $${Math.max(svc.maxDaily - perService, 0)} remains` });
      }
    }

    // Rule 9: trust-level approval gap. Accumulated even alongside DENY codes
    // (so callers see the full picture) but the decision is ranked below DENY.
    if (svc.action === "approval") {
      reasons.push({ code: "APPROVAL_REQUIRED", message: `Service trust level ${ctx.trustLevel} requires payment approval (Phase 1: refused — no approval channel)` });
    }

    const decision = reasons.some((r) => DENY_CODES.has(r.code))
      ? "DENY"
      : reasons.some((r) => r.code === "APPROVAL_REQUIRED")
        ? "APPROVAL_REQUIRED"
        : "ALLOW";

    return { decision, reasons, limits };
  }
}

/** An amount is spendable only if it is a finite, non-negative number. Anything
 * else fails closed via REQUEST_LIMIT_EXCEEDED rather than slipping through
 * numeric comparisons (NaN comparisons are always false). */
function isSpendableAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount >= 0;
}

function finiteOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}