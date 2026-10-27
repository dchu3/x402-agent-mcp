import type { x402Client } from '@x402/fetch';
import { existsSync, readFileSync } from 'fs';
import { CASPER_MAINNET_CAIP2, CSPR_DECIMALS, csprToMotes, toCasperCaip2 } from './networks.js';
import { assertPayableCasperAccept, casperAmountMotes, WCSPR_ASSETS } from './accepts.js';
// Issue #62/#65: the Casper rail's optional rate resolves through the SAME
// asset table the priced legs use (operator extensions included) — never a
// second price source.
import { resolveAsset } from '../assets.js';
import { loadPolicyConfig } from '../policy/config.js';
// Issue #65: the budget registry — the Casper rail registers as an ADAPTER
// over this module's own counter (no duplicated accounting), and its USD
// rate resolves through the registry's ONE rate function (no built-in rate).
import { registerBudget, resolveRailUsdRate } from '../budget-registry.js';
// The OPTIONAL cross-chain ceiling (issue #65 req 4): the rail's check reads
// whether an operator set MAX_DAILY_SPEND_TOTAL_USD (no cycle — reservations
// reads its accounting through the registry, never through this module).
import { dailyTotalCeilingUsd } from '../reservations.js';
// Issue #54 (req 3 + req 6): the SAME ledger resolution and the SAME
// counted-spend predicate every other accounting consumer reads — the
// Casper rail rehydrates from these exact rows (see the singleton below).
import { resolveLedger } from '../ledger-path.js';
import { isCountedSpend } from '../payment-utils.js';

// The ledger location resolves through src/ledger-path.ts — one resolution
// shared by every reader/writer. Captured once at module load, mirroring the
// payment-utils capture-at-load semantics.
const LEDGER = resolveLedger();
const LOG_PATH = LEDGER.primary;

// Separate from the USD tracker. Debit before signing, not after an untrusted
// HTTP response. Ambiguous failures retain the debit to prevent retry overspend.
export class CasperBudget {
  private date = '';
  private spent = 0n;
  private rehydrated = false;
  constructor(
    private readonly now = () => new Date().toISOString().slice(0, 10),
    // Issue #54 (req 6): only the rail's SINGLETON rehydrates from the ledger
    // (constructed with `true` below); a caller-constructed budget stays
    // process-local exactly as before.
    private readonly rehydrateFromLedger = false,
  ) {}
  getDailySpent(): bigint {
    const date = this.now();
    if (date !== this.date) { this.date = date; this.spent = 0n; }
    // One-shot lazy rehydration, BEFORE the first read or debit — the same
    // merge order the USD side uses (a restart must not reset the daily
    // Casper budget through the in-memory map starting at 0).
    if (this.rehydrateFromLedger && !this.rehydrated) {
      this.rehydrated = true; // set before any I/O — never double-read
      this.spent += rehydratedCasperMotesToday(date, Date.now());
    }
    return this.spent;
  }
  check(amount: bigint): void {
    // Issue #65 (req 4): while the OPTIONAL cross-chain ceiling is active,
    // an unpriced Casper rail cannot be verified against it — refused
    // outright with the stable refusal code, ONE stderr line (never a
    // flood), before any budget or amount check (refusal is refusal).
    if (dailyTotalCeilingUsd() !== undefined && casperRailUsdRate() === null) {
      console.error('[x402] Casper rail refused while MAX_DAILY_SPEND_TOTAL_USD is set: no configured rate (RAIL_DISABLED_NO_RATE)');
      throw new Error('Paid Casper requests disabled while MAX_DAILY_SPEND_TOTAL_USD is set: no rate configured for CSPR (code RAIL_DISABLED_NO_RATE; configure X402_RATE_WCSPR_USD)');
    }
    const perCall = process.env.CASPER_MAX_PAYMENT_PER_CALL;
    const daily = process.env.CASPER_MAX_DAILY_SPEND;
    if (!perCall?.trim() || !daily?.trim()) throw new Error('Paid Casper requests disabled: configure both Casper budgets');
    // Parse operator input as decimal strings; never round or convert to USD.
    const callLimit = csprToMotes(perCall);
    const dailyLimit = csprToMotes(daily);
    if (amount <= 0n || callLimit <= 0n || dailyLimit <= 0n) throw new Error('Casper amounts and budgets must be positive');
    if (amount > callLimit) throw new Error('Casper per-call budget exceeded');
    if (this.getDailySpent() + amount > dailyLimit) throw new Error('Casper daily budget exceeded');
  }
  reserve(amount: bigint): void {
    this.check(amount);
    this.spent += amount; // synchronous check+debit prevents concurrent bypass
  }
}


export const casperBudget = new CasperBudget(undefined, true);

/** Split a ledger file into lines, best-effort: a missing/unreadable file is
 * an empty ledger (the per-file error names the path). */
function readLedgerLines(path: string | undefined): string[] {
  if (!path || !existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf-8').split('\n');
  } catch (err) {
    console.error(`[x402] Failed to read ledger ${path}: ${err}`);
    return [];
  }
}

/** Issue #97: TODAY's Casper spend rebuilt from the SAME ledger rows
 * every other accounting counter reads (the USD counters deliberately
 * exclude casper rows — this is where they are summed). The ONE
 * counted-spend predicate (isCountedSpend) decides: a verified success
 * counts; a signed-but-unverified authorization counts for the whole UTC
 * day it was written — rows written today carry no expires_at, so nothing
 * releases the count at the intent TTL and the count survives rehydration;
 * a legacy row that still carries a parseable expires_at keeps its old
 * release-on-read. Failed never counts. Amounts sum
 * the row's own amount_motes audit field as exact integers — NEVER a USD
 * conversion, NEVER an invented price (an unpriced rail's refusal path stays
 * RAIL_DISABLED_NO_RATE at the budget check). Legacy-first, read-once, the
 * same best-effort reads as the other consumers. */
function rehydratedCasperMotesToday(date: string, nowMs: number): bigint {
  let total = 0n;
  for (const line of readLedgerLines(LEDGER.legacyReadOnly).concat(readLedgerLines(LOG_PATH))) {
    try {
      const e = JSON.parse(line) as { status?: string; chain?: string; amount_motes?: string; timestamp?: string; expires_at?: string };
      if (
        e.chain === 'casper' &&
        typeof e.timestamp === 'string' &&
        e.timestamp.slice(0, 10) === date &&
        isCountedSpend(e, nowMs) &&
        typeof e.amount_motes === 'string' &&
        /^\d+$/.test(e.amount_motes)
      ) {
        total += BigInt(e.amount_motes);
      }
    } catch {
      // Corrupted ledger lines are skipped — logging is best-effort, so is reading it back
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Issue #65: the Casper rail registers in the budget registry as an ADAPTER
// over this module's own counter — the registry duplicates nothing.
// Issue #54 (req 6): persistence is 'ledger-rehydrated' — the counter
// rebuilds today's mote spend from today's ledger rows (the same ledger the
// USD rail lists), so a restart is not a reset. Caps read the env LIVE per
// call through the existing csprToMotes math (an unset or unusable budget is
// "no cap" — the rail's own checks refuse all paid calls then). The USD rate
// comes ONLY from X402_RATE_WCSPR_USD (or a rate an operator prices onto the
// table's wCSPR entry via assets.extensions): NO built-in rate ever ships —
// an unpriced Casper rail is disabled for paid calls while the optional
// cross-chain MAX_DAILY_SPEND_TOTAL_USD ceiling is set (RAIL_DISABLED_NO_RATE).
// ---------------------------------------------------------------------------

/** One Casper budget env value as exact atomic motes, or null when unset or
 * unusable (a sub-mote/garbage budget already disables every paid call at the
 * rail's own checks — the adapter just reports the absence honestly). */
function casperBudgetCapAtomic(varName: string): { atomic: string; decimals: number } | null {
  const raw = process.env[varName];
  if (raw === undefined || raw.trim() === "") return null;
  try {
    return { atomic: csprToMotes(raw.trim()).toString(), decimals: CSPR_DECIMALS };
  } catch {
    return null;
  }
}

/** The asset table's wCSPR rate — shipped rows carry none, but an operator
 * may price the table's entry via assets.extensions; the USD leg prices
 * through the same resolved entry, so the ceiling and the priced legs always
 * agree on one rate. An unreadable config prices nothing (fail closed). */
function casperTableRate(): number | undefined {
  try {
    const extensions = loadPolicyConfig().config.assets.extensions;
    return resolveAsset(CASPER_MAINNET_CAIP2, WCSPR_ASSETS[CASPER_MAINNET_CAIP2], extensions)?.usdRate;
  } catch {
    return undefined;
  }
}

/** The Casper rail's ONE USD rate (env var first, then the asset table): used
 * by both the budget check's ceiling refusal and the registry adapter. */
function casperRailUsdRate(): number | null {
  return resolveRailUsdRate('wCSPR', casperTableRate());
}

registerBudget({
  id: 'casper',
  unit: 'wCSPR',
  decimals: CSPR_DECIMALS,
  perCallCap: () => casperBudgetCapAtomic('CASPER_MAX_PAYMENT_PER_CALL'),
  dailyCap: () => casperBudgetCapAtomic('CASPER_MAX_DAILY_SPEND'),
  spentToday: () => ({ atomic: casperBudget.getDailySpent().toString(), decimals: CSPR_DECIMALS }),
  // The Casper rail debits synchronously on reserve — its holds ARE its
  // spend, so there are no separate outstanding holds to report.
  reservedToday: () => null,
  persistence: 'ledger-rehydrated',
  // The effective ledger location (issue #54 req 6): the same resolution the
  // rehydrated counter reads, captured once at module load.
  ledgerPath: LOG_PATH,
  usdRate: () => casperRailUsdRate(),
});

/** Test hook: clear the singleton's in-memory spend, its day and its
 * rehydration mark (fresh state between scenarios — the next read rehydrates
 * exactly as a restart would). Not part of the runtime surface. */
export function _resetCasperBudgetForTests(): void {
  const budget = casperBudget as unknown as { date: string; spent: bigint; rehydrated: boolean };
  budget.date = '';
  budget.spent = 0n;
  budget.rehydrated = false;
}

/** Guard the requirements actually selected by x402, not just the earlier probe. */
export function guardCasperPayments(client: x402Client, network: string, budget = casperBudget) {
  let authorized = 0n;
  client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
    if (paymentRequired.x402Version !== 2) throw new Error('Casper requires x402 v2');
    if (toCasperCaip2(selectedRequirements.network) !== toCasperCaip2(network)) throw new Error('Casper network changed after probe');
    assertPayableCasperAccept(selectedRequirements);
    const amount = casperAmountMotes(selectedRequirements);
    // At most one authorization per fetch, including SDK recovery attempts.
    if (authorized !== 0n) throw new Error('Casper payment already authorized for this call');
    budget.reserve(amount);
    authorized = amount;
  });
  return () => authorized;
}
