import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

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
}

export interface EndpointDirectory {
  endpoints: EndpointEntry[];
  categories: string[];
  last_updated: string;
}

let cachedDirectory: EndpointDirectory | null = null;

export function loadDirectory(): EndpointDirectory {
  if (cachedDirectory) return cachedDirectory;
  const possiblePaths = [
    join(__dirname, "..", "endpoints.json"),       // from dist/ → project root
    join(process.cwd(), "endpoints.json"),          // from project root
    "/home/derekchudley/projects/x402-agent-mcp/endpoints.json",
  ];
  for (const p of possiblePaths) {
    try {
      const raw = readFileSync(p, "utf-8");
      cachedDirectory = JSON.parse(raw) as EndpointDirectory;
      return cachedDirectory;
    } catch {
      continue;
    }
  }
  throw new Error("endpoints.json not found in any expected location");
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

  // Write back to file
  const possiblePaths = [
    join(__dirname, "..", "endpoints.json"),       // from dist/ → project root
    join(process.cwd(), "endpoints.json"),          // from project root
    "/home/derekchudley/projects/x402-agent-mcp/endpoints.json",
  ];
  for (const p of possiblePaths) {
    try {
      writeFileSync(p, JSON.stringify(dir, null, 2) + "\n", "utf-8");
      return true;
    } catch {
      continue;
    }
  }
  throw new Error("Could not write to endpoints.json");
}