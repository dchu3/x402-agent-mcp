import { readFileSync } from "fs";
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
  // Try multiple paths — works both in dev and when built
  const possiblePaths = [
    join(__dirname, "..", "..", "endpoints.json"),    // from dist/tools/
    join(__dirname, "..", "endpoints.json"),           // from dist/
    join(process.cwd(), "endpoints.json"),             // from project root
    "/home/derekchudley/projects/x402-agent-mcp/endpoints.json",  // absolute fallback
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