// Issue #67 — x402_inspect: WHAT WILL THIS PAY? — answered without paying.
//
// A 402 challenge (or a bare offer / accepts array) goes IN, a complete
// per-offer report comes OUT: exact atomic amounts and unit-priced strings,
// the USD value when the per-network asset table prices it (issue #62's
// vocabulary: asset_not_listed / asset_no_usd_rate when it does not), the
// deterministic selection's verdict with the same rejection tokens
// (issues #61/#62), a budget verdict for the chosen leg against the live
// caps and the optional cross-chain ceiling (issues #62/#65), and — for
// Casper offers — the mote rail's verdict (RAIL_DISABLED_NO_RATE while an
// active ceiling finds no configured rate, issue #65 req 4).
//
// The selection and the per-candidate policy gate come from the SAME
// extracted wiring the paid flow uses (src/tools/offer-evaluation.ts) — one
// wiring, two callers, no drift between what is inspected and what would be
// paid. The inspection is READ-ONLY: no probe, no reservation hold, no
// signature, no ledger write, ZERO network calls. Seller-controlled text is
// stripped/capped and never rendered raw (issue #63 discipline).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { selectOffer, DEFAULT_CHAIN_ORDER, type RejectedOffer, type SelectOfferResult } from "./offer-selection.js";
import { seamUsdOf, seamPolicyFor } from "./offer-evaluation.js";
import { loadPolicyConfig } from "../policy/config.js";
import { modeAllowsNetwork, resolveNetworkMode } from "../networks.js";
import { parseChainFromNetwork } from "./probe-utils.js";
import { CASPER_CHAIN } from "../casper/networks.js";
import { selectCasperAccept, casperAmountMotes } from "../casper/accepts.js";
import { casperBudget } from "../casper/budget.js";
import { getBudgets, usdValueOf, railSpendUsd } from "../budget-registry.js";
import { ceilingState, dailyTotalCeilingUsd, railSpendTotalUsd, reservedUsd, TOTAL_USD_SCOPE } from "../reservations.js";
import { checkSpendingLimit, spendBucketForNetwork } from "../payment-utils.js";
import { exactUsdString, formatAtomic } from "./accounting.js";
import { stripUntrusted, untrustedText, CHALLENGE_UNTRUSTED_MAX } from "../transport/untrusted.js";

/** Accepts-extraction bound: the same order of magnitude the paid flow
 * parses (the payment-required header/body cap is 64 KiB there). */
const OFFER_INPUT_MAX = 65_536;

const CEILING_REFUSAL_CODE = "RAIL_DISABLED_NO_RATE" as const;

/** One accept entry's seller-controlled fields, stripped and capped — never
 * rendered raw (issue #63). */
function strippedOfferFields(raw: unknown): { network: string; asset: string; payTo: string; scheme: string } {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const s = (value: unknown, cap: number) => (typeof value === "string" ? stripUntrusted(value, cap) : "");
  return {
    scheme: s(entry.scheme, 32),
    network: s(entry.network, 64),
    asset: s(entry.asset, 100),
    payTo: s(entry.payTo, 100),
  };
}

/** Normalize ANY inspector input to the accepts array (or null when nothing
 * parseable was given). The offer may be:
 *   - a JSON string (the whole payment-required payload, an accepts array or
 *     a single offer) — parsed bounded; a malformed string is not an
 *     exception, it is a reported empty report,
 *   - an object with accepts/accept (the whole payload),
 *   - an accepts array,
 *   - a single offer object. */
function normalizeOfferInput(offer: unknown): { accepts: unknown[] | null; malformedInput: boolean } {
  let parsed: unknown = offer;
  if (typeof offer === "string") {
    if (offer.length > OFFER_INPUT_MAX) return { accepts: null, malformedInput: true };
    try {
      parsed = JSON.parse(offer);
    } catch {
      return { accepts: null, malformedInput: true };
    }
  }
  if (Array.isArray(parsed)) return { accepts: parsed, malformedInput: false };
  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["accepts", "accept"]) {
      const value = obj[key];
      if (Array.isArray(value)) return { accepts: value, malformedInput: false };
      if (value !== null && typeof value === "object") return { accepts: [value], malformedInput: false };
    }
    return { accepts: [parsed], malformedInput: false };
  }
  return { accepts: null, malformedInput: true };
}

/** The USD-rail budget verdict for a USD-chains candidate, computed with the
 * SAME reads the paid flow makes (checkSpendingLimit's per-call + daily
 * read; reserveSpend's ceiling rule) — as pure reads, no hold is inserted,
 * nothing is credited or debited. */
function usdBudgetVerdict(amountUsd: number, network: string): { verdict: "within" | "refused"; reason?: string; rail: "usd" } {
  const spend = checkSpendingLimit(amountUsd, spendBucketForNetwork(network));
  if (!spend.allowed) {
    return { verdict: "refused", reason: spend.reason, rail: "usd" };
  }
  // The optional cross-chain ceiling (issue #65 req 4/5) — the same verdict
  // reserveSpend makes, evaluated read-only here (settled rails' spend +
  // every outstanding 'total-usd' hold + this amount under the ceiling).
  const ceiling = dailyTotalCeilingUsd();
  if (ceiling !== undefined) {
    const ceilingHeld = reservedUsd(TOTAL_USD_SCOPE);
    const totalSpend = railSpendTotalUsd();
    if (totalSpend + ceilingHeld + amountUsd > ceiling + 1e-9) {
      return {
        verdict: "refused",
        reason: `Payment $${amountUsd} would exceed the cross-chain daily ceiling MAX_DAILY_SPEND_TOTAL_USD $${ceiling} (total spent $${totalSpend.toFixed(4)} + held $${ceilingHeld.toFixed(4)} across rails)`,
        rail: "usd",
      };
    }
  }
  return { verdict: "within", rail: "usd" };
}

/** The Casper rail's read-only verdict for a mote amount: the SAME check the
 * paid flow runs before any signature (budgets, then the ceiling's
 * RAIL_DISABLED_NO_RATE refusal with its one stderr line) — check() never
 * debits (only reserve() does), so this stays side-effect free. A thrown
 * refusal is caught and REPORTED, never surfaced as an exception. */
function casperBudgetVerdict(motes: bigint): { verdict: "within" | "refused"; reason?: string; code?: typeof CEILING_REFUSAL_CODE } {
  try {
    casperBudget.check(motes);
    return { verdict: "within" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      verdict: "refused",
      reason: message,
      ...(message.includes(CEILING_REFUSAL_CODE) ? { code: CEILING_REFUSAL_CODE } : {}),
    };
  }
}

interface InspectOfferEntry {
  index: number;
  chain: string;
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount_atomic: string | null;
  /** The amount in the asset's OWN unit at the table's real decimals —
   * exact via the atomic formatter (#67 "clear amounts", never toFixed). */
  amount_unit: string | null;
  /** The table's priced USD value, or null with a reason when unpriced. */
  usd_estimate: number | null;
  usd_estimate_note?: string;
  symbol: string | null;
  selectable: boolean;
  reject?: RejectedOffer["reject"];
  rail_budget?: { verdict: "within" | "refused"; reason?: string; code?: typeof CEILING_REFUSAL_CODE; usd_value?: number };
}

export function registerInspectTool(server: McpServer): void {
  server.tool(
    "x402_inspect",
    "Inspect a 402 payment challenge (or a single offer, or an accepts array — pass it in `offer`) WITHOUT paying: the deterministic selection's verdict for every listed offer (the same wiring as x402_fetch: per-network asset table, policy gate, network mode), the exact atomic amount and unit price of each offer, the USD value when the table prices it, the rejection token for every offer the flow would skip, a budget verdict for the chosen leg (per-call cap, daily cap, the optional MAX_DAILY_SPEND_TOTAL_USD cross-chain ceiling — an unpriced rail reports RAIL_DISABLED_NO_RATE) and a snapshot of every registered budget rail. Read-only: this tool never signs, never reserves budget, never pays and never makes a network call.",
    {
      offer: z.unknown().describe("The 402 payment-required payload (object with accepts/accept), an accepts array, a single offer object, or any of those as a JSON string"),
      url: z.string().optional().describe("The endpoint URL the offer came from — sharpens per-service policy inputs (the same rule x402_fetch enforces); no request is ever made to it"),
    },
    async ({ offer, url }) => {
      const inspectUrl = typeof url === "string" && url.trim() !== "" ? url.trim() : "";
      let serviceHost = "";
      try { serviceHost = new URL(inspectUrl).hostname.toLowerCase(); } catch { serviceHost = ""; }

      const { accepts, malformedInput } = normalizeOfferInput(offer);
      if (accepts === null) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ...(malformedInput
                ? { error: "offer is not parseable x402 payment data (a JSON string, whole payload, accepts array or single offer object)" }
                : { error: "offer contains no accepts entries" }),
              offers: [],
              selection: { code: "NO_PAYABLE_OFFER", rejected: [] },
              note: "Read-only inspection — nothing was signed, reserved, paid or fetched.",
            }, null, 2),
          }],
        };
      }

      // The live context, read fresh per call — the same state the paid flow
      // reads at its seam (config, mode, keys, table extensions).
      const policyState = loadPolicyConfig();
      const networkMode = resolveNetworkMode().mode ?? null;
      const keysLoaded = {
        solana: !!process.env.SOLANA_PRIVATE_KEY,
        evm: !!(process.env.EVM_PRIVATE_KEY || process.env.BASE_PRIVATE_KEY),
      };
      const pricer = seamUsdOf(policyState.config.assets.extensions);
      const policyFor = seamPolicyFor(inspectUrl || "x402://inspect", serviceHost);

      // Split the accepts exactly as the paid flow splits them: the
      // deterministic selection runs on the USD-chains entries; Casper
      // entries are inspected through the mote rail (the paid flow never
      // runs them through this selector either — it selects via
      // selectCasperAccept over the same list).
      const acceptsList = accepts as unknown[];
      const usdIndices: number[] = [];
      let casperAccept: ReturnType<typeof selectCasperAccept> = undefined;
      for (let index = 0; index < acceptsList.length; index++) {
        const fields = strippedOfferFields(acceptsList[index]);
        if (parseChainFromNetwork(fields.network) === CASPER_CHAIN) {
          if (casperAccept === undefined) {
            casperAccept = selectCasperAccept({ accepts: acceptsList }, undefined);
          }
          continue;
        }
        usdIndices.push(index);
      }

      // The deterministic selection over the USD entries, re-indexed onto the
      // ORIGINAL accept indices afterwards.
      let selection: SelectOfferResult | undefined = undefined;
      const usdBySelectionIndex = new Map<number, number>();
      if (usdIndices.length > 0) {
        selection = selectOffer({
          accepts: usdIndices.map((i) => acceptsList[i]),
          keysLoaded,
          allowedNetworks: policyState.configErrors.length > 0 ? [] : policyState.config.networks.allowed,
          networkAllowed: (network) => !networkMode || modeAllowsNetwork(networkMode, network),
          usdOf: pricer,
          policyFor,
          chainOrder: DEFAULT_CHAIN_ORDER,
        });
        usdIndices.forEach((originalIndex, selectionIndex) => usdBySelectionIndex.set(selectionIndex, originalIndex));
      }
      const rejectByIndex = new Map<number, RejectedOffer>();
      if (selection) {
        for (const r of selection.rejected) {
          const original = usdBySelectionIndex.get(r.index) ?? r.index;
          if (!rejectByIndex.has(original)) rejectByIndex.set(original, { ...r, index: original });
        }
      } else if (casperAccept === undefined) {
        // Nothing entered the selection (all Casper/malformed): the whole
        // list rejects (the table/policy/mode vocabulary is evaluated below
        // per entry for the report).
      }
      const chosenIndex = selection?.ok ? (usdBySelectionIndex.get(selection.chosen.index) ?? selection.chosen.index) : undefined;

      // Casper verdict (read-only) — the selected accept participates; it is
      // the same entry object from the accepts list, so identity finds it.
      const casperMotes = casperAccept ? casperAmountMotes(casperAccept) : null;
      const casperVerdict = casperAccept ? casperBudgetVerdict(casperMotes!) : undefined;

      // Per-offer report: exact amounts, table pricing when priced, the
      // rejection token, and the mote-rail verdict for the selected Casper
      // offer (the rail's configured rate prices the motes to USD when one
      // exists — never an assumed value).
      const casperRail = getBudgets().find((r) => r.id === "casper");
      const casperRate = casperRail?.usdRate() ?? null;
      const casperUsd = casperRate === null || casperMotes === null ? null : usdValueOf(casperMotes.toString(), 9, casperRate) ?? null;
      const entries: InspectOfferEntry[] = acceptsList.map((raw, index) => {
        const fields = strippedOfferFields(raw);
        const isCasper = parseChainFromNetwork(fields.network) === CASPER_CHAIN;
        let amountAtomic: string | null = null;
        let amountUnit: string | null = null;
        let usd: number | null = null;
        let usdNote: string | undefined;
        let symbol: string | null = null;
        const rawEntry = (raw ?? {}) as Record<string, unknown>;
        const rawAmount = typeof rawEntry.amount === "string" ? rawEntry.amount : typeof rawEntry.maxAmountRequired === "string" ? rawEntry.maxAmountRequired : null;
        if (rawAmount !== null && /^\d+$/.test(rawAmount) && BigInt(rawAmount) > 0n) {
          amountAtomic = rawAmount;
          if (isCasper) {
            amountUnit = formatAtomic(BigInt(rawAmount), 9);
            symbol = "wCSPR";
          } else if (typeof rawEntry.asset === "string" && fields.network !== "") {
            const priced = pricer(rawEntry.asset, fields.network, rawAmount);
            if (priced.ok === true) {
              amountUnit = formatAtomic(BigInt(rawAmount), priced.decimals);
              usd = priced.usd;
              symbol = priced.symbol;
            } else {
              usdNote = priced.code; // asset_not_listed | asset_no_usd_rate
            }
          }
        }
        return {
          index,
          chain: isCasper ? CASPER_CHAIN : parseChainFromNetwork(fields.network) || "unknown",
          scheme: fields.scheme,
          network: fields.network,
          asset: fields.asset,
          payTo: fields.payTo,
          amount_atomic: amountAtomic,
          amount_unit: amountUnit,
          usd_estimate: usd,
          ...(usdNote ? { usd_estimate_note: usdNote } : {}),
          symbol,
          selectable: chosenIndex === index || (casperAccept !== undefined && casperAccept === raw && casperVerdict?.verdict === "within"),
          ...(rejectByIndex.get(index)?.reject !== undefined ? { reject: rejectByIndex.get(index)!.reject } : {}),
          ...(isCasper && casperAccept === raw && casperVerdict
            ? {
                rail_budget: {
                  ...casperVerdict,
                  ...(casperUsd !== null && casperVerdict.verdict === "within" ? { usd_value: casperUsd } : {}),
                },
              }
            : {}),
        } satisfies InspectOfferEntry;
      });

      // The selection block: which offer the flow would sign — or why none.
      let selectionBlock: Record<string, unknown>;
      if (selection?.ok) {
        const chosen = selection.chosen;
        const verdict = usdBudgetVerdict(chosen.usd, chosen.network);
        selectionBlock = {
          chosen_index: chosenIndex,
          chain: chosen.chain,
          network: chosen.network,
          symbol: chosen.symbol,
          decimals: chosen.decimals,
          amount_atomic: chosen.amountAtomic,
          // The priced USD as an EXACT unit string at the table decimals —
          // the same number the ranking used, rendered through the atomic
          // formatter (issue #67: clear amounts, never a toFixed surprise).
          amount_unit: exactUsdString(chosen.usd, chosen.decimals),
          usd: chosen.usd,
          budget: verdict,
        };
      } else if (casperVerdict?.verdict === "within") {
        const casperIndex = acceptsList.indexOf(casperAccept);
        selectionBlock = {
          chosen_index: casperIndex,
          chain: CASPER_CHAIN,
          network: stripUntrusted(String((casperAccept as any)?.network ?? ""), 64),
          symbol: "wCSPR",
          decimals: 9,
          amount_atomic: casperMotes!.toString(),
          amount_unit: formatAtomic(casperMotes!, 9),
          budget: { verdict: "within", rail: "casper" },
        };
      } else if (casperVerdict?.verdict === "refused") {
        selectionBlock = {
          code: "NO_PAYABLE_OFFER",
          rejected: rejectsForReport(rejectByIndex, acceptsList, casperAccept, casperVerdict),
        };
      } else {
        selectionBlock = {
          code: "NO_PAYABLE_OFFER",
          rejected: [...rejectByIndex.values()].map((r) => ({ index: r.index, chain: r.chain, reject: r.reject })),
        };
      }

      // The whole-registry snapshot so an operator sees the full budget state
      // next to the verdicts (the same listing family x402_status prints).
      const cel = ceilingState();
      const snapshotRails = getBudgets().map((rail) => {
        const dailyCap = rail.dailyCap();
        const spent = rail.spentToday();
        let remaining: string | null = null;
        if (dailyCap !== null && dailyCap.decimals === spent.decimals) {
          const left = BigInt(dailyCap.atomic) - BigInt(spent.atomic) - BigInt(rail.reservedToday?.()?.atomic ?? "0");
          remaining = formatAtomic(left > 0n ? left : 0n, dailyCap.decimals);
        }
        const rate = rail.usdRate();
        return {
          rail: rail.id,
          unit: rail.unit,
          spent_today: formatAtomic(BigInt(spent.atomic), rail.decimals),
          remaining_today: remaining,
          usd_rate: rate,
          // The same "the ceiling cannot price → disabled" rule reservations.ts
          // uses, reported here so an operator sees an unpriced rail's fate.
          disabled: cel.active && (rate === null || railSpendUsd(rail) === null),
        };
      });

      const output = {
        ...(inspectUrl === "" ? {} : { url: inspectUrl }),
        network_mode: networkMode ?? null,
        untrusted_challenge: untrustedText(JSON.stringify(acceptsList), CHALLENGE_UNTRUSTED_MAX),
        offers: entries,
        selection: selectionBlock,
        budget_snapshot: { ceiling: cel, rails: snapshotRails },
        note: "Read-only inspection — nothing was signed, reserved, paid or fetched. x402_fetch governs every leg the same way at pay time.",
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      };
    },
  );
}

/** Rejections for the report: the USD entries' tokens plus the Casper
 * verdict's token so a refused mote leg names its stable code too. */
function rejectsForReport(
  rejectByIndex: Map<number, RejectedOffer>,
  acceptsList: unknown[],
  casperAccept: unknown,
  casperVerdict: { verdict: string; code?: typeof CEILING_REFUSAL_CODE },
): Array<{ index: number; chain: string; reject: string }> {
  const list: Array<{ index: number; chain: string; reject: string }> = [...rejectByIndex.values()].map((r) => ({
    index: r.index,
    chain: r.chain,
    reject: r.reject,
  }));
  if (casperVerdict.code) {
    list.push({
      index: acceptsList.indexOf(casperAccept),
      chain: CASPER_CHAIN,
      reject: casperVerdict.code,
    });
  }
  return list.sort((a, b) => a.index - b.index);
}