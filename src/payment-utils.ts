import { appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";

export interface PaymentLogEntry {
  timestamp: string;
  url: string;
  method: string;
  chain: string;
  amount_usdc: number;
  tx_hash?: string;
  status: "success" | "failed";
  error?: string;
}

const LOG_PATH = process.env.PAYMENT_LOG_PATH || "./x402-payments.jsonl";

// Track daily spending in memory
let dailySpent = 0;
let dailyDate = new Date().toISOString().slice(0, 10);

function resetDailyIfNewDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyDate) {
    dailySpent = 0;
    dailyDate = today;
  }
}

export function getMaxPerCall(): number {
  return parseFloat(process.env.MAX_PAYMENT_PER_CALL || "0.50");
}

export function getMaxDailySpend(): number {
  return parseFloat(process.env.MAX_DAILY_SPEND || "10.00");
}

export function checkSpendingLimit(amountUsdc: number): { allowed: boolean; reason?: string } {
  resetDailyIfNewDay();

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

  if (entry.status === "success") {
    dailySpent += entry.amount_usdc;
  }

  try {
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(LOG_PATH, line, { encoding: "utf-8" });
  } catch (err) {
    // Logging is best-effort — don't fail the payment if logging fails
    console.error(`[x402] Failed to log payment: ${err}`);
  }
}

export function getDailySpent(): number {
  resetDailyIfNewDay();
  return dailySpent;
}