// Issue #50 guard: the agent-visible url argument description of x402_fetch
// must not name svm402 routes that are retired (the service rotates its paid
// routes), and must not claim a fixed "one paid route"; it must still carry a
// live-shaped https:// example and point the agent at how to find the CURRENT
// route (/.well-known/x402 or /llms.txt). Captured exactly as agents receive
// it — via the same fake-McpServer pattern used in fetch.test.ts:35-39.
import { strict as assert } from 'node:assert';
import { after, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic ledger + directory BEFORE importing fetch.js (fetch.test.ts
// pattern) so module-load side effects stay off the repo root.
const dir = mkdtempSync(join(tmpdir(), 'x402-fetch-desc-test-'));
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
process.env.X402_DIRECTORY_PATH = join(dir, 'endpoints.json');
writeFileSync(process.env.X402_DIRECTORY_PATH, JSON.stringify({ endpoints: [], categories: [], last_updated: '2026-10-19' }), 'utf8');

const { registerFetchTool } = await import('./fetch.js');

// Capture the registered (name, description, schema) triple.
const captured: { name: string; description: string; schema: any } = { name: '', description: '', schema: null };
registerFetchTool({
  tool: (name: unknown, description: unknown, schema: unknown, _fn: unknown) => {
    captured.name = name as string;
    captured.description = description as string;
    captured.schema = schema as any;
  },
} as any);

const urlDescription: string = captured.schema.url?.description ?? '';

after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

it('x402_fetch url description is route-agnostic: no retired svm402 route names, a live-shaped https:// example, and the well-known/llms.txt hint (#50)', () => {
  assert.equal(captured.name, 'x402_fetch', 'the registered tool must be x402_fetch');
  const low = urlDescription.toLowerCase();
  for (const dead of ['/check', '/holdcheck', '/price']) {
    assert.ok(
      !low.includes(dead),
      `url description must not name retired svm402 route "${dead}" (issue #50: paths rotate) — got: ${urlDescription}`,
    );
  }
  assert.ok(
    !low.includes('verdict'),
    `url description must not claim a fixed "verdict" route (issue #50) — got: ${urlDescription}`,
  );
  assert.ok(
    !/one\s+paid\b[\s\S]{0,48}\broute\b/.test(low),
    `url description must not claim "one paid ... route" (issue #50: routes rotate) — got: ${urlDescription}`,
  );
  assert.ok(
    /https:\/\/\S+/.test(urlDescription),
    `url description must still carry an https:// example URL — got: ${urlDescription}`,
  );
  assert.ok(
    /(\.well-known|llms\.txt)/.test(low),
    `url description must point at how to find the current route (/.well-known/x402 or /llms.txt) — got: ${urlDescription}`,
  );
});