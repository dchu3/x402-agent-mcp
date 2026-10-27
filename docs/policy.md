# Payment policy engine

The deterministic gate every payment passes before any payment code runs — decisions and reason codes, the fixed rule order, trust levels, and the recipients, price-anomaly and endpoint-liveness gates.

Every payment passes a deterministic policy gate **before any payment code runs**. The policy engine (in `src/policy/`) is deliberately small, pure (same inputs → same decision, always) and independent of payment mechanics: `x402_fetch` calls `policyEngine.evaluate(context, budgetState)` and refuses to pay unless the decision is `ALLOW`. The pre-existing budget guards stay in place as belt-and-braces inside the payment layer — the policy engine is the outer gate, not a replacement.

```
Agent request (x402_fetch or x402_check_payment)
   |
   v
Policy Engine  ← policy config + trust level + today's budget state
   |
   +-- DENY -------------> structured refusal, NO payment
   |
   +-- APPROVAL_REQUIRED -> refusal with that reason code (Phase 1: see below)
   |
   +-- ALLOW
          |
          v
     belt-and-braces budget checks (payment-utils / casper budget)
          |
          v
     payment execution (x402 protocol)
          |
          v
     settlement receipt (server-attested — see payments.md, Trust Model)
```

### Decisions and reason codes

Decisions are exactly `ALLOW`, `DENY`, `APPROVAL_REQUIRED`. Every non-ALLOW result carries stable machine-readable reason codes — code against these, never against the human-readable message:

| Reason code | Fires when |
|-------------|------------|
| `PAYMENTS_DISABLED` | Global payments kill switch (`payments.enabled: false`) |
| `REQUEST_LIMIT_EXCEEDED` | Amount above the per-request cap (level override or global); also fails closed on non-finite/negative amounts |
| `DAILY_LIMIT_EXCEEDED` | Today's global spend + amount would exceed the daily cap |
| `SERVICE_LIMIT_EXCEEDED` | Today's spend for this service would exceed its per-service daily cap |
| `CHAIN_NOT_ALLOWED` | Chain not in the `networks.allowed` allowlist; or the Ethereum L1 (`ethereum` / `eip155:1`), which is always refused even when listed; or an allowed EVM chain the configured facilitator does not settle (`evm.facilitatorNetworks`) — one reason per evaluation, in that precedence |
| `TOKEN_NOT_ALLOWED` | Token not in the token allowlist |
| `SERVICE_BLOCKED` | Host is BLOCKED, or its trust level is configured to deny |
| `UNKNOWN_SERVICE` | Host is not in the directory while `services.unknown` is configured to deny |
| `APPROVAL_REQUIRED` | The trust level is configured to `approval` (Phase 1: treated as a refusal — see below) |
| `CONFIG_INVALID` | Policy configuration failed validation — the engine fails closed |
| `RECIPIENT_NOT_ALLOWED` | Rule 4.5 recipient gate: the probed recipient is not on the effective allowlist (allowlist mode — fail-closed on an empty effective list or a missing/unusable probed recipient), or differs from the recorded baseline (change-detect mode) |
| `PRICE_ANOMALY` | Rule 4.6 price anomaly gate: the amount is outside the tolerance of the per-service settled-amount baseline — a mild spike routes to `APPROVAL_REQUIRED`, a severe spike (or a non-positive amount on a USD chain) hard-**DENY**s. The reason carries a `detail` payload with the z-score (or fallback ratio) plus baseline stats |
| `ENDPOINT_NOT_LIVE` | Rule 4.7 endpoint liveness gate: the target is off the liveness pin set (catalog membership is not proof of liveness; an explicit `liveness.allowlist` also refuses every unlisted host), or its last recorded 402 probe is missing, stale (older than `liveness.max_age_seconds`), or not a live 402. Refresh with `x402_probe_allowlist` |
| `NETWORK_NOT_CONFIGURED` | x402_fetch: a payment key is loaded but `X402_NETWORK_MODE` is unset or invalid — the explicit-mode gate refuses EVERY paid call BEFORE the probe (fail closed, no default; free tools immune) |
| `ASSET_NOT_LISTED` | x402_fetch: the offer's asset is not listed for its network in the asset table — refused before any pricing, binding or signing |
| `ASSET_NO_USD_RATE` | x402_fetch: the asset is listed but priced nothing on the USD leg (no `usdPeg`, no positive `usdRate`) — the USD caps need a value, refuse rather than assume |

Rules are evaluated in a fixed, documented order and reasons **accumulate** (all triggered codes are returned, not just the first): 1 `SERVICE_BLOCKED`, 2 `PAYMENTS_DISABLED`, 3 `CHAIN_NOT_ALLOWED`, 4 `TOKEN_NOT_ALLOWED`, 4.5 `RECIPIENT_NOT_ALLOWED`, 4.6 `PRICE_ANOMALY`, 4.7 `ENDPOINT_NOT_LIVE`, 5 `UNKNOWN_SERVICE`, 6 `REQUEST_LIMIT_EXCEEDED`, 7 `DAILY_LIMIT_EXCEEDED`, 8 `SERVICE_LIMIT_EXCEEDED`, 9 `APPROVAL_REQUIRED`. `DENY` outranks `APPROVAL_REQUIRED` outranks `ALLOW`. Cap boundaries match the inner payment guards exactly: `> cap` denies, reaching the cap exactly is allowed.

### Trust levels

Derived from operator env allowlists plus directory provenance (the `source` metadata on directory entries). No reputation system.

| Level | Derived from | Default behavior |
|-------|--------------|------------------|
| `BLOCKED` | host listed in `POLICY_BLOCKED_HOSTS` (comma-separated) | always deny |
| `TRUSTED` | host listed in `POLICY_TRUSTED_HOSTS` (user-managed allowlist) | payable at global caps |
| `DISCOVERED` | host is a directory entry (`source: "seed"` or `"discovery"`) | payable at global caps |
| `UNKNOWN` | host not in the directory | governed by `services.unknown` (default: allow — see the compat decision below) |

Precedence is fail-closed: `BLOCKED` > `TRUSTED` > directory > `UNKNOWN`. Per-level configuration can tighten any level (`deny`, `approval`, or a lower `maxPerRequest` / per-service `maxDaily`).

### Configuration

JSON via `POLICY_CONFIG_PATH` (no new dependencies), with `X402_POLICY_*` env overrides. A complete, commented, validated example lives in [`policy.example.json`](../policy.example.json) (usage notes: [`policy.example.README.md`](../policy.example.README.md)) — copy it, edit it, and point `POLICY_CONFIG_PATH` at it; `node scripts/validate-policy-example.mjs` proves it loads clean and behaves as documented. Precedence: `MAX_PAYMENT_PER_CALL` / `MAX_DAILY_SPEND` (the legacy defaults) < the `X402_POLICY_PROFILE` overlay (see Profiles below) < config file < env overrides.

```json
{
  "payments": {
    "enabled": true,
    "maxPerRequest": 0.50,
    "maxDaily": 10.00
  },
  "services": {
    "unknown":    { "action": "allow" },
    "discovered": { "action": "allow" },
    "verified":   { "action": "allow" },
    "trusted":    { "action": "allow" },
    "blocked":    { "action": "deny" }
  },
  "networks": { "allowed": ["base", "solana", "casper"] },
  "tokens":   { "allowed": ["USDC", "wCSPR"] },
  "evm":      { "facilitatorNetworks": ["eip155:8453", "eip155:137", "eip155:42161"] },
  "recipients": { "mode": "change-detect", "allowed": [], "perService": {}, "known": {} },
  "anomaly": { "enabled": false, "window": 20, "warnZ": 2.0, "denyZ": 3.0, "minSamples": 5, "seedFromDirectory": true, "defaultTolerance": 2.0 },
  "liveness": { "require_fresh_402": true, "max_age_seconds": 3600 }
}
```

The example above **is** the behavior-compat default: non-directory hosts are payable at the global caps (`services.unknown: allow` — before the policy engine, directory membership played no role in the limit checks), the recipient gate is inactive by construction (`recipients` defaults to `change-detect` with **no** recorded baselines — nothing to compare, so rule 4.5 never fires), and the price anomaly gate ships disabled (`anomaly.enabled: false`). Tightening is opt-in and never the default — for example, the following refuses every non-directory host and tightens directory-service caps (a copy-paste of the block above does NOT apply any of this). Every policy file carries its own `payments` block — it is the one required section:

```json
{
  "payments": { "enabled": true, "maxPerRequest": 0.50, "maxDaily": 10.00 },
  "services": {
    "unknown":    { "action": "deny" },
    "discovered": { "action": "allow", "maxPerRequest": 0.25, "maxDaily": 1.00 },
    "trusted":    { "action": "allow", "maxPerRequest": 5.00 }
  }
}
```

A file that carries only `recipients` (or only `services`) does not load: validation fails, the engine lands in the payments-disabled error state (`CONFIG_INVALID`, payments refused, fail closed). An allowlist-only policy therefore needs at least the `payments` block plus the recipient gate:

```json
{
  "payments": { "enabled": true, "maxPerRequest": 0.50, "maxDaily": 10.00 },
  "recipients": { "mode": "allowlist", "allowed": [], "perService": {}, "known": {} }
}
```

(list your payees in `recipients.allowed` / `recipients.perService`; an empty effective list denies every recipient.)

#### Profiles — `X402_POLICY_PROFILE`

Three **operator opt-in** profiles ship on top of the defaults; `X402_POLICY_PROFILE` (`strict` | `standard` | `permissive`, exact lowercase match) selects one. With the variable unset the profile is **`permissive`** — exactly the behavior-compat default above; nothing changes until an operator opts in, and the startup log names the active profile (with the permissive default it warns that unknown services are payable up to the global caps — unless a policy file tightened them past that default).

| Profile | Effect |
|---------|--------|
| `permissive` (default) | The behavior-compat default: every service level payable at the global caps (`services.unknown: allow`), the recipient gate inactive (`change-detect` with no recorded baselines — nothing to compare against), the price-anomaly gate off. It does **not** turn the shipped gates off: the `BLOCKED` trust level (`POLICY_BLOCKED_HOSTS`) always denies, the `networks.allowed` / `tokens.allowed` allowlists still bind, and the endpoint liveness gate (`liveness.require_fresh_402: true` — the one deliberate default tightening, see below) refuses payments to unpinned or stale directory rows. |
| `standard` | Non-directory hosts stay payable only at or below a **USD 0.05 per-request** line (written as `services.unknown.maxPerRequest`), directory membership raises no trust, and the price-anomaly gate turns on. Otherwise like `strict`: the recipient gate flips to **allowlist** mode — there is no approval channel, so the first payment to a new recipient is refused until the payee is listed via the config file — and the explicitly-trusted service levels are capped per host at **USD 0.05 per request** and **USD 1.00 per host per day** (`services.trusted` / `services.verified` carry that line). |
| `strict` | BOTH host and recipient gates must be satisfied before anything pays. The recipient gate flips to **allowlist** mode — an unlisted payee is refused with `RECIPIENT_NOT_ALLOWED` (with an empty effective list every recipient is denied) — and non-directory hosts are refused outright (`services.unknown: deny`): an unknown host is refused with `UNKNOWN_SERVICE` even when its payee is listed, and a trusted host (`POLICY_TRUSTED_HOSTS`, the one level that survives the trust cap) with an unlisted payee is refused with `RECIPIENT_NOT_ALLOWED`. Directory membership raises no trust either. The price-anomaly gate turns on and the per-host cap binds everywhere: `services.trusted` / `services.verified` carry **USD 0.05 per request** and **USD 1.00 per host per day**, and `services.discovered` carries the same per-request line as defense in depth — no service level rides the global caps alone. |

The table states exactly what the code applies (`src/policy/profile.ts`): the caps are not aspirational. Every profile cap is `min()`-ed against the existing value and the legacy line — a profile can never raise a cap. An invalid `X402_POLICY_PROFILE` value fails closed: the engine lands in the payments-disabled error state (`CONFIG_INVALID`, payments refused), the failure is reported as `policy_profile=invalid` with the resolver message (in the startup log and in `x402_check_payment` as `policy_profile_error`), and free tools are unaffected.

**A policy file always wins over the profile**; the full precedence is: profile < `POLICY_CONFIG_PATH` file < `X402_POLICY_*` env overrides. With the variable unset the profile is `permissive`.

**Recipients.** The `recipients` block gates *who* may be paid — rule 4.5 emits `RECIPIENT_NOT_ALLOWED`. Comparison happens on the **normalized (canonical)** recipient, chain-aware: EVM `0x…` addresses are compared case-insensitively against their EIP-55-valid spelling (a wrong-checksum spelling is not repaired — it is unusable) on **every** EVM chain in the vocabulary (`base`, `polygon`, `arbitrum`, `base-sepolia`, any `eip155:*` id), Solana wallets as the canonical 32-byte base58 re-encoding, Casper payTo as `00` + 64 hex with an optional `account-hash-` prefix stripped. Formatting can therefore never bypass or break the gate. Entries are **chain-scoped**: `"polygon:0x…"` matches only on polygon, `"*:0x…"` on any chain, and a **bare** entry (no qualifier) is scoped to **base** — a bare Base entry authorises only on base and can never silently authorise the same `0x…` address on Polygon. An entry with an unrecognised qualifier is unusable (fail closed). Two modes:

- **`allowlist` — active always, fail-closed.** A payment is refused unless the probed recipient normalizes to an entry on the *effective* allowlist for the host: `recipients.perService[host]` **replaces** the global `recipients.allowed` list when present (keys are lowercase hostnames). An **empty effective list denies every recipient**, and a missing or unusable probed recipient is denied too — membership can never be proven.
- **`change-detect` — active only for a host with a recorded baseline.** `recipients.known` maps a lowercase hostname to its expected recipient (e.g. `"known": { "merchant.example": "00ab…" }`); the payment is refused when the probed recipient differs from the baseline. With no baseline for the host nothing fires — nothing to compare. This is the compat default (empty `known` ⇒ inactive).

Compat default block:

```json
{
  "recipients": {
    "mode": "change-detect",
    "allowed": [],
    "perService": {},
    "known": {}
  }
}
```

Tightening example — only ever pay one global recipient, except one host which pays only its own:

```json
{
  "recipients": {
    "mode": "allowlist",
    "allowed": ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
    "perService": {
      "trusted-merchant.example": ["<MERCHANT_PAYTO_ADDRESS>"]
    },
    "known": {}
  }
}
```

**The `recipients` block is file-only.** A per-host map cannot be expressed cleanly as a flat env var, so unlike the sections above there is deliberately **no** `X402_POLICY_*` override for it (the other sections keep their knobs, below). Unknown keys inside `recipients` are errors (typo protection), like everywhere else. In `allowlist` mode, `x402_fetch` passes the `payTo` address from the 402 challenge into the gate for both the USD legs (Base/Solana) and the Casper leg, so the recipient is validated **before** any payment machinery runs; the payment intent then binds exactly the validated value.

**Price anomaly detection — the `anomaly` block, rule 4.6.** Caps track *cumulative* spend; they cannot see one service being paid 10× its normal rate. Rule 4.6 adds a second spend axis: each non-Casper service keeps a baseline of its last N **settled** amounts (ledger-backed, rehydrated like the budget counters — no parallel state), and every prospective payment is compared against it. `PRICE_ANOMALY` is deliberately **not** a `DENY_CODES` member: the *band* decides the routing.

Compat default block (the gate ships **disabled** — enabling it is an operator opt-in, exactly like `services.unknown: deny` and the recipient allowlist):

```json
{
  "anomaly": {
    "enabled": false,
    "window": 20,
    "warnZ": 2.0,
    "denyZ": 3.0,
    "minSamples": 5,
    "seedFromDirectory": true,
    "defaultTolerance": 2.0
  }
}
```

With `enabled: true`, rule 4.6 (evaluated after rule 4.5, before `UNKNOWN_SERVICE`) routes in bands:

- **z-score band** (baseline has ≥ `minSamples` samples and non-zero variance): `z < warnZ` annotates nothing; `warnZ ≤ z < denyZ` routes to `APPROVAL_REQUIRED` with a `PRICE_ANOMALY` reason; `z ≥ denyZ` hard-**DENY**s with that reason. `PRICE_ANOMALY` is intentionally absent from `DENY_CODES` — membership would force DENY whenever it appears and make the approval band unreachable.
- **Thin-baseline fallback** (fewer than `minSamples` samples, or zero variance): the payment is compared against the reference price (the baseline mean, else the advertised directory price) with the `defaultTolerance` multiplier — exceeding it routes to `APPROVAL_REQUIRED`, **never** to a hard deny. Statistics are the evidence for a hard deny; a stub baseline is not (1–2 samples yield `stdev = 0` ⇒ `z = ∞`, which would deny everything).
- **Non-positive amount** on a USD chain (0, negative, non-finite): hard **DENY** — the gate fails closed on amounts it cannot reason about.
- **Casper is excluded**: the Casper leg passes `amount: 0` by design (amounts are mote-denominated and have no USD price at that layer), so rule 4.6 is inert for it — `casper/budget.ts` remains Casper's spend authority, the same scope rule the USD-ledger stores document.
- **First call, graceful seeding**: with `seedFromDirectory: true`, a host with no settled baseline yet is softly compared against the advertised directory price (a one-sample seed, derived per call, never stored) and can only reach the approval band. Once the first real settlement lands (recorded **only** on a successful settlement, next to `recordServicePayment`, under the same `resp.status === 200` guard), it becomes the first real sample — a denied spike can never poison the baseline.

Every `PRICE_ANOMALY` reason carries an optional `detail` payload for the audit log — `{zScore | ratio, mean, stdev, samples, window, band, amount, host}` (or `{reason: "non-positive-amount", amount, host}`) — surfaced verbatim in `x402_fetch`'s structured refusal and in `x402_check_payment` output. The block is **file-only** like `recipients`: no `X402_POLICY_*` override (thresholds are deliberate operator config), and unknown keys inside it are errors (typo protection).

Env overrides (each fails closed on a malformed value — never silently ignored):

| Env var | Overrides |
|---------|-----------|
| `X402_POLICY_PAYMENTS_ENABLED` | `true` / `false` (exact strings) |
| `X402_POLICY_MAX_PER_REQUEST` | global per-request cap |
| `X402_POLICY_MAX_DAILY` | global daily cap |
| `X402_POLICY_NETWORKS` | comma-separated network allowlist |
| `X402_POLICY_TOKENS` | comma-separated token allowlist |
| `X402_EVM_FACILITATOR_NETWORKS` | comma-separated CAIP-2 ids the facilitator settles |
| `X402_POLICY_SERVICE_<LEVEL>` | `allow` / `deny` / `approval` for `unknown\|discovered\|verified\|trusted\|blocked` |
| `X402_POLICY_SERVICE_<LEVEL>_MAX_PER_REQUEST` / `X402_POLICY_SERVICE_<LEVEL>_MAX_DAILY` | per-level caps |
| `POLICY_TRUSTED_HOSTS` / `POLICY_BLOCKED_HOSTS` | comma-separated hostnames for the `TRUSTED` / `BLOCKED` trust levels |

**Fail closed.** A config file that is unreadable (e.g. revoked permissions — any read error other than a missing file), malformed JSON, wrong types, missing critical fields (`payments` is required), unrecognized keys (typo protection — a misspelled cap is an error, not a silent no-op), or unparseable env values puts the engine into a payments-disabled error state: `evaluate()` returns `DENY` with `CONFIG_INVALID` + `PAYMENTS_DISABLED` for **every** request. A missing file at `POLICY_CONFIG_PATH` (ENOENT) loads the default policy (fail-closed applies to unusable content, not to an absent file). The policy layer never weakens a malformed setting into a permissive one.

### The two explicit Phase 1 decisions

1. **`APPROVAL_REQUIRED` is a refusal in Phase 1.** This MCP runs over stdio and has no human-approval channel; returning a decision the agent could treat as "pending" would be worse than refusing. The engine returns `APPROVAL_REQUIRED` with that reason code preserved, and `x402_fetch` refuses to pay — the fail-closed principle applied to the approval gap.

2. **The default policy is permissive**: payments enabled, caps from `MAX_PAYMENT_PER_CALL` (default $0.50) / `MAX_DAILY_SPEND` (default $10.00), networks `[base, solana, casper]`, tokens `[USDC, wCSPR]`, every directory service payable at the global caps, `services.unknown: allow` — **any** host is payable at the global caps (directory membership plays no role in the limit checks) — and the recipient gate inactive (`recipients` defaults to `change-detect` with no baselines). **Polygon and Arbitrum are deliberately NOT in the default allowlist**: widening the set of payable chains is a money-path change and ships opt-in only — add `"polygon", "arbitrum"` to `networks.allowed` to enable them (the default facilitator settle-list `evm.facilitatorNetworks` already covers their CAIP-2 ids; it is a fail-closed gate consulted only for chains that passed `networks.allowed`, never an authorisation source). **The one deliberate default tightening**: the endpoint liveness gate (`liveness.require_fresh_402: true`) refuses payments to DIRECTORY rows that are unpinned or lack a fresh live 402 probe — hosts that are NOT directory rows are governed by the other rules (allowlist omitted = seed-pinned mode, inert for non-catalog hosts). Tightening — e.g. `services.unknown: "deny"` so non-directory hosts are refused, or a recipient `allowlist` — is opt-in via config. The default path is test-locked: the suite asserts both the liveness refusal path and the untouched default path.

### Endpoint liveness

Directory membership is not proof of liveness. Each directory entry carries its most recent liveness probe record (`liveness`: `{ probed_at, status: live_402|no_402|error, latency_ms, probe_url, accepts? }`), written ONLY by the operator-triggered refresh tool:

- **`x402_probe_allowlist`** probes the pin set — with bounded concurrency (4), a 10 s per-probe timeout, no redirects, and never a payment — and records each result atomically onto its directory entry (the same `atomicWriteFileSync` path every directory write uses). Each row is probed across a bounded candidate list, in precedence order: an allowlist entry's configured `paths` (when present — exhaustive, no discovery; a trailing-`*` wildcard entry such as `/price/*` probes its substituted `/price/x402-probe` representative, never the literal wildcard URL), then the row's advertised `endpoints[]` GET paths (`{param}`/`*` placeholders are substituted by a clearly-marked `x402-probe` token in the built request URL only), then the row's `base_url`, then up to 8 noise-filtered GET paths discovered from the row's `/openapi.json`; candidates are de-duplicated and the walk is capped at 5 URLs per row, with the first `live_402` winning (its exact URL is recorded as `probe_url`). Root-only services are unaffected — the `base_url` is still probed — and a `no_402` record means "no candidate answered 402". Run it on your own schedule (e.g. cron, like the directory crawler); nothing probes in the background, and **`x402_search` performs zero network calls** (tripwire-tested).
- **`x402_search` ranks live-first**: rows with a fresh `live_402` record sort ahead (newest probe first), then rows with stale / `no_402` / `error` records, then never-probed rows. Every row carries `live: boolean` and its `liveness` block; the summary adds `live_total`. Rows that are NOT on the pin set are withheld by default (`include_unverified: true` reveals them, always `live: false`).
- **The pin set** (policy `liveness` block): when `liveness.allowlist` is **omitted** (the default), directory entries with `source: "seed"` are pinned — the operator-curated baseline. An explicit `allowlist: [{ base_url, paths? }]` pins the directory rows whose ORIGIN matches a configured `base_url` (a `paths` list additionally narrows the gate per-URL and drives which URLs the refresh probes; each `paths` entry matches a target URL's pathname exactly — `/api` pins only `/api` — except for ONE trailing `*`, the prefix wildcard: `/price/*` admits every parametrized route under the prefix (`/price/<address>`) but not the bare `/price` or `/price/`; a `*` anywhere else, or the directory's `{param}` templated syntax, is a config-validation error — the config fails closed rather than silently pinning nothing); a configured `base_url` with no matching directory row pins **nothing** (records live on directory entries; this change never grows the catalog). `allowlist: []` pins nothing and turns the gate into **strict allowlist mode**: every unlisted host is refused, including non-directory hosts.
- **Rule 4.7 (`ENDPOINT_NOT_LIVE`) fails closed at the payment gate**: with `require_fresh_402: true` (the default) a payment to a directory row is refused unless the row is pinned AND its probe record is a fresh `live_402` (not older than `max_age_seconds`, default 3600 s). The verdict is computed at context build and re-derived once more **inside the signing hook** (`INTENT_ENDPOINT_NOT_LIVE` abort before any signature), so a record that ages out between the gate and the signature can no longer be paid. Non-directory hosts are inert when the allowlist is omitted — `services.unknown`, recipient and cap rules govern them exactly as before. `x402_check_payment` echoes the verdict as `endpoint_liveness`. Set `require_fresh_402: false` to turn the gate off (search keeps its liveness metadata); the `liveness` block is **file-only** — no `X402_POLICY_*` env override, like `recipients`/`anomaly`.

### Inspecting a payment without paying

`x402_check_payment` evaluates a prospective payment and returns the structured decision — it never touches payment code paths (locked by a zero-payment-calls test):

```json
{
  "decision": "DENY",
  "service": "example.com",
  "amount": "2.50",
  "currency": "USDC",
  "chain": "base",
  "trust_level": "DISCOVERED",
  "reasons": [
    { "code": "SERVICE_LIMIT_EXCEEDED", "message": "Service example.com daily limit is $1.00 and $0.27 remains" }
  ],
  "limits": { "trustLevel": "DISCOVERED", "maxPerRequest": 0.5, "maxDaily": 10, "perServiceDaily": 1.0 },
  "note": "Inspection only — no payment was attempted. Resolve DENY reasons before calling x402_fetch."
}
```

Per-service daily spend is tracked in the same payment ledger (grouped by URL hostname, rehydrated like the global counter — no parallel state). Per-service caps are enforced for USD-settled chains (Base/Solana); Casper remains governed by its mote budgets (`CASPER_MAX_PAYMENT_PER_CALL` / `CASPER_MAX_DAILY_SPEND`) inside the payment layer.

`x402_check_payment` also accepts an optional **`recipient`** argument — the `payTo` address from the 402 challenge — so the recipient gate can be checked before fetching. In `allowlist` mode the argument is **required** (without it the gate denies); in `change-detect` mode it is compared against the recorded baseline. The response echoes `recipient` verbatim plus `recipient_normalized`, the canonical form rule 4.5 compares (`null` when no recipient was supplied or it is not a valid address for the chain). With the price anomaly gate **enabled**, omitting `amount` means checking a $0 payment — which rule 4.6 hard-denies on USD chains — so pass the real amount from the 402 challenge when the anomaly gate is on; with the compat default (gate disabled) the $0 amount is checked against the remaining rules as usual. When a reason carries one, the response includes its `detail` payload (e.g. the `PRICE_ANOMALY` z-score/baseline stats).

Deliberately **not** in Phase 1 (future extensions, tracked separately): approval workflows, payment velocity limits, circuit breakers, transaction simulation, response size limits, untrusted-data labelling, prompt-injection-aware response handling, and a persistent audit ledger. (Recipient allowlisting ships as rule 4.5; price anomaly detection ships as rule 4.6.)

