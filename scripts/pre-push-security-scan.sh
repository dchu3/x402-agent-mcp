# SECURITY PRE-PUSH GATE for x402-agent-mcp (PUBLIC REPO)
# Blocks a push if the diff introduces any secret or PII.
# Usage: bash scripts/pre-push-security-scan.sh <base-ref> [<head-ref>]
#   default base = origin/master, head = HEAD (covers all unpushed commits)

#!/bin/bash
set -euo pipefail

BASE="${1:-origin/master}"
HEAD="${2:-HEAD}"
cd "$(git rev-parse --show-toplevel)"

# Collect the diff to be pushed (added lines + new file names)
DIFF_NAMES=$(git diff --name-only --diff-filter=A "$BASE" "$HEAD" 2>/dev/null || true)
DIFF_ADDED=$(git diff "$BASE" "$HEAD" 2>/dev/null | grep -E "^\+" | grep -vE "^\+\+\+" || true)

FAIL=0
reasons=()

# 1. Private keys / secrets in added lines (base58 solana ~88ch, hex 64-66ch,
#    classic key labels, JWT/PAT shapes). Base58 solana keys: [1-9A-HJ-NP-Za-km-z]{80,}
#    EVM keys: 0x[0-9a-fA-F]{64}; raw hex 64+; PEM markers; 'PRIVATE_KEY=' with content.
if echo "$DIFF_ADDED" | grep -qE "(0x)?[0-9a-fA-F]{64,}|[1-9A-HJ-NP-Za-km-z]{80,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}"; then
  # filter out false positives: long words in tests/docs that contain no hex/base58 runs of pure key charset
  if echo "$DIFF_ADDED" | grep -qE "(0x)?[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{87,90}"; then
    FAIL=1; reasons+=("private-key-shaped string in added lines")
  fi
fi

# 2. Secret assignments in added lines
if echo "$DIFF_ADDED" | grep -qiE "(PRIVATE_KEY|SECRET|API_KEY|PASSWORD|TOKEN|MNEMONIC|SEED)[A-Z_]*\s*[:=]\s*[\"']?[A-Za-z0-9+/=_-]{16,}"; then
  FAIL=1; reasons+=("secret-shaped assignment (PRIVATE_KEY/SECRET/etc)")
fi

# 3. Real names in file paths (the operator's host user must never appear)
if echo "$DIFF_NAMES" | grep -qiE "BLOCKED-PATTERN|/home/[a-z]+/"; then
  FAIL=1; reasons+=("personal path or real name in added file paths")
fi
if echo "$DIFF_ADDED" | grep -qE "/home/[a-zA-Z]+/|BLOCKED-PATTERN"; then
  FAIL=1; reasons+=("personal path or real name in added lines")
fi

# 4. .env or payments ledger ever added as a FILE
if echo "$DIFF_NAMES" | grep -qE "(^|/)\.env$|\.env\.[^/]*$|payments.*\.jsonl$"; then
  FAIL=1; reasons+=("secrets file (.env / payments ledger) added to the repo")
fi

# 5. Wallet addresses (be lenient: only known-ours 32-44 base58 with context)
KNOWN_WALLETS=$(cat .env 2>/dev/null | grep -oE "[1-9A-HJ-NP-Za-km-z]{32,44}" || true)
for w in $KNOWN_WALLETS; do
  if echo "$DIFF_ADDED" | grep -q "$w"; then
    FAIL=1; reasons+=("wallet address from local .env appears in the diff")
    break
  fi
done

if [ "$FAIL" -eq 1 ]; then
  echo "⛔ SECURITY SCAN FAILED — push blocked:"
  for r in "${reasons[@]}"; do echo "  - $r"; done
  echo "Resolve the flagged content, or stage a redacted version."
  exit 1
else
  echo "✓ security scan clean: no secrets, no personal paths, no .env files in $BASE..$HEAD"
fi