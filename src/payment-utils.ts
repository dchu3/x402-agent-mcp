import { appendFileSync, existsSync, readFileSync } from "fs";
// Issue #54 (req 3): the ledger path resolver shared by every ledger
// reader/writer (see the capture comment below).
import { prepareLedgerDir, resolveLedger } from "./ledger-path.js";

export interface PaymentLogEntry {
  timestamp: string;
  url: string;
  method: string;
  chain: string;
  amount_usdc?: number;
  amount_motes?: string;
  currency?: "USDC" | "wCSPR";
  tx_hash?: string;
  status: "success" | "failed";
  error?: string;
  // Issue #45: a refused (non-200) paid fetch row is self-describing — it
  // carries the HTTP status and the gateway's error string (or `HTTP <status>`
  // when the body is not JSON), reads amount_usdc as 0 because nothing
  // settled, and preserves the advertised price in attempted_amount_usdc.
  // Both fields are optional: rows written before #45 (and the intent-abort
  // catch rows) rehydrate and read exactly as before.
  http_status?: number;
  attempted_amount_usdc?: number;
  // Issue #53: the exact audit trail of the SIGNED amount on success rows —
  // the intent's atomic amount as a decimal string, its decimals, and the
  // offer's asset when known. `amount_usdc` remains the USD number the caps
  // read (single narrowing at the ledger boundary, usdFromAtomic).
  amount_atomic?: string;
  decimals?: number;
  asset?: string;
}

// Issue #54 (req 3): the ledger location resolves through src/ledger-path.ts
// — one resolution shared by every reader/writer: an explicit PAYMENT_LOG_PATH
// wins outright (absolute, no legacy read), otherwise the state-dir primary
// (X402_STATE_DIR, default ~/.x402-agent-mcp) plus a read-only legacy
// working-directory ledger when one exists. Captured once at module load,
// mirroring the pre-#54 capture-at-load semantics.
const LEDGER = resolveLedger();
const LOG_PATH = LEDGER.primary;

// Track daily spending in memory
const dailySpentByChain = new Map<string, number>();
let dailyDate = new Date().toISOString().slice(0, 10);

// The MCP runs over stdio with per-session process lifetime, so the in-memory
// counter starts at $0 on every restart and MAX_DAILY_SPEND would never be
// cumulative. Rebuild today's spend from the ledger once, lazily, on first
// budget check.
let rehydrated = false;

function rehydrateFromLedger(): void {
  if (rehydrated) return;
  rehydrated = true; // set before any I/O — never double-read, even if read throws
  // Legacy first (read once, read-only), then the primary ledger — a
  // pre-upgrade working-directory ledger must still count toward today's
  // spend (an upgrade that dropped it would silently widen every cap that
  // reads these totals).
  for (const line of readLedgerLines(LEDGER.legacyReadOnly).concat(readLedgerLines(LOG_PATH))) {
    try {
      const entry = JSON.parse(line) as PaymentLogEntry;
      if (
        entry.status === "success" &&
        entry.chain !== "casper" &&
        typeof entry.chain === "string" &&
        entry.timestamp.slice(0, 10) === dailyDate
      ) {
        dailySpentByChain.set(entry.chain, (dailySpentByChain.get(entry.chain) ?? 0) + (entry.amount_usdc ?? 0));
      }
    } catch {
      // Corrupted ledger lines are skipped — logging is best-effort, so is reading it back
    }
  }
}

/** Split a ledger file into lines, best-effort: a missing/unreadable file is
 * an empty ledger (the per-file error names the path). */
function readLedgerLines(path: string | undefined): string[] {
  if (!path || !existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8").split("\n");
  } catch (err) {
    console.error(`[x402] Failed to read ledger ${path}: ${err}`);
    return [];
  }
}

function resetDailyIfNewDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyDate) {
    dailySpentByChain.clear();
    dailyDate = today;
  }
}

/** Issue #54 (cap-parsing hardening): caps must fail CLOSED. A garbage
 * env value must never widen spend: today's `parseFloat("abc")` yields NaN
 * and `amount > NaN` is false, so a typo silently allowed every payment.
 * Only plain non-negative decimal strings are accepted (digits with an
 * optional .digits part — no sign, no exponent, no whitespace); anything else
 * logs one stderr line and reads as 0, denying all payments until the env is
 * fixed. Absent vars keep the documented fallbacks (zero behavior change for
 * ordinary operators). The policy layer's own defaults (policy/config.ts
 * legacyNumber) already fail closed on their side. */
function readCapUsd(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    console.error(
      `[x402] ${name}="${raw}" is not a plain non-negative decimal amount ` +
      `(digits with an optional . fraction) — failing closed: the cap reads 0 ` +
      `and every payment is denied until the environment is fixed`,
    );
    return 0;
  }
  return Number(raw);
}

export function getMaxPerCall(): number {
  return readCapUsd("MAX_PAYMENT_PER_CALL", 0.50);
}

export function getMaxDailySpend(): number {
  return readCapUsd("MAX_DAILY_SPEND", 10.00);
}

export function checkSpendingLimit(amountUsdc: number): { allowed: boolean; reason?: string } {
  rehydrateFromLedger();
  resetDailyIfNewDay();

  const dailySpent = getDailySpent();
  const maxPerCall = getMaxPerCall();
  if (amountUsdc > maxPerCall) {
    return { allowed: false, reason: `Payment $${amountUsdc} exceeds MAX_PAYMENT_PER_CALL $${maxPerCall}` };
  }

  const maxDaily = getMaxDailySpend();
  if (dailySpent + amountUsdc > maxDaily) {
    return { allowed: false, reason: `Payment $${amountUsdc} would exceed MAX_DAILY_SPEND $${maxDaily} (spent $${dailySpent.toFixed(4)} today)` };
  }

  return { allowed: true };
}

export function logPayment(entry: PaymentLogEntry): void {
  resetDailyIfNewDay();
  // Issue #54 (req 3): rehydrate BEFORE the first in-memory success-add, not
  // after it. The one-shot ledger read must precede every in-memory row or a
  // getDailySpent() that arrives late (e.g. a first call after a write) would
  // merge the file's copy of rows that are already in memory — every restart
  // parity and in-process/restart comparison then diverges (rehydration must
  // read identical totals; the test catches it). Rehydrating in logPayment —
  // the only in-memory writer — makes the merge order safe: the first write
  // of a session always rehydrates an empty in-memory counter first. For
  // settled rows the merge order is unchanged (checks already rehydrated
  // before any payment leg in the real flow).
  rehydrateFromLedger();

  if (entry.status === "success" && entry.chain !== "casper") {
    dailySpentByChain.set(entry.chain, (dailySpentByChain.get(entry.chain) ?? 0) + (entry.amount_usdc ?? 0));
  }

  try {
    const line = JSON.stringify(entry) + "\n";
    // Issue #54: the state-dir ledger may live in a directory that does not
    // exist yet — mkdir -p before the first append.
    prepareLedgerDir(LOG_PATH);
    appendFileSync(LOG_PATH, line, { encoding: "utf-8" });
  } catch (err) {
    // Logging is best-effort — don't fail the payment if logging fails
    console.error(`[x402] Failed to log payment: ${err}`);
  }
}

export function getDailySpent(chain?: string): number {
  rehydrateFromLedger();
  resetDailyIfNewDay();
  return chain ? dailySpentByChain.get(chain) ?? 0 : [...dailySpentByChain.values()].reduce((sum, amount) => sum + amount, 0);
}