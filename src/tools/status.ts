// Issue #65 (req 2, plan C3) — x402_status: ONE free listing of every
// registered budget rail.
//
// What it shows, per rail: the unit, the per-call cap, the daily cap, today's
// spent amount, the remaining daily budget, the outstanding reservation
// holds, the persistence mode, the effective ledger path (when a ledger is
// the counter's source of truth) and the USD rate when one is configured.
// Amounts print through the exact atomic formatter (issue #65 req 3) — a
// small value is never rounded to zero.
//
// What it NEVER does: no signing, no ledger write, no budget reservation, no
// network call at all. The registry is a read-only listener over the rails'
// own accounting (issue #65 req 1), so a future rail that self-registers at
// its own module load appears here with no change to this code — that is
// #65 acceptance test 5.
//
// The optional cross-chain ceiling (MAX_DAILY_SPEND_TOTAL_USD) is reported
// with its stable refusal vocabulary: a rail with no configured USD rate is
// DISABLED while a ceiling is set (RAIL_DISABLED_NO_RATE — issue #65 req 4);
// the ceiling itself has no default and is inactive when the variable is
// unset.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// The rails self-register at module load of their accounting modules; BOTH
// imports are required here so the listing always sees the production rails
// regardless of who imported what first.
import "../payment-utils.js";
import "../casper/budget.js";
import { getBudgets, RAIL_DISABLED_NO_RATE } from "../budget-registry.js";
import type { BudgetRail } from "../budget-registry.js";
import { ceilingState, type CeilingState } from "../reservations.js";
import { exactUsdString, formatAtomic } from "./accounting.js";
import { resolveNetworkMode } from "../networks.js";
import { resolveLedger } from "../ledger-path.js";

/** Render one rail's atomic amount (or null) as its exact decimal string. */
function atomicOr(amount: { atomic: string; decimals: number } | null | undefined, decimals: number): string | null {
  if (amount === null || amount === undefined) return null;
  return formatAtomic(BigInt(amount.atomic), amount.decimals ?? decimals);
}

/** One rail's listing entry: exact strings for every money field. */
function railEntry(rail: BudgetRail, disabledRails: CeilingState["disabled_rails"]): Record<string, unknown> {
  const dailyCap = rail.dailyCap();
  const spent = rail.spentToday();
  const reserved = rail.reservedToday?.() ?? null;
  // Remaining daily budget: cap − spent − holds in exact integer atomic
  // units; the same unit must be compared, so a rail that reports no daily
  // cap (a disabled-by-misconfiguration rail) lists null remaining.
  let remaining: string | null = null;
  if (dailyCap !== null && dailyCap.decimals === spent.decimals) {
    const left = BigInt(dailyCap.atomic) - BigInt(spent.atomic) - BigInt(reserved?.atomic ?? "0");
    remaining = formatAtomic(left > 0n ? left : 0n, dailyCap.decimals);
  }
  const disabled = disabledRails?.some((d) => d.rail === rail.id) ?? false;
  return {
    rail: rail.id,
    unit: rail.unit,
    decimals: rail.decimals,
    per_call_cap: atomicOr(rail.perCallCap(), rail.decimals),
    daily_cap: atomicOr(dailyCap, rail.decimals),
    spent_today: atomicOr(spent, rail.decimals),
    remaining_today: remaining,
    reserved_today: atomicOr(reserved, rail.decimals),
    persistence: rail.persistence,
    ...(rail.ledgerPath !== undefined ? { ledger_path: rail.ledgerPath } : {}),
    usd_rate: rail.usdRate(),
    disabled,
    ...(disabled ? { disabled_code: RAIL_DISABLED_NO_RATE } : {}),
  };
}

export function registerStatusTool(server: McpServer): void {
  server.tool(
    "x402_status",
    "List every registered budget rail with its spending controls: unit, per-call cap, daily cap, spent today, remaining today, outstanding holds, persistence mode, effective ledger path, and the USD rate when one is configured. Also reports the optional cross-chain spending ceiling when the operator set MAX_DAILY_SPEND_TOTAL_USD (a rail with no configured rate is disabled while it is active, code RAIL_DISABLED_NO_RATE). Read-only: this tool never signs, never pays, never reserves budget and never writes the ledger.",
    {},
    async () => {
      // Read live per call: registry state, ceiling config and the mode can
      // all change across a long-lived stdio session — nothing is cached.
      const ceiling = ceilingState();
      const modeState = resolveNetworkMode();
      const output = {
        network_mode: modeState.mode ?? null,
        ...(modeState.error ? { network_mode_error: modeState.error } : {}),
        ledger: { primary: resolveLedger().primary },
        cross_chain_ceiling: {
          active: ceiling.active,
          ...(ceiling.max_usd !== undefined ? { max_daily_total_usd: exactUsdString(ceiling.max_usd, 6) } : {}),
          ...(ceiling.spent_total_usd !== undefined ? { spent_total_usd: exactUsdString(ceiling.spent_total_usd, 6) } : {}),
          ...(ceiling.reserved_total_usd !== undefined ? { reserved_total_usd: exactUsdString(ceiling.reserved_total_usd, 6) } : {}),
          ...(ceiling.disabled_rails !== undefined && ceiling.disabled_rails.length > 0
            ? { disabled_rails: ceiling.disabled_rails }
            : {}),
        },
        rails: getBudgets().map((rail) => railEntry(rail, ceiling.disabled_rails)),
        note: "Read-only listing — nothing was signed, reserved or written. Paid tools still govern every leg by policy.",
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      };
    },
  );
}