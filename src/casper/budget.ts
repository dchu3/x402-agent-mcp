import type { x402Client } from '@x402/fetch';
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

// Separate from the USD tracker. Debit before signing, not after an untrusted
// HTTP response. Ambiguous failures retain the debit to prevent retry overspend.
export class CasperBudget {
  private date = '';
  private spent = 0n;
  constructor(private readonly now = () => new Date().toISOString().slice(0, 10)) {}
  getDailySpent(): bigint {
    const date = this.now();
    if (date !== this.date) { this.date = date; this.spent = 0n; }
    return this.spent;
  }
  check(amount: bigint): void {
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


export const casperBudget = new CasperBudget();

// ---------------------------------------------------------------------------
// Issue #65: the Casper rail registers in the budget registry as an ADAPTER
// over this module's own memory counter — the registry duplicates nothing.
// persistence is honestly "memory": the counter is process-local, and the
// ledger is not its source of truth. Caps read the env LIVE per call through
// the existing csprToMotes math (an unset or unusable budget is "no cap" —
// the rail's own checks refuse all paid calls then). The USD rate comes ONLY
// from X402_RATE_WCSPR_USD (or a rate an operator prices onto the table's
// wCSPR entry via assets.extensions): NO built-in rate ever ships — an
// unpriced Casper rail is disabled for paid calls while the optional
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
  persistence: 'memory',
  usdRate: () => resolveRailUsdRate('wCSPR', casperTableRate()),
});

/** Test hook: clear the singleton's in-memory spend and its day (fresh state
 * between scenarios). Not part of the runtime surface. */
export function _resetCasperBudgetForTests(): void {
  const budget = casperBudget as unknown as { date: string; spent: bigint };
  budget.date = '';
  budget.spent = 0n;
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
