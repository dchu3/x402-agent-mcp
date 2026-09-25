# x402-agent-mcp

**Universal x402 MCP for AI agents — discover and pay for any x402 endpoint on Base, Polygon, Arbitrum, Solana or Casper.**

Agents discover services, pay per call, and consume data — all autonomously. No API keys, no subscriptions, no signup. Just a wallet.

## What It Does

```
Agent: "I need news data"
  → x402_search("news") → finds 2s.io
  → x402_describe("2s.io") → gets endpoint schema + price
  → x402_fetch("https://2s.io/api/news/search?q=x402&limit=3") → pays $0.003 USDC → gets results
```

The agent never sees wallets, private keys, or x402 protocol details. Just search, discover, fetch.

## Tools (10)

| Tool | Cost | Description |
|------|------|-------------|
| `x402_search` | Free | Search x402 endpoints by keyword, category, or chain — **ranked live-first** by the recorded 402 liveness probes (issue #34; unpinned rows withheld unless `include_unverified: true`). Never performs network calls. |
| `x402_probe_allowlist` | Free | Refresh the liveness probes for the pinned endpoint set (seed rows, or the `liveness.allowlist` origins) and record them atomically on the directory entries. Never pays, never follows redirects (issue #34). |
| `x402_list_categories` | Free | List all endpoint categories with counts |
| `x402_describe` | Free | Get detailed info for a specific service (paths, prices, schema) |
| `x402_discover_url` | Free | Discover any x402 service by URL via well-known files + auto-add to directory |
| `x402_health` | Free | Check if a service is live and responding with 402 |
| `x402_discover_urls` | Free | Batch discover multiple x402 services in parallel |
| `x402_crawl_directory` | Free | Crawl x402scan.com to discover new x402 services and auto-add to directory |
| `x402_check_payment` | Free | Evaluate a prospective payment against policy — ALLOW / DENY / APPROVAL_REQUIRED with reason codes. **Never pays.** |
| `x402_fetch` | Endpoint price | Fetch any x402 endpoint — handles 402 payment on Base, Polygon, Arbitrum, Solana or Casper |

## Multi-Chain Support

| Chain | Env var | Payment |
|-------|---------|---------|
| Solana | `SOLANA_PRIVATE_KEY` | USDC via @x402/svm |
| Base | `EVM_PRIVATE_KEY` or `BASE_PRIVATE_KEY` | USDC via @x402/evm |
| Polygon | `EVM_PRIVATE_KEY` or `BASE_PRIVATE_KEY` | USDC via @x402/evm |
| Arbitrum | `EVM_PRIVATE_KEY` or `BASE_PRIVATE_KEY` | USDC via @x402/evm |
| Casper | `CASPER_PRIVATE_KEY` | wCSPR via @make-software/casper-x402 |

Chain is auto-detected from the 402 response's real CAIP-2 network id (`eip155:8453` ⇒ base, `eip155:137` ⇒ polygon, `eip155:42161` ⇒ arbitrum — an unrecognised `eip155:*` id keeps its verbatim identity and is denied by the default policy, never collapsed onto base). Override with the `chain` parameter (`base`/`polygon`/`arbitrum`/`solana`/`casper`). All EVM chains share the one `EVM_PRIVATE_KEY`; the Ethereum L1 (`eip155:1`) is always refused (see rule 3). `BASE_RPC_URL` applies to Base only — EVM payments on Polygon/Arbitrum sign locally (EIP-3009) with no RPC dependency. Policy note: Polygon and Arbitrum are **opt-in** — add them to `networks.allowed` (and keep the facilitator settle-list `evm.facilitatorNetworks` covering their CAIP-2 ids) to make them payable; the default policy pays Base only among EVM chains.

### Casper

Casper endpoints advertise CAIP-2 networks `casper:casper` (mainnet) and `casper:casper-test` (testnet), and settle in **wCSPR**, a CEP-18 token with 9 decimals (motes). Amounts are handled as exact integer motes — a requirement with sub-mote precision is rejected rather than rounded.

| Env var | Default | Description |
|---------|---------|-------------|
| `CASPER_PRIVATE_KEY` | — | Hex secret key, PEM file path, or PEM contents |
| `CASPER_KEY_ALGORITHM` | ed25519 | `ed25519` or `secp256k1` |
| `CASPER_NETWORK` | auto | Force `casper:casper` or `casper:casper-test` when a server offers both |
| `CASPER_MAX_PAYMENT_PER_CALL` | disabled | Maximum per authorization in decimal wCSPR (e.g. `1.5`) |
| `CASPER_MAX_DAILY_SPEND` | disabled | Daily authorization budget in decimal wCSPR (e.g. `10`) |

Both budgets must be explicitly set and positive. No USD conversion is performed. Only the network-specific wCSPR package hashes from [Casper Wallet Core](https://github.com/make-software/casper-wallet-core/blob/master/src/domain/constants/casperNetwork.ts) are accepted. `scheme: "exact"` and x402 v2 are required. Forced-chain calls still probe payment requirements, and the SDK checks the actual requirements again before signing. Settlement is performed by the endpoint's facilitator; this client does not configure a separate facilitator.

```
x402_fetch({ url: "https://some-casper-endpoint.example/api", chain: "casper" })
```

### Enabling the Casper leg

Before live paid Casper calls work, four prerequisites must be in place:

| Prerequisite | How to satisfy it |
|--------------|-------------------|
| Funded account key | Create a key with [Casper Wallet](https://www.casperwallet.io/) or [cspr.live](https://cspr.live) and export the hex secret key or PEM. On testnet, request free CSPR from the [Casper testnet faucet](https://testnet.cspr.live/tools/faucet). On mainnet you need real CSPR from an exchange or the staking ecosystem. |
| wCSPR balance | Endpoints settle in wCSPR (CEP-18), not raw CSPR. On mainnet you may need to wrap CSPR to wCSPR via a supported contract interaction first; on testnet the faucet plus a testnet wCSPR mint may apply. The exact wrap/mint flow varies — confirm it with the endpoint operator. |
| Target endpoint | This client ships no Casper endpoint list, and the x402 directory currently lists none. You need the endpoint URL from the operator — ask the endpoint operator or the Casper team. |
| Mote budgets | Both `CASPER_MAX_PAYMENT_PER_CALL` and `CASPER_MAX_DAILY_SPEND` must be set and positive, or **all** paid Casper requests fail closed. This is deliberate safety design, not a bug. |

Worked testnet `.env` (faucet-funded, small budgets — values are decimal wCSPR, converted to integer motes under the hood):

```bash
CASPER_PRIVATE_KEY=<hex-key-or-pem-path>
CASPER_NETWORK=casper:casper-test
CASPER_MAX_PAYMENT_PER_CALL=1
CASPER_MAX_DAILY_SPEND=5
```

Smoke test your first call:

```
x402_fetch({ url: "https://your-casper-endpoint.example/api", chain: "casper" })
```

Check the payment ledger for an entry with `currency: "wCSPR"` and an exact `amount_motes` string. Before the env vars are set, paid Casper calls return a `NOT_CONFIGURED`-style error; after, they sign and settle. An unset budget means no Casper signing happens at all.

**Why fail-closed:** if the key or either budget is unset, no Casper payment is ever signed — there is no silent fallback. Ambiguous failures retain their budget reservation (authorized, not settled), and spend stays bounded in native motes without any USD-conversion assumptions.

## Spending Limits & Payment Logging

| Env var | Default | Description |
|---------|---------|-------------|
| `MAX_PAYMENT_PER_CALL` | 0.50 | Reject any single call above this amount (USDC) |
| `MAX_DAILY_SPEND` | 10.00 | Reject after cumulative daily spend exceeded (USDC) |
| `PAYMENT_LOG_PATH` | ./x402-payments.jsonl | Path to payment log file (gitignored) |
| `X402_DIRECTORY_PATH` | ./endpoints.json | Path to the endpoint directory file (gitignored); set to isolate tests/sandboxes from the live directory |
| `X402_INTENT_TTL_MS` | 60000 | Payment-intent time-to-live in milliseconds (see Payment Intent Boundary); an expired intent can never be signed |

Payments share one `x402-payments.jsonl` ledger with timestamp, URL, chain, amount, tx hash, and status. USDC entries use `amount_usdc`; Casper entries use `currency: "wCSPR"` and an exact `amount_motes` string. Base/Solana counters are tracked by chain and summed for the existing USD daily limit. Casper has an independent mote counter.

Casper reserves budget synchronously before signing to prevent concurrent overspending. Failed or ambiguous requests retain that reservation; it represents authorized spend, not confirmed settlement. Only one authorization is permitted per fetch. A server-provided settlement receipt is not independently verified on-chain. Payment response bodies/headers are size-bounded and Casper redirects are refused.

Counters are process-local and reset at UTC midnight or process restart. They are not a durable, multi-instance wallet limit.

### Limitations — read before relying on these budgets

- **Per-process counters.** Daily spend lives in the memory of one MCP process (rehydrated once from the ledger on the first budget check). It is never a wallet-level limit.
- **Multiple instances = separate budgets.** Running two MCP processes gives each its own counter, so the real daily spend can reach N × `MAX_DAILY_SPEND`. Durable multi-instance enforcement requires an external store and is on the roadmap; until then, run one instance per budget scope.
- **The USDC daily cap can be overshot by in-flight concurrency.** The guard checks `MAX_DAILY_SPEND` before paying and records spend only after settlement; the await points between the check and the log inside a paid fetch mean several in-flight requests can pass the same check. The synchronous check-then-log span itself is exact (locked by the concurrent-consumption test in `src/payment-utils.rehydrate.test.ts`), but cross-await atomicity must not be assumed.
- **Casper is the fail-closed equivalent class.** Casper reserves budget synchronously *before* signing, so concurrent Casper calls cannot overspend, and an unset or invalid budget disables Casper payments entirely. Verified by `src/casper/budget.test.ts`: "daily reservations prevent concurrent callers overspending", "checks changed requirements at signing and blocks retries", "unset either Casper budget disables signing", "invalid, zero and negative budgets disable payment", and "rolls only the Casper counter at UTC day change".

## Payment Policy Engine (Phase 1)

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
     payment execution (x402 protocol, unchanged)
          |
          v
     settlement receipt (server-attested — see Trust Model)
```

### Decisions and reason codes

Decisions are exactly `ALLOW`, `DENY`, `APPROVAL_REQUIRED`. Every non-ALLOW result carries stable machine-readable reason codes — code against these, never against the human-readable message:

| Reason code | Fires when |
|-------------|------------|
| `PAYMENTS_DISABLED` | Global payments kill switch (`payments.enabled: false`) |
| `REQUEST_LIMIT_EXCEEDED` | Amount above the per-request cap (level override or global); also fails closed on non-finite/negative amounts |
| `DAILY_LIMIT_EXCEEDED` | Today's global spend + amount would exceed the daily cap |
| `SERVICE_LIMIT_EXCEEDED` | Today's spend for this service would exceed its per-service daily cap |
| `CHAIN_NOT_ALLOWED` | Chain not in the `networks.allowed` allowlist; or the Ethereum L1 (`ethereum` / `eip155:1`), which is always refused even when listed; or an allowed EVM chain the configured facilitator does not settle (`evm.facilitatorNetworks`) — one reason per evaluation, in that precedence (issue #32) |
| `TOKEN_NOT_ALLOWED` | Token not in the token allowlist |
| `SERVICE_BLOCKED` | Host is BLOCKED, or its trust level is configured to deny |
| `UNKNOWN_SERVICE` | Host is not in the directory while `services.unknown` is configured to deny |
| `APPROVAL_REQUIRED` | The trust level is configured to `approval` (Phase 1: treated as a refusal — see below) |
| `CONFIG_INVALID` | Policy configuration failed validation — the engine fails closed |
| `RECIPIENT_NOT_ALLOWED` | Rule 4.5 recipient gate (issue #26): the probed recipient is not on the effective allowlist (allowlist mode — fail-closed on an empty effective list or a missing/unusable probed recipient), or differs from the recorded baseline (change-detect mode) |
| `PRICE_ANOMALY` | Rule 4.6 price anomaly gate (issue #30): the amount is outside the tolerance of the per-service settled-amount baseline — a mild spike routes to `APPROVAL_REQUIRED`, a severe spike (or a non-positive amount on a USD chain) hard-**DENY**s. The reason carries a `detail` payload with the z-score (or fallback ratio) plus baseline stats |
| `ENDPOINT_NOT_LIVE` | Rule 4.7 endpoint liveness gate (issue #34): the target is off the liveness pin set (catalog membership is not proof of liveness; an explicit `liveness.allowlist` also refuses every unlisted host), or its last recorded 402 probe is missing, stale (older than `liveness.max_age_seconds`), or not a live 402. Refresh with `x402_probe_allowlist` |

Rules are evaluated in a fixed, documented order and reasons **accumulate** (all triggered codes are returned, not just the first): 1 `SERVICE_BLOCKED`, 2 `PAYMENTS_DISABLED`, 3 `CHAIN_NOT_ALLOWED`, 4 `TOKEN_NOT_ALLOWED`, 4.5 `RECIPIENT_NOT_ALLOWED` (issue #26), 4.6 `PRICE_ANOMALY` (issue #30), 4.7 `ENDPOINT_NOT_LIVE` (issue #34), 5 `UNKNOWN_SERVICE`, 6 `REQUEST_LIMIT_EXCEEDED`, 7 `DAILY_LIMIT_EXCEEDED`, 8 `SERVICE_LIMIT_EXCEEDED`, 9 `APPROVAL_REQUIRED`. `DENY` outranks `APPROVAL_REQUIRED` outranks `ALLOW`. Cap boundaries match the inner payment guards exactly: `> cap` denies, reaching the cap exactly is allowed.

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

JSON via `POLICY_CONFIG_PATH` (no new dependencies), with `X402_POLICY_*` env overrides. A complete, commented, validated example lives in [`policy.example.json`](policy.example.json) (usage notes: [`policy.example.README.md`](policy.example.README.md)) — copy it, edit it, and point `POLICY_CONFIG_PATH` at it; `node scripts/validate-policy-example.mjs` proves it loads clean and behaves as documented. Precedence: `MAX_PAYMENT_PER_CALL` / `MAX_DAILY_SPEND` (the legacy defaults) < config file < env overrides.

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

The example above **is** the behavior-compat default: non-directory hosts are payable at the global caps (`services.unknown: allow` — before the policy engine, directory membership played no role in the limit checks), the recipient gate is inactive by construction (`recipients` defaults to `change-detect` with **no** recorded baselines — nothing to compare, so rule 4.5 never fires), and the price anomaly gate ships disabled (`anomaly.enabled: false`, issue #30). Tightening is opt-in and never the default — for example, the following refuses every non-directory host and tightens directory-service caps (a copy-paste of the block above does NOT apply any of this):

```json
{
  "services": {
    "unknown":    { "action": "deny" },
    "discovered": { "action": "allow", "maxPerRequest": 0.25, "maxDaily": 1.00 },
    "trusted":    { "action": "allow", "maxPerRequest": 5.00 }
  }
}
```

**Recipients (issue #26).** The `recipients` block gates *who* may be paid — rule 4.5 emits `RECIPIENT_NOT_ALLOWED`. Comparison happens on the **normalized (canonical)** recipient, chain-aware: EVM `0x…` addresses are compared case-insensitively against their EIP-55-valid spelling (a wrong-checksum spelling is not repaired — it is unusable) on **every** EVM chain in the vocabulary (`base`, `polygon`, `arbitrum`, `base-sepolia`, any `eip155:*` id — issue #32), Solana wallets as the canonical 32-byte base58 re-encoding, Casper payTo as `00` + 64 hex with an optional `account-hash-` prefix stripped. Formatting can therefore never bypass or break the gate. Entries are **chain-scoped** (issue #32): `"polygon:0x…"` matches only on polygon, `"*:0x…"` on any chain, and a **bare** entry (no qualifier) is the legacy unqualified form scoped to **base** — pre-#32 the only EVM chain in the vocabulary, so an existing bare Base approval keeps exactly its old meaning and can never silently authorise the same `0x…` address on Polygon. An entry with an unrecognised qualifier is unusable (fail closed). Two modes:

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
      "trusted-merchant.example": ["0x2222222222222222222222222222222222222222"]
    },
    "known": {}
  }
}
```

**The `recipients` block is file-only.** A per-host map cannot be expressed cleanly as a flat env var, so unlike the sections above there is deliberately **no** `X402_POLICY_*` override for it (the other sections keep their knobs, below). Unknown keys inside `recipients` are errors (typo protection), like everywhere else. In `allowlist` mode, `x402_fetch` passes the `payTo` address from the 402 challenge into the gate for both the USD legs (Base/Solana) and the Casper leg, so the recipient is validated **before** any payment machinery runs; the payment intent then binds exactly the validated value.

**Price anomaly detection (issue #30) — the `anomaly` block, rule 4.6.** Caps track *cumulative* spend; they cannot see one service being paid 10× its normal rate. Rule 4.6 adds a second spend axis: each non-Casper service keeps a baseline of its last N **settled** amounts (ledger-backed, rehydrated like the budget counters — no parallel state), and every prospective payment is compared against it. `PRICE_ANOMALY` is deliberately **not** a `DENY_CODES` member: the *band* decides the routing.

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

With `enabled: true`, rule 4.6 (evaluated after rule 4.5, before `UNKNOWN_SERVICE` — the fixed rule order is unchanged) routes in bands:

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
| `X402_EVM_FACILITATOR_NETWORKS` | comma-separated CAIP-2 ids the facilitator settles (issue #32) |
| `X402_POLICY_SERVICE_<LEVEL>` | `allow` / `deny` / `approval` for `unknown\|discovered\|verified\|trusted\|blocked` |
| `X402_POLICY_SERVICE_<LEVEL>_MAX_PER_REQUEST` / `_MAX_DAILY` | per-level caps |
| `POLICY_TRUSTED_HOSTS` / `POLICY_BLOCKED_HOSTS` | comma-separated hostnames for the `TRUSTED` / `BLOCKED` trust levels |

**Fail closed.** A config file that is unreadable (e.g. revoked permissions — any read error other than a missing file), malformed JSON, wrong types, missing critical fields (`payments` is required), unrecognized keys (typo protection — a misspelled cap is an error, not a silent no-op), or unparseable env values puts the engine into a payments-disabled error state: `evaluate()` returns `DENY` with `CONFIG_INVALID` + `PAYMENTS_DISABLED` for **every** request. A missing file at `POLICY_CONFIG_PATH` (ENOENT) loads the default policy (fail-closed applies to unusable content, not to an absent file). The policy layer never weakens a malformed setting into a permissive one.

### The two explicit Phase 1 decisions

1. **`APPROVAL_REQUIRED` is a refusal in Phase 1.** This MCP runs over stdio and has no human-approval channel; returning a decision the agent could treat as "pending" would be worse than refusing. The engine returns `APPROVAL_REQUIRED` with that reason code preserved, and `x402_fetch` refuses to pay — the issue's fail-closed principle applied to the approval gap.

2. **The default policy reproduces pre-policy behavior exactly** (the explicit backwards-compatibility decision the issue demands — made explicit here rather than silently weakening the safety model): payments enabled, caps from `MAX_PAYMENT_PER_CALL` (default $0.50) / `MAX_DAILY_SPEND` (default $10.00), networks `[base, solana, casper]`, tokens `[USDC, wCSPR]`, every directory service payable at the global caps, `services.unknown: allow` — because today **any** host is payable at the global caps (directory membership plays no role in the pre-policy gate) — and the recipient gate inactive (`recipients` defaults to `change-detect` with no baselines). **Polygon and Arbitrum are deliberately NOT in the compat default allowlist** (issue #32): widening the set of payable chains is a money-path change and ships opt-in only — add `"polygon", "arbitrum"` to `networks.allowed` to enable them (the default facilitator settle-list `evm.facilitatorNetworks` already covers their CAIP-2 ids; it is a fail-closed gate consulted only for chains that passed `networks.allowed`, never an authorisation source). **Issue #34 adds the ONE deliberate default tightening**: the endpoint liveness gate (`liveness.require_fresh_402: true`) refuses payments to DIRECTORY rows that are unpinned or lack a fresh live 402 probe — while hosts that are NOT directory rows stay governed by the pre-#34 rules exactly as today (allowlist omitted = seed-pinned mode, inert for non-catalog hosts), so the pre-#34 paid-flow tests stay green by construction. The unchanged test suite is the proof of that compatibility. Tightening — e.g. `services.unknown: "deny"` so non-directory hosts are refused, or a recipient `allowlist` — is opt-in via config. The zero-behavior-change claim is test-locked: the full pre-existing suite passes unchanged under the default policy, and the fetch integration tests assert both the refusal path and the untouched default path.

### Endpoint liveness (issue #34)

Discovery no longer treats directory membership as proof of liveness. Each directory entry carries its most recent liveness probe record (`liveness`: `{ probed_at, status: live_402|no_402|error, latency_ms, probe_url, accepts? }`), written ONLY by the operator-triggered refresh tool:

- **`x402_probe_allowlist`** probes the pin set — with bounded concurrency (4), a 10 s per-probe timeout, no redirects, and never a payment — and records each result atomically onto its directory entry (the same `atomicWriteFileSync` path every directory write uses). Since issue #38, each row is probed across a bounded candidate list, in precedence order: an allowlist entry's configured `paths` (when present — exhaustive, no discovery; since issue #36 a trailing-`*` wildcard entry such as `/price/*` probes its substituted `/price/x402-probe` representative, never the literal wildcard URL), then the row's advertised `endpoints[]` GET paths (`{param}`/`*` placeholders are substituted by a clearly-marked `x402-probe` token in the built request URL only), then the row's `base_url`, then up to 8 noise-filtered GET paths discovered from the row's `/openapi.json`; candidates are de-duplicated and the walk is capped at 5 URLs per row, with the first `live_402` winning (its exact URL is recorded as `probe_url`). Root-only services are unaffected — the `base_url` is still probed — and a `no_402` record now means "no candidate answered 402" rather than "root is free". Run it on your own schedule (e.g. cron, like the directory crawler); nothing probes in the background, and **`x402_search` performs zero network calls** (tripwire-tested).
- **`x402_search` ranks live-first**: rows with a fresh `live_402` record sort ahead (newest probe first), then rows with stale / `no_402` / `error` records, then never-probed rows. Every row carries `live: boolean` and its `liveness` block; the summary adds `live_total`. Rows that are NOT on the pin set are withheld by default (`include_unverified: true` reveals them, always `live: false`).
- **The pin set** (policy `liveness` block): when `liveness.allowlist` is **omitted** (the default), directory entries with `source: "seed"` are pinned — the operator-curated baseline. An explicit `allowlist: [{ base_url, paths? }]` pins the directory rows whose ORIGIN matches a configured `base_url` (a `paths` list additionally narrows the gate per-URL and drives which URLs the refresh probes; issue #36: each `paths` entry matches a target URL's pathname exactly — `/api` pins only `/api` — except for ONE trailing `*`, the prefix wildcard: `/price/*` admits every parametrized route under the prefix (`/price/<address>`) but not the bare `/price` or `/price/`; a `*` anywhere else, or the directory's `{param}` templated syntax, is a config-validation error — the config fails closed rather than silently pinning nothing); a configured `base_url` with no matching directory row pins **nothing** (records live on directory entries; this change never grows the catalog). `allowlist: []` pins nothing and turns the gate into **strict allowlist mode**: every unlisted host is refused, including non-directory hosts.
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

`x402_check_payment` also accepts an optional **`recipient`** argument (issue #26) — the `payTo` address from the 402 challenge — so the recipient gate can be checked before fetching. In `allowlist` mode the argument is **required** (without it the gate denies); in `change-detect` mode it is compared against the recorded baseline. The response echoes `recipient` verbatim plus `recipient_normalized`, the canonical form rule 4.5 compares (`null` when no recipient was supplied or it is not a valid address for the chain). With the price anomaly gate **enabled** (issue #30), omitting `amount` means checking a $0 payment — which rule 4.6 hard-denies on USD chains — so pass the real amount from the 402 challenge when the anomaly gate is on; with the compat default (disabled) today's behavior is unchanged. When a reason carries one, the response includes its `detail` payload (e.g. the `PRICE_ANOMALY` z-score/baseline stats).

Deliberately **not** in Phase 1 (future extensions, tracked separately in issue #19): approval workflows, payment velocity limits, circuit breakers, transaction simulation, response size limits, untrusted-data labelling, prompt-injection-aware response handling, and a persistent audit ledger. (Recipient allowlisting — formerly on this list — shipped as rule 4.5, issue #26. Price anomaly detection — formerly on this list — shipped as rule 4.6, issue #30.)

## Payment Intent Boundary (issue #25)

Between the policy decision and the wallet there is a second, internal authorisation boundary. The layers have distinct jobs — **policy engine: "is this permitted?"; payment intent: "exactly what was authorised"; executor: "how it is executed"** on Base, Polygon, Arbitrum, Solana or Casper. After the policy gate returns `ALLOW`, `x402_fetch` binds the evaluated offer (service, URL, chain, CAIP-2 network, token, asset, integer atomic amount, recipient, scheme) into a short-lived, immutable **payment intent**, and the payment layer can only sign through an intent-validating executor:

```
LLM input (URL/method/body — no payment parameters)
   |
   v
Policy decision (ALLOW / DENY / APPROVAL_REQUIRED)
   |
   +-- not ALLOW -----------> structured refusal, NO intent, NO payment
   |
   v
Authorised payment intent  (in-memory registry; paramsHash +
   |                        policyDecisionId bound at creation;
   |                        TTL-bounded, one-shot)
   v
Validated executor         (executeGuarded: validate + beginAttempt,
   |                        enforcement hook on the x402 client)
   v
Wallet / signing           (onBeforePaymentCreation: final check
                            immediately BEFORE payload is signed)
```

The enforcement point is the x402 SDK's `onBeforePaymentCreation` hook — exactly where parameters become a signature. Any drift between the authorised intent and the offer the SDK actually selected (amount, recipient, asset, network, scheme) aborts with `OFFER_MISMATCH` before a signature exists. **The boundary is at signing/payload creation, never at the HTTP request:** an endpoint that answers the paid request without a 402 passes through unchanged, while any attempt to charge is verified against the intent.

Six security properties:

1. **Immutable after authorisation.** The registry keeps a frozen record; `paramsHash` (sha256 over the security-sensitive fields in fixed canonical order) and `policyDecisionId` (sha256 of `decision:paramsHash`) are recomputed and deep-compared at validation. Tampering any field ⇒ `PARAM_MISMATCH`.
2. **Policy binding.** Only an `ALLOW` decision can mint an executable intent; `DENY` / `APPROVAL_REQUIRED` ⇒ `NOT_AUTHORISED`. The engine itself is untouched (the intent layer never re-implements policy rules).
3. **Expiry.** Intents live for `X402_INTENT_TTL_MS` (default 60 s, invalid values fall back to the default). After that, validation ⇒ `EXPIRED`.
4. **Replay protection.** One authorisation per intent: `issued → in-flight → consumed`; a second execution or consume ⇒ `ALREADY_USED`.
5. **Fail closed.** Unknown, malformed, mismatched, expired or replayed ⇒ a structured reason code (`NOT_AUTHORISED` / `MALFORMED` / `UNKNOWN_INTENT` / `PARAM_MISMATCH` / `EXPIRED` / `ALREADY_USED` / `OFFER_MISMATCH` / `AMOUNT_UNBINDABLE`), never a guess, never a default price. Money is integer atomic units (`amountAtomic`); the USD figure policy evaluated is informational only and never the binding.
6. **No bypass.** A structural test (`src/payment-intent/no-bypass.test.ts`) locks `wrapFetchWithPayment(` / `new x402Client(` to the sanctioned call sites; any new payment path added elsewhere fails the suite.

The intent registry is **in-memory per process** — the same limitation class as the budget counters (see Limitations above): intents cannot be forged from the MCP tool surface (the LLM never sees intents), and a restart simply invalidates all of them.

**Deliberate tightening (`AMOUNT_UNBINDABLE`).** Previously, when the probe offer had no parseable amount, `x402_fetch` fell back to a `$0.01` *estimate* for the policy/limit checks and the real amount was only discovered when the SDK built the payload. Now: an offer that cannot be bound to a payment intent can never be **paid** — the payment-payload creation aborts before any signing (`INTENT_UNAUTHORISED`). Unpaid/non-402 responses still pass through unchanged, so endpoints that do not actually charge are unaffected. With a forced `chain` of `base`/`solana` the same single free 402 probe still runs to observe the offer (the probe never replaces the forced chain and never refuses the HTTP request), so a well-formed forced-chain request binds and pays exactly like the auto-detected one; the blocking rule applies only when no bindable offer was observed at all (an unrecognised forced chain, or a probe that legitimately cannot yield one). The policy's USD estimate for such offers remains the informational fallback for the policy evaluation itself.

**Structured refusals.** Intent refusals reuse the #19 refusal shape keys (`error`, `url`, `chain`, `estimated_cost_usdc`, `daily_spent_usdc`, `max_per_call`, `max_daily`, `policy_decision`, `reasons[{code, message}]`) with primary reason code `INTENT_UNAUTHORISED` plus the specific intent code.

The boundary is internal to the server: no new MCP tool, no new tool argument, and nothing about intents (or wallets) is exposed to the agent.

## Trust Model

**Settlement receipts are server-attested, not independently verified.** When a paid fetch settles, the seller's `PAYMENT-RESPONSE` header is decoded and surfaced as `payment_receipt` in the tool output. That receipt comes from the endpoint operator's server: it is an attestation, not proof. Every paid-fetch output therefore also carries `receipt_verified: false` and `receipt_note: "server-provided, not independently verified on-chain"` so the agent never mistakes an attestation for an on-chain fact. A malformed or hostile receipt is surfaced as-is (or absent) rather than treated as payment confirmation.

Independent on-chain verification is roadmap work — it requires a chain client per network (Base, Solana, Casper) to confirm the settlement transaction. Until then, treat `receipt_verified: false` as the ground truth: if a payment's settlement matters to you, verify the `tx_hash` / receipt yourself on the relevant chain explorer.

The other trust boundaries are explicit: the discovery fetcher refuses private/loopback/link-local addresses before any request and never follows redirects (see `x402_discover_url`), payment paths refuse redirects and size-bound all response bodies and payment headers, the directory is written atomically with corrupt-file quarantine rather than silent overwrite, and **directory membership is not treated as proof of liveness** (issue #34): `x402_search` ranks by the recorded 402 probes and the payment gate fails closed (`ENDPOINT_NOT_LIVE`) on endpoints off the liveness pin set or with a missing/stale/failed probe.

## Quick Start

### 1. Install

```bash
git clone https://github.com/dchu3/x402-agent-mcp.git
cd x402-agent-mcp
npm install
npm run build
```

### 2. Configure

```bash
# .env
SOLANA_PRIVATE_KEY=your-base58-solana-key
EVM_PRIVATE_KEY=your-hex-base-key
CASPER_PRIVATE_KEY=your-hex-casper-key-or-pem-path
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your-key
BASE_RPC_URL=https://mainnet.base.org
MAX_PAYMENT_PER_CALL=0.50
MAX_DAILY_SPEND=10.00
```

You only need the key for chains you want to pay on. Solana-only? Just set `SOLANA_PRIVATE_KEY`.

### 3. Connect to Your Agent

#### Hermes Agent

```bash
hermes config set mcp_servers.x402.command "node"
hermes config set mcp_servers.x402.args '["/path/to/x402-agent-mcp/dist/index.js"]'
hermes config set mcp_servers.x402.enabled true

# Set env vars
python3 -c "
import yaml
with open('$HOME/.hermes/config.yaml') as f:
    config = yaml.safe_load(f)
config['mcp_servers']['x402']['env'] = {
    'SOLANA_PRIVATE_KEY': 'your-base58-key',
    'EVM_PRIVATE_KEY': 'your-hex-key',
}
with open('$HOME/.hermes/config.yaml', 'w') as f:
    yaml.dump(config, f, default_flow_style=False, allow_unicode=True)
"

hermes gateway restart
hermes mcp test x402
```

#### Claude Desktop

```json
{
  "mcpServers": {
    "x402": {
      "command": "node",
      "args": ["/path/to/x402-agent-mcp/dist/index.js"],
      "env": {
        "SOLANA_PRIVATE_KEY": "your-base58-key",
        "EVM_PRIVATE_KEY": "your-hex-key"
      }
    }
  }
}
```

## Usage Examples

### Search for endpoints

```
x402_search({ query: "news" })
x402_search({ category: "social" })
x402_search({ chain: "solana" })
x402_search({ include_unverified: true })   // also show rows OFF the liveness pin set (always live: false)
```

Results are ranked live-first: each row carries `live` and a `liveness` block (`status`, `probed_at`, `stale`), and the summary carries `live_total` (issue #34).

### Refresh the liveness probes

```
x402_probe_allowlist({})   // probes the pin set (seed rows, or liveness.allowlist origins); never pays
```

Run it on your own schedule (cron), exactly like the directory crawler — search itself never probes.

### Discover a service by URL

```
x402_discover_url({ url: "https://svm402.com" })
```

### Batch discover multiple URLs

```
x402_discover_urls({ urls: ["https://svm402.com", "https://2s.io"] })
```

### Crawl x402scan for new services

```
x402_crawl_directory({ max_results: 20 })
```

### Check if a service is live

```
x402_health({ name: "svm402" })
x402_health({ url: "https://svm402.com" })
```

### Fetch an x402 endpoint

```
x402_fetch({
  url: "https://svm402.com/analyze",
  method: "POST",
  body: '{"address": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"}'
})
```

```
x402_fetch({
  url: "https://2s.io/api/news/search?q=x402&limit=3",
  chain: "solana"
})
```

## Endpoint Directory

The `endpoints.json` file contains known x402 endpoints. It is **gitignored** — each installation builds its own directory.

- `endpoints.example.json` is shipped as a template (empty, with categories)
- On first run, the MCP loads the template and populates from there
- `x402_discover_url` auto-adds new services when discovered
- `x402_crawl_directory` scrapes x402scan.com for new services
- Only true x402 endpoints (no API keys) are included
- Set `X402_DIRECTORY_PATH` to point the directory elsewhere (consulted first by all reads/writes) — useful for tests and sandboxed installs so the live `endpoints.json` is never modified

To bootstrap a fresh install:
```bash
cp endpoints.example.json endpoints.json
# Then run x402_crawl_directory to populate
```

Directory entries carry a `source` field for provenance: `"seed"` marks the operator-curated baseline, `"discovery"` marks entries added by `x402_crawl_directory`. This is the baseline for the trust-level classification planned in issue #19, and — since issue #34 — for the **liveness pin set**: with `liveness.allowlist` omitted (the default), only `"seed"` rows are pinned (ranked live-first in `x402_search` when freshly probed, and payable under rule 4.7); `"discovery"` rows are unverified until explicitly pinned. Entries also accumulate a `liveness` record written by `x402_probe_allowlist` (see *Endpoint liveness*).

## Automated Directory Refresh

The endpoint directory stays fresh by running `x402_crawl_directory` on a schedule. Here's how to set it up in popular agent frameworks:

### Hermes Agent (cron job)

Hermes supports scheduled cron jobs that can run the crawler automatically:

```bash
# Create a weekly cron job (every Monday at 03:00 UTC)
hermes cron create \
  --name "x402 Crawl Directory" \
  --schedule "0 3 * * 1" \
  --toolsets terminal \
  --deliver local \
  --prompt 'Run the x402-agent-mcp crawler to discover new endpoints from x402scan.com:

cd /path/to/x402-agent-mcp && echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"hermes-cron\",\"version\":\"1.0\"}}}
{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}
{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"x402_crawl_directory\",\"arguments\":{\"max_results\":20}}}" | timeout 120 node dist/index.js 2>/dev/null | tail -1

Parse the JSON response and report how many new services were added. If none found, say "No new x402 endpoints discovered this week."'
```

The `--deliver local` flag keeps the cron job silent (no chat messages) — it just updates `endpoints.json` in the background.

### Other Agents (crontab)

For agents without built-in scheduling, use system crontab:

```bash
# Add to crontab — runs every Monday at 03:00
crontab -e

# Add this line:
0 3 * * 1 cd /path/to/x402-agent-mcp && echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cron","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"x402_crawl_directory","arguments":{"max_results":20}}}' | timeout 120 node dist/index.js >> /var/log/x402-crawl.log 2>&1
```

### Custom Scripts

The crawler can also be called programmatically:

```javascript
import { registerCrawlX402ScanTool } from "./tools/crawl-directory.js";
// Or call the MCP via stdio — see usage examples above
```

## Roadmap

Explicitly deferred — tracked here so the boundary is visible, not forgotten:

- **Discovery freshness & trust levels (issue #18.2 detail)** — the directory records provenance (`source: "seed"` / `source: "discovery"`) but does not track freshness or verification state. Enforcement of freshness, trust levels and per-service policy belongs to the **#19 policy engine** (its trust-level model consumes exactly this metadata) and is deliberately not implemented ad hoc here.
- **Self-describing service manifests (issue #18.7)** — machine-readable service metadata is an ecosystem-wide direction: services must publish manifests before clients can consume them. Deferred to the ecosystem roadmap; `x402_discover_url` already consumes `/.well-known/ai-catalog.json` and `/.well-known/x402` where present.
- **Multi-instance budget durability** — enforcing one budget across several MCP processes needs an external spend store (see Limitations under Spending Limits).
- **On-chain settlement-receipt verification** — independently verifying receipts needs a chain client per network (see Trust Model).
- **Persistent audit ledger for payments/intents** — durable, multi-instance audit trails (payment intents are process-local by design, like the budget counters); needs an external store and is deferred with the multi-instance budget work.

## Disclaimer

**This software is experimental and provided "as is", without warranty of any kind. Use at your own risk.**

This software initiates real cryptocurrency transactions that are irreversible.

## Tech Stack

- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [@x402/fetch](https://www.npmjs.com/package/@x402/fetch) — x402 payment handling
- [@x402/svm](https://www.npmjs.com/package/@x402/svm) — Solana x402 scheme
- [@x402/evm](https://www.npmjs.com/package/@x402/evm) — Base/EVM x402 scheme
- [@make-software/casper-x402](https://www.npmjs.com/package/@make-software/casper-x402) — Casper x402 scheme
- [viem](https://viem.sh) — EVM account signing
- [@solana/kit](https://github.com/solana-labs/solana-kit) — Solana SDK
- [casper-js-sdk](https://github.com/casper-ecosystem/casper-js-sdk) — Casper SDK

## License

MIT

## Links

- [x402 Protocol](https://x402.org) — Payment standard
- [x402scan](https://x402scan.com) — Endpoint explorer
- [MCP Protocol](https://modelcontextprotocol.io) — Agent tool protocol
- [Casper x402 docs](https://docs.cspr.cloud) — Casper facilitator and integration docs