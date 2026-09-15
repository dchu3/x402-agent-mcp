import type { x402Client } from '@x402/fetch';
import { csprToMotes, toCasperCaip2 } from './networks.js';
import { assertPayableCasperAccept, casperAmountMotes } from './accepts.js';

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
