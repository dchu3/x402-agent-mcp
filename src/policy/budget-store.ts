// Issue #19 — per-service daily budget tracking, extending the PR #21 payment
// ledger (no parallel state files): the ledger x402-payments.jsonl is the
// single source of truth. Conventions deliberately mirror src/payment-utils.ts:
//
// - PAYMENT_LOG_PATH captured at module load (tests use fresh query-busted
//   imports with the env preset — see payment-utils.rehydrate.test.ts).
// - Lazy one-shot rehydration: today's SUCCESSFUL payments are grouped by the
//   ledger URL's hostname; rehydrated flag set before any I/O so a throw can
//   never cause a double-read. Corrupted lines and unparseable URLs are
//   skipped — logging is best-effort, so is reading it back.
// - resetDailyIfNewDay() rolls the in-memory map at the UTC day boundary.
//
// Scope rule (symmetric with the global ledger): Casper entries are excluded
// everywhere — Casper settles in wCSPR motes, its spend authority stays
// casper/budget.ts (fail-closed, untouched), and per-service USD caps are a
// USD-ledger mechanism. fetch.ts therefore records per-service spend only for
// USD-settled chains (base/solana), exactly like the global daily tracker.

import { existsSync, readFileSync } from "fs";
// Issue #54 (req 3): the ledger path resolver shared by every ledger reader
// (see the capture comment below).
import { resolveLedger } from "../ledger-path.js";

// Issue #54: the ledger location resolves through src/ledger-path.ts — one
// resolution shared by every reader/writer: an explicit PAYMENT_LOG_PATH wins
// outright (absolute, no legacy read), otherwise the state-dir primary
// (X402_STATE_DIR, default ~/.x402-agent-mcp) plus a read-only legacy
// working-directory ledger when one exists. Captured once at module load,
// mirroring the pre-#54 capture-at-load semantics.
const LEDGER = resolveLedger();
const LOG_PATH = LEDGER.primary;

/** Today's USD spend per service hostname. */
const perServiceSpent = new Map<string, number>();
let dailyDate = new Date().toISOString().slice(0, 10);

let rehydrated = false;

function rehydrateFromLedger(): void {
  if (rehydrated) return;
  rehydrated = true; // set before any I/O — never double-read, even if a read throws
  // Legacy first (read once, read-only), then the primary ledger — a
  // pre-upgrade working-directory ledger must still count toward today's
  // per-service spend (an upgrade that dropped it would silently widen the
  // per-service cap).
  for (const line of readLedgerLines(LEDGER.legacyReadOnly).concat(readLedgerLines(LOG_PATH))) {
    try {
      const e = JSON.parse(line) as { status?: string; chain?: string; url?: string; amount_usdc?: number; timestamp?: string };
      if (
        e.status === "success" &&
        e.chain !== "casper" &&
        typeof e.url === "string" &&
        typeof e.timestamp === "string" &&
        e.timestamp.slice(0, 10) === dailyDate
      ) {
        const host = hostnameOf(e.url);
        if (host !== null) {
          perServiceSpent.set(host, (perServiceSpent.get(host) ?? 0) + (e.amount_usdc ?? 0));
        }
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
    perServiceSpent.clear();
    dailyDate = today;
  }
}

/** Lowercased hostname of a ledger URL, or null when unparseable (such entries
 * are excluded from per-service accounting — there is no service to cap). */
function hostnameOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/** Today's USD spend for one service host (case-insensitive), rehydrating from
 * the ledger on first use. */
export function getPerServiceSpent(host: string): number {
  rehydrateFromLedger();
  resetDailyIfNewDay();
  return perServiceSpent.get((host || "").toLowerCase()) ?? 0;
}

/** Record a successful USD-settled payment against its service host, in
 * memory. Call this right next to payment-utils.logPayment for non-Casper
 * successes so the in-memory map and the ledger stay consistent (rehydration
 * rebuilds the same values after a restart). */
export function recordServicePayment(url: string, amountUsdc: number): void {
  resetDailyIfNewDay();
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) return;
  const host = hostnameOf(url);
  if (host === null) return;
  perServiceSpent.set(host, (perServiceSpent.get(host) ?? 0) + amountUsdc);
}