// Issue #54 (req 3) — one ledger path resolver. Every ledger reader/writer
// resolves its location through this module so the three pre-#54 capture
// points (payment-utils, policy/budget-store, policy/anomaly-store) agree on
// exactly one resolution:
//
// - an explicit PAYMENT_LOG_PATH wins outright: the primary ledger resolves
//   to it (absolute) and there is NO legacy read — this is also what keeps
//   every hermetic test hermetic (they all set PAYMENT_LOG_PATH);
// - with PAYMENT_LOG_PATH unset, the ledger moves to a per-user state
//   directory (X402_STATE_DIR, default ~/.x402-agent-mcp) and a legacy
//   working-directory ledger (the pre-#53/#54 "./x402-payments.jsonl" in the
//   cwd) is picked up READ-ONLY when it exists — an upgrade must never
//   silently reset today's spend to 0 (that would be silent cap widening).
//   The legacy file is counted but never written.
//
// The resolver is pure: it reads env + cwd and touches nothing on disk
// except an existsSync probe on the legacy path. Callers capture the result
// ONCE at module load, mirroring the pre-#54 capture-at-load semantics that
// the per-session MCP process and the fresh-import test convention rely on.

import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

/** The legacy ledger filename — unchanged since the very first version. */
export const LEDGER_FILE_NAME = "x402-payments.jsonl";

export interface LedgerPathInfo {
  /** The only ledger WRITES land here (absolute path). */
  primary: string;
  /** The pre-upgrade working-directory ledger, when it exists — read once,
   * read-only (rehydration counts it; no writer ever appends to it). */
  legacyReadOnly?: string;
}

/** The default per-user state directory: X402_STATE_DIR, else ~/.x402-agent-mcp. */
export function defaultStateDir(): string {
  const fromEnv = process.env.X402_STATE_DIR;
  return fromEnv !== undefined && fromEnv.trim() !== "" ? resolve(fromEnv) : join(homedir(), ".x402-agent-mcp");
}

export function resolveLedger(): LedgerPathInfo {
  const explicit = process.env.PAYMENT_LOG_PATH;
  // An empty-string PAYMENT_LOG_PATH is unset (mirrors the pre-#54
  // `process.env.PAYMENT_LOG_PATH || "./x402-payments.jsonl"` fallback).
  if (explicit !== undefined && explicit.trim() !== "") {
    return { primary: resolve(explicit) };
  }
  const primary = join(defaultStateDir(), LEDGER_FILE_NAME);
  const legacyReadOnlyPath = resolve(process.cwd(), LEDGER_FILE_NAME);
  // Only present legacy files are read (the state dir may not exist yet —
  // existsSync on the legacy candidate merely answers the question). A
  // legacy path that equals the primary (state dir = cwd) is not legacy: it
  // is the SAME file and must not be counted twice.
  if (existsSync(legacyReadOnlyPath) && legacyReadOnlyPath !== resolve(primary)) {
    return { primary, legacyReadOnly: legacyReadOnlyPath };
  }
  return { primary };
}

/** mkdir -p the primary ledger's directory before an append. All resolver
 * outputs are absolute paths, so dirname is absolute. Best-effort: a failed
 * mkdir is surfaced to stderr here; the caller's append catch reports a
 * logging failure on its own. */
export function prepareLedgerDir(primaryPath: string): void {
  const dir = dirname(primaryPath);
  if (dir === "") return;
  if (existsSync(dir)) return;
  try {
    // recursive:true is mkdir -p and is a no-op when the directory exists.
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`[x402] Failed to create ledger directory ${dir}: ${err}`);
  }
}