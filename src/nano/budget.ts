import type { x402Client } from '@x402/fetch';
import { toNanoCaip2, xnoToRaw } from './networks.js';
import { assertPayableNanoAccept, nanoAmountRaw } from './accepts.js';

// Separate from the USD tracker (the Casper pattern). Debit before the send
// block is created, not after an untrusted HTTP response. A Nano send is final
// the moment it confirms, so ambiguous failures keep the debit.
export class NanoBudget {
  private date = '';
  private spent = 0n;
  constructor(private readonly now = () => new Date().toISOString().slice(0, 10)) {}
  getDailySpent(): bigint {
    const date = this.now();
    if (date !== this.date) { this.date = date; this.spent = 0n; }
    return this.spent;
  }
  check(amount: bigint): void {
    const perCall = process.env.NANO_MAX_PAYMENT_PER_CALL;
    const daily = process.env.NANO_MAX_DAILY_SPEND;
    if (!perCall?.trim() || !daily?.trim()) throw new Error('Paid Nano requests disabled: configure both Nano budgets');
    // Parse operator input as decimal strings; never round or convert to USD.
    const callLimit = xnoToRaw(perCall);
    const dailyLimit = xnoToRaw(daily);
    if (amount <= 0n || callLimit <= 0n || dailyLimit <= 0n) throw new Error('Nano amounts and budgets must be positive');
    if (amount > callLimit) throw new Error('Nano per-call budget exceeded');
    if (this.getDailySpent() + amount > dailyLimit) throw new Error('Nano daily budget exceeded');
  }
  reserve(amount: bigint): void {
    this.check(amount);
    this.spent += amount; // synchronous check+debit prevents concurrent bypass
  }
}

export const nanoBudget = new NanoBudget();

/** Guard the requirements actually selected by x402, not just the earlier probe. */
export function guardNanoPayments(client: x402Client, network: string, budget = nanoBudget) {
  let authorized = 0n;
  client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
    if (paymentRequired.x402Version !== 2) throw new Error('Nano requires x402 v2');
    if (toNanoCaip2(selectedRequirements.network) !== toNanoCaip2(network)) throw new Error('Nano network changed after probe');
    assertPayableNanoAccept(selectedRequirements);
    const amount = nanoAmountRaw(selectedRequirements);
    // At most one send per fetch, including SDK recovery attempts.
    if (authorized !== 0n) throw new Error('Nano payment already authorized for this call');
    budget.reserve(amount);
    authorized = amount;
  });
  return () => authorized;
}
