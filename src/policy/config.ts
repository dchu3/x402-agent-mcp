// Issue #19 — policy configuration: loading, validation, fail-closed behavior,
// env overrides, and trust-level derivation.
//
// Ratified decisions implemented here (see README "Payment Policy Engine"):
//
// 1. JSON config, not YAML (no new dependencies): POLICY_CONFIG_PATH points at
//    a JSON file; X402_POLICY_* env vars override individual fields. Missing
//    FILE at POLICY_CONFIG_PATH loads the default policy (ratified); a file
//    that exists but is malformed/wrong-typed/missing-critical-fields fails
//    closed: the engine state is "payments disabled" and evaluate() returns
//    DENY with CONFIG_INVALID + PAYMENTS_DISABLED — never silently permissive.
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
import { loadDirectory } from "../directory.js";
import type {
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

/** Strict validation of a parsed config document against the schema. Only
 * `payments` is required (safety-critical — the issue's fail-closed rule);
 * services/networks/tokens are optional and merge over the defaults. Unknown
 * keys are errors everywhere (typo protection: a misspelled cap must never be
 * silently ignored). */
function validateDocument(doc: unknown, errors: string[]): void {
  if (!isPlainObject(doc)) {
    errors.push("policy config must be a JSON object");
    return;
  }
  const knownTop = new Set(["payments", "services", "networks", "tokens"]);
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
  } catch {
    // Ratified: a MISSING file at POLICY_CONFIG_PATH loads the default policy.
    // (Fail-closed applies to malformed/unusable content, decided explicitly
    // for this repo; a missing file is indistinguishable from "no config".)
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
}

/** Build the full PolicyContext for a prospective payment to `url`: derives the
 * service hostname and trust level (the engine itself stays pure). An
 * unparseable URL yields service "" / UNKNOWN — deterministic and fail-closed
 * at the derivation layer. */
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
    trustLevel: resolveTrustLevel(service),
  };
}