// Issue #19 — pure policy evaluation core. The engine decides whether a
// payment is permitted BEFORE any payment code runs. It is a pure function of
// (engine state, context, budget state, anomaly inputs): no clocks, no env
// reads, no I/O, no randomness — same input ⇒ same output, always (issue:
// "deterministic and explainable"). Ledger rehydration, day rollover and
// trust-level derivation live in the callers (src/policy/budget-store.ts,
// src/policy/anomaly-store.ts, src/policy/config.ts).
//
// Fixed rule order (documented contract — do not reorder without a reason-code
// stability review; reasons accumulate in this order, not first-only):
//   1. SERVICE_BLOCKED          — trust level BLOCKED (or level configured deny)
//   2. PAYMENTS_DISABLED        — global payments kill switch
//   3. CHAIN_NOT_ALLOWED        — network allowlist (issue #32: ONE reason,
//      three fail-closed sub-checks in fixed precedence): (1) the Ethereum
//      L1 is hard-denied ALWAYS, even when listed in networks.allowed;
//      (2) networks.allowed membership (unchanged shape/message); (3) an EVM
//      chain that passed membership is denied when the configured facilitator
//      does not settle its CAIP-2 id (evm.facilitatorNetworks).
//   4. TOKEN_NOT_ALLOWED        — token allowlist
//   4.5 RECIPIENT_NOT_ALLOWED   — recipient gate (issue #26): allowlist mode is
//      ACTIVE always (fail-closed on an empty effective list and on a
//      missing/unusable probed recipient); change-detect mode is ACTIVE only
//      for a host with a recorded baseline (denies only when the probed
//      recipient differs from it). Comparison is on normalized recipients.
//      Entries are chain-scoped (issue #32, R6): "<alias>:<address>" matches
//      only that chain, "*:<address>" any chain, and a BARE address is the
//      legacy unqualified form scoped to base (never widens onto a new EVM
//      chain); an unrecognised qualifier makes the entry unusable.
//   4.6 PRICE_ANOMALY           — price anomaly gate (issue #30): z-score (or
//      fallback multiplier) of the payment amount against the per-service
//      settled-amount baseline. Middle band ⇒ APPROVAL_REQUIRED, high band ⇒
//      hard deny; inert for the mote-denominated Casper leg and when
//      anomaly.enabled is false (the compat default).
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

import { evaluatePriceAnomaly } from "./anomaly.js";
import { normalizeRecipient, parseRecipientEntry, RECIPIENT_ANY_CHAIN } from "./recipient.js";
import { aliasForCaip2, caip2Of, isEvmNetwork, L1_CAIP2 } from "../evm/networks.js";
import type {
  AnomalyInputs,
  PolicyBudgetState,
  PolicyConfig,
  PolicyContext,
  PolicyEngineState,
  PolicyLimits,
  PolicyReason,
  PolicyResult,
  ReasonCode,
} from "./types.js";

/** Codes whose presence forces a DENY decision.
 *
 * PRICE_ANOMALY (rule 4.6, issue #30) is deliberately NOT a member: the same
 * code must route to APPROVAL_REQUIRED in the middle band and to a hard deny
 * in the high band, and membership here would force DENY whenever it appears,
 * making the approval band unreachable (conflict C). The band decides the
 * routing instead: the deny band sets an engine-local hardDeny flag consulted
 * in the final decision expression; the approval band additionally pushes
 * APPROVAL_REQUIRED, which the existing aggregation already ranks. */
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

  /** Evaluate a payment decision. `budget` carries today's spend; `anomaly`
   * (issue #30) carries the per-service settled-amount baseline and the
   * advertised directory price — a distinct input class from spend, supplied
   * by the caller (anomaly-store) so the engine never touches the ledger or
   * the directory itself. Both parameters are optional: existing two-argument
   * call sites are unaffected, and an absent anomaly input degrades rule 4.6
   * to its seed band (or to inert when the compat default is disabled). */
  evaluate(ctx: PolicyContext, budget: PolicyBudgetState = {}, anomaly: AnomalyInputs = {}): PolicyResult {
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
    // Rule 4.6 deny band (issue #30): PRICE_ANOMALY is not a DENY_CODES member
    // (see the comment there) — the deny band routes through this local flag
    // instead, consulted in the final decision expression.
    let hardDeny = false;

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

    // Rule 3: network allowlist (issue #32). At most ONE CHAIN_NOT_ALLOWED
    // reason, emitted by the first of three fail-closed sub-checks in fixed
    // precedence — this keeps every existing reason-count assertion intact
    // and the L1/facilitator denials route through the existing code (no new
    // ReasonCode, fact 6).
    const chainCaip2 = caip2Of(ctx.chain);
    if (chainCaip2 === L1_CAIP2) {
      // (1) Ethereum L1 hard deny — refused ALWAYS, even when an operator
      // lists 'ethereum' or 'eip155:1' in networks.allowed (the issue: L1
      // settlement is out of scope for this agent, unconditionally).
      reasons.push({ code: "CHAIN_NOT_ALLOWED", message: `Chain '${ctx.chain}' (${L1_CAIP2}) is the Ethereum L1 and is always refused, even when listed in the allowed networks` });
    } else if (!cfg.networks.allowed.includes(ctx.chain)) {
      // (2) membership — unchanged shape/message.
      reasons.push({ code: "CHAIN_NOT_ALLOWED", message: `Chain '${ctx.chain}' is not in the allowed networks [${cfg.networks.allowed.join(", ")}]` });
    } else if (isEvmNetwork(ctx.chain) && (chainCaip2 === undefined || !cfg.evm.facilitatorNetworks.includes(chainCaip2))) {
      // (3) facilitator settle-gate — an EVM chain the operator allowed is
      // still refused when the configured facilitator cannot settle its
      // CAIP-2 id. Fail closed: isEvmNetwork ⇒ caip2Of is defined, so the
      // undefined branch below is belt-and-braces, never a guess.
      reasons.push({ code: "CHAIN_NOT_ALLOWED", message: `Chain '${ctx.chain}' is not settled by the configured facilitator networks [${cfg.evm.facilitatorNetworks.join(", ")}]` });
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
        } else if (!effective.some((entry) => {
          // Issue #32 (R6): chain-scoped entries — an entry can satisfy the
          // gate only for the chain its qualifier names ("*": any chain; bare
          // legacy form: base). An unusable or out-of-scope entry never
          // matches; comparison stays on the normalized address part.
          const address = recipientEntryAddress(ctx.chain, entry);
          return address !== undefined && normalizeRecipient(ctx.chain, address) === canonical;
        })) {
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
          // Issue #32 (R6): the recorded baseline is chain-scoped like any
          // allowlist entry — an out-of-scope or unparseable baseline is
          // unusable, so it denies (fail-closed, exactly like a baseline that
          // cannot be normalized).
          const probed = normalizeRecipient(ctx.chain, ctx.recipient);
          const baselineAddress = recipientEntryAddress(ctx.chain, baseline);
          const base = baselineAddress !== undefined ? normalizeRecipient(ctx.chain, baselineAddress) : undefined;
          if (probed === undefined || base === undefined || probed !== base) {
            reasons.push({ code: "RECIPIENT_NOT_ALLOWED", message: `Probed recipient ${probed ?? `(not a valid address for chain '${ctx.chain}')`} differs from the recorded baseline for ${rcptHost} (change-detect mode)` });
          }
        }
      }
    }

    // Rule 4.6: price anomaly gate (issue #30). Pure inputs only: the
    // baseline and the advertised price arrive via the `anomaly` parameter —
    // the engine never reads the ledger, the directory or the env. Inert for
    // the mote-denominated Casper leg (its spend authority is casper/budget.ts
    // — the gate passes amount 0 by design) and when anomaly.enabled is false
    // (the compat default). The band decides routing: approval pushes the
    // PRICE_ANOMALY reason AND an APPROVAL_REQUIRED reason (the aggregation
    // already ranks APPROVAL_REQUIRED); deny pushes PRICE_ANOMALY and sets
    // hardDeny. No existing rule's order or message is changed by this rule.
    const anomalyEval = evaluatePriceAnomaly(cfg.anomaly, ctx.chain, ctx.service, ctx.amount, anomaly);
    if (anomalyEval.band === "approval") {
      reasons.push(anomalyEval.reason!);
      reasons.push({ code: "APPROVAL_REQUIRED", message: `Price anomaly at ${ctx.service} requires payment approval (Phase 1: refused — no approval channel)` });
    } else if (anomalyEval.band === "deny") {
      reasons.push(anomalyEval.reason!);
      hardDeny = true;
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

    const decision = hardDeny || reasons.some((r) => DENY_CODES.has(r.code))
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

/** Issue #32 (R6): resolve the address part of a chain-scoped recipient
 * entry for the evaluated chain, or undefined when the entry is unusable for
 * it (unrecognised qualifier, or a base-scoped bare/legacy form evaluated on
 * a non-base EVM chain). The wildcard "*" scopes to every chain; a concrete
 * alias scopes to exactly that alias; the BARE legacy form means base —
 * pre-#32 the only EVM chain in the vocabulary — so on NON-EVM chains bare
 * entries keep their pre-#32 meaning (the address form governs there), and
 * on eip155:8453 (base itself) a bare entry still matches base. */
function recipientEntryAddress(chain: string, entry: string): string | undefined {
  const parsed = parseRecipientEntry(entry);
  if (parsed === undefined) return undefined;
  const inScope =
    parsed.chain === RECIPIENT_ANY_CHAIN ||
    parsed.chain === chain ||
    (parsed.chain === "base" && (!isEvmNetwork(chain) || aliasForCaip2(chain) === "base"));
  return inScope ? parsed.address : undefined;
}