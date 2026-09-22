import { readFileSync, writeFileSync, renameSync, rmSync } from "fs";
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

export function loadDirectory(): EndpointDirectory {
  if (cachedDirectory) return cachedDirectory;
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