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

const server = new McpServer({
  name: "x402-agent-mcp",
  version: "1.3.0",
});

// Register tools
registerSearchTool(server);
registerListCategoriesTool(server);
registerDescribeTool(server);
registerDiscoverUrlTool(server);
registerHealthCheckTool(server);
registerBatchDiscoverTool(server);
registerCrawlX402ScanTool(server);
registerFetchTool(server);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);