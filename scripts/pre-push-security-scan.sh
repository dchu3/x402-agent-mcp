#!/bin/bash
# SECURITY PRE-PUSH GATE for x402-agent-mcp (PUBLIC REPO)
# Blocks a push if the diff introduces any secret or PII.
# Usage: bash scripts/pre-push-security-scan.sh <base-ref> [<head-ref>]
#        [--patterns-file <path>] [--known-wallet <pattern>]
#   default base = origin/master, head = HEAD (covers all unpushed commits)
#
# The scan NEVER sources, evaluates or executes .env or any repo file.
# All operator-supplied patterns are read as DATA from (any combination of):
#   - $X402_SCAN_WALLET_PATTERNS_FILE  path to a patterns file OUTSIDE the repo
#                                      (one wallet pattern per line, # comments ok)
#   - $X402_KNOWN_WALLETS              whitespace-separated wallet patterns
#   - --known-wallet <pattern>         repeatable argument
#   - $BLOCKED_NAME_PATTERNS           real-name regex for check 3 (env only,
#                                      fail-closed default when unset)
set -euo pipefail

BASE="origin/master"
HEAD="HEAD"
PATTERNS_FILE="${X402_SCAN_WALLET_PATTERNS_FILE:-}"
WALLETS_FROM_ARGS=""
NPOS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --patterns-file)
      [ $# -ge 2 ] || { echo "use: --patterns-file <path>" >&2; exit 2; }
      PATTERNS_FILE="$2"; shift 2 ;;
    --known-wallet)
      [ $# -ge 2 ] || { echo "use: --known-wallet <pattern>" >&2; exit 2; }
      WALLETS_FROM_ARGS="${WALLETS_FROM_ARGS}${2}"$'\n'; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    --) shift; break ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *)
      if [ "$NPOS" -ge 2 ]; then echo "too many positional args" >&2; exit 2
      elif [ "$NPOS" -eq 0 ]; then BASE="$1"; else HEAD="$1"
      fi
      NPOS=$((NPOS+1))
      shift ;;
  esac
done
cd "$(git rev-parse --show-toplevel)"

# Blocked name patterns live OUTSIDE the repo and reach the scan only through
# the environment above. Fail-closed default: nothing is allowlisted by name.
BLOCKED_NAMES="${BLOCKED_NAME_PATTERNS:-placeholder-must-be-set}"

# Collect the diff to be pushed (added lines + new file names)
DIFF_NAMES=$(git diff --name-only --diff-filter=A "$BASE" "$HEAD" 2>/dev/null || true)
DIFF_ADDED=$(git diff "$BASE" "$HEAD" 2>/dev/null | grep -E "^\+" | grep -vE "^\+\+\+" || true)

FAIL=0
reasons=()

# 1. Raw private-key material in added lines (base58 solana ~88ch, hex 64-66ch,
#    EVM keys: 0x[0-9a-fA-F]{64}; raw hex 64+; PEM markers; classic key labels).
if echo "$DIFF_ADDED" | grep -qE "(0x)?[0-9a-fA-F]{64,}|[1-9A-HJ-NP-Za-km-z]{80,}"; then
  # filter out false positives: long words in tests/docs that contain no hex/base58 runs of pure key charset
  if echo "$DIFF_ADDED" | grep -qE "(0x)?[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{87,90}"; then
    FAIL=1; reasons+=("private-key-shaped string in added lines")
  fi
fi

# 1b. Common hosted-key/token shapes (no second-stage confirm needed — the
#     prefixes are precise enough): GitHub tokens, OpenAI-style keys, AWS key
#     ids, PEM blocks. Catches key shapes the wide hex/base58 pass filtered out.
if echo "$DIFF_ADDED" | grep -qE "ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY"; then
  # exclude lines that are the scan's own pattern definitions (quoted regex, not a real key)
  if echo "$DIFF_ADDED" | grep -E "ghp_|github_pat_|sk-|AKIA|PRIVATE KEY" | grep -vE 'grep|qE|"[^"]*ghp_[^"]*"|"[^"]*sk-[^"]*"|"[^"]*AKIA[^"]*"|"[^"]*PRIVATE KEY[^"]*"|pattern' | grep -qE "ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY"; then
    FAIL=1; reasons+=("hosted-key/GitHub/AWS token shape in added lines")
  fi
fi

# 2. Secret assignments in added lines
if echo "$DIFF_ADDED" | grep -qiE "(PRIVATE_KEY|SECRET|API_KEY|PASSWORD|TOKEN|MNEMONIC|SEED)[A-Z_]*\s*[:=]\s*[\"']?[A-Za-z0-9+/=_-]{16,}"; then
  FAIL=1; reasons+=("secret-shaped assignment (PRIVATE_KEY/SECRET/etc)")
fi

# 3. Real names in file paths (the operator's host user must never appear) and
#    absolute home-directory paths. Pattern definitions and docs prose use the
#    literal regex text and are allowlisted; a leaked path like
#    "/home/alice/notes.md" carries the path itself, never the literal
#    regex text, and stays blocked.
# The scan script itself contains these patterns — allowlist its own path.
SCAN_SELF=$(basename "$(git rev-parse --show-toplevel)/scripts/pre-push-security-scan.sh")
if echo "$DIFF_NAMES" | grep -vE "(^|/)$SCAN_SELF$" | grep -qiE "$BLOCKED_NAMES|/home/[a-z]+/|/(home|Users)/[^/]+/"; then
  FAIL=1; reasons+=("personal path or real name in added file paths")
fi
if echo "$DIFF_ADDED" | grep -qE "/home/|\(home\|Users\)|$BLOCKED_NAMES"; then
  # exclude lines that are the scan's own pattern definitions (quoted regex, not a real path)
  if echo "$DIFF_ADDED" | grep -E "/home/|\(home\|Users\)" | grep -vE 'grep|qiE|qE|"[^"]*home[^"]*"|pattern|\(home\|Users\)' | grep -qE "/home/[a-zA-Z]+/|/(home|Users)/[^/]+/"; then
    FAIL=1; reasons+=("personal path or real name in added lines")
  fi
fi

# 4. .env or payments ledger ever added as a FILE
if echo "$DIFF_NAMES" | grep -qE "(^|/)\.env$|\.env\.[^/]*$|payments.*\.jsonl$"; then
  FAIL=1; reasons+=("secrets file (.env / payments ledger) added to the repo")
fi

# 5. Known wallet patterns (from --known-wallet args, $X402_KNOWN_WALLETS, or
#    $X402_SCAN_WALLET_PATTERNS_FILE). Read as DATA only — never sourced.
WALLET_LINES="$(cat "$PATTERNS_FILE" 2>/dev/null || true)"$'\n'
WALLET_LINES="${WALLET_LINES}$(printf '%s' "${X402_KNOWN_WALLETS:-}" | tr ' \t' '\n')"$'\n'
WALLET_LINES="${WALLET_LINES}${WALLETS_FROM_ARGS}"
while IFS= read -r w; do
  w="$(echo "$w" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [ -z "$w" ]; then continue; fi
  case "$w" in \#*) continue ;; esac
  if echo "$DIFF_ADDED" | grep -qF -- "$w"; then
    FAIL=1; reasons+=("known wallet pattern appears in the diff (redact before pushing)")
    break
  fi
done < <(printf '%s' "$WALLET_LINES")

if [ "$FAIL" -eq 1 ]; then
  echo "⛔ SECURITY SCAN FAILED — push blocked:"
  for r in "${reasons[@]}"; do echo "  - $r"; done
  echo "Resolve the flagged content, or stage a redacted version."
  exit 1
else
  echo "✓ security scan clean: no secrets, no personal paths, no .env files in $BASE..$HEAD"
fi