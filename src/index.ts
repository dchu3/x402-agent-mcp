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
// Issue #65 (req 2): the free budget listing — every registered rail's caps,
// spend and persistence, plus the optional cross-chain ceiling state.
import { registerStatusTool } from "./tools/status.js";
// Issue #67 (#67's free inspector): run the paid flow's exact selection
// wiring over a supplied offer and report every verdict — never pays.
import { registerInspectTool } from "./tools/inspector.js";
// Issue #59 (req 8 — C9 visibility): the run's EXPLICIT network mode + the
// mode's Solana RPC host render at startup (the RPC HOST only — never a full
// URL, one can carry credentials; a non-URL value must never crash startup).
import { resolveNetworkMode, solanaRpcHostForMode } from "./networks.js";
import { assetTableSummary } from "./assets.js";
// Issue #66 (stage A, req 1/4): the startup log names the active policy
// profile, and with the permissive default a second line warns that unknown
// services are payable up to the global caps and names the tightening
// switch. DEFAULT_POLICY_PROFILE is what the warning keys on.
import { DEFAULT_POLICY_PROFILE, resolvePolicyProfile } from "./policy/profile.js";
import { VERSION } from "./version.js";
// Issue #80 (R1d): startup fail-fast on an invalid timeout configuration —
// the parsers fail closed (RangeError) at CALL time; validating them here, on
// startup, instead of mid-flow (pre-#80 they only surfaced per-call inside
// the paid leg's generic payment failure).
import { paidTimeoutMs, probeTimeoutMs } from "./transport/replay.js";

for (const validateTimeoutConfig of [paidTimeoutMs, probeTimeoutMs]) {
  try {
    validateTimeoutConfig(process.env);
  } catch (err) {
    if (err instanceof RangeError) {
      // Fixed message naming the variable (the RangeError text already does);
      // refusal BEFORE any server construction, key handling or network.
      console.error(`x402-agent-mcp: refusing to start — invalid timeout configuration: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

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
registerStatusTool(server);
registerInspectTool(server);
registerFetchTool(server);

// Start server
// Issue #59 (req 8): the startup log — the operator sees the run's mode and
// network identity exactly once, on stderr (stdout is the MCP protocol).
// When the mode is unset over a loaded key, the same line names the
// NETWORK_NOT_CONFIGURED condition the paid tool refuses with.
const networkModeState = resolveNetworkMode();
const networkModeForLog = networkModeState.mode ?? "(unset)";
const solanaRpcHost = networkModeState.mode
  ? solanaRpcHostForMode(networkModeState.mode)
  : "";
const assetTable = assetTableSummary();
// Issue #66 (stage A): the same env-time resolution loadPolicyConfig uses —
// the log line never disagrees with the engine state built from it.
const activeProfile = resolvePolicyProfile();
console.error(
  `x402-agent-mcp v${VERSION} | network_mode=${networkModeForLog}` +
  (networkModeState.error ? ` — NETWORK_NOT_CONFIGURED: paid tools refuse until X402_NETWORK_MODE is set` : "") +
  ` | solana_rpc_host=${solanaRpcHost || "(inactive)"}` +
  ` | assets=${assetTable.table_entries} entries on [${assetTable.networks.join(", ")}]` +
  ` | policy_profile=${activeProfile.profile}`,
);
// Issue #66 (stage A, req 4): the permissive default is TODAY's behavior, so
// it must be announced, not silent — unknown services are payable up to the
// global caps, and X402_POLICY_PROFILE=strict|standard is the shipped
// tightening switch. One extra stderr line, visible exactly once at startup.
// (Stage B/C — flipping the DEFAULT — is a later release; this warning is
// the "A now" half of the recorded A+B blend.)
if (activeProfile.profile === DEFAULT_POLICY_PROFILE) {
  console.error(
    `policy_profile=permissive: unknown services are payable up to the global caps — tighten with X402_POLICY_PROFILE=strict or X402_POLICY_PROFILE=standard (a POLICY_CONFIG_PATH file overrides the profile)`,
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);