// Single source of truth for the MCP server version (#18.1). src/index.ts and
// package.json must both derive from this constant; src/version.test.ts fails
// if package.json ever drifts again.
export const VERSION = "1.3.0";