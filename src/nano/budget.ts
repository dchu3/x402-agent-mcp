import { existsSync, readFileSync } from 'node:fs';
import type { x402Client } from '@x402/fetch';
import { MAX_RAW, toNanoCaip2, xnoToRaw } from './networks.js';
import { assertPayableNanoAccept, nanoAmountRaw } from './accepts.js';
import { getLedgerPath } from '../payment-utils.js';

const RAW_STRING = /^\d{1,39}$/;
const BLOCK_HASH = /^[0-9A-Fa-f]{64}$/;

/**
 * Sum the raw spent on Nano on one UTC day, from the shared JSONL ledger.
 *
 * Mirrors rehydrateFromLedger() in payment-utils.ts: a nano row counts when
 * its timestamp falls on `date` and it is `success`, or it is `failed` but
 * carries a published send block hash (a published send can still confirm,
 * so it is treated as spent, the same as the in-process reservation that is
 * kept after a send was attempted). Amounts are parsed as BigInt only.
 * Malformed lines and rows with a malformed amount are skipped; they can
 * only fail to add, never subtract. A missing ledger is zero spend; a ledger
 * that exists but cannot be read throws, so the caller fails closed.
 */
export function nanoSpentFromLedger(path: string, date: string): bigint {
  if (!existsSync(path)) return 0n;
  const text = readFileSync(path, 'utf-8');
  let total = 0n;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object' || entry.chain !== 'nano') continue;
    if (typeof entry.timestamp !== 'string' || entry.timestamp.slice(0, 10) !== date) continue;
    const published = entry.status === 'failed' && typeof entry.tx_hash === 'string' && BLOCK_HASH.test(entry.tx_hash);
    if (entry.status !== 'success' && !published) continue;
    if (typeof entry.amount_raw !== 'string' || !RAW_STRING.test(entry.amount_raw)) continue;
    const amount = BigInt(entry.amount_raw);
    if (amount > MAX_RAW) continue;
    total += amount;
  }
  return total;
}

// Separate from the USD tracker (the Casper pattern). Debit before the send
// block is created, not after an untrusted HTTP response. A Nano send is final
// the moment it confirms, so ambiguous failures keep the debit.
//
// The process is per-session (stdio), so the counter is rebuilt from the
// ledger on first use and at every UTC day change; otherwise a restart would
// reset the daily cap. If the ledger cannot be read, getDailySpent() throws
// and every check() refuses (fail closed), retrying the read on the next call.
export class NanoBudget {
  private date = '';
  private spent = 0n;
  constructor(
    private readonly now = () => new Date().toISOString().slice(0, 10),
    private readonly ledgerPath: () => string = getLedgerPath,
  ) {}
  getDailySpent(): bigint {
    const date = this.now();
    if (date !== this.date) {
      let fromLedger: bigint;
      try {
        fromLedger = nanoSpentFromLedger(this.ledgerPath(), date);
      } catch (err) {
        throw new Error(`Paid Nano requests disabled: cannot read the payment ledger to rebuild today's Nano spend (${(err as Error)?.message ?? err})`);
      }
      this.date = date;
      this.spent = fromLedger;
    }
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
