// Settlement reconciliation for sent-but-unproven payments: an
// authorized_unserved ledger row that carries its on-chain signature is
// reconciled against the chain once its validity has passed (or is about to
// pass, inside the reconciliation window):
//
//   - the chain knows the signature → the row is rewritten IN PLACE to
//     settled_unserved: a permanent count. The settled amount must never
//     drop out of a cap again, not even after a restart — this is the
//     release the row's old expiry would otherwise give a possibly-settled
//     payment;
//   - the chain does not know the signature → the row stays as written and
//     its expiry governs: past expiry it stopped counting (it can no longer
//     settle), inside the window it keeps counting. Never un-count a
//     possibly-settled payment;
//   - the lookup errors (RPC 429/5xx, timeout, unparseable answer) → the
//     row's expiry is EXTENDED by RECONCILE_RETRY_MS (the fail-closed
//     direction: keep counting) with a bounded reconcile_retries counter in
//     the row; past the bound the row expires like any other — the
//     direction is always over-count, never un-count, never forever-count.
//
// Rows without a signature and non-Solana rows are never reconciled: there
// is no chain-status path for them, so an EVM sent payment simply counts to
// its payload-expiry (fail closed).
//
// The reconciler is rate-limited INSIDE this module (rehydration and the
// reservation call site share the one maybeReconcile window), its lookups
// are injectable for tests (setSignatureStatusLookup), and every run
// rebuilds the daily totals from the ledger afterwards — a rewritten row is
// immediately consistent with the in-memory caps and with what a restart
// would rehydrate (restart parity).

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolveLedger } from "./ledger-path.js";
import { recountDailyFromLedger, type PaymentLogEntry } from "./payment-utils.js";
// The devnet marker (public protocol identifier) decides which RPC a row is
// reconciled against; DEVNET_RPC_URL is the SDK's documented fallback.
import { DEVNET_RPC_URL, SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { SOLANA_MAINNET_RPC_FALLBACK } from "./networks.js";

/** How long a row whose lookup failed keeps counting before the next
 * extension (fail closed: 5 minutes of additional counting per retry). */
export const RECONCILE_RETRY_MS = 5 * 60_000;
/** Upper bound of extensions: after this many failed lookups the row's
 * expiry governs on its own (bounded counting — no forever-holds). */
export const MAX_RECONCILE_RETRIES = 12;
/** Reconciliation runs at most once per window, shared by the rehydration
 * hook and the reservation call site. */
export const RECONCILE_INTERVAL_MS = 30_000;
/** A row whose expiry is within this window of passing is reconciled
 * already (look-before-release: a settlement found here converts BEFORE the
 * row would have dropped out of the caps). */
export const RECONCILE_WINDOW_MS = 60_000;

/** What a status lookup reports for one signature. */
export type SignatureStatusResult =
  | { found: true; confirmationStatus?: string }
  | { found: false }
  | { error: string };

export type SignatureStatusLookup = (signature: string, rpcUrl: string) => Promise<SignatureStatusResult>;

// The ledger location resolves through the shared ledger-path resolution at
// CALL time (not at module load): tests import this module before their env
// is in place — the one-capture-per-process rule payment-utils follows is
// preserved because payment-utils itself captures at its own load.

let lookup: SignatureStatusLookup | undefined; // undefined → the default JSON-RPC lookup

/** Inject a signature-status lookup (tests run hermetic — a mock, no
 * network) or restore the default when called with undefined. */
export function setSignatureStatusLookup(fn: SignatureStatusLookup | undefined): void {
  lookup = fn ?? undefined;
}

/** The default lookup: one JSON-RPC getSignatureStatuses call against the
 * row's RPC, short timeout, NO retries (the retry policy lives in the row
 * extensions above, never in the transport). */
async function jsonRpcGetSignatureStatus(signature: string, rpcUrl: string): Promise<SignatureStatusResult> {
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[signature], { searchTransactionHistory: false }] }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const body = (await resp.json()) as { value?: Array<{ confirmationStatus?: unknown } | null> };
    const value = body?.value?.[0];
    if (!value) return { found: false };
    return {
      found: true,
      ...(typeof value.confirmationStatus === "string" ? { confirmationStatus: value.confirmationStatus } : {}),
    };
  } catch (err) {
    return { error: String((err as { message?: unknown } | undefined)?.message ?? err) };
  }
}

/** The RPC a row is reconciled against: a DEVNET row rides the devnet RPC,
 * every other Solana row the mainnet one — never the run's mode. */
function rpcUrlForRow(entry: { network?: string }): string {
  return entry.network === SOLANA_DEVNET_CAIP2
    ? process.env.SOLANA_DEVNET_RPC_URL || DEVNET_RPC_URL
    : process.env.SOLANA_RPC_URL || SOLANA_MAINNET_RPC_FALLBACK;
}

function readLedgerLines(path: string): string[] {
  if (!path || !existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8").split("\n");
  } catch (err) {
    console.error(`[x402] Failed to read ledger ${path}: ${err}`);
    return [];
  }
}

/** Reconcile every expired/expiring, signed, Solana authorized_unserved row
 * in the primary ledger and rebuild the daily totals afterwards. */
export async function reconcileAuthorizedUnserved(nowMs: number): Promise<void> {
  const LEDGER = resolveLedger();
  const LOG_PATH = LEDGER.primary;
  const lines = readLedgerLines(LOG_PATH);
  interface Candidate { index: number; entry: PaymentLogEntry; }
  const candidates: Candidate[] = [];
  for (let index = 0; index < lines.length; index++) {
    let entry: PaymentLogEntry;
    try {
      entry = JSON.parse(lines[index]!) as PaymentLogEntry;
    } catch {
      continue; // corrupted line — the ledger readers skip it identically
    }
    if (entry.status !== "authorized_unserved") continue;
    if (typeof entry.signature !== "string" || entry.signature === "") continue;
    if (entry.chain !== "solana") continue;
    const exp = entry.expires_at === undefined ? NaN : Date.parse(entry.expires_at);
    if (!Number.isFinite(exp)) continue; // unparseable expiry: it counts forever, fail closed — leave it alone
    if (exp > nowMs + RECONCILE_WINDOW_MS) continue; // far from expiry — outside the window
    candidates.push({ index, entry });
  }

  interface Update { index: number; line: string; }
  const updates: Update[] = [];
  for (const { index, entry } of candidates) {
    let result: SignatureStatusResult;
    try {
      result = await (lookup ?? jsonRpcGetSignatureStatus)(entry.signature!, rpcUrlForRow(entry));
    } catch (err) {
      result = { error: String((err as { message?: unknown } | undefined)?.message ?? err) };
    }
    const exp = Date.parse(entry.expires_at!);
    if ("error" in result) {
      // Lookup failed: keep counting. Bounded — once the row's retries reach
      // the bound, extensions stop and the row's own expiry governs.
      const retries = typeof entry.reconcile_retries === "number" && Number.isFinite(entry.reconcile_retries) && entry.reconcile_retries >= 0
        ? entry.reconcile_retries
        : 0;
      if (retries >= MAX_RECONCILE_RETRIES) continue;
      const base = Math.max(exp, nowMs);
      const extended: PaymentLogEntry = {
        ...entry,
        expires_at: new Date(base + RECONCILE_RETRY_MS).toISOString(),
        reconcile_retries: retries + 1,
      };
      updates.push({ index, line: JSON.stringify(extended) });
    } else if (result.found) {
      // Confirmed on chain — the possibly-settled payment IS settled:
      // permanent count, validity bound dropped.
      const settled: PaymentLogEntry = { ...entry, status: "settled_unserved" };
      delete settled.expires_at;
      updates.push({ index, line: JSON.stringify(settled) });
    }
    // not found: the row governs itself (past expiry it stopped counting;
    // inside the window it keeps counting) — no rewrite either way.
  }

  if (updates.length > 0) {
    // Re-read for freshness (concurrent logPayment appends only ever ADD
    // lines — indexes of earlier lines are stable), then rewrite in place.
    let fresh: string[] = [];
    try {
      fresh = readLedgerLines(LOG_PATH);
    } catch {
      fresh = [];
    }
    if (fresh.length === lines.length) {
      for (const u of updates) {
        if (fresh[u.index] === lines[u.index]) fresh[u.index] = u.line;
      }
      try {
        writeFileSync(LOG_PATH, fresh.join("\n"), "utf-8");
      } catch (err) {
        // A failed rewrite keeps the rows exactly as they were — counting
        // never decreases because of the reconciler (fail closed).
        console.error(`[x402] Failed to reconcile settlement rows in ${LOG_PATH}: ${err}`);
      }
    }
  }
  // The caps read the rebuilt totals: a rewritten row is immediately
  // consistent with the in-memory map and with a restart's rehydration.
  recountDailyFromLedger();
}

// ---------------------------------------------------------------------------
// Rate limiting — the ONE window shared by every call site.
// ---------------------------------------------------------------------------

let lastAttemptMs: number | undefined;
let lastRun: Promise<void> | undefined;

/** Rate-limited reconciliation: at most one module run per interval window
 * (rehydration and the reservation call site both land here; callers never
 * await on a request's critical path — the returned promise may be dropped).
 * Failures are swallowed into the module log; the rows keep their previous
 * counting semantics either way. */
export function maybeReconcileAuthorizedUnserved(nowMs: number): Promise<void> {
  if (lastAttemptMs !== undefined && nowMs - lastAttemptMs < RECONCILE_INTERVAL_MS && lastRun !== undefined) {
    return lastRun;
  }
  lastAttemptMs = nowMs;
  lastRun = reconcileAuthorizedUnserved(nowMs).catch((err) => {
    console.error(`[x402] settlement reconciliation skipped: ${String((err as { message?: unknown } | undefined)?.message ?? err)}`);
  });
  return lastRun;
}

/** Test seam: the most recent reconciler run (started if none), bypassing
 * the rate-limit window so a test can await the rehydration's own
 * fire-and-forget run. */
export function _reconcileNowForTests(nowMs: number): Promise<void> {
  if (lastRun === undefined) {
    lastRun = reconcileAuthorizedUnserved(nowMs).catch(() => {});
  }
  return lastRun!;
}

/** Test hook: reset the rate-limit window state between scenarios. */
export function _resetReconcileForTests(): void {
  lastAttemptMs = undefined;
  lastRun = undefined;
}