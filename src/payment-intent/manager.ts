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
 * key order of an arbitrary object. Issue #55: the challenge scope is part
 * of the binding (the agent hashes everything it will sign against).
 * Optional scope fields canonicalise to `null` when absent, so a JSON
 * round-trip (which drops `undefined` properties) cannot change the string. */
const BINDING_KEYS = [
  'serviceId', 'serviceUrl', 'chain', 'network', 'token', 'asset', 'amountAtomic', 'recipient', 'scheme',
] as const;

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalParamsJson(i: PaymentIntent): string {
  return JSON.stringify({
    serviceId: i.serviceId,
    serviceUrl: i.serviceUrl,
    chain: i.chain,
    network: i.network,
    token: i.token,
    asset: i.asset,
    amountAtomic: i.amountAtomic,
    recipient: i.recipient,
    scheme: i.scheme,
    validitySeconds: i.validitySeconds,
    extensionKeys: i.extensionKeys,
    evmDomainName: i.evmDomainName ?? null,
    evmDomainVersion: i.evmDomainVersion ?? null,
    solanaFeePayer: i.solanaFeePayer ?? null,
    memo: i.memo ?? null,
  });
}

export function paramsHashOf(i: PaymentIntent): string {
  return sha256hex(canonicalParamsJson(i));
}

/** Every field, fixed order — used to deep-compare a presented intent against
 * the frozen registry record (tampering ANY field changes this string).
 * Same optional-scope canonicalisation as canonicalParamsJson. */
function canonicalIntentJson(i: PaymentIntent): string {
  return JSON.stringify({
    serviceId: i.serviceId,
    serviceUrl: i.serviceUrl,
    chain: i.chain,
    network: i.network,
    token: i.token,
    asset: i.asset,
    amountAtomic: i.amountAtomic,
    recipient: i.recipient,
    scheme: i.scheme,
    validitySeconds: i.validitySeconds,
    extensionKeys: i.extensionKeys,
    evmDomainName: i.evmDomainName ?? null,
    evmDomainVersion: i.evmDomainVersion ?? null,
    solanaFeePayer: i.solanaFeePayer ?? null,
    memo: i.memo ?? null,
    id: i.id,
    decimals: i.decimals,
    amountUsdEstimate: i.amountUsdEstimate,
    policyDecision: i.policyDecision,
    policyDecisionId: i.policyDecisionId,
    paramsHash: i.paramsHash,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
  });
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
  // Issue #55 — challenge-scope fields: fail closed on wrong types so a
  // scope value can never be smuggled in with an unusable shape.
  if (typeof o.validitySeconds !== 'number' || !Number.isFinite(o.validitySeconds)) return false;
  if (!Array.isArray(o.extensionKeys)) return false;
  for (const key of o.extensionKeys) if (typeof key !== 'string') return false;
  for (const k of ['evmDomainName', 'evmDomainVersion', 'solanaFeePayer', 'memo']) {
    const v = o[k];
    if (v !== undefined && typeof v !== 'string') return false;
  }
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
  /** Issue #55 — challenge scope to bind (from the scope boundary or the
   * raw challenge for legacy offers). Absent/invalid ⇒ legacy values, so
   * the comparator skips the new checks exactly as before #55. */
  /** The offer's max timeout in seconds; 0/absent/invalid binds 0. */
  maxTimeoutSeconds?: number;
  /** The sorted challenge extension key set; absent binds []. */
  extensionKeys?: string[];
  /** The offer's extra.name / extra.version (EIP-712 domain), bound for
   * exact equality when present. */
  evmDomainName?: string;
  evmDomainVersion?: string;
  /** The offer's extra.feePayer / extra.memo (SVM), bound for exact
   * equality when present. */
  solanaFeePayer?: string;
  memo?: string;
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
    // Issue #55 — the challenge-scope arguments fail closed on wrong types.
    // Absent stays legacy (0 / no keys) so pre-#55 callers are untouched.
    if (args.maxTimeoutSeconds !== undefined
      && (typeof args.maxTimeoutSeconds !== 'number' || !Number.isFinite(args.maxTimeoutSeconds) || args.maxTimeoutSeconds <= 0)) {
      return { ok: false, code: 'MALFORMED', message: 'maxTimeoutSeconds must be a positive finite number of seconds' };
    }
    if (args.extensionKeys !== undefined
      && (!Array.isArray(args.extensionKeys) || args.extensionKeys.some((k) => typeof k !== 'string'))) {
      return { ok: false, code: 'MALFORMED', message: 'extensionKeys must be an array of strings' };
    }
    for (const [key, value] of [['evmDomainName', args.evmDomainName], ['evmDomainVersion', args.evmDomainVersion], ['solanaFeePayer', args.solanaFeePayer], ['memo', args.memo]] as const) {
      if (value !== undefined && (typeof value !== 'string' || value === '')) {
        return { ok: false, code: 'MALFORMED', message: `${key} must be a non-empty string when present` };
      }
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
      // Issue #55 — the challenge scope binds here (never clamped: what the
      // caller passes is what the intent records; the scope boundary has
      // already refused out-of-scope challenges upstream).
      validitySeconds:
        typeof args.maxTimeoutSeconds === 'number' && Number.isFinite(args.maxTimeoutSeconds) && args.maxTimeoutSeconds > 0
          ? args.maxTimeoutSeconds
          : 0,
      extensionKeys: args.extensionKeys === undefined ? [] : [...new Set(args.extensionKeys)].sort(),
      ...(args.evmDomainName === undefined ? {} : { evmDomainName: args.evmDomainName }),
      ...(args.evmDomainVersion === undefined ? {} : { evmDomainVersion: args.evmDomainVersion }),
      ...(args.solanaFeePayer === undefined ? {} : { solanaFeePayer: args.solanaFeePayer }),
      ...(args.memo === undefined ? {} : { memo: args.memo }),
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
 * via toCasperCaip2; base/solana compare as exact CAIP-2 strings.
 *
 * Issue #55: the challenge scope binds where the offer bound it.
 * `challengeExtensions` is the PAID leg's challenge `extensions` value (the
 * SDK hands the hook the parsed challenge); its key set must equal the
 * bound one. Legacy intents (validitySeconds 0 / no bound keys) skip these
 * checks, so pre-#55 behavior is byte-for-byte preserved. */
export function matchesRequirements(intent: PaymentIntent, requirements: unknown, challengeExtensions?: unknown): RequirementMatch {
  const r = (typeof requirements === 'object' && requirements !== null ? requirements : {}) as Record<string, unknown>;
  if (nonEmptyString(r.scheme) !== intent.scheme) return { match: false, field: 'scheme' };
  if (!sameNetwork(intent, r.network)) return { match: false, field: 'network' };
  const asset = nonEmptyString(r.asset);
  if (asset === null || asset !== intent.asset) return { match: false, field: 'asset' };
  const amount = nonEmptyString(r.amount);
  if (amount === null || amount !== intent.amountAtomic) return { match: false, field: 'amount' };
  const payTo = nonEmptyString(r.payTo);
  if (payTo === null || payTo !== intent.recipient) return { match: false, field: 'payTo' };
  // Issue #55 — the challenge scope binds where the offer bound it. Skip
  // rules for values the intent did not bind (legacy/pre-#55 offers) so
  // their behavior is unchanged.
  if (intent.validitySeconds > 0) {
    const timeout = typeof r.maxTimeoutSeconds === 'number' ? r.maxTimeoutSeconds : NaN;
    if (timeout !== intent.validitySeconds) return { match: false, field: 'validity' };
  }
  if (intent.extensionKeys.length > 0) {
    const challengeKeys = (typeof challengeExtensions === 'object' && challengeExtensions !== null && !Array.isArray(challengeExtensions))
      ? Object.keys(challengeExtensions).sort()
      : [];
    if (JSON.stringify(challengeKeys) !== JSON.stringify(intent.extensionKeys)) {
      return { match: false, field: 'extensions' };
    }
  }
  const extra = (r.extra !== undefined && typeof r.extra === 'object' && r.extra !== null && !Array.isArray(r.extra))
    ? r.extra as Record<string, unknown>
    : {} as Record<string, unknown>;
  if (intent.evmDomainName !== undefined && extra.name !== intent.evmDomainName) return { match: false, field: 'evmDomain' };
  if (intent.evmDomainVersion !== undefined && extra.version !== intent.evmDomainVersion) return { match: false, field: 'evmDomain' };
  if (intent.solanaFeePayer !== undefined && extra.feePayer !== intent.solanaFeePayer) return { match: false, field: 'feePayer' };
  if (intent.memo !== undefined && extra.memo !== intent.memo) return { match: false, field: 'memo' };
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
  matchesRequirements(intent: PaymentIntent, requirements: unknown, challengeExtensions?: unknown): RequirementMatch;
}

/** The module-level manager over the process-local registry. */
export const intentManager: IntentManager = {
  createFromOffer,
  validate,
  beginAttempt,
  consume,
  matchesRequirements,
};
