import { appendFileSync, existsSync, readFileSync } from "fs";
// Issue #59 (D7): the DEVNET CAIP-2 (public protocol identifier) marks the
// devnet ledger rows and the devnet spend bucket.
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";
// Issue #54 (req 3): the ledger path resolver shared by every ledger
// reader/writer (see the capture comment below).
import { prepareLedgerDir, resolveLedger } from "./ledger-path.js";
// Issue #65: the USD rail registers as an ADAPTER over THIS module's own
// accounting (no duplicated counters) — the registry itself owns nothing.
// The adapter's reservedUsd import is cycle-safe: reservations.ts depends on
// payment-utils, and both modules export hoisted function declarations only,
// so the closures run long after both module bodies have evaluated.
import { atomicStringFromUsdString, exactUsdString } from "./tools/accounting.js";
import { registerBudget, resolveRailUsdRate } from "./budget-registry.js";
import { reservedUsd } from "./reservations.js";
// Issue #93 (A2): the USD rail lists the EFFECTIVE caps — the same policy
// state the gate reads. policy/config.ts imports no accounting module (its
// legacy caps re-implement this module's parsing), so the import is
// cycle-safe: both export hoisted function declarations only, and the rail's
// closures run long after both module bodies have evaluated.
import { loadPolicyConfig } from "./policy/config.js";

export interface PaymentLogEntry {
  timestamp: string;
  url: string;
  method: string;
  chain: string;
  amount_usdc?: number;
  amount_motes?: string;
  currency?: "USDC" | "wCSPR";
  tx_hash?: string;
  // Issue #54 (Option A): the FOUR ledger statuses governed by ONE counted
  // predicate (isCountedSpend below — every accounting consumer reads it, no
  // consumer keeps a private copy of the status test):
  //   "success"              a 200 — counts (the pre-#54 rule, unchanged);
  //   "settled_unserved"     a non-200 WITH a decodable success receipt
  //                          carrying a tx hash — settlement evidence exists,
  //                          so the row counts permanently;
  //   "authorized_unserved"  a signed payload was sent WITHOUT settlement
  //                          evidence — the outcome is UNKNOWN, so the send
  //                          counts until the UTC day rollover (fail-closed
  //                          over-count);
  //   "failed"               nothing was signed/sent, or a clear
  //                          pre-settlement refusal — never counted.
  status: "success" | "failed" | "settled_unserved" | "authorized_unserved";
  error?: string;
  // The ISO instant an "authorized_unserved" row stops counting — LEGACY
  // READ ONLY. Rows written today carry no expires_at (the sent payment's
  // outcome is unknown, so the amount counts until the UTC day rollover);
  // rows written before the fail-closed change keep their old release
  // semantics on read: a past expires_at releases the row exactly as
  // before. Absent or unparseable, the row counts — the fail-closed
  // over-count direction: a signed-and-sent payment must never silently
  // un-count.
  expires_at?: string;
  // Issue #45: a refused (non-200) paid fetch row is self-describing — it
  // carries the HTTP status and the gateway's error string (or `HTTP <status>`
  // when the body is not JSON), reads amount_usdc as 0 because nothing
  // settled, and preserves the advertised price in attempted_amount_usdc.
  // Both fields are optional: rows written before #45 (and the intent-abort
  // catch rows) rehydrate and read exactly as before.
  http_status?: number;
  attempted_amount_usdc?: number;
  // Issue #53: the exact audit trail of the SIGNED amount on success rows —
  // the intent's atomic amount as a decimal string, its decimals, and the
  // offer's asset when known. `amount_usdc` remains the USD number the caps
  // read (single narrowing at the ledger boundary, usdFromAtomic).
  amount_atomic?: string;
  decimals?: number;
  asset?: string;
  // Issue #59 (D7): the exact CAIP-2 network the row settled on — a
  // DEVNET row's marker: its spend bucket is the network id itself, never the
  // chain vocabulary ("solana") that would merge it into the mainnet total.
  // Optional: rows written before #59 rehydrate into their chain's mainnet
  // bucket exactly as before (rehydrate tests pin this).
  network?: string;
}

// Issue #54 (req 3): the ledger location resolves through src/ledger-path.ts
// — one resolution shared by every reader/writer: an explicit PAYMENT_LOG_PATH
// wins outright (absolute, no legacy read), otherwise the state-dir primary
// (X402_STATE_DIR, default ~/.x402-agent-mcp) plus a read-only legacy
// working-directory ledger when one exists. Captured once at module load,
// mirroring the pre-#54 capture-at-load semantics.
const LEDGER = resolveLedger();
const LOG_PATH = LEDGER.primary;

// Track daily spending in memory
const dailySpentByChain = new Map<string, number>();
let dailyDate = new Date().toISOString().slice(0, 10);

// The MCP runs over stdio with per-session process lifetime, so the in-memory
// counter starts at $0 on every restart and MAX_DAILY_SPEND would never be
// cumulative. Rebuild today's spend from the ledger once, lazily, on first
// budget check.
let rehydrated = false;

/** Issue #59 (D7): the SPEND BUCKET of a ledger row. A DEVNET row's bucket
 * is its exact network id — separate from every mainnet chain bucket, and the
 * only new bucket the daily gate can see. A mainnet row (or any old row
 * without `network`) reads into its chain-vocabulary bucket exactly as
 * before. Rows whose network cannot be a devnet id fall back to the chain.
 * The per-service tracker (policy/budget-store.ts) keeps its host key — the
 * devnet boundary is the DAILY and reservation accounting, per D7. */
function spendBucketOf(entry: { chain: string; network?: string }): string {
  return entry.network === SOLANA_DEVNET_CAIP2 ? SOLANA_DEVNET_CAIP2 : entry.chain;
}

/** Issue #59/D7: the spend bucket for a NETWORK being paid on. Exactly the
 * devnet id returns the devnet bucket (a distinct key); everything else (the
 * mainnet networks, legacy asset-less offers) pays the mainnet buckets —
 * undefined at the global gate, exactly today's call. */
export function spendBucketForNetwork(network: string | undefined): string | undefined {
  return network === SOLANA_DEVNET_CAIP2 ? network : undefined;
}

/** Devnet's own daily total (issue #59/D7). The devnet bucket is read
 * through the same map; it is never part of getDailySpent()'s sum. */
export function getDevnetDailySpent(): number {
  return getDailySpent(SOLANA_DEVNET_CAIP2);
}

/** Issue #54 (Option A): THE counted-spend predicate — the single rule every
 * accounting consumer (ledger rehydration below, the in-process add in
 * logPayment, and policy/budget-store.ts rehydration) applies to a ledger
 * row. `nowMs` is the caller's clock (rehydration and the in-process add both
 * pass Date.now()).
 *
 * - "success" and "settled_unserved" count, permanently — settlement
 *   happened (the 200, or the receipt's tx evidence);
 * - "authorized_unserved": the payment was SENT but its outcome is unknown
 *   — it may have settled, so the fail-closed direction is over-count: the
 *   row counts for the whole UTC day it was written (today's rows carry no
 *   expires_at at all; the day's counter rolls over at midnight). A legacy
 *   row that still carries a parseable expires_at keeps its old release
 *   semantics and stops counting at that instant. A missing/unparseable
 *   expires_at always COUNTS — a sent payment never silently un-counts;
 * - "failed" (nothing signed/sent, or a clear pre-settlement refusal) and
 *   any unknown/legacy status never count. */
export function isCountedSpend(entry: { status?: string; expires_at?: string }, nowMs: number): boolean {
  switch (entry.status) {
    case "success":
    case "settled_unserved":
      return true;
    case "authorized_unserved": {
      const exp = entry.expires_at === undefined ? NaN : Date.parse(entry.expires_at);
      if (Number.isNaN(exp)) return true; // fail closed: no expiry, no silent un-count
      return nowMs < exp;
    }
    default:
      return false;
  }
}

function rehydrateFromLedger(): void {
  if (rehydrated) return;
  rehydrated = true; // set before any I/O — never double-read, even if read throws
  // Legacy first (read once, read-only), then the primary ledger — a
  // pre-upgrade working-directory ledger must still count toward today's
  // spend (an upgrade that dropped it would silently widen every cap that
  // reads these totals).
  for (const line of readLedgerLines(LEDGER.legacyReadOnly).concat(readLedgerLines(LOG_PATH))) {
    creditCountedLedgerRow(line);
  }
}

/** The per-row counting rule both rehydration and the recount apply — the
 * isCountedSpend predicate, same-day rows only, Casper excluded (its mote
 * budget is casper/budget.ts), bucketed by the row's spend bucket. */
function creditCountedLedgerRow(line: string): void {
  try {
    const entry = JSON.parse(line) as PaymentLogEntry;
    if (
      // Issue #54: the ONE counted-spend predicate — success and
      // settled_unserved count; a sent-but-unproven authorization counts
      // (its outcome is unknown; the day rollover ends the count, and only
      // a legacy row with a past expires_at releases); failed never counts.
      isCountedSpend(entry, Date.now()) &&
      entry.chain !== "casper" &&
      typeof entry.chain === "string" &&
      entry.timestamp.slice(0, 10) === dailyDate
    ) {
      // Issue #59 (D7): DEVNET rows bucket under their exact network id; old
      // rows (no `network` field) and every mainnet row read as the chain's
      // mainnet bucket — rehydration behavior unchanged.
      const bucket = spendBucketOf(entry);
      dailySpentByChain.set(bucket, (dailySpentByChain.get(bucket) ?? 0) + (entry.amount_usdc ?? 0));
    }
  } catch {
    // Corrupted ledger lines are skipped — logging is best-effort, so is reading it back
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
    dailySpentByChain.clear();
    dailyDate = today;
  }
}

/** Issue #54 (cap-parsing hardening): caps must fail CLOSED. A garbage
 * env value must never widen spend: today's `parseFloat("abc")` yields NaN
 * and `amount > NaN` is false, so a typo silently allowed every payment.
 * Only plain non-negative decimal strings are accepted (digits with an
 * optional .digits part — no sign, no exponent, no whitespace); anything else
 * logs one stderr line and reads as 0, denying all payments until the env is
 * fixed. Absent vars keep the documented fallbacks (zero behavior change for
 * ordinary operators). The policy layer's own defaults (policy/config.ts
 * legacyNumber) already fail closed on their side. The budget registry's #65
 * ceiling reader reuses this exact discipline, so it is exported. */
export function readCapUsd(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    console.error(
      `[x402] ${name}="${raw}" is not a plain non-negative decimal amount ` +
      `(digits with an optional . fraction) — failing closed: the cap reads 0 ` +
      `and every payment is denied until the environment is fixed`,
    );
    return 0;
  }
  return Number(raw);
}

export function getMaxPerCall(): number {
  return readCapUsd("MAX_PAYMENT_PER_CALL", 0.50);
}

export function getMaxDailySpend(): number {
  return readCapUsd("MAX_DAILY_SPEND", 10.00);
}

// ---------------------------------------------------------------------------
// Issue #62 (D4): the SDK's explicit spend controls need the per-call cap as
// an EXACT integer ATOMIC value per asset decimals (the SDK's
// allowedAssets[].maxAmountPerPayment field rejects a "$1"-style money
// string). Deriving that number from a float would drift; these helpers read
// the configured cap's DECIMAL STRING and scale with BigInt arithmetic only.
// ---------------------------------------------------------------------------

/** The cap as its configured decimal string, mirroring readCapUsd exactly:
 * absent → the same documented fallback expressed exactly; a malformed value
 * → "0" (the same fail-closed 0 that path produces — the cap reads 0 and
 * nothing is signed, the stderr line included in readCapUsd's first read). */
function capUsdExactString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+(\.\d+)?$/.test(raw)) return "0"; // mirrors readCapUsd's fail-closed 0
  return raw;
}

/** The per-call cap as its exact configured decimal string ("0.50" unless the
 * operator wrote a plain decimal — never a float round trip). */
export function getMaxPerCallExactUsdString(): string {
  return capUsdExactString("MAX_PAYMENT_PER_CALL", "0.50");
}

/** The daily cap as its exact configured decimal string ("10.00" unless the
 * operator wrote a plain decimal) — the budget registry #65 adapter reads it
 * for the USD rail's daily-cap listing. */
export function getMaxDailySpendExactUsdString(): string {
  return capUsdExactString("MAX_DAILY_SPEND", "10.00");
}

/** The per-call cap as an exact integer atomic value for an asset's decimals:
 * the LARGEST integer atomic amount whose USD value is still within the cap
 * (the same >cap boundary checkSpendingLimit refuses). BigInt arithmetic on
 * the configured decimal string — no float multiply ('0.50' at 6 decimals is
 * exactly 500000; a cap with more fraction digits than the asset has floors,
 * because only integer atomic amounts exist). Returns undefined outside the
 * decimals domain; a fail-closed cap of "0" stays 0 (the entry then caps
 * every atomic amount at 0 — nothing over an invalid cap is signed). */
export function getMaxPerCallAtomic(decimals: number): bigint | undefined {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return undefined;
  const usd = getMaxPerCallExactUsdString();
  const [whole, frac = ""] = usd.split(".");
  const atomicFraction = BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return BigInt(whole) * (10n ** BigInt(decimals)) + atomicFraction;
}

export function checkSpendingLimit(amountUsdc: number, spendBucket?: string): { allowed: boolean; reason?: string } {
  rehydrateFromLedger();
  resetDailyIfNewDay();

  // Issue #59 (D7): a DEVNET call reads the DEVNET bucket — its per-call and
  // daily caps are its own account, never the mainnet total. Every other
  // call (the mainnet networks, legacy paths) reads today's whole-map total.
  const dailySpent = spendBucket ? getDailySpent(spendBucket) : getDailySpent();
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
  // Issue #54 (req 3): rehydrate BEFORE the first in-memory success-add, not
  // after it. The one-shot ledger read must precede every in-memory row or a
  // getDailySpent() that arrives late (e.g. a first call after a write) would
  // merge the file's copy of rows that are already in memory — every restart
  // parity and in-process/restart comparison then diverges (rehydration must
  // read identical totals; the test catches it). Rehydrating in logPayment —
  // the only in-memory writer — makes the merge order safe: the first write
  // of a session always rehydrates an empty in-memory counter first. For
  // settled rows the merge order is unchanged (checks already rehydrated
  // before any payment leg in the real flow).
  rehydrateFromLedger();

  // Issue #54: the in-process add counts by the SAME predicate rehydration
  // filters by — a signed-and-sent unserved write counts immediately (for
  // the rest of the UTC day), a failed write never does; the in-memory
  // total always matches what a restart rehydrates from the same rows.
  if (isCountedSpend(entry, Date.now()) && entry.chain !== "casper") {
    // Issue #59 (D7): the same bucket rule as rehydration — a devnet write
    // lands in the devnet bucket immediately, never in the chain's total.
    const bucket = spendBucketOf(entry);
    dailySpentByChain.set(bucket, (dailySpentByChain.get(bucket) ?? 0) + (entry.amount_usdc ?? 0));
  }

  try {
    const line = JSON.stringify(entry) + "\n";
    // Issue #54: the state-dir ledger may live in a directory that does not
    // exist yet — mkdir -p before the first append.
    prepareLedgerDir(LOG_PATH);
    appendFileSync(LOG_PATH, line, { encoding: "utf-8" });
  } catch (err) {
    // Logging is best-effort — don't fail the payment if logging fails
    console.error(`[x402] Failed to log payment: ${err}`);
  }
}

export function getDailySpent(chain?: string): number {
  rehydrateFromLedger();
  resetDailyIfNewDay();
  // Issue #59 (D7): the whole-map SUM — the mainnet daily total the caps
  // read — EXCLUDES the devnet bucket (a devnet payment never moves it). The
  // explicit-bucket read (getDevnetDailySpent) is unaffected.
  return chain
    ? dailySpentByChain.get(chain) ?? 0
    : [...dailySpentByChain.entries()].filter(([bucket]) => bucket !== SOLANA_DEVNET_CAIP2).reduce((sum, [, val]) => sum + val, 0);
}

/** Test hook: zero the in-memory daily spend map (fresh-process simulation
 * between scenarios — getDailySpent would otherwise rehydrate the same
 * ledger). Not part of the runtime surface. */
export function _resetForTests(): void {
  for (const bucket of [...dailySpentByChain.keys()]) dailySpentByChain.delete(bucket);
}
// ---------------------------------------------------------------------------
// Issue #65: the USD rail registers itself in the budget registry as an
// ADAPTER over exactly this module's accounting — the same counters rehydrate
// from the ledger, the same caps fail closed; the registry duplicates nothing.
// The adapter reads every value LIVE per call (no env caching), and its USD
// rate is the pegged asset's 1 unless the operator configures
// X402_RATE_USDC_USD — there is no built-in override beyond the peg.
// ---------------------------------------------------------------------------

/** The USD rail's whole-map spend today: every settle bucket the ledger
 * tracks (mainnet chains AND the devnet bucket — the cross-chain ceiling is
 * an operator-set total across rails, so it must see every bucket; the
 * per-chain daily caps keep their own bucket rules unchanged). */
function usdRailSpentToday(): number {
  return getDailySpent() + getDevnetDailySpent();
}

// ---------------------------------------------------------------------------
// Issue #93 (A2): the USD rail lists the caps that ACTUALLY gate the next
// payment — the effective pair, not the raw legacy env values. The payment
// layer's gate reads the effective daily cap (reservations.effectiveDailyCapUsd:
// min MAX_DAILY_SPEND / the policy layer's payments.maxDaily, fail closed to 0
// on a broken configuration) and rule 6 binds the policy layer's
// payments.maxPerRequest the same way, while the rail's registry caps were the
// raw MAX_PAYMENT_PER_CALL / MAX_DAILY_SPEND readings — an operator running a
// profile or a policy file with lower caps saw x402_status and
// x402_check_payment display caps wider than what gates their next payment.
// The rail now renders min(env, policy) per call — LIVE, never cached, exactly
// like every cap here — so both surfaces report the same numbers. With the
// behavior-compat default policy the min is byte-identical to the env value
// (the default policy mirrors the legacy knobs), so this changes nothing for
// operators without a policy file; every other rail is untouched, and no
// enforcement path changes — the gates were already enforcing the effective
// caps; only the listings lagged.
// ---------------------------------------------------------------------------
function effectiveUsdCapParts(): { perCall: number; daily: number } {
  const state = loadPolicyConfig();
  if (state.configErrors.length > 0) {
    // Fail closed exactly like the reservation registry's effective cap: an
    // unusable configuration gates at 0 (the engine refuses every payment
    // with CONFIG_INVALID — the listing must not display a usable cap).
    return { perCall: 0, daily: 0 };
  }
  return {
    perCall: Math.min(getMaxPerCall(), state.config.payments.maxPerRequest),
    daily: Math.min(getMaxDailySpend(), state.config.payments.maxDaily),
  };
}

/** Exact integer atomic digit string from a USD float at 6 decimals — ONE
 * toFixed rounding at the display boundary (never a float multiply), then
 * integer string math (atomicStringFromUsdString). Display/registry use
 * only: the caps and the ceiling compare the float the accounting module
 * always compared. */
function atomicFromUsdNumber(usd: number, decimals: number): string {
  return atomicStringFromUsdString(exactUsdString(usd, decimals), decimals);
}

registerBudget({
  id: "usd",
  unit: "USDC",
  decimals: 6,
  perCallCap: () => {
    // Issue #93 (A2): the EFFECTIVE per-call cap (min env/policy) — the same
    // number rule 6 and the inner spending-limit check bind. Rendered through
    // the registry's exact display boundary (a USD float narrowed once via
    // toFixed(6), then integer atomic math — never a float multiply).
    const { perCall } = effectiveUsdCapParts();
    return { atomic: atomicStringFromUsdString(exactUsdString(perCall, 6), 6), decimals: 6 };
  },
  dailyCap: () => {
    // Issue #93 (A2): the EFFECTIVE daily cap (min env/policy) — the same
    // number the reservation registry (effectiveDailyCapUsd) and the policy
    // gate's rule 7 bind.
    const { daily } = effectiveUsdCapParts();
    return { atomic: atomicStringFromUsdString(exactUsdString(daily, 6), 6), decimals: 6 };
  },
  spentToday: () => ({ atomic: atomicFromUsdNumber(usdRailSpentToday(), 6), decimals: 6 }),
  spentUsdToday: () => usdRailSpentToday(),
  reservedToday: () => {
    // The USD rail's outstanding holds: the mainnet global scope plus the
    // devnet bucket's own scope (each hold is listed in one of them).
    const mainnet = reservedUsd("global");
    const devnet = reservedUsd(`net:${SOLANA_DEVNET_CAIP2}`);
    const total = mainnet + devnet;
    if (total <= 0) return null;
    return { atomic: atomicFromUsdNumber(total, 6), decimals: 6 };
  },
  persistence: "ledger-rehydrated",
  // The effective ledger location (issue #65 req 2): the same resolution the
  // counters rehydrate from, captured once at module load.
  ledgerPath: LOG_PATH,
  usdRate: () => resolveRailUsdRate("USDC", 1), // pegged: the table's price IS the peg
});
