import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Persistence model (#18.3):
// - Single-process ownership: the directory file is written by this process
//   only. There is no file lock and no cross-process coordination — two MCP
//   instances sharing one endpoints.json operate last-writer-wins and will
//   silently overwrite each other's additions. Multi-instance deployments
//   should give each instance its own X402_DIRECTORY_PATH.
// - Atomic writes: every write goes to a temp file in the destination
//   directory followed by renameSync — atomic on POSIX — so a crash mid-write
//   can never leave a truncated or half-written endpoints.json.
// - Corrupt recovery: if the live file exists but cannot be parsed into a
//   directory shape, it is quarantined as endpoints.json.corrupt-<timestamp>
//   (evidence preserved verbatim) and the MCP continues with an empty
//   directory instead of crashing. Corrupt data is never silently overwritten.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface EndpointEntry {
  name: string;
  description: string;
  base_url: string;
  chain: string;
  category: string;
  tags: string[];
  endpoints: Array<{
    path: string;
    method: string;
    price_usdc: string;
    description: string;
  }>;
  well_known?: Record<string, string>;
  /** Provenance metadata (#18.2/#18.7 — baseline for #19's trust levels):
   * "seed" = operator-curated baseline entries; "discovery" = entries added
   * by x402_crawl_directory. Entries added through other paths may omit it
   * and are treated as unclassified by the #19 policy engine. */
  source?: string;
  /** Issue #34 (L4): the entry's MOST RECENT liveness probe record, written
   * by x402_probe_allowlist via recordLiveness. Consumed by x402_search
   * (ranking + emitted liveness metadata) and by the policy liveness gate
   * (rule 4.7). Absent means never probed. */
  liveness?: LivenessRecord;
}

/** The most recent liveness probe for a directory entry (issue #34, L4 —
 * per entry, singular). `accepts` is present ONLY when the probe answered 402
 * with a parseable accepts array (never invented on no_402/error). */
export interface LivenessRecord {
  /** ISO timestamp of the probe. */
  probed_at: string;
  status: "live_402" | "no_402" | "error";
  latency_ms: number;
  /** The exact URL the probe hit (the entry's base_url, or a pinned
   * allowlist path under it). */
  probe_url: string;
  accepts?: Array<{ scheme?: string; network?: string; amount?: string; payTo?: string; asset?: string }>;
}

export interface EndpointDirectory {
  endpoints: EndpointEntry[];
  categories: string[];
  last_updated: string;
}

let cachedDirectory: EndpointDirectory | null = null;

// Directory path resolution order (X402_DIRECTORY_PATH env override first —
// set this in tests/sandboxes so the operator's live endpoints.json is never touched):
//   1. X402_DIRECTORY_PATH env override
//   2. <repo>/endpoints.json (from dist/ → project root)
//   3. process.cwd()/endpoints.json
function livePaths(): string[] {
  return [
    ...(process.env.X402_DIRECTORY_PATH ? [process.env.X402_DIRECTORY_PATH] : []),
    join(__dirname, "..", "endpoints.json"),       // from dist/ → project root
    join(process.cwd(), "endpoints.json"),          // from project root
  ];
}

/** Clear the in-memory directory cache (used by tests between cases). */
export function clearDirectoryCache(): void {
  cachedDirectory = null;
}

let tmpSeq = 0;

/** Write data to p atomically: temp file in the same directory (same
 * filesystem — required for atomic rename), then renameSync over the target.
 * On failure the temp file is removed so no partial artifacts remain.
 * Exported for the atomicity smoke tests. */
export function atomicWriteFileSync(p: string, data: string): void {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`;
  try {
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, p);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function emptyDirectory(): EndpointDirectory {
  return { endpoints: [], categories: [], last_updated: new Date().toISOString().slice(0, 10) };
}

/** Parse a directory file, tolerating absent categories/last_updated but
 * refusing anything without an endpoints array (that would crash addToDirectory). */
function parseDirectory(raw: string, source: string): EndpointDirectory | null {
  try {
    const parsed = JSON.parse(raw) as Partial<EndpointDirectory> | null;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.endpoints)) {
      console.error(`[x402] ${source} is not a valid endpoints directory (missing endpoints array)`);
      return null;
    }
    return {
      endpoints: parsed.endpoints,
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      last_updated: typeof parsed.last_updated === "string" ? parsed.last_updated : new Date().toISOString().slice(0, 10),
    };
  } catch (err) {
    console.error(`[x402] ${source} is not valid JSON: ${err}`);
    return null;
  }
}

let quarantineSeq = 0;

/** Move a corrupt directory file aside, preserving the evidence. Best-effort:
 * never throws — recovering to an empty directory matters more than the rename. */
function quarantineCorruptFile(p: string): void {
  try {
    const quarantined = `${p}.corrupt-${Date.now()}-${++quarantineSeq}`;
    renameSync(p, quarantined);
    console.error(`[x402] ${p} was corrupt; quarantined as ${quarantined}; continuing with an empty directory`);
  } catch (err) {
    console.error(`[x402] ${p} was corrupt and could not be quarantined: ${err}`);
  }
}

/** Issue #37 structural guard: a test run must never read the operator's
 * LIVE, gitignored endpoints.json — the operator's real data, not fixture
 * data (the casper-fetch suite went red exactly this way: it set no
 * X402_DIRECTORY_PATH override, so the #34 liveness gate evaluated the live
 * file's FAILED seed row and hard-DENYed before any assertion ran).
 *
 * Throws when ALL of the following hold:
 *   (a) the current process is under the node:test runner —
 *       `process.env.NODE_TEST_CONTEXT` is set (production/MCP runtime never
 *       sets it, and a direct `node file.js` run leaves it unset, so the
 *       guard is inert outside test runs);
 *   (b) no X402_DIRECTORY_PATH override is in effect;
 *   (c) at least one candidate path EXISTS on disk.
 *
 * `opts` overrides the env-derived defaults so the guard is directly
 * unit-testable without child processes (see directory.test.ts).
 *
 * Remediation (named in the thrown message): tests that reach the directory
 * MUST set X402_DIRECTORY_PATH to a temp path — the repo test pattern (see
 * src/tools/fetch.test.ts).
 *
 * Pure-ish: reads env + existsSync/realpathSync only; no writes, never
 * mutates the directory cache, and never throws from the de-dup step. The
 * only side effect is ONE stderr line at the throw point so a firing stays
 * visible in test output even when a caller catches the throw. */
export function guardLiveDirectoryRead(
  candidates: string[],
  opts?: { isTestRun?: boolean; override?: string },
): void {
  const isTestRun = opts?.isTestRun ?? Boolean(process.env.NODE_TEST_CONTEXT);
  const override = opts?.override ?? process.env.X402_DIRECTORY_PATH;
  if (!isTestRun) return; // production / MCP runtime / direct node run: inert
  if (override) return; // a hermetic override is in effect
  // livePaths() items 2-3 (dist-relative and cwd-relative) can resolve to the
  // SAME file; de-duplicate by realpath so one existing file is reported once.
  // Best-effort: a failed lookup keeps the raw path and never throws here.
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let key = candidate;
    try {
      key = realpathSync(candidate);
    } catch {
      // missing or unreadable — keep the raw path as the de-dup key
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync(candidate)) {
      const message =
        `[x402] test-run guard: this test run is about to read the operator's LIVE endpoints.json at ${candidate} ` +
        `without an X402_DIRECTORY_PATH override. Tests that reach the directory MUST set X402_DIRECTORY_PATH ` +
        `to a temp path (see src/tools/fetch.test.ts for the pattern) — issue #37.`;
      // One stderr echo at the throw point (issue #37 canary finding): some
      // read paths swallow this throw — computeEndpointLiveness
      // (src/policy/config.ts:752-775) catches it and returns a fail-open
      // verdict when liveness.allowlist is omitted — so a firing must stay
      // visible in test output even when a caller catches it. The thrown
      // message itself is unchanged.
      console.error(message);
      throw new Error(message);
    }
  }
}

export function loadDirectory(): EndpointDirectory {
  if (cachedDirectory) return cachedDirectory;
  // Issue #37: before ANY file read, refuse (loudly) when a test run without
  // an X402_DIRECTORY_PATH override would touch the operator's live
  // repo-root endpoints.json. Inert in production (no NODE_TEST_CONTEXT),
  // inert in every suite that sets the override, and inert when the live
  // file is absent (clean checkout) — see guardLiveDirectoryRead. Checked
  // after the cache test: a cache hit performs no read, so it must not fire.
  guardLiveDirectoryRead([join(__dirname, "..", "endpoints.json")]);
  // Try live file first, then template
  const searchPaths = livePaths();
  const templatePaths = [
    join(__dirname, "..", "endpoints.example.json"),
    join(process.cwd(), "endpoints.example.json"),
  ];

  // Try live file first
  for (const p of searchPaths) {
    let raw: string;
    try {
      raw = readFileSync(p, "utf-8");
    } catch {
      continue; // missing or unreadable — try the next candidate location
    }
    const parsed = parseDirectory(raw, p);
    if (parsed) {
      cachedDirectory = parsed;
      return cachedDirectory;
    }
    // File exists but is unreadable/corrupt: preserve the evidence and keep
    // the MCP alive (#18.3). Deliberately do NOT fall through to the template
    // — that would silently discard operator data.
    quarantineCorruptFile(p);
    cachedDirectory = emptyDirectory();
    return cachedDirectory;
  }

  // Fall back to template, then copy it to live file
  for (const p of templatePaths) {
    try {
      const raw = readFileSync(p, "utf-8");
      cachedDirectory = parseDirectory(raw, p) ?? emptyDirectory();
      // Create live file from template so future writes go to the right place
      for (const lp of searchPaths) {
        try {
          atomicWriteFileSync(lp, raw);
          break;
        } catch {
          continue;
        }
      }
      return cachedDirectory;
    } catch {
      continue;
    }
  }
  throw new Error("endpoints.json not found in any expected location");
}

/** Advertised USD price for a URL's endpoint path (issue #30): hostname +
 * pathname match against the directory's endpoints[].price_usdc — the same
 * match rule x402_check_payment used to inline. Pure read over the in-memory
 * cached directory: no network I/O. Any error (unparseable URL, directory
 * unavailable, malformed entry) ⇒ undefined — never throws, never guesses. */
export function advertisedPriceUsd(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const directory = loadDirectory();
    for (const entry of directory.endpoints) {
      try {
        if (new URL(entry.base_url).hostname.toLowerCase() !== host) continue;
        const match = entry.endpoints.find((e) => {
          const ePath = e.path.startsWith("/") ? e.path : `/${e.path}`;
          return ePath === parsed.pathname;
        });
        if (match && match.price_usdc) {
          const price = Number(match.price_usdc);
          if (Number.isFinite(price) && price >= 0) return price;
        }
      } catch {
        continue; // malformed base_url can never match — skip the entry
      }
    }
    return undefined;
  } catch {
    return undefined; // unparseable URL or directory unavailable
  }
}

/** Origin-based directory lookup (issue #34): find the entry whose base_url
 * ORIGIN (scheme://host, default ports normalised, case-insensitive) matches
 * the target URL's origin. Unparseable input URLs and malformed entry
 * base_urls never match; a directory-load failure yields undefined instead of
 * throwing — this helper sits on the policy/search read paths and must not
 * crash them. */
export function findEntryForUrl(url: string): EndpointEntry | undefined {
  try {
    const target = new URL(url);
    const directory = loadDirectory();
    for (const entry of directory.endpoints) {
      try {
        if (new URL(entry.base_url).origin === target.origin) return entry;
      } catch {
        continue; // malformed entry base_url can never match — skip
      }
    }
    return undefined;
  } catch {
    return undefined; // unparseable URL or directory unavailable
  }
}

/** Record an entry's latest liveness probe (issue #34, L4). Locates the entry
 * by base_url ORIGIN match (same rule as findEntryForUrl), mutates the cached
 * directory, and writes it back atomically (atomicWriteFileSync over
 * livePaths(), exactly like addToDirectory — the X402_DIRECTORY_PATH override
 * is consulted first). Returns false when no entry matches the origin (the
 * probe result is dropped; nothing is written). */
export function recordLiveness(baseUrl: string, record: LivenessRecord): boolean {
  const entry = findEntryForUrl(baseUrl);
  if (!entry) return false;
  entry.liveness = record;
  const dir = loadDirectory();
  const possiblePaths = livePaths();
  for (const p of possiblePaths) {
    try {
      atomicWriteFileSync(p, JSON.stringify(dir, null, 2) + "\n");
      return true;
    } catch {
      continue;
    }
  }
  throw new Error("Could not write to endpoints.json");
}

export function addToDirectory(entry: EndpointEntry): boolean {
  const dir = loadDirectory();
  // Check if already exists (by base_url or name)
  const exists = dir.endpoints.some(
    (e) => e.base_url === entry.base_url || e.name.toLowerCase() === entry.name.toLowerCase()
  );
  if (exists) return false; // already in directory

  // Add new entry
  dir.endpoints.push(entry);

  // Add category if new
  if (!dir.categories.includes(entry.category)) {
    dir.categories.push(entry.category);
  }

  // Write back to file (X402_DIRECTORY_PATH override consulted first)
  const possiblePaths = livePaths();
  for (const p of possiblePaths) {
    try {
      atomicWriteFileSync(p, JSON.stringify(dir, null, 2) + "\n");
      return true;
    } catch {
      continue;
    }
  }
  throw new Error("Could not write to endpoints.json");
}