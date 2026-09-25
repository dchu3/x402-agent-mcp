// Issue #19 — policy configuration: loading, validation, fail-closed behavior,
// env overrides, and trust-level derivation.
//
// Ratified decisions implemented here (see README "Payment Policy Engine"):
//
// 1. JSON config, not YAML (no new dependencies): POLICY_CONFIG_PATH points at
//    a JSON file; X402_POLICY_* env vars override individual fields. Missing
//    FILE at POLICY_CONFIG_PATH loads the default policy (ratified); a file
//    that exists but is unreadable, malformed/wrong-typed/missing-critical-
//    fields fails closed: the engine state is "payments disabled" and
//    evaluate() returns DENY with CONFIG_INVALID + PAYMENTS_DISABLED — never
//    silently permissive. (Error classes on read: only ENOENT means "no
//    config"; EACCES/EISDIR/… fail closed.)
//
// 2. Behavior-compat default (the explicit decision issue #19 demands):
//    the default policy reproduces pre-policy behavior EXACTLY — payments
//    enabled, caps from MAX_PAYMENT_PER_CALL (default $0.50) and
//    MAX_DAILY_SPEND (default $10.00) exactly as the inner payment layer
//    resolves them, networks [base, solana, casper], tokens [USDC, wCSPR],
//    every directory service payable at the global caps, and
//    services.unknown = "allow" (today any host is payable at the global
//    caps — directory membership plays no role in today's limit checks, and
//    the zero-behavior-change compat proof is the unchanged test suite).
//    Tightening — e.g. services.unknown = "deny" — is opt-in via config.
//
// 3. Legacy env vars (MAX_PAYMENT_PER_CALL / MAX_DAILY_SPEND) feed the DEFAULT
//    caps so operators who set them before the policy engine existed keep
//    exactly today's behavior. Precedence:
//      legacy env (default source)  <  POLICY_CONFIG_PATH file  <  X402_POLICY_* overrides.
//    Unparseable values fail closed (today's parseFloat would yield NaN and
//    accidentally bypass the inner check; the policy layer refuses instead).
//
// 4. Trust levels (issue Phase 4), no reputation system:
//      BLOCKED    — host listed in POLICY_BLOCKED_HOSTS (comma-separated)
//      TRUSTED    — host listed in POLICY_TRUSTED_HOSTS (user-managed allowlist)
//      DISCOVERED — host is a directory entry (source "seed" or "discovery")
//      UNKNOWN    — not in the directory
//    Precedence BLOCKED > TRUSTED > directory > UNKNOWN (fail-closed ordering).

import { readFileSync } from "fs";
import { PolicyEngine } from "./engine.js";
import { DEFAULT_ANOMALY_CONFIG } from "./anomaly.js";
import { DEFAULT_FACILITATOR_NETWORKS } from "../evm/networks.js";
import { findEntryForUrl, loadDirectory } from "../directory.js";
import { livenessVerdict } from "./liveness.js";
import type {
  AnomalyConfig,
  EndpointLiveness,
  LivenessAllowlistEntry,
  LivenessConfig,
  PolicyConfig,
  PolicyContext,
  PolicyEngineState,
  ServicePolicy,
  TrustLevel,
} from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function legacyNumber(varName: string, fallback: number, errors: string[]): number {
  const raw = process.env[varName];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    errors.push(`${varName}='${raw}' is not a finite non-negative number`);
    return fallback;
  }
  return parsed;
}

/** Today's caps, resolved the way payment-utils resolves them (legacy env with
 * the same fallbacks) so the default policy is behavior-identical. */
function legacyCaps(errors: string[]): { maxPerRequest: number; maxDaily: number } {
  return {
    maxPerRequest: legacyNumber("MAX_PAYMENT_PER_CALL", 0.5, errors),
    maxDaily: legacyNumber("MAX_DAILY_SPEND", 10.0, errors),
  };
}

/** The behavior-compat default policy — see module header, decision 2. */
export function defaultPolicyConfig(errors: string[] = []): PolicyConfig {
  return {
    payments: { enabled: true, ...legacyCaps(errors) },
    services: {
      unknown: { action: "allow" },
      discovered: { action: "allow" },
      verified: { action: "allow" },
      trusted: { action: "allow" },
      blocked: { action: "deny" },
    },
    networks: { allowed: ["base", "solana", "casper"] },
    tokens: { allowed: ["USDC", "wCSPR"] },
    // Issue #32 (R2): the compat default for networks.allowed intentionally
    // stays [base, solana, casper] — Polygon/Arbitrum are OPT-IN via config,
    // never silently payable by default (money-path widenings ship opt-in, the
    // #30 precedent). The facilitator settle-list DOES default to all three
    // EVM ids: it is a fail-closed gate consulted only for chains that already
    // passed networks.allowed, so it widens nothing by itself. Fresh copies —
    // DEFAULT_POLICY_CONFIG must stay pristine.
    evm: { facilitatorNetworks: [...DEFAULT_FACILITATOR_NETWORKS] },
    // Issue #26 compat default: change-detect with NO baselines — the rule is
    // active only for a host with a recorded baseline, so with an empty `known`
    // map the recipient gate never fires and today's decisions are unchanged
    // (the unchanged test suite is the proof, README "compat default").
    recipients: { mode: "change-detect", allowed: [], perService: {}, known: {} },
    // Issue #30 compat default (conflict B): the anomaly block ships DISABLED —
    // an always-on price gate could hard-deny a previously allowed payment (a
    // legitimate provider price rise looks exactly like an attack), so turning
    // it on is an operator opt-in, exactly like services.unknown: deny and the
    // recipient allowlist. DEFAULT_POLICY_CONFIG.anomaly.enabled === false and
    // the untouched existing test suite are the compat proof.
    anomaly: { ...DEFAULT_ANOMALY_CONFIG },
    // Issue #34 (L10): the liveness gate ships with the issue's fail-closed
    // defaults — require_fresh_402 TRUE, max_age_seconds 3600 — with the
    // allowlist ABSENT (seed-pinned mode, L2). Per L3 this is a real
    // tightening for catalog rows (a directory row must be pinned and freshly
    // live) and inert for non-catalog hosts (no catalog claim to falsify), so
    // the existing paid-path tests — all on non-directory hosts — stay green
    // by construction. Fresh copies — DEFAULT_POLICY_CONFIG must stay pristine.
    liveness: { require_fresh_402: true, max_age_seconds: 3600 },
  };
}
/** Frozen snapshot of the compat default, exported for documentation/tests.
 * loadPolicyConfig() never mutates it (it builds fresh states). */
export const DEFAULT_POLICY_CONFIG: PolicyConfig = defaultPolicyConfig();

/** Fail-closed fallback state content: payments disabled. Used whenever the
 * configuration cannot be validated — the engine additionally short-circuits
 * on configErrors, so even a context that would otherwise be allowed is DENYed
 * with CONFIG_INVALID + PAYMENTS_DISABLED. */
function failClosedConfig(errors: string[]): PolicyConfig {
  return {
    payments: { enabled: false, maxPerRequest: 0, maxDaily: 0 },
    services: {
      unknown: { action: "deny" },
      discovered: { action: "deny" },
      verified: { action: "deny" },
      trusted: { action: "deny" },
      blocked: { action: "deny" },
    },
    networks: { allowed: [] },
    tokens: { allowed: [] },
    // Fail-closed state: an empty settle-list — nothing is payable in this
    // state anyway (the engine short-circuits on configErrors first).
    evm: { facilitatorNetworks: [] },
    // Fail-closed state: allowlist mode with an empty effective list denies
    // every recipient — consistent with this state's "nothing is payable"
    // content (the engine additionally short-circuits on configErrors).
    recipients: { mode: "allowlist", allowed: [], perService: {}, known: {} },
    // Fail-closed anomaly state: the disabled default (payments are disabled
    // here anyway — the engine short-circuits on configErrors before any rule).
    anomaly: { ...DEFAULT_ANOMALY_CONFIG },
    // Fail-closed liveness state (issue #34): gate on, explicit EMPTY
    // allowlist ⇒ strict mode with an empty pin set — NOTHING is live in this
    // state (the engine additionally short-circuits on configErrors).
    liveness: { require_fresh_402: true, max_age_seconds: 3600, allowlist: [] },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SERVICE_LEVEL_KEYS = ["unknown", "discovered", "verified", "trusted", "blocked"] as const;
type ServiceLevelKey = (typeof SERVICE_LEVEL_KEYS)[number];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNonNegative(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function stringArray(v: unknown, path: string, errors: string[]): string[] | undefined {
  if (!Array.isArray(v)) {
    errors.push(`${path} must be an array of strings`);
    return undefined;
  }
  if (!v.every((e) => typeof e === "string" && e.trim() !== "")) {
    errors.push(`${path} must contain only non-empty strings`);
    return undefined;
  }
  return v as string[];
}

function servicePolicy(v: unknown, path: string, errors: string[]): ServicePolicy | undefined {
  if (!isPlainObject(v)) {
    errors.push(`${path} must be an object with an "action" of allow|deny|approval`);
    return undefined;
  }
  const known = new Set(["action", "maxPerRequest", "maxDaily"]);
  for (const key of Object.keys(v)) {
    if (!known.has(key)) errors.push(`${path}.${key} is not a recognised policy key (typo protection)`);
  }
  const action = v.action;
  if (action !== "allow" && action !== "deny" && action !== "approval") {
    errors.push(`${path}.action must be "allow", "deny" or "approval"`);
    return undefined;
  }
  const policy: ServicePolicy = { action };
  if (v.maxPerRequest !== undefined) {
    if (!finiteNonNegative(v.maxPerRequest)) errors.push(`${path}.maxPerRequest must be a finite non-negative number`);
    else policy.maxPerRequest = v.maxPerRequest;
  }
  if (v.maxDaily !== undefined) {
    if (!finiteNonNegative(v.maxDaily)) errors.push(`${path}.maxDaily must be a finite non-negative number`);
    else policy.maxDaily = v.maxDaily;
  }
  return policy;
}

function recipientsPolicy(v: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(v)) {
    errors.push(`${path} must be an object with a "mode" of allowlist|change-detect`);
    return;
  }
  const known = new Set(["mode", "allowed", "perService", "known"]);
  for (const key of Object.keys(v)) {
    if (!known.has(key)) errors.push(`${path}.${key} is not a recognised policy key (typo protection)`);
  }
  if (v.mode !== "allowlist" && v.mode !== "change-detect") {
    errors.push(`${path}.mode must be "allowlist" or "change-detect"`);
  }
  if (v.allowed !== undefined) stringArray(v.allowed, `${path}.allowed`, errors);
  if (v.perService !== undefined) {
    if (!isPlainObject(v.perService)) {
      errors.push(`${path}.perService must be an object keyed by hostname`);
    } else {
      for (const [host, list] of Object.entries(v.perService)) {
        stringArray(list, `${path}.perService.${host}`, errors);
      }
    }
  }
  if (v.known !== undefined) {
    if (!isPlainObject(v.known)) {
      errors.push(`${path}.known must be an object keyed by hostname`);
    } else {
      for (const [host, baseline] of Object.entries(v.known)) {
        if (typeof baseline !== "string" || baseline.trim() === "") {
          errors.push(`${path}.known.${host} must be a non-empty string`);
        }
      }
    }
  }
}

function anomalyPolicy(v: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(v)) {
    errors.push(`${path} must be an object with an "enabled" boolean (issue #30)`);
    return;
  }
  const known = new Set(["enabled", "window", "warnZ", "denyZ", "minSamples", "seedFromDirectory", "defaultTolerance"]);
  for (const key of Object.keys(v)) {
    if (!known.has(key)) errors.push(`${path}.${key} is not a recognised policy key (typo protection)`);
  }
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") errors.push(`${path}.enabled must be a boolean`);
  if (v.seedFromDirectory !== undefined && typeof v.seedFromDirectory !== "boolean") {
    errors.push(`${path}.seedFromDirectory must be a boolean`);
  }
  if (v.window !== undefined && !(typeof v.window === "number" && Number.isInteger(v.window) && v.window >= 1)) {
    errors.push(`${path}.window must be an integer >= 1`);
  }
  if (v.minSamples !== undefined && !(typeof v.minSamples === "number" && Number.isInteger(v.minSamples) && v.minSamples >= 1)) {
    errors.push(`${path}.minSamples must be an integer >= 1`);
  }
  if (v.warnZ !== undefined && !finiteNonNegative(v.warnZ)) errors.push(`${path}.warnZ must be a finite non-negative number`);
  if (v.denyZ !== undefined && !finiteNonNegative(v.denyZ)) errors.push(`${path}.denyZ must be a finite non-negative number`);
  if (v.defaultTolerance !== undefined && !(typeof v.defaultTolerance === "number" && Number.isFinite(v.defaultTolerance) && v.defaultTolerance >= 1)) {
    errors.push(`${path}.defaultTolerance must be a finite number >= 1`);
  }
}

function livenessPolicy(v: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(v)) {
    errors.push(`${path} must be an object with require_fresh_402 / max_age_seconds / allowlist (issue #34)`);
    return;
  }
  const known = new Set(["require_fresh_402", "max_age_seconds", "allowlist"]);
  for (const key of Object.keys(v)) {
    if (!known.has(key)) errors.push(`${path}.${key} is not a recognised policy key (typo protection)`);
  }
  if (v.require_fresh_402 !== undefined && typeof v.require_fresh_402 !== "boolean") {
    errors.push(`${path}.require_fresh_402 must be a boolean`);
  }
  if (v.max_age_seconds !== undefined && !(typeof v.max_age_seconds === "number" && Number.isFinite(v.max_age_seconds) && v.max_age_seconds > 0)) {
    errors.push(`${path}.max_age_seconds must be a finite number > 0`);
  }
  if (v.allowlist !== undefined) {
    if (!Array.isArray(v.allowlist)) {
      errors.push(`${path}.allowlist must be an array of { base_url, paths? } entries ([] is allowed and pins nothing — strict mode)`);
    } else {
      for (const [i, item] of v.allowlist.entries()) {
        const ipath = `${path}.allowlist[${i}]`;
        if (!isPlainObject(item)) {
          errors.push(`${ipath} must be an object with a base_url string`);
          continue;
        }
        for (const key of Object.keys(item)) {
          if (key !== "base_url" && key !== "paths") errors.push(`${ipath}.${key} is not a recognised policy key (typo protection)`);
        }
        if (typeof item.base_url !== "string" || item.base_url.trim() === "") {
          errors.push(`${ipath}.base_url must be a non-empty string`);
        } else {
          try {
            const u = new URL(item.base_url);
            if (u.protocol !== "http:" && u.protocol !== "https:") {
              errors.push(`${ipath}.base_url must be an http/https URL — got '${item.base_url}'`);
            }
          } catch {
            errors.push(`${ipath}.base_url must be a parseable http/https URL — got '${item.base_url}'`);
          }
        }
        if (item.paths !== undefined) {
          if (!Array.isArray(item.paths) || !item.paths.every((p: unknown) => typeof p === "string" && p.startsWith("/"))) {
            errors.push(`${ipath}.paths must be an array of path strings, each starting with "/"`);
          }
        }
      }
    }
  }
}

function evmPolicy(v: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(v)) {
    errors.push(`${path} must be an object with a "facilitatorNetworks" array of CAIP-2 ids (issue #32)`);
    return;
  }
  for (const key of Object.keys(v)) {
    if (key !== "facilitatorNetworks") errors.push(`${path}.${key} is not a recognised policy key (typo protection)`);
  }
  if (v.facilitatorNetworks !== undefined) {
    const list = stringArray(v.facilitatorNetworks, `${path}.facilitatorNetworks`, errors);
    if (list !== undefined) {
      for (const entry of list) {
        if (!/^eip155:\d+$/.test(entry)) {
          errors.push(`${path}.facilitatorNetworks entries must be CAIP-2 evm ids (eip155:<chainId>) — got '${entry}'`);
        }
      }
    }
  }
}

/** Strict validation of a parsed config document against the schema. Only
 * `payments` is required (safety-critical — the issue's fail-closed rule);
 * services/networks/tokens/recipients/anomaly/evm/liveness are optional and
 * merge over the defaults. Unknown keys are errors everywhere (typo
 * protection: a misspelled cap must never be silently ignored). */
function validateDocument(doc: unknown, errors: string[]): void {
  if (!isPlainObject(doc)) {
    errors.push("policy config must be a JSON object");
    return;
  }
  const knownTop = new Set(["payments", "services", "networks", "tokens", "recipients", "anomaly", "evm", "liveness"]);
  for (const key of Object.keys(doc)) {
    if (!knownTop.has(key)) errors.push(`policy config key "${key}" is not recognised (typo protection)`);
  }

  // payments — required, safety-critical.
  const payments = doc.payments;
  if (!isPlainObject(payments)) {
    errors.push("payments section is required and must be an object");
  } else {
    for (const key of Object.keys(payments)) {
      if (!["enabled", "maxPerRequest", "maxDaily"].includes(key)) errors.push(`payments.${key} is not a recognised policy key`);
    }
    if (typeof payments.enabled !== "boolean") errors.push("payments.enabled must be a boolean");
    if (!finiteNonNegative(payments.maxPerRequest)) errors.push("payments.maxPerRequest must be a finite non-negative number");
    if (!finiteNonNegative(payments.maxDaily)) errors.push("payments.maxDaily must be a finite non-negative number");
  }

  // services — optional; each known level optional; shape strict.
  if (doc.services !== undefined) {
    if (!isPlainObject(doc.services)) {
      errors.push("services must be an object keyed by trust level");
    } else {
      for (const key of Object.keys(doc.services)) {
        if (!(SERVICE_LEVEL_KEYS as readonly string[]).includes(key)) errors.push(`services.${key} is not a known trust level (use unknown|discovered|verified|trusted|blocked)`);
      }
      for (const level of SERVICE_LEVEL_KEYS) {
        if (doc.services[level] !== undefined) {
          servicePolicy(doc.services[level], `services.${level}`, errors);
        }
      }
    }
  }

  // networks / tokens — optional allowlists (an empty list is a valid
  // operator choice meaning "nothing allowed", not malformed input).
  if (doc.networks !== undefined) {
    if (!isPlainObject(doc.networks)) errors.push("networks must be an object with an allowed array");
    else {
      for (const key of Object.keys(doc.networks)) if (key !== "allowed") errors.push(`networks.${key} is not a recognised policy key`);
      stringArray(doc.networks.allowed, "networks.allowed", errors);
    }
  }
  if (doc.tokens !== undefined) {
    if (!isPlainObject(doc.tokens)) errors.push("tokens must be an object with an allowed array");
    else {
      for (const key of Object.keys(doc.tokens)) if (key !== "allowed") errors.push(`tokens.${key} is not a recognised policy key`);
      stringArray(doc.tokens.allowed, "tokens.allowed", errors);
    }
  }

  // recipients — optional; strict shape (issue #26). No mode-conditional
  // requirements: a partial block merges over the defaults field-by-field in
  // applyFileConfig, and whatever shape results is what the engine evaluates
  // (an allowlist mode with an empty effective list denies — fail-closed).
  if (doc.recipients !== undefined) {
    recipientsPolicy(doc.recipients, "recipients", errors);
  }

  // anomaly — optional; strict shape (issue #30). No env override (the
  // recipients precedent). A partial block merges over the defaults
  // field-by-field in applyFileConfig; the warnZ < denyZ ORDERING is checked
  // there too, on the merged values (a partial block that only raises warnZ
  // above the default denyZ must fail closed just the same).
  if (doc.anomaly !== undefined) {
    anomalyPolicy(doc.anomaly, "anomaly", errors);
  }

  // evm — optional; strict shape (issue #32): only facilitatorNetworks, each
  // entry a CAIP-2 eip155:<chainId> id. A partial block merges over the
  // defaults in applyFileConfig (the anomaly precedent).
  if (doc.evm !== undefined) {
    evmPolicy(doc.evm, "evm", errors);
  }

  // liveness — optional; strict shape (issue #34, L8): require_fresh_402 a
  // boolean, max_age_seconds a finite number > 0, allowlist an array of
  // { base_url: parseable http/https URL, paths?: path strings starting with
  // "/" } ([] allowed — it pins nothing and activates strict mode). A partial
  // block merges over the defaults in applyFileConfig (the anomaly
  // precedent). FILE-ONLY: no X402_POLICY_* env override (the recipients /
  // anomaly precedent).
  if (doc.liveness !== undefined) {
    livenessPolicy(doc.liveness, "liveness", errors);
  }
}

// ---------------------------------------------------------------------------
// Loading (file + env overrides)
// ---------------------------------------------------------------------------

function applyFileConfig(config: PolicyConfig, errors: string[]): void {
  const path = process.env.POLICY_CONFIG_PATH;
  if (!path || path.trim() === "") return;

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    // Ratified: a MISSING file at POLICY_CONFIG_PATH loads the default policy.
    // (Fail-closed applies to malformed/unusable content, decided explicitly
    // for this repo; a missing file is indistinguishable from "no config".)
    // Post-#23 follow-up: ENOENT is the ONLY error class with that meaning.
    // A file that exists but cannot be read (EACCES on revoked permissions,
    // EISDIR on a directory path, …) is NOT "no config" — swallowing its
    // error would fail OPEN, silently discarding the operator's tightened
    // rules and running the permissive default. Every other read error fails
    // closed: the engine returns DENY with CONFIG_INVALID + PAYMENTS_DISABLED
    // and the underlying error in the reason message. (A dangling symlink
    // surfaces as ENOENT on read, so it follows the ratified missing-file
    // behavior.)
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return;
    errors.push(
      `POLICY_CONFIG_PATH ${path} exists but could not be read (${err instanceof Error ? err.message : String(err)})`,
    );
    return;
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    errors.push(`POLICY_CONFIG_PATH ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const before = errors.length;
  validateDocument(doc, errors);
  if (errors.length > before) return; // already reported — don't half-apply

  const d = doc as {
    payments?: { enabled?: boolean; maxPerRequest?: number; maxDaily?: number };
    services?: Partial<Record<ServiceLevelKey, ServicePolicy>>;
    networks?: { allowed?: string[] };
    tokens?: { allowed?: string[] };
    recipients?: {
      mode?: "allowlist" | "change-detect";
      allowed?: string[];
      perService?: Record<string, string[]>;
      known?: Record<string, string>;
    };
    anomaly?: Partial<AnomalyConfig>;
    evm?: { facilitatorNetworks?: string[] };
    liveness?: {
      require_fresh_402?: boolean;
      max_age_seconds?: number;
      allowlist?: LivenessAllowlistEntry[];
    };
  };

  // payments is fully specified (required) — replace wholesale.
  config.payments = {
    enabled: d.payments!.enabled!,
    maxPerRequest: d.payments!.maxPerRequest!,
    maxDaily: d.payments!.maxDaily!,
  };
  if (d.services) {
    for (const level of SERVICE_LEVEL_KEYS) {
      if (d.services[level]) config.services[level] = { ...d.services[level]! };
    }
  }
  if (d.networks?.allowed) config.networks = { allowed: [...d.networks.allowed] };
  if (d.tokens?.allowed) config.tokens = { allowed: [...d.tokens.allowed] };

  // Issue #26: merge recipients over the default ONLY when the section is
  // present, field-by-field, copying fresh arrays/objects — never aliasing
  // DEFAULT_POLICY_CONFIG (the default template must stay pristine). Shapes
  // are guaranteed by validateDocument (unknown keys / wrong types error out
  // before anything is applied).
  if (d.recipients) {
    config.recipients = {
      mode: d.recipients.mode ?? config.recipients.mode,
      allowed: d.recipients.allowed !== undefined ? [...d.recipients.allowed] : config.recipients.allowed,
      perService: d.recipients.perService !== undefined
        ? Object.fromEntries(Object.entries(d.recipients.perService).map(([host, list]) => [host, [...list]]))
        : config.recipients.perService,
      known: d.recipients.known !== undefined ? { ...d.recipients.known } : config.recipients.known,
    };
  }

  // Issue #30: merge anomaly over the default ONLY when the section is
  // present, field-by-field, copying fresh values — never aliasing
  // DEFAULT_ANOMALY_CONFIG (the default template must stay pristine). Shapes
  // are guaranteed by validateDocument.
  if (d.anomaly) {
    config.anomaly = {
      enabled: d.anomaly.enabled ?? config.anomaly.enabled,
      window: d.anomaly.window ?? config.anomaly.window,
      warnZ: d.anomaly.warnZ ?? config.anomaly.warnZ,
      denyZ: d.anomaly.denyZ ?? config.anomaly.denyZ,
      minSamples: d.anomaly.minSamples ?? config.anomaly.minSamples,
      seedFromDirectory: d.anomaly.seedFromDirectory ?? config.anomaly.seedFromDirectory,
      defaultTolerance: d.anomaly.defaultTolerance ?? config.anomaly.defaultTolerance,
    };
    // Cross-field ordering is validated on the MERGED values: a partial block
    // that only raises warnZ above the default denyZ (or lowers denyZ below a
    // raised warnZ) must fail closed like any other malformed input.
    if (!(config.anomaly.warnZ >= 0) || !(config.anomaly.warnZ < config.anomaly.denyZ)) {
      errors.push(`anomaly.warnZ must satisfy 0 <= anomaly.warnZ < anomaly.denyZ (got warnZ ${config.anomaly.warnZ}, denyZ ${config.anomaly.denyZ} after merging over the defaults)`);
    }
  }

  // Issue #32: merge the evm block over the default ONLY when present, fresh
  // array copy — never aliasing DEFAULT_POLICY_CONFIG (same convention as
  // recipients/anomaly above).
  if (d.evm?.facilitatorNetworks) {
    config.evm = { facilitatorNetworks: [...d.evm.facilitatorNetworks] };
  }

  // Issue #34: merge the liveness block over the defaults ONLY when present,
  // field-by-field with fresh copies — never aliasing DEFAULT_POLICY_CONFIG
  // (same convention as recipients/anomaly/evm above). `allowlist` is
  // distinguished from ABSENT (L2/L3): an omitted key keeps the default
  // (seed-pinned mode); an explicit [] pins nothing and puts the gate in
  // strict mode. Shapes are guaranteed by validateDocument.
  if (d.liveness) {
    const merged: LivenessConfig = {
      require_fresh_402: d.liveness.require_fresh_402 ?? config.liveness.require_fresh_402,
      max_age_seconds: d.liveness.max_age_seconds ?? config.liveness.max_age_seconds,
    };
    const allowlist = d.liveness.allowlist !== undefined ? d.liveness.allowlist : config.liveness.allowlist;
    if (allowlist !== undefined) {
      merged.allowlist = allowlist.map((a) => ({
        base_url: a.base_url,
        ...(a.paths !== undefined ? { paths: [...a.paths] } : {}),
      }));
    }
    config.liveness = merged;
  }
}

function parseNumberOverride(value: string, name: string, errors: string[]): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    errors.push(`${name}='${value}' is not a finite non-negative number`);
    return undefined;
  }
  return parsed;
}

function parseListOverride(value: string, name: string, errors: string[]): string[] | undefined {
  const parts = value.split(",").map((s) => s.trim());
  if (parts.length === 0 || parts.some((s) => s === "")) {
    errors.push(`${name}='${value}' must be a comma-separated list of non-empty entries`);
    return undefined;
  }
  return parts;
}

function parseActionOverride(value: string, name: string, errors: string[]): ServicePolicy["action"] | undefined {
  if (value === "allow" || value === "deny" || value === "approval") return value;
  errors.push(`${name}='${value}' must be one of allow|deny|approval`);
  return undefined;
}

function applyEnvOverrides(config: PolicyConfig, errors: string[]): void {
  const enabledRaw = process.env.X402_POLICY_PAYMENTS_ENABLED;
  if (enabledRaw !== undefined && enabledRaw.trim() !== "") {
    if (enabledRaw === "true") config.payments.enabled = true;
    else if (enabledRaw === "false") config.payments.enabled = false;
    else errors.push(`X402_POLICY_PAYMENTS_ENABLED='${enabledRaw}' must be exactly "true" or "false"`);
  }

  const perReq = process.env.X402_POLICY_MAX_PER_REQUEST;
  if (perReq !== undefined && perReq.trim() !== "") {
    const v = parseNumberOverride(perReq, "X402_POLICY_MAX_PER_REQUEST", errors);
    if (v !== undefined) config.payments.maxPerRequest = v;
  }
  const daily = process.env.X402_POLICY_MAX_DAILY;
  if (daily !== undefined && daily.trim() !== "") {
    const v = parseNumberOverride(daily, "X402_POLICY_MAX_DAILY", errors);
    if (v !== undefined) config.payments.maxDaily = v;
  }

  const networks = process.env.X402_POLICY_NETWORKS;
  if (networks !== undefined && networks.trim() !== "") {
    const list = parseListOverride(networks, "X402_POLICY_NETWORKS", errors);
    if (list) config.networks = { allowed: list };
  }
  const tokens = process.env.X402_POLICY_TOKENS;
  if (tokens !== undefined && tokens.trim() !== "") {
    const list = parseListOverride(tokens, "X402_POLICY_TOKENS", errors);
    if (list) config.tokens = { allowed: list };
  }

  // Issue #32: the facilitator settle-list has an env override. Malformed
  // values fail closed via parseListOverride (error ⇒ CONFIG_INVALID state).
  const facilitator = process.env.X402_EVM_FACILITATOR_NETWORKS;
  if (facilitator !== undefined && facilitator.trim() !== "") {
    const list = parseListOverride(facilitator, "X402_EVM_FACILITATOR_NETWORKS", errors);
    if (list) config.evm = { facilitatorNetworks: list };
  }

  // NOTE (issue #30): the `anomaly` block has deliberately NO X402_POLICY_*
  // override — same precedent as `recipients`: the thresholds/seed settings
  // are file-only operator config (see applyFileConfig).
  // NOTE (issue #34): the `liveness` block likewise has deliberately NO
  // X402_POLICY_* override — fail-closed pin-set semantics need the file's
  // structured shape (see applyFileConfig).

  // Per-level service overrides: X402_POLICY_SERVICE_<LEVEL> = allow|deny|approval
  // plus optional X402_POLICY_SERVICE_<LEVEL>_MAX_PER_REQUEST / _MAX_DAILY.
  for (const level of SERVICE_LEVEL_KEYS) {
    const prefix = `X402_POLICY_SERVICE_${level.toUpperCase()}`;
    const actionRaw = process.env[prefix];
    if (actionRaw !== undefined && actionRaw.trim() !== "") {
      const action = parseActionOverride(actionRaw, prefix, errors);
      if (action) config.services[level] = { ...config.services[level], action };
    }
    const perReqRaw = process.env[`${prefix}_MAX_PER_REQUEST`];
    if (perReqRaw !== undefined && perReqRaw.trim() !== "") {
      const v = parseNumberOverride(perReqRaw, `${prefix}_MAX_PER_REQUEST`, errors);
      if (v !== undefined) config.services[level] = { ...config.services[level], maxPerRequest: v };
    }
    const dailyRaw = process.env[`${prefix}_MAX_DAILY`];
    if (dailyRaw !== undefined && dailyRaw.trim() !== "") {
      const v = parseNumberOverride(dailyRaw, `${prefix}_MAX_DAILY`, errors);
      if (v !== undefined) config.services[level] = { ...config.services[level], maxDaily: v };
    }
  }
}

/** Load and validate the policy configuration. Returns the engine state —
 * with configErrors non-empty (and payments disabled) whenever anything is
 * wrong, per the fail-closed rule. Reads env at call time. */
export function loadPolicyConfig(): PolicyEngineState {
  const errors: string[] = [];
  const config = defaultPolicyConfig(errors); // legacy env feeds the default caps
  applyFileConfig(config, errors);
  applyEnvOverrides(config, errors);

  if (errors.length > 0) {
    return { config: failClosedConfig(errors), configErrors: errors };
  }
  return { config, configErrors: [] };
}

/** Build a PolicyEngine from the current configuration. Deliberately NOT
 * memoised: each call re-reads env/config so a corrupted or tightened policy
 * applies immediately and deterministically; construction is trivial. */
export function getPolicyEngine(): PolicyEngine {
  return new PolicyEngine(loadPolicyConfig());
}

// ---------------------------------------------------------------------------
// Trust-level derivation + context building
// ---------------------------------------------------------------------------

function envHostList(varName: string): Set<string> {
  const raw = process.env[varName];
  if (!raw || raw.trim() === "") return new Set();
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== ""));
}

/** Map a service hostname to its trust level. Env allow/blocklists are read at
 * call time; the directory lookup uses the cached directory. Exact lowercase
 * hostname match — no wildcard, no reputation. */
export function resolveTrustLevel(serviceHost: string): TrustLevel {
  const host = (serviceHost || "").toLowerCase();
  if (host === "") return "UNKNOWN";
  if (envHostList("POLICY_BLOCKED_HOSTS").has(host)) return "BLOCKED";
  if (envHostList("POLICY_TRUSTED_HOSTS").has(host)) return "TRUSTED";
  try {
    const directory = loadDirectory();
    const match = directory.endpoints.some((e) => {
      try {
        return new URL(e.base_url).hostname.toLowerCase() === host;
      } catch {
        return false; // malformed directory base_url can never match — skip
      }
    });
    return match ? "DISCOVERED" : "UNKNOWN";
  } catch {
    // Directory unavailable (no endpoints.json anywhere) — treat as UNKNOWN
    // rather than crashing; the engine then applies services.unknown rules.
    return "UNKNOWN";
  }
}

export interface BuildContextOptions {
  currency?: string;
  recipient?: string;
  purpose?: string;
  agentContext?: string;
  /** Injectable clock (ms since epoch) for the liveness staleness check
   * (issue #34) — deterministic tests; defaults to Date.now(). */
  now?: number;
}

/** Compute the liveness verdict for a prospective target (issue #34, L1): the
 * directory row (findEntryForUrl — origin match, never throws) plus the
 * liveness config plus the injected clock, evaluated by the PURE helper
 * (src/policy/liveness.ts). NEVER throws: on any read failure the verdict is
 * ok:false ONLY in explicit-allowlist (strict) mode — otherwise the gate is
 * inert and evaluation proceeds exactly as before. */
function computeEndpointLiveness(url: string, now?: number): EndpointLiveness | undefined {
  let cfg: LivenessConfig;
  try {
    cfg = loadPolicyConfig().config.liveness;
  } catch {
    return undefined; // config not even loadable — the engine already fails closed on its own configErrors path
  }
  try {
    const entry = findEntryForUrl(url);
    return livenessVerdict({ url, entry, cfg, nowMs: now ?? Date.now() });
  } catch {
    if (cfg.allowlist !== undefined) {
      return {
        ok: false,
        status: "never_probed",
        stale: true,
        on_allowlist: false,
        reason: "Liveness state could not be read and liveness.allowlist is explicit — failing closed (strict mode)",
      };
    }
    return { ok: true, status: "never_probed", stale: true, on_allowlist: false };
  }
}

/** Compute the CURRENT liveness verdict for a URL (issue #34) — the exact
 * derivation buildPolicyContext performs for ctx.endpointLiveness, exported
 * so x402_fetch's signing-time recheck (L9) re-derives the verdict with NO new
 * network I/O (cached directory + config + injected/real clock). Never
 * throws; undefined only when the policy config itself cannot be loaded. */
export function livenessVerdictForUrl(url: string, now?: number): EndpointLiveness | undefined {
  return computeEndpointLiveness(url, now);
}

/** Build the full PolicyContext for a prospective payment to `url`: derives the
 * service hostname and trust level (the engine itself stays pure). An
 * unparseable URL yields service "" / UNKNOWN — deterministic and fail-closed
 * at the derivation layer. Issue #34: additionally computes the endpoint
 * liveness verdict (computeEndpointLiveness) so the engine's rule 4.7 can
 * refuse an off-pin-set or stale endpoint WITHOUT reading the directory
 * itself. */
export function buildPolicyContext(
  url: string,
  chain: string,
  token: string,
  amountUsd: number,
  opts: BuildContextOptions = {},
): PolicyContext {
  let service = "";
  try {
    service = new URL(url).hostname.toLowerCase();
  } catch {
    service = "";
  }
  return {
    service,
    chain,
    token,
    amount: amountUsd,
    ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
    ...(opts.recipient !== undefined ? { recipient: opts.recipient } : {}),
    ...(opts.purpose !== undefined ? { purpose: opts.purpose } : {}),
    ...(opts.agentContext !== undefined ? { agentContext: opts.agentContext } : {}),
    endpointLiveness: computeEndpointLiveness(url, opts.now),
    trustLevel: resolveTrustLevel(service),
  };
}