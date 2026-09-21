// Issue #25 — payment intent registry + lifecycle.
//
// An intent binds exactly what the policy layer authorised for one payment:
// the security-sensitive fields of the probed offer plus the decision. The
// registry is in-memory per process (the issue: no distributed persistence),
// TTL-bounded, and fail closed: unknown / malformed / mismatched / expired /
// replayed ⇒ a structured refusal, never a guess, never a default price.
//
// Honesty note (per the ratified design): the paramsHash is an INTEGRITY
// check against in-place mutation of the intent record, and the frozen
// registry record is the AUTHORITY it is checked against — the MCP tool
// surface exposes no intent parameters, so an LLM caller cannot forge one;
// no secret/MAC is needed and no new dependency is introduced (node:crypto).

import { createHash, randomUUID } from 'node:crypto';
import type { PolicyResult } from '../policy/types.js';
import { toCasperCaip2 } from '../casper/networks.js';
import type {
  IntentRejectCode,
  IntentState,
  IntentValidation,
  PaymentIntent,
  RequirementMatch,
} from './types.js';
import { CASPER_CHAIN } from '../casper/networks.js';

/** Default intent TTL: 60 seconds (short, per the issue). Override with the
 * X402_INTENT_TTL_MS env var; invalid/≤0 values fall back to this default —
 * no config-error plumbing: the intent layer must not become a second policy
 * engine. */
export const INTENT_DEFAULT_TTL_MS = 60_000;

interface RegistryRecord {
  /** Frozen snapshot taken at issuance — the authority for PARAM_MISMATCH. */
  intent: PaymentIntent;
  state: IntentState;
}

const registry = new Map<string, RegistryRecord>();

/** Test seam (name-underscored like the existing ones): drop all intents. */
export function _resetRegistryForTests(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// Canonical binding + hashing
// ---------------------------------------------------------------------------

/** The ONLY fields inside paramsHash, in fixed literal order — the canonical
 * serialiser builds the JSON string explicitly so it never depends on object
 * key order of an arbitrary object. */
const BINDING_KEYS = [
  'serviceId', 'serviceUrl', 'chain', 'network', 'token', 'asset', 'amountAtomic', 'recipient', 'scheme',
] as const;

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalParamsJson(i: PaymentIntent): string {
  return `{${BINDING_KEYS.map((k) => `${JSON.stringify(k)}:${JSON.stringify(i[k])}`).join(',')}}`;
}

export function paramsHashOf(i: PaymentIntent): string {
  return sha256hex(canonicalParamsJson(i));
}

/** Every field, fixed order — used to deep-compare a presented intent against
 * the frozen registry record (tampering ANY field changes this string). */
const ALL_KEYS = [
  ...BINDING_KEYS, 'id', 'decimals', 'amountUsdEstimate', 'policyDecision', 'policyDecisionId',
  'paramsHash', 'createdAt', 'expiresAt',
] as const;

function canonicalIntentJson(i: PaymentIntent): string {
  return `{${ALL_KEYS.map((k) => `${JSON.stringify(k)}:${JSON.stringify(i[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

const STRING_KEYS = [
  'id', 'serviceId', 'serviceUrl', 'chain', 'network', 'token', 'asset', 'amountAtomic',
  'recipient', 'scheme', 'policyDecision', 'policyDecisionId', 'paramsHash', 'createdAt', 'expiresAt',
] as const;

function isShapeValid(i: unknown): i is PaymentIntent {
  if (typeof i !== 'object' || i === null || Array.isArray(i)) return false;
  const o = i as Record<string, unknown>;
  for (const k of STRING_KEYS) if (typeof o[k] !== 'string') return false;
  if (typeof o.decimals !== 'number' || !Number.isInteger(o.decimals)) return false;
  if (typeof o.amountUsdEstimate !== 'number' || !Number.isFinite(o.amountUsdEstimate)) return false;
  if (!/^[0-9]+$/.test(o.amountAtomic as string)) return false;
  return true;
}

const invalid = (code: IntentRejectCode, message: string): IntentValidation => ({ valid: false, code, message });

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateFromOfferArgs {
  /** The policy result for this request. Only 'ALLOW' can mint an intent. */
  decision: PolicyResult;
  url: string;
  chain: string;
  token: string;
  /** Asset as the offer declared it; absent ⇒ '' (fatal at signing, not here). */
  asset?: string;
  /** Integer atomic units as a decimal string. Missing/non-integer/≤0 ⇒
   * AMOUNT_UNBINDABLE — never guessed, never defaulted. */
  amountAtomic?: string;
  decimals: number;
  recipient?: string;
  network?: string;
  scheme?: string;
  /** Informational USD estimate as evaluated by policy — never the binding. */
  amountUsdEstimate?: number;
  /** Defaults to X402_INTENT_TTL_MS env, then INTENT_DEFAULT_TTL_MS. */
  ttlMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: number;
}

export type CreateResult =
  | { ok: true; intent: PaymentIntent }
  | { ok: false; code: Extract<IntentRejectCode, 'AMOUNT_UNBINDABLE' | 'MALFORMED' | 'NOT_AUTHORISED'>; message: string };

function resolveTtlMs(ttlMs?: number): number {
  if (ttlMs !== undefined) return Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : INTENT_DEFAULT_TTL_MS;
  const raw = process.env.X402_INTENT_TTL_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return INTENT_DEFAULT_TTL_MS;
}

/** Mint an intent from a policy-authorised offer. NEVER throws: a refusal is
 * a value ({ok:false, code, message}) meaning "no executable intent exists —
 * this payment is unauthorised". */
export function createFromOffer(args: CreateFromOfferArgs): CreateResult {
  try {
    // 1. Policy binding: only ALLOW can ever produce an executable intent.
    if (args?.decision?.decision !== 'ALLOW') {
      return { ok: false, code: 'NOT_AUTHORISED', message: `policy decision ${args?.decision?.decision ?? 'MISSING'} cannot authorise a payment intent` };
    }
    // 2. Money must bind as integer atomic units — never guessed or defaulted.
    if (typeof args.amountAtomic !== 'string' || !/^[0-9]+$/.test(args.amountAtomic) || BigInt(args.amountAtomic) <= 0n) {
      return { ok: false, code: 'AMOUNT_UNBINDABLE', message: 'offer has no bindable positive integer atomic amount' };
    }
    // 3. Identity-critical fields must exist (asset is exempt per the ratified
    //    rule: absence is fatal at signing via the comparator, not here).
    let serviceId = '';
    try { serviceId = new URL(args.url).hostname.toLowerCase(); } catch { serviceId = ''; }
    if (serviceId === '') {
      return { ok: false, code: 'MALFORMED', message: 'request URL has no parseable hostname to bind' };
    }
    if (typeof args.recipient !== 'string' || args.recipient === '') {
      return { ok: false, code: 'MALFORMED', message: 'offer payTo is missing — a recipient cannot be guessed' };
    }
    if (typeof args.network !== 'string' || args.network === '') {
      return { ok: false, code: 'MALFORMED', message: 'offer network is missing' };
    }
    if (typeof args.decimals !== 'number' || !Number.isInteger(args.decimals) || args.decimals < 0) {
      return { ok: false, code: 'MALFORMED', message: 'decimals must be a non-negative integer' };
    }

    const now = args.now ?? Date.now();
    const ttl = resolveTtlMs(args.ttlMs);
    // Lazy sweep of expired records keeps the in-memory registry bounded.
    for (const [id, rec] of registry) {
      if (Date.parse(rec.intent.expiresAt) < now) registry.delete(id);
    }

    const intent: PaymentIntent = {
      id: randomUUID(),
      serviceId,
      serviceUrl: args.url,
      chain: args.chain,
      network: args.network,
      token: args.token,
      asset: args.asset ?? '',
      amountAtomic: args.amountAtomic,
      decimals: args.decimals,
      amountUsdEstimate: typeof args.amountUsdEstimate === 'number' && Number.isFinite(args.amountUsdEstimate) ? args.amountUsdEstimate : 0,
      recipient: args.recipient,
      scheme: args.scheme ?? '',
      policyDecision: 'ALLOW',
      policyDecisionId: '',
      paramsHash: '',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
    };
    intent.paramsHash = paramsHashOf(intent);
    intent.policyDecisionId = sha256hex(`ALLOW:${intent.paramsHash}`);

    // The registry holds its own frozen snapshot; the returned object is live
    // so callers/tests can attempt tampering — which validate() will detect.
    registry.set(intent.id, {
      intent: Object.freeze(JSON.parse(JSON.stringify(intent)) as PaymentIntent),
      state: 'issued',
    });
    return { ok: true, intent };
  } catch (err: any) {
    return { ok: false, code: 'MALFORMED', message: `intent creation failed closed: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}

// ---------------------------------------------------------------------------
// Validation — fixed order, pure, never throws
// ---------------------------------------------------------------------------

export function validate(intent: unknown, now: number = Date.now()): IntentValidation {
  try {
    if (!isShapeValid(intent)) return invalid('MALFORMED', 'intent shape is malformed');
    const rec = registry.get(intent.id);
    if (!rec) return invalid('UNKNOWN_INTENT', 'intent was never issued by this process');
    if (rec.state === 'consumed') return invalid('ALREADY_USED', 'intent has already been consumed by a payment');
    // Integrity: re-derive from the presented intent's own fields AND
    // deep-compare against the frozen registry record.
    if (intent.paramsHash !== paramsHashOf(intent) || intent.policyDecisionId !== sha256hex(`ALLOW:${intent.paramsHash}`)) {
      return invalid('PARAM_MISMATCH', 'intent hashes do not match its own fields (tampered)');
    }
    if (canonicalIntentJson(intent) !== canonicalIntentJson(rec.intent)) {
      return invalid('PARAM_MISMATCH', 'intent differs from the issued registry record (tampered)');
    }
    if (now > Date.parse(rec.intent.expiresAt)) return invalid('EXPIRED', 'intent TTL has elapsed');
    if (intent.policyDecision !== 'ALLOW') return invalid('NOT_AUTHORISED', 'only an ALLOW decision may execute');
    return { valid: true };
  } catch (err: any) {
    return invalid('MALFORMED', `intent validation failed closed: ${String(err?.message ?? err).slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

/** Atomic issued → in-flight. Anything but 'issued' ⇒ ALREADY_USED: a second
 * execution of the same intent is refused (replay protection). */
export function beginAttempt(intent: unknown, now: number = Date.now()): IntentValidation {
  if (!isShapeValid(intent)) return invalid('MALFORMED', 'intent shape is malformed');
  const rec = registry.get(intent.id);
  if (!rec) return invalid('UNKNOWN_INTENT', 'intent was never issued by this process');
  if (rec.state !== 'issued') return invalid('ALREADY_USED', 'intent is not in the issued state');
  rec.state = 'in-flight';
  void now;
  return { valid: true };
}

/** in-flight (or issued on the hook-driven Casper path) → consumed. Called by
 * the enforcement hook at payload creation; afterwards every attempt is
 * ALREADY_USED. */
export function consume(intent: unknown): IntentValidation {
  if (!isShapeValid(intent)) return invalid('MALFORMED', 'intent shape is malformed');
  const rec = registry.get(intent.id);
  if (!rec) return invalid('UNKNOWN_INTENT', 'intent was never issued by this process');
  if (rec.state === 'consumed') return invalid('ALREADY_USED', 'intent has already been consumed by a payment');
  rec.state = 'consumed';
  return { valid: true };
}

// ---------------------------------------------------------------------------
// The hook comparator — exact equality, never repair, never default
// ---------------------------------------------------------------------------

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function sameNetwork(intent: PaymentIntent, network: unknown): boolean {
  const req = nonEmptyString(network);
  if (req === null) return false;
  if (intent.chain === CASPER_CHAIN) {
    try {
      return toCasperCaip2(req) === toCasperCaip2(intent.network);
    } catch {
      return false; // unparseable Casper network ⇒ fail closed
    }
  }
  return req === intent.network;
}

/** Compare the SDK-selected requirements against the authorised intent.
 * Missing requirement fields, empty asset, absent/absent asset, or any value
 * difference ⇒ {match:false, field} (abort). Casper networks are normalised
 * via toCasperCaip2; base/solana compare as exact CAIP-2 strings. */
export function matchesRequirements(intent: PaymentIntent, requirements: unknown): RequirementMatch {
  const r = (typeof requirements === 'object' && requirements !== null ? requirements : {}) as Record<string, unknown>;
  if (nonEmptyString(r.scheme) !== intent.scheme) return { match: false, field: 'scheme' };
  if (!sameNetwork(intent, r.network)) return { match: false, field: 'network' };
  const asset = nonEmptyString(r.asset);
  if (asset === null || asset !== intent.asset) return { match: false, field: 'asset' };
  const amount = nonEmptyString(r.amount);
  if (amount === null || amount !== intent.amountAtomic) return { match: false, field: 'amount' };
  const payTo = nonEmptyString(r.payTo);
  if (payTo === null || payTo !== intent.recipient) return { match: false, field: 'payTo' };
  return { match: true };
}

// ---------------------------------------------------------------------------
// Manager facade — the interface executors depend on (injectable in tests)
// ---------------------------------------------------------------------------

export interface IntentManager {
  createFromOffer(args: CreateFromOfferArgs): CreateResult;
  validate(intent: unknown, now?: number): IntentValidation;
  beginAttempt(intent: unknown, now?: number): IntentValidation;
  consume(intent: unknown): IntentValidation;
  matchesRequirements(intent: PaymentIntent, requirements: unknown): RequirementMatch;
}

/** The module-level manager over the process-local registry. */
export const intentManager: IntentManager = {
  createFromOffer,
  validate,
  beginAttempt,
  consume,
  matchesRequirements,
};
