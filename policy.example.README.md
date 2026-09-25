# policy.example.json — how to use it

Example policy configuration for the x402-agent-mcp policy engine (issue #19).
Copy to a private location, edit, and point POLICY_CONFIG_PATH at it. This
file is documentation, not live config. NO SECRETS BELONG HERE — this file
contains spending rules only; keys live in the MCP server's environment.

Validation is strict (fail-closed): unknown keys, wrong types, and missing
critical fields ('payments' is required) put the engine in a payments-disabled
error state — every request DENIES with CONFIG_INVALID + PAYMENTS_DISABLED.
A MISSING file at POLICY_CONFIG_PATH loads the behavior-compat default
(payments on, $0.50/request, $10/day, all supported chains/tokens), so
deleting this file is a safe rollback path.

Precedence: legacy env defaults (MAX_PAYMENT_PER_CALL / MAX_DAILY_SPEND) <
this file < X402_POLICY_* env overrides.

Trust levels come from outside this file:
  BLOCKED  — host listed in POLICY_BLOCKED_HOSTS (comma-separated, env)
  TRUSTED  — host listed in POLICY_TRUSTED_HOSTS (comma-separated, env)
  DISCOVERED — host found in the local service directory
  UNKNOWN  — everything else
Hosts in the env lists never appear in this file, so it stays shareable.

APPROVAL_REQUIRED note: 'approval' actions are REFUSED in Phase 1 (there
is no human-approval channel over stdio MCP); the request returns the
APPROVAL_REQUIRED reason code so callers see why. Use 'deny' for the same
effect with clearer semantics, or 'allow' to permit.

---------------------------------------------------------------------------
Recipient gate (issue #26) — the 'recipients' block (rule 4.5,
RECIPIENT_NOT_ALLOWED)
---------------------------------------------------------------------------

The example ships the COMPAT DEFAULT: mode 'change-detect' with empty maps.
That is inactive by construction — change detection is active only for a
host with a recorded baseline in 'known', and this example records none, so
rule 4.5 never fires and today's behavior is unchanged.

Two modes:

  'allowlist' — ACTIVE ALWAYS and fail-closed. A payment is refused unless
  the probed recipient (the payTo of the 402 challenge) normalizes to an
  entry on the EFFECTIVE allowlist for the host: perService[host] REPLACES
  the global 'allowed' list when present (keys are lowercase hostnames).
  An EMPTY effective list denies EVERY recipient, and a missing or unusable
  probed recipient is denied too — membership can never be proven. This is
  the tightest setting: with 'allowed' left empty, nothing is payable until
  you list recipients.

  'change-detect' — ACTIVE ONLY for a host with a recorded baseline in
  'known' (lowercase hostname -> expected recipient). The payment is refused
  only when the probed recipient DIFFERS from the baseline. A host without a
  baseline has nothing to compare — no reason fires for it. Recording a
  baseline means: 'this host normally pays exactly this address; refuse the
  rest'.

Recipients are compared after chain-aware normalization, so formatting can
never bypass or break the gate:

  base / polygon / arbitrum / base-sepolia / eip155:*
                   — EVM address, EIP-55-checked; compared lowercase on EVERY
                     EVM chain (issue #32). A wrong-checksum spelling is NOT
                     repaired (unusable).
  solana           — 32-byte base58 wallet; compared as the canonical
                     re-encoding. 'SoLWallet' is not a real wallet.
  casper           — '00' + 64 hex (optional 'account-hash-' prefix is
                     stripped); compared lowercase.

Entries are CHAIN-SCOPED (issue #32). The grammar is '<chain>:<address>',
where <chain> is an EVM alias (base / base-sepolia / polygon / arbitrum /
ethereum) or '*':

  'polygon:0x…'    — matches ONLY on polygon (denied for the same address on
                     base).
  '*:0x…'          — matches on any chain.
  '0x…' (BARE)     — legacy unqualified form, scoped to BASE. Pre-#32 base
                     was the only EVM chain, so an existing bare Base approval
                     keeps exactly its old meaning — including for bare Solana
                     wallets / Casper hashes, where the address form still
                     governs — and never silently authorises the same 0x…
                     address on Polygon or Arbitrum. To pay one address on
                     several EVM chains, list it per chain (or use '*:').
  'foo:0x…'        — an unrecognised qualifier makes the entry UNUSABLE: it
                     never matches anything (fail closed, no guessing).

The same scoping applies to 'perService' lists and to 'known' change-detect
baselines: a 'polygon:0x…' baseline is active only for polygon payments to
that host.

This block is FILE-ONLY: there is deliberately no X402_POLICY_* env override
for it (a per-host map does not fit a flat env var). Unknown keys inside the
block are errors (typo protection), like everywhere else in the config.

Example tightening (replace the compat block with):

  "recipients": {
    "mode": "allowlist",
    "allowed": ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
    "perService": {
      "trusted-merchant.example": ["0x2222222222222222222222222222222222222222"]
    },
    "known": {}
  }

Example baselines (change-detect):

  "recipients": {
    "mode": "change-detect",
    "allowed": [],
    "perService": {},
    "known": {
      "merchant.example": "00ab…"  // elided: '00' + 64 lowercase hex chars
    }
  }

x402_check_payment accepts an optional 'recipient' argument so the gate can
be inspected BEFORE x402_fetch: in allowlist mode it is required, in
change-detect mode it is compared against the baseline. The tool response
echoes 'recipient' verbatim plus 'recipient_normalized' (the canonical form
rule 4.5 compares; null when unusable).

---------------------------------------------------------------------------
Price anomaly detection (issue #30) — the 'anomaly' block (rule 4.6,
PRICE_ANOMALY)
---------------------------------------------------------------------------

The example ships the COMPAT DEFAULT: the gate is DISABLED ('enabled': false).
An always-on price gate could hard-deny a previously allowed payment — a
legitimate provider price rise looks exactly like an attack — so enabling the
gate is an operator opt-in, exactly like 'services.unknown: deny' and the
recipient allowlist. With the default block nothing changes: rule 4.6 is
inert and today's decisions are unchanged.

Rule 4.6 adds a second spend axis beside the caps: caps track cumulative
spend and cannot see one service being paid 10x its normal rate. The gate
keeps a per-service baseline of the last N SETTLED amounts (ledger-backed,
rehydrated like the budget counters — no parallel state file) and compares
every prospective payment against it. PRICE_ANOMALY is deliberately NOT a
DENY code: the BAND decides the routing.

Fields:

  'enabled'            — operator opt-in (false in the compat default).
  'window'             — baseline window: the last N settled amounts.
  'warnZ' / 'denyZ'    — z-score thresholds; 0 <= warnZ < denyZ is validated
                         (including against the defaults when only one is
                         set in the file).
  'minSamples'         — minimum baseline size before the z-score path is
                         trusted (default 5).
  'seedFromDirectory'  — softly compare the first payment for a host against
                         the advertised directory price (a one-sample seed,
                         derived per call, never stored).
  'defaultTolerance'   — fallback multiplier (>= 1) while the baseline is too
                         thin for statistics.

Bands (with 'enabled': true):

  z-score path (>= minSamples samples, non-zero variance):
    z < warnZ                      -> nothing annotated (ALLOW)
    warnZ <= z < denyZ             -> APPROVAL_REQUIRED + PRICE_ANOMALY
    z >= denyZ                     -> hard DENY + PRICE_ANOMALY
  thin baseline (below minSamples, or stdev = 0):
    amount > reference * defaultTolerance -> APPROVAL_REQUIRED, NEVER deny
    (statistics are the evidence for a hard deny; a stub baseline is not —
    1-2 samples yield stdev = 0, z = infinity, which would deny everything)
  non-positive amount on a USD chain (0 / negative / non-finite):
                                     -> hard DENY (fail-closed)
  Casper leg:                        -> inert. The Casper gate passes amount 0
    by design (mote-denominated, no USD price at that layer); casper/budget.ts
    remains Casper's spend authority.

Every PRICE_ANOMALY reason carries a 'detail' payload for the audit log:
{zScore | ratio, mean, stdev, samples, window, band, amount, host} (or
{reason: 'non-positive-amount', amount, host}) — surfaced verbatim by
x402_fetch's structured refusal and by x402_check_payment. The baseline moves
ONLY on a successful settlement (the same resp.status === 200 guard as the
per-service budget store), so a denied or failed payment can never poison it.
The first settled amount becomes the first real sample when there is no
directory price — the graceful fallback.

This block is FILE-ONLY: there is deliberately no X402_POLICY_* env override
for it (thresholds are deliberate operator config). Unknown keys inside the
block are errors (typo protection), like everywhere else in the config.

x402_check_payment note: with the gate ENABLED, omitting 'amount' means
checking a $0 payment — which rule 4.6 hard-denies on USD chains — so pass
the real amount from the 402 challenge when the gate is on. With the compat
default (disabled), today's behavior is unchanged.

---------------------------------------------------------------------------
Multi-EVM chains (issue #32) — 'networks.allowed' + 'evm.facilitatorNetworks'
---------------------------------------------------------------------------

This example's allowlist includes the three EVM chain aliases — 'base',
'polygon', 'arbitrum' — alongside 'solana' and 'casper'. Chain detection
resolves the 402 offer's REAL CAIP-2 network id (eip155:8453 => base,
eip155:137 => polygon, eip155:42161 => arbitrum); an UNRECOGNISED eip155:*
id (e.g. eip155:10, Optimism) is never collapsed onto base — it keeps its
verbatim identity and rule 3 denies it unless you deliberately allowlist AND
facilitator-enable it.

Rule 3 (CHAIN_NOT_ALLOWED) applies three fail-closed checks, one reason max:
  1. The Ethereum L1 — 'ethereum' or 'eip155:1' — is refused ALWAYS, even if
     you add it to networks.allowed here.
  2. Membership: the chain must be in networks.allowed (this file) — that is
     the OPT-IN. The compat default omits polygon/arbitrum; this example adds
     them.
  3. Facilitator settle-gate: an allowed EVM chain is still refused when its
     CAIP-2 id is not in 'evm.facilitatorNetworks' — the chains your
     configured facilitator actually settles. The default (and this example)
     is ["eip155:8453", "eip155:137", "eip155:42161"]; override with the
     X402_EVM_FACILITATOR_NETWORKS env var (comma-separated). Every entry
     must be a CAIP-2 id of the form eip155:<chainId> — anything else fails
     closed (CONFIG_INVALID).

Per-chain RPC note: BASE_RPC_URL applies to Base (eip155:8453) only. EVM
payments on Polygon/Arbitrum sign locally (EIP-3009 / EIP-712) and need no
RPC endpoint — there is deliberately no per-chain RPC matrix (out of scope
for #32).

Recipient allowlists are chain-scoped on the new chains — see the recipient
section above: a bare '0x…' entry authorises that address on BASE only; use
'polygon:0x…' / '*:0x…' for the other EVM chains.

---------------------------------------------------------------------------
Endpoint liveness (issue #34) — the 'liveness' block (rule 4.7,
ENDPOINT_NOT_LIVE)
---------------------------------------------------------------------------

The example ships the FAIL-CLOSED DEFAULTS with the allowlist OMITTED:
require_fresh_402: true, max_age_seconds: 3600. That is seed-pinned mode —
the pin set is the directory's source: "seed" rows — and it is INERT for
hosts that are not directory rows (there is no catalog claim to falsify:
services.unknown, recipients and caps govern them exactly as today). The
example deliberately does NOT set 'allowlist' — see "strict mode" below.

The gate: with require_fresh_402 on, a payment to a DIRECTORY row is refused
(ENDPOINT_NOT_LIVE) unless the row is PINNED and its recorded last probe is a
fresh live_402 (status exactly 'live_402', probed_at no older than
max_age_seconds). Catalog membership alone proves nothing: a row that is not
pinned, never probed, stale, or whose last probe answered without a 402 or
errored is refused. The same verdict is re-derived inside the signing hook
(the INTENT_ENDPOINT_NOT_LIVE abort), so a record that ages out between the
policy check and the signature can no longer be paid. x402_check_payment
echoes it as 'endpoint_liveness'.

Pin-set rules (the 'allowlist' key):

  OMITTED          — seed mode: the directory's source: "seed" rows are the
                     pin set.
  []               — pins NOTHING and activates STRICT MODE: every host not
                     on an allowlist entry is refused, including hosts that
                     are not directory rows at all.
  [{ base_url, paths? }] — pins the directory rows whose ORIGIN (scheme://
                     host[:port]) matches a configured base_url. With 'paths',
                     only those pathnames pass the gate per-URL, and the
                     refresh tool probes those URLs (first live_402 wins).
                     Fail-closed wart, documented not hidden: a configured
                     base_url that matches NO directory row pins NOTHING —
                     liveness records live on directory entries and this
                     change never grows the catalog, so add the host to the
                     directory first (or it can never become live).

Refresh: liveness records are written ONLY by the x402_probe_allowlist tool
(10 s timeout per probe, concurrency 4, no redirects, never pays; each record
is written atomically onto its directory entry). Run it on your own schedule
— e.g. cron, like the directory crawler under "Automated Directory Refresh".
There is no background probing inside the MCP, and x402_search performs ZERO
network calls: it ranks by the recorded probes instead (fresh live_402 first,
newest probe first; unpinned rows are withheld unless include_unverified:
true, and are always live: false).

Fields:

  require_fresh_402 — the gate switch. true = the default, described above.
                      false = the escape hatch: fetch behaviour is exactly
                      the pre-#34 behaviour; search keeps its liveness
                      metadata (ranked, annotated) unchanged.
  max_age_seconds   — staleness bound for probe records (finite > 0). A
                      record older than this is stale and refuses. A missing
                      or unparseable probed_at is ALWAYS stale (fail closed).
  allowlist         — optional; see the pin-set rules above. An explicit []
                      means "nothing is live" — combine with care.

This block is FILE-ONLY: there is deliberately no X402_POLICY_* env override
for it (the recipients/anomaly precedent — pin-set structure does not fit a
flat env var). Unknown keys inside the block are errors (typo protection),
like everywhere else in the config.
