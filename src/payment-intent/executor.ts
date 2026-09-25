// Issue #25 — intent enforcement hook + guarded executor.
//
// The enforcement boundary sits at signing/payload creation, never at the
// HTTP request (amendment 1): the x402 core client runs onBeforePaymentCreation
// hooks immediately before a payload is signed, and returning
// `{abort:true, reason}` throws `Payment creation aborted: <reason>` inside
// the client — no signature can exist for parameters the intent did not
// authorise. An unbindable offer (intent === null) registers a BLOCKING hook
// that aborts any payload creation, while unpaid/non-402 responses pass
// through unchanged.
//
// Note on types: BeforePaymentCreationHook is derived from the @x402/fetch
// x402Client export (no new dependency, no undeclared import).

import type { x402Client } from '@x402/fetch';
import type { IntentManager } from './manager.js';
import type { IntentRejectCode, PaymentIntent } from './types.js';

/** The SDK hook type, derived from the client the repo already uses. */
export type BeforePaymentCreationHook = Parameters<x402Client['onBeforePaymentCreation']>[0];

/** Minimal structural client — anything with the SDK's hook registration. */
export interface HookRegistrar {
  onBeforePaymentCreation(hook: BeforePaymentCreationHook): unknown;
}

export interface IntentEnforcementArgs {
  intent: PaymentIntent;
  manager: IntentManager;
  /** Free-form label for diagnostics (which executor authorised this). */
  executorLabel: string;
}

/** Build the enforcement hook for an executable intent. At payload creation
 * it re-validates the intent (never throws), compares the SDK-selected
 * requirements against the bound offer, and consumes the intent on success —
 * one authorisation per intent. Abort reasons are machine-parseable:
 * INTENT_<CODE> for validation failures, INTENT_OFFER_MISMATCH:<field> for
 * drift between the probed offer and the selected requirements. */
export function intentEnforcement({ intent, manager, executorLabel }: IntentEnforcementArgs): BeforePaymentCreationHook {
  void executorLabel;
  return async (context) => {
    const v = manager.validate(intent);
    if (v.valid === false) return { abort: true as const, reason: `INTENT_${v.code}` };
    const m = manager.matchesRequirements(intent, context.selectedRequirements);
    if (m.match === false) return { abort: true as const, reason: `INTENT_OFFER_MISMATCH:${m.field}` };
    manager.consume(intent);
  };
}

export interface BlockingEnforcementArgs {
  code: IntentRejectCode;
  executorLabel: string;
}

/** Build the BLOCKING hook used when no executable intent exists
 * (createFromOffer refused). It aborts ANY payment-payload creation with
 * INTENT_UNAUTHORISED:<code> — an offer that cannot be bound can never be
 * paid; it can still pass through unpaid. */
export function blockingEnforcement({ code, executorLabel }: BlockingEnforcementArgs): BeforePaymentCreationHook {
  void executorLabel;
  return async () => ({ abort: true as const, reason: `INTENT_UNAUTHORISED:${code}` });
}

export type GuardedOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; code: IntentRejectCode; message: string };

export interface ExecuteGuardedArgs<T> {
  /** The intent to execute under, or null when the offer could not be bound. */
  intent: PaymentIntent | null;
  /** Why no intent exists (required when intent === null). */
  blockedCode?: IntentRejectCode;
  manager: IntentManager;
  client: HookRegistrar;
  /** The executor: performs the paid fetch through the x402 client. */
  run: () => Promise<T>;
  label: string;
  /** Injectable clock for deterministic expiry tests. */
  now?: number;
  /** Issue #34 (L9): optional signing-time liveness recheck, invoked INSIDE
   * the enforcement hook at payload creation — immediately before any
   * signature. Returning { ok: false } aborts with INTENT_ENDPOINT_NOT_LIVE,
   * so a record that aged out or flipped to error between the policy gate and
   * the signature can no longer be paid. Deterministic, caller-supplied; the
   * closure performs no network I/O. */
  recheck?: () => { ok: boolean; reason?: string };
}

/** The only sanctioned execution wrapper for paid fetches.
 *
 * - intent !== null: validate + beginAttempt FIRST — a tampered / expired /
 *   replayed / unknown intent returns a structured refusal and run() is never
 *   called; the payment layer is unreachable. Otherwise the enforcement hook
 *   is registered on the client and run() executes; an offer drift surfaces as
 *   the normal payment-failure path via the SDK's abort error.
 *
 * - intent === null: registers the blocking hook and STILL runs the executor —
 *   the boundary is at signing, not at the HTTP request, so an endpoint that
 *   does not actually charge passes through unchanged while any payment is
 *   aborted before payload creation. */
export async function executeGuarded<T>(args: ExecuteGuardedArgs<T>): Promise<GuardedOutcome<T>> {
  const { intent, manager, client, run, label } = args;
  if (intent === null) {
    client.onBeforePaymentCreation(
      blockingEnforcement({ code: args.blockedCode ?? 'NOT_AUTHORISED', executorLabel: label }),
    );
    const result = await run();
    return { ok: true, result };
  }
  const v = manager.validate(intent, args.now);
  if (v.valid === false) return { ok: false, code: v.code, message: v.message };
  const b = manager.beginAttempt(intent, args.now);
  if (b.valid === false) return { ok: false, code: b.code, message: b.message };
  const enforcement = intentEnforcement({ intent, manager, executorLabel: label });
  // Issue #34 (L9): when a recheck is supplied it runs FIRST inside the
  // payload-creation hook — the same abort-before-signing pattern as the
  // intent validation — and only then is the intent checked and consumed.
  // A failed recheck leaves the intent UNCONSUMED (nothing was signed, so the
  // authorisation must not be spent).
  const hook: BeforePaymentCreationHook = args.recheck === undefined
    ? enforcement
    : async (context) => {
      const check = args.recheck!();
      if (check.ok === false) return { abort: true as const, reason: 'INTENT_ENDPOINT_NOT_LIVE' };
      return enforcement(context);
    };
  client.onBeforePaymentCreation(hook);
  const result = await run();
  return { ok: true, result };
}
