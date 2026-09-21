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
