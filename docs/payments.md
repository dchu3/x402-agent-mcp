# Payments, budgets and the ledger

Spend accounting for every paying call: the budget rails (the per-chain USD rail, the mote-denominated Casper rail, and the optional cross-chain ceiling `MAX_DAILY_SPEND_TOTAL_USD` priced through `X402_RATE_USDC_USD` / `X402_RATE_WCSPR_USD`), the payment ledger and its reservations, the payment-intent boundary, and how far the payment flow may be trusted.

## Spending Limits & Payment Logging

| Env var | Default | Description |
|---------|---------|-------------|
| `MAX_PAYMENT_PER_CALL` | 0.50 | Reject any single call above this amount (USDC). Fail-closed: a value that does not parse as a plain non-negative decimal reads as 0 and disables payments |
| `MAX_DAILY_SPEND` | 10.00 | Reject after cumulative daily spend exceeded (USDC). Fail-closed on malformed values like the per-call cap |
| `MAX_DAILY_SPEND_TOTAL_USD` | unset | OPTIONAL cross-chain ceiling — a daily total across EVERY budget rail (the USD rail's ledger buckets, a Casper rail priced by its explicitly configured rate). Unset = today's behaviour exactly; there is no default. Fail-closed like the other caps (garbage reads 0 and refuses everything). While active, a rail with no usable USD rate is refused outright (`RAIL_DISABLED_NO_RATE`) instead of being assumed to fit |
| `X402_RATE_USDC_USD` | unset | The USD rail's USD rate for the cross-chain total — usually unset (the USD rail prices natively; the peg is 1). Setting it OVERRIDES the peg (positive finite number; garbage fails the rate closed with one stderr line) |
| `X402_RATE_WCSPR_USD` | unset | The Casper rail's USD rate (per whole CSPR) — REQUIRED for Casper spend to count toward `MAX_DAILY_SPEND_TOTAL_USD`; unset means the rail is unpriced and, while a ceiling is active, disabled. Operator-priced table entries (`assets.extensions` on wCSPR) also price the rail — the env var wins if both exist |
| `PAYMENT_LOG_PATH` | `<state dir>/x402-payments.jsonl` | Explicit ledger path — wins outright; when unset the state-dir ledger is used and a legacy working-directory ledger is counted read-only |
| `X402_STATE_DIR` | `~/.x402-agent-mcp` | Per-user state directory holding the spend ledger (`x402-payments.jsonl`) when `PAYMENT_LOG_PATH` is unset |
| `X402_DIRECTORY_PATH` | ./endpoints.json | Path to the endpoint directory file (gitignored); set to isolate tests/sandboxes from the live directory |
| `X402_INTENT_TTL_MS` | 60000 | Payment-intent time-to-live in milliseconds (see Payment Intent Boundary); an expired intent can never be signed |
| `X402_PAID_TIMEOUT_MS` | 30000 | End-to-end deadline for the whole paid leg — the signed request AND its response body read, on the USD rails and the Casper paid leg alike (see The paid leg's own bounds). Positive integer milliseconds only; an EMPTY value is treated as UNSET (the 30000 ms default applies and the server starts); a non-empty invalid value refuses startup |
| `X402_PROBE_TIMEOUT_MS` | 30000 | Timeout for the free 402 probe. Positive integer milliseconds only; an EMPTY value is treated as UNSET (the 30000 ms default applies and the server starts); a non-empty invalid value refuses startup; a probe that runs out of time refuses with `timeout_before_payment` |

Payments share one ledger (by default `<state dir>/x402-payments.jsonl`) with timestamp, URL, chain, amount, tx hash, and status. USDC entries use `amount_usdc`; Casper entries use `currency: "wCSPR"` and an exact `amount_motes` string. Base/Solana counters are tracked by chain and summed for the existing USD daily limit. Casper has an independent mote counter. **Every row carries the exact CAIP-2 `network` it settled on, and a DEVNET row's spend bucket is that network id — the mainnet daily totals and reservations never see devnet spend. A `failed` row is self-describing: it carries the HTTP status in `http_status` and the refusal reason in `error` (the gateway's error string, e.g. an insufficient-balance-style challenge message, or `HTTP <status>` when the body is not JSON), `amount_usdc` reads 0 because nothing settled, and the attempted price is preserved in `attempted_amount_usdc`.

### Spend accounting

What you are charged derives from the SIGNED payment only: the ledger `amount_usdc` of a settled call is the bound intent's atomic amount narrowed once to USD (`usdFromAtomic`, integer arithmetic), never a value from the seller's response body and never the probe estimate. A call that signed nothing records 0 — a free 200 is not spend. The seller's own cost figure, when their body carries one, is surfaced as `seller_reported_cost` information-only: it cannot move accounting, policy decisions, or what the caps read. The caps themselves fail closed — a `MAX_PAYMENT_PER_CALL`/`MAX_DAILY_SPEND` env value that is not a plain non-negative decimal (`abc`, `1e3`, `-1`, empty) reads as 0 and denies every payment instead of silently disabling the check.

Counted spend: a payment that was **signed and sent** is spend the budgets count — the caller is never told `paid: false` after a send went out. Every paid call lands in exactly one of four ledger statuses, and one shared predicate (`isCountedSpend` in `src/payment-utils.ts`) decides what counts — the USD daily counters, the per-service store, the Casper mote budget and every restart's rehydration all read the same rule, so in-process and post-restart totals always agree:

- `success` — the request was served (HTTP 200). Counts.
- `settled_unserved` — the server answered non-200 but returned a decodable success receipt carrying a transaction hash (settlement evidence without service). Counts permanently.
- `authorized_unserved` — a signed payload was sent with no settlement evidence (including a timeout or a dropped connection after the send). Counts until the sent payload's own validity expires (the row carries `expires_at`), then releases; a row without `expires_at` counts — over-counting is the fail-closed direction.
- `failed` — nothing was signed/sent, or the answer was a clear refusal before settlement (a 4xx with no settlement receipt — the seller never settled). Never counts.

The tool output mirrors the same rule: `paid` is tri-state — `true` (served, or settlement evidence), `"unknown"` (sent, no evidence either way), `false` (nothing signed/sent, or a clear refusal) — alongside `authorization_sent` (a signed payload left this wallet) and `served` (the request produced the paid-for response). `cost_usdc` equals the counted amount in every branch, and an `"unknown"` result tells the caller not to retry blindly — the client never auto-retries a paid call — because a blind second call could pay twice. The price-anomaly baseline (rule 4.6, `docs/policy.md`) is deliberately stricter: it learns only from verified-success settlements, so an unserved or unknown outcome never moves a service's baseline and can never poison it.

The free-response rule: a 200 with **nothing signed or sent** (a free endpoint, or an offer the SDK never signed for) is not a payment — `paid: false`, `served: true`, `cost_usdc: 0`, and **no ledger row, no per-service record, no baseline movement** (a `recordSettledAmount(url, 0)` on a free response would zero a service's price baseline). The Casper leg follows the same tri-state `paid` rule: `true` only on a verified success receipt, `"unknown"` when a nonzero mote authorization was sent but is unverified, `false` when nothing was authorized — and no payment row is written when `authorized() === 0n`. Its thrown-leg catch path reports the same tri-state explicitly — `paid: "unknown"` with `authorization_sent: true` and the sent `authorized_motes` when the leg threw AFTER the authorization left the wallet (matching the counted `authorized_unserved` ledger row), `paid: false` when nothing was authorized — never a bare error a caller could retry blindly, and never echoing SDK or key material.

Overlap safety: each paid call reserves its signed amount synchronously BEFORE signing — the reserve's check+insert is one synchronous step (Node's single-threaded atomicity), spanning the global and the per-service scope — and the hold is settled into the ledger write or released whenever nothing was signed, so overlapping calls cannot each pass the same remaining budget. No reservation is released merely because a response was slow.

Ledger location: an explicit `PAYMENT_LOG_PATH` wins. When it is unset, the ledger lives in `<X402_STATE_DIR|~/.x402-agent-mcp>/x402-payments.jsonl` and a legacy working-directory `x402-payments.jsonl` is counted once, read-only — an upgrade never resets today's spend to 0.

Casper reserves budget synchronously before signing to prevent concurrent overspending, and the USD chains reserve their SIGNED amount the same way — the amount that costs you money is the signed intent's amount (see Spend accounting). Failed or ambiguous requests retain that reservation; it represents authorized spend, not confirmed settlement. Only one authorization is permitted per fetch. A server-provided settlement receipt is not independently verified on-chain. Redirects are refused on **every** payment path, not just the Casper leg: the shared transport guard (`src/transport/guard.ts`) rebuilds every request with `redirect: "manual"` and refuses each 3xx (`REDIRECT_REFUSED`) instead of following it — the probe, the SDK's paid request and every tool path ride that guard, pinned per path in `src/transport/guarded-fetch.test.ts` and `src/tools/inspector.test.ts` — and the Casper leg runs `redirect: "error"` (`src/tools/casper-fetch.ts`). Response bodies and payment headers stay size-bounded, never clamped: the paid body read is bounded at 1 MiB and over the cap the attempt ends as a counted `authorized_unserved` row naming the bound, a payment-required header over 64 KiB is refused before it is parsed, a header-less 402 body is read only up to `PAYMENT_REQUIRED_BODY_CAP`, and the Casper leg's streamed body is capped at 64 KiB — the smaller `boundedText` default limit of 65536 bytes in `src/tools/casper-fetch.ts`, not the 1 MiB cap above (the exact cap wordings are pinned in `src/tools/fetch-paid-limits.test.ts`, `src/tools/probe-utils.test.ts` and `src/tools/casper-fetch.test.ts`).

Counters are process-local and reset at UTC midnight or process restart. They are not a durable, multi-instance wallet limit.

### Limitations — read before relying on these budgets

- **Per-process counters.** Daily spend lives in the memory of one MCP process (rehydrated once from the ledger on the first budget check). It is never a wallet-level limit.
- **Multiple instances = separate budgets.** Running two MCP processes gives each its own counter, so the real daily spend can reach N × `MAX_DAILY_SPEND`. Durable multi-instance enforcement requires an external store and is on the roadmap; until then, run one instance per budget scope.
- **The USDC daily cap is protected against in-flight concurrency.** Each paid call now reserves its signed amount synchronously before signing — the reserve's check+insert is one synchronous step, so overlapping calls cannot each pass the same remaining budget (`src/reservations.test.ts`: N interleaved reservations against a cap of k×price → exactly k are granted; the reserve holds span release/settle across every no-sign/throw path). Before the overlap-safety fix, concurrent in-flight requests could overshoot until the ledger write; holds are process-local like the counters themselves.
- **Casper is the fail-closed equivalent class.** Casper reserves budget synchronously *before* signing, so concurrent Casper calls cannot overspend, and an unset or invalid budget disables Casper payments entirely. Verified by `src/casper/budget.test.ts`: "daily reservations prevent concurrent callers overspending", "checks changed requirements at signing and blocks retries", "unset either Casper budget disables signing", "invalid, zero and negative budgets disable payment", and "rolls only the Casper counter at UTC day change".


## Payment Intent Boundary

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

**Deliberate tightening (`AMOUNT_UNBINDABLE`).** An offer that cannot be bound to a payment intent is never **paid**: there is no `$0.01` *estimate* fallback into the paid leg. The order is: the probe's USD estimate feeds the policy evaluation first — a policy refusal stops the call before any payment machinery — and only after the policy gate allows does the payment-payload creation bind the offer: an offer that cannot be bound aborts at that intent boundary, before anything is signed (`INTENT_UNAUTHORISED`), never riding a guessed amount past it. Unpaid/non-402 responses still pass through unchanged, so endpoints that do not actually charge are unaffected. With a forced `chain` of `base`/`solana` the same single free 402 probe still runs to observe the offer (the probe never replaces the forced chain and never refuses the HTTP request), so a well-formed forced-chain request binds and pays exactly like the auto-detected one; the blocking rule applies only when no bindable offer was observed at all (an unrecognised forced chain, or a probe that legitimately cannot yield one).

**Structured refusals.** Intent refusals reuse the shared refusal-shape keys (`error`, `url`, `chain`, `estimated_cost_usdc`, `daily_spent_usdc`, `max_per_call`, `max_daily`, `policy_decision`, `reasons[{code, message}]`) with primary reason code `INTENT_UNAUTHORISED` plus the specific intent code.

The boundary is internal to the server: no new MCP tool, no new tool argument, and nothing about intents (or wallets) is exposed to the agent.

## Trust Model

**Settlement receipts are server-attested, not independently verified.** When a paid fetch settles, the seller's `PAYMENT-RESPONSE` header is decoded and surfaced as `payment_receipt` in the tool output. That receipt comes from the endpoint operator's server: it is an attestation, not proof. Every paid-fetch output therefore also carries `receipt_verified: false` and `receipt_note: "server-provided, not independently verified on-chain"` so the agent never mistakes an attestation for an on-chain fact. A malformed or hostile receipt is surfaced as-is (or absent) rather than treated as payment confirmation.

Independent on-chain verification is roadmap work — it requires a chain client per network (Base, Solana, Casper) to confirm the settlement transaction. Until then, treat `receipt_verified: false` as the ground truth: if a payment's settlement matters to you, verify the `tx_hash` / receipt yourself on the relevant chain explorer.

The other trust boundaries are explicit: the discovery fetcher refuses private/loopback/link-local addresses before any request and never follows redirects (see `x402_discover_url`), payment paths refuse redirects and size-bound all response bodies and payment headers, the directory is written atomically with corrupt-file quarantine rather than silent overwrite, and **directory membership is not treated as proof of liveness**: `x402_search` ranks by the recorded 402 probes and the payment gate fails closed (`ENDPOINT_NOT_LIVE`) on endpoints off the liveness pin set or with a missing/stale/failed probe.

### One shared transport guard

Every outbound fetch this server makes — the `x402_fetch` 402 probe, the SDK's first request and the signed paid leg, `x402_health`, `x402_discover_url` (including its page fetch), `x402_crawl_directory` and the shared probe utils — rides the single guard in `src/transport/guard.ts`. Before any request (and therefore before any payment attempt), it refuses:

- **private, loopback, link-local and unspecified address ranges** (IPv4 and IPv6) — stable code `PRIVATE_HOST_REFUSED`;
- **redirect responses** (`3xx`) — stable code `REDIRECT_REFUSED` (redirects are never followed);
- **plain `http://` to public hosts** — stable code `HTTP_NOT_ALLOWED` (https only), plus `URL_INVALID` for malformed URLs.

Guard refusals surface as `{"error": "<CODE>", "detail": "..."}` with fixed detail text — never a raw stack or seller echo. Hostnames that do not resolve are not specially refused; they simply fail as ordinary fetch errors.

For loopback development (running a mock seller beside the MCP), `X402_ALLOW_PRIVATE_HOSTS` allows specific `host:port` pairs (e.g. `127.0.0.1:8921,localhost:8922`) through the private-host guard. It read from the process environment only — a tool caller can never extend it — and https-only is not relaxed: localhost is exempted only from the private-address refusal.

### Seller text is untrusted data

Anything an endpoint, directory or crawl writes is **untrusted data for an AI agent, not instructions**. Tool descriptions say so, and the tools confine that text to named `untrusted` fields:

- `untrusted.body` — a response body surfaced by `x402_fetch` (free responses and non-200 paid responses);
- `untrusted.challenge` — a payment requirement blob the tool could not parse/bind ;
- `untrusted.description` — `x402_search` row descriptions and endpoint hints (the plain row keeps structural fields only; crawled rows additionally carry `source: "discovery"` versus `"seed"`).

Each is `{ text, truncated, original_bytes }`: control characters and ANSI escape sequences are stripped (tab/newline kept), the text is capped (`X402_MAX_UNTRUSTED_CHARS`, default 100 000 chars for bodies, 1 000 for challenge blobs, 2 000 for directory text — a lower env value wins), and truncation is marked with the original size. The tools' own status/error fields carry fixed text only (e.g. `x402 payment failed`, `Failed to probe endpoint`) — raw failure detail goes to the local debug log, not to the model.

### Caller request headers, deny by default

`x402_fetch` accepts an optional `headers: { name: value }` map for sellers that need a caller identifier to link the unpaid and paid requests. It is deny-by-default:

- only names listed in `X402_EXTRA_HEADER_ALLOWLIST` (comma-separated, case-insensitive, **empty by default**) are ever sent;
- a hard deny list configuration cannot override — `Authorization`, `Cookie`, `Proxy-Authorization`, `Host`, `Content-Length`, `Transfer-Encoding`, `Connection` (plus hop-by-hop `Keep-Alive`, `TE`, `Trailer`, `Upgrade`) and anything starting `payment-` / `x-payment` (the SDK owns payment headers) — refused **even when allowlisted**;
- names must be RFC 7230 tokens, values must not contain CR/LF/NUL and are capped at 1 024 characters, at most 16 headers, no case-duplicate names;
- a refusal (`{"error": "HEADER_REFUSED", "detail": ...}`) happens **before any request or payment attempt**;
- accepted headers ride all three legs identically (free probe, SDK first request, signed paid leg); header **values are never logged and never written to the payment ledger** (log lines carry names only).

```bash
# .env — allow exactly these extra header names on x402_fetch (deny-by-default):
X402_EXTRA_HEADER_ALLOWLIST=x-client-id
# Loopback mock sellers for development (env-only; tool callers cannot add):
# X402_ALLOW_PRIVATE_HOSTS=127.0.0.1:8921,localhost:8922
```

### Challenge signing scope and the paid leg's own bounds

#### What a challenge may make these wallets sign

A seller's 402 challenge is untrusted data that becomes a signature. Before anything is signed, the flow scopes the challenge and binds the result into the payment intent; the payment hook verifies the bound fields at signing. Every rule **refuses, never clamps or repairs**:

- **`extensions`** — every extension key must be allowlisted in `X402_ALLOWED_EXTENSIONS` (default `bazaar`, the x402 discovery extension). *Compatibility note: the default allowlist is set to match the first-party sellers listed in the endpoint directory.* An allowed extension's key set is bound into the intent and compared exactly at signing; setting the variable **replaces** the default list.
- **Validity window** — the challenge's `maxTimeoutSeconds` must be a positive number and at most `X402_MAX_CHALLENGE_TIMEOUT_SECONDS` (default **300 s**). Longer windows are refused (`VALIDITY_WINDOW_TOO_LONG`), never trimmed.
- **`extra` fields** — only the SDK's known-safe signing fields (`name`, `version`, `feePayer`, `memo`, `lastValidBlockHeight`) plus anything operators explicitly allow via `X402_ALLOWED_EXTRA_KEYS` are ever in scope; unknown keys are refused, never forwarded to a signer.
- **Fee payer rule** — a challenge whose `extra.feePayer` names **this agent's own address** would make the agent pay the seller's gas: refused by default. `X402_ALLOW_SELF_FEE_PAYER=1` opts in; `X402_FEE_PAYER_ALLOWLIST` pins the fee-payer addresses a challenge may name. The chosen fee payer is bound into the intent either way and compared exactly.
- **`memo`** — printable ASCII only, capped at `X402_MAX_MEMO_BYTES` (default 64), bound into the intent.
- **EIP-712 domain fields** (`name`, `version`) — bound for exact equality, so a seller cannot retarget the signed domain at signing time. **Block hints** (`lastValidBlockHeight`, `recentBlockhash`) are shape-checked only and never bound: they are volatile per block, and pinning them would refuse honest replays.

Scope refusals (`EXTENSION_NOT_ALLOWED`, `VALIDITY_WINDOW_*`, `FEE_PAYER_REFUSED`, `MEMO_INVALID`, `BLOCK_HINT_INVALID`, `TRANSFER_METHOD_NOT_ALLOWED`) surface as fixed structured refusals with the field label — seller text goes to the local debug log only. Legacy challenge shapes (no `extra`, no `extensions`, no window) are unaffected and skip the new checks byte-for-byte.

#### One unpaid request, one offer, one paid request

The flow closes both places the SDK could drift from what the agent authorised:

- **The agent selects the offer, not the SDK.** `x402_fetch` parses **all** offers of a challenge, ranks them cheap-first in integer atomic units, breaks ties by the configured chain order and seller order, and refuses unpayable candidates with fixed tokens (`no_key`, `network_not_allowed`, `asset_not_allowed`, `policy_refused` — surfaced in `offer_refusals`). The chosen offer rides the output as `selected_offer` `{chain, network, amount_atomic, amount_usdc}`, and the SDK's payment-requirements selector is bound to that exact offer: if the SDK's own filters ever drop it, the whole payment is refused (fail closed) — the SDK cannot pay anything but the agent's selection. When nothing qualifies, the tool refuses with `NO_PAYABLE_OFFER`.
- **The probe's response is replayed as the SDK's request.** The free probe's bytes are reused for the SDK's first (unpaid) request, so a charging endpoint sees **exactly two** requests: the unpaid probe and the signed paid leg. A seller can no longer serve a different requirement to a mid-flow unpaid request than it served to the agent, and there is no extra unmonitored network leg.
- Signed-but-unexecuted states keep the same guarantees: the pre-signature gate still validates the bound intent exactly (`INTENT_OFFER_MISMATCH:<field>` / `INTENT_EXPIRED`), and the signature itself can only ever carry the probe's offer.

#### The paid leg's own bounds

- The paid response body is **read bounded (1 MiB)**. A seller streaming a huge body cannot dictate the agent's memory: over the cap the attempt ends with a counted `authorized_unserved` ledger row naming the cap (`Payment response exceeds size limit`) — the send already happened, so the outcome is `paid: "unknown"`, never a bare failure, and no retry happens against a seller that just did that.
- **One repo-owned deadline spans the whole paid leg — headers AND body.** `X402_PAID_TIMEOUT_MS` (default **30 000 ms**, positive integer milliseconds only) bounds everything from the signed request leaving to the last body byte: the deadline's own timer races the paid fetch and the bounded body read (its signal also rides the request init — belt and braces, because a timer signal passed through the SDK's request-clone chain is not guaranteed to bound a body read after headers have arrived). A seller that never answers, sends headers then stalls the body (200 or re-challenges with 402), produces the fixed `PAID_TIMEOUT` structured refusal at the configured bound (never a hang, never a raw `AbortError`); after a send the refusal reports `paid: "unknown"` (`authorization_sent: true`) and the send is counted until its validity expires. A signed payment is never retried by this client. The Casper leg honours the same variable: its paid transport times the signed Casper request (headers and the bounded body read) with the same parsed `X402_PAID_TIMEOUT_MS` bound — the mote rail carries no separate deadline literal, and a stall surfaces through the Casper catch path's tri-state `paid` flag with the counted `authorized_unserved` row.
- The free probe carries the same class of bound: **`X402_PROBE_TIMEOUT_MS`** (default **30 000 ms**, same fail-closed parsing). A probe that runs out of time — including a 402 whose challenge body never completes — refuses with the stable code **`timeout_before_payment`** before any payment machinery runs (the signer is never invoked and the ledger is untouched); other probe failures keep the generic `Failed to probe endpoint` refusal.
- **Timeout configuration: blank is UNSET, invalid refuses startup.** `X402_PAID_TIMEOUT_MS` / `X402_PROBE_TIMEOUT_MS` are validated before the server starts. An empty (or whitespace-only) value is treated as UNSET — the 30 000 ms default applies and the server starts. A non-empty value that is not a whole-digit positive integer (`abc`, `0`, `-1`, `1.5`, …) prints one stderr line naming the variable and exits non-zero — instead of surfacing per-call inside a payment flow.

#### Per-call narrowing limits (x402_fetch arguments)

Three optional tool arguments let a CALLER narrow what this one request may pay — they can only ever narrow the global policy (a generous value never raises `MAX_PAYMENT_PER_CALL` or any other operator cap), and a violation refuses the call with a stable code BEFORE anything is signed — zero payment headers are sent and no ledger row is written:

- `max_price_usd` (number > 0) — the selected offer's price must not exceed it, compared in exact integer atomic units at the offer asset's decimals (no float arithmetic on the bound): over ⇒ `MAX_PRICE_REFUSED`. A price equal to the cap pays.
- `expected_pay_to` (string) — the selected offer's `payTo` must equal it exactly ⇒ mismatch is `PAY_TO_MISMATCH`.
- `allowed_chains` (`base` / `polygon` / `arbitrum` / `solana` / `casper`) — the selected offer's chain must be listed ⇒ otherwise `CHAIN_NOT_ALLOWED`.

Enforcement engages on EVERY rail, including the Casper rail: an `allowed_chains` that omits `casper` refuses a Casper offer with `CHAIN_NOT_ALLOWED`, and `expected_pay_to` is compared exactly against the selected Casper accept's `payTo` (`PAY_TO_MISMATCH`) — both before the Casper authorization is signed, with zero signed requests and no ledger row. The one carve-out is `max_price_usd`: the Casper rail is mote-priced and has no USD price, so a `max_price_usd` on a Casper call cannot be honoured and is refused explicitly with `PER_CALL_LIMIT_UNSUPPORTED` (the call is not signed) — never silently ignored; bound that leg with `CASPER_MAX_PAYMENT_PER_CALL` / `CASPER_MAX_DAILY_SPEND` or narrow it with the other two arguments.

Malformed values (non-positive numbers, empty arrays, unknown chain names) are refused with `PER_CALL_LIMIT_INVALID` — a narrowing input is never silently ignored. Enforcement engages when a charge was actually observed (an offer the flow would pay); an unchargeable endpoint's free pass-through is unchanged.

