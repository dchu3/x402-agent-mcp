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

  base / eip155:*  — EVM address, EIP-55-checked; compared lowercase. A
                     wrong-checksum spelling is NOT repaired (unusable).
  solana           — 32-byte base58 wallet; compared as the canonical
                     re-encoding. 'SoLWallet' is not a real wallet.
  casper           — '00' + 64 hex (optional 'account-hash-' prefix is
                     stripped); compared lowercase.

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
