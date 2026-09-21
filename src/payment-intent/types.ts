// Issue #25 — payment intent types. A PaymentIntent is the exact, immutable
// record of what the policy layer authorised for ONE payment attempt. It sits
// between the policy decision ("is this permitted?") and the executor ("how is
// it executed?"); nothing reaches signing with parameters the intent does not
// bind. Types only — no logic here (manager.ts / executor.ts implement it).

/**
 * The intent record. Money is integer atomic units as a decimal string
 * (`amountAtomic`) — never floats. `amountUsdEstimate` is the informational
 * value the policy engine evaluated; it is NEVER the binding.
 */
export interface PaymentIntent {
  /** Unique issuance identity (crypto.randomUUID()). */
  id: string;
  /** Lowercased service hostname — the policy `service` key. */
  serviceId: string;
  /** The exact request URL. */
  serviceUrl: string;
  /** Policy vocabulary chain: 'base' | 'solana' | 'casper'. */
  chain: string;
  /** CAIP-2 network as the offer declares it (matched against the SDK selection). */
  network: string;
  /** Policy vocabulary token: 'USDC' | 'wCSPR'. */
  token: string;
  /** Token contract/mint/package hash as the offer declared it (may be ''
   * for a legacy/malformed offer — fatal at signing, never at creation). */
  asset: string;
  /** Integer atomic units, decimal string: /^[0-9]+$/ and > 0. */
  amountAtomic: string;
  /** 6 (USDC) | 9 (wCSPR). */
  decimals: number;
  /** What policy evaluated — informational, never the binding. */
  amountUsdEstimate: number;
  /** Offer payTo. */
  recipient: string;
  /** 'exact'. */
  scheme: string;
  /** Only ALLOW can create an executable intent. */
  policyDecision: 'ALLOW';
  /** sha256(decision + ':' + paramsHash) — derived because the policy engine
   * returns no decision id (src/policy/types.ts PolicyResult carries none). */
  policyDecisionId: string;
  /** sha256 of the canonical JSON of the security-sensitive fields. */
  paramsHash: string;
  /** ISO timestamp of issuance. */
  createdAt: string;
  /** ISO timestamp, createdAt + ttl. After it, validate() ⇒ EXPIRED. */
  expiresAt: string;
}

/** Machine-readable refusal codes for the intent boundary. Stable contract —
 * callers branch on `code`, never on message text. AMOUNT_UNBINDABLE marks the
 * deliberate tightening: money that cannot be bound as integer atomic units
 * can never be paid (see README "Payment Intent boundary"). */
export type IntentRejectCode =
  | 'MALFORMED'
  | 'UNKNOWN_INTENT'
  | 'PARAM_MISMATCH'
  | 'NOT_AUTHORISED'
  | 'EXPIRED'
  | 'ALREADY_USED'
  | 'OFFER_MISMATCH'
  | 'AMOUNT_UNBINDABLE';

/** Validation outcome — a result object, never a throw (fail closed). */
export type IntentValidation = { valid: true } | { valid: false; code: IntentRejectCode; message: string };

/** Registry lifecycle: issued → (beginAttempt) → in-flight → (consume) →
 * consumed. The hook-driven Casper path consumes directly from issued. Once
 * consumed, every later attempt is ALREADY_USED (replay protection). */
export type IntentState = 'issued' | 'in-flight' | 'consumed';

/** Comparator outcome for the enforcement hook: never repairs, never defaults. */
export type RequirementMatch = { match: true } | { match: false; field: string };
