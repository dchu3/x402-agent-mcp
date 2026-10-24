import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSearchTool } from "./tools/search.js";
import { registerFetchTool } from "./tools/fetch.js";
import { registerDescribeTool } from "./tools/describe.js";
import { registerListCategoriesTool } from "./tools/categories.js";
import { registerDiscoverUrlTool } from "./tools/discover-url.js";
import { registerHealthCheckTool } from "./tools/health.js";
import { registerBatchDiscoverTool } from "./tools/batch-discover.js";
import { registerCrawlX402ScanTool } from "./tools/crawl-directory.js";
import { registerCheckPaymentTool } from "./tools/check-payment.js";
import { registerProbeAllowlistTool } from "./tools/probe-allowlist.js";
// Issue #59 (req 8 — C9 visibility): the run's EXPLICIT network mode + the
// mode's Solana RPC host render at startup (the RPC HOST only — never a full
// URL, one could carry credentials).
import { resolveNetworkMode, solanaRpcUrlForMode } from "./networks.js";
import { assetTableSummary } from "./assets.js";
import { VERSION } from "./version.js";

const server = new McpServer({
  name: "x402-agent-mcp",
  version: VERSION,
});

// Register tools
registerSearchTool(server);
registerListCategoriesTool(server);
registerDescribeTool(server);
registerDiscoverUrlTool(server);
registerHealthCheckTool(server);
registerBatchDiscoverTool(server);
registerCrawlX402ScanTool(server);
registerCheckPaymentTool(server);
registerProbeAllowlistTool(server);
registerFetchTool(server);

// Start server
// Issue #59 (req 8): the startup log — the operator sees the run's mode and
// network identity exactly once, on stderr (stdout is the MCP protocol).
// When the mode is unset over a loaded key, the same line names the
// NETWORK_NOT_CONFIGURED condition the paid tool refuses with.
const networkModeState = resolveNetworkMode();
const networkModeForLog = networkModeState.mode ?? "(unset)";
const solanaRpcHost = networkModeState.mode
  ? new URL(solanaRpcUrlForMode(networkModeState.mode)).hostname
  : "";
const assetTable = assetTableSummary();
console.error(
  `x402-agent-mcp v${VERSION} | network_mode=${networkModeForLog}` +
  (networkModeState.error ? ` — NETWORK_NOT_CONFIGURED: paid tools refuse until X402_NETWORK_MODE is set` : "") +
  ` | solana_rpc_host=${solanaRpcHost || "(inactive)"}` +
  ` | assets=${assetTable.table_entries} entries on [${assetTable.networks.join(", ")}]`,
);

const transport = new StdioServerTransport();
await server.connect(transport);