import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { registerDiscoverUrlTool } from './discover-url.js';
import { registerProbeAllowlistTool } from './probe-allowlist.js';
import { registerBatchDiscoverTool } from './batch-discover.js';
import { registerCrawlX402ScanTool } from './crawl-directory.js';

// ---------------------------------------------------------------------------
// Issue #67 req 7 (acceptance test 7) — tool-description snapshot: EVERY
// discovery surface must state plainly that discovery only records what a
// service advertises; it never makes the host payable. The allowlist and the
// payment policy still decide, and no discovery tool ever pays.
//
// A caller (or an agent) reading only the tool description must come away
// knowing that a discovered/probed/recorded host is NOT thereby payable —
// x402_fetch's policy gate and allowlist govern every paid leg.
// ---------------------------------------------------------------------------

function captureDescription(register: (server: any) => void): { name: string; description: string } {
  const captured: { name: string; description: string } = { name: '', description: '' };
  register({ tool: (name: unknown, description: unknown) => { captured.name = String(name); captured.description = String(description); } } as any);
  return captured;
}

const discoveryToolNames = ['x402_discover_url', 'x402_discover_urls', 'x402_crawl_directory', 'x402_probe_allowlist'] as const;

it('every discovery tool description states that discovery does not make the host payable', async () => {
  const captured = Object.fromEntries(discoveryToolNames.map((name) => {
    const { name: registered, description } = captureDescription(
      name === 'x402_discover_url' ? registerDiscoverUrlTool
      : name === 'x402_discover_urls' ? registerBatchDiscoverTool
      : name === 'x402_crawl_directory' ? registerCrawlX402ScanTool
      : registerProbeAllowlistTool,
    );
    assert.equal(registered, name, `${name} must be the registered tool name`);
    return [name, description];
  }));

  for (const name of discoveryToolNames) {
    const description = captured[name];
    assert.ok(description.length > 0, `${name} description captured`);
    // Issue #67 req 7: the plain statement that discovery records an
    // advertisement — it does not make the host payable.
    assert.match(
      description,
      /only records what a service advertises/i,
      `${name} must state discovery only records what the service advertises`,
    );
    assert.match(
      description,
      /never makes it payable/i,
      `${name} must state discovery never makes the host payable`,
    );
    // The allowlist and the policy still decide.
    assert.match(
      description,
      /allowlist and the payment policy still decide/i,
      `${name} must say the allowlist and the policy still decide`,
    );
    assert.match(
      description,
      /never pays/i,
      `${name} must keep its never-pays statement`,
    );
  }
});