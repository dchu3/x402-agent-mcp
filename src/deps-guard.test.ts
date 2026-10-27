import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Issue #98: the production dependency tree must contain ONLY zod versions
// fixed against GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6, high, CWE-770). The fix is
// the package.json `overrides: { "zod": "^4.6.7" }` entry, which resolves the
// WHOLE tree to one fixed zod; these tests guard the RESULT of the install,
// independent of how npm happens to nest or dedupe packages on a future
// install (the vendor pins that caused the nested zod@3.25.76 copies —
// @x402/core and @x402/evm — still declare `zod: ^3.24.2`, so a naive bump
// would regress this silently).
//
// Hermetic: a bounded walk over the installed node_modules reading
// package.json manifests only — no `npm ls` shell-out (slow and glob-fragile
// in CI), no network, no registry.
// ---------------------------------------------------------------------------

const REPO = join(import.meta.dirname, '..');
const NODE_MODULES = join(REPO, 'node_modules');

// The GHSA-mrhx-c7xc-m3w5 fix version: zod 4.6.6. The override pins ^4.6.7
// (the current release at fix time); the floor here stays at the fixed
// version so the guard tracks the advisory, not the pin.
const FLOOR = { major: 4, minor: 6, patch: 6 } as const;

type Semver = { major: number; minor: number; patch: number };

function parseVersion(v: string): Semver {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  assert.ok(m, `unparseable zod version: ${JSON.stringify(v)}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function atLeastFloor(v: Semver): boolean {
  if (v.major !== FLOOR.major) return v.major > FLOOR.major;
  if (v.minor !== FLOOR.minor) return v.minor > FLOOR.minor;
  return v.patch >= FLOOR.patch;
}

type ZodCopy = { path: string; version: string };

// Every installed zod copy, found by walking node_modules itself (including
// nested `node_modules` inside packages). A directory only counts as zod when
// its manifest names the package "zod" with a version — arbitrary `zod/`
// subdirectories inside other packages (e.g. abitype's export shim, which has
// a package.json with no name/version) must be ignored.
function installedZodCopies(): ZodCopy[] {
  const found: ZodCopy[] = [];
  // The queue mixes node_modules levels and @scope levels; both enumerate
  // package directories, whose children are handled uniformly below.
  const queue: string[] = [NODE_MODULES];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // a path vanished mid-walk (concurrent install): not a tree defect
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgDir = join(dir, entry.name);
      if (entry.name.startsWith('@')) {
        queue.push(pkgDir);
        continue;
      }
      const manifest = join(pkgDir, 'package.json');
      if (entry.name === 'zod' && existsSync(manifest)) {
        try {
          const pkg = JSON.parse(readFileSync(manifest, 'utf-8')) as { name?: string; version?: string };
          if (pkg.name === 'zod' && typeof pkg.version === 'string') {
            found.push({ path: relative(REPO, pkgDir), version: pkg.version });
          }
        } catch {
          assert.fail(`unreadable manifest at ${relative(REPO, pkgDir)} — a corrupt install must fail the guard for review`);
        }
      }
      const nested = join(pkgDir, 'node_modules');
      if (existsSync(nested)) queue.push(nested);
    }
  }
  return found;
}

// The vendor chain that historically carried the vulnerable nested copies:
// nested zod@3.25.76 under @x402/core@2.15.0 (via casper-x402), @x402/core@2.26.0
// and @x402/evm@2.26.0 (via @x402/evm). A regression re-lands HERE first.
const SDK_CHAIN_PACKAGES = [
  'node_modules/@make-software/casper-x402',
  'node_modules/@x402/core',
  'node_modules/@x402/evm',
  'node_modules/@x402/fetch',
  'node_modules/@x402/svm',
];

it('#98: every installed zod copy is fixed against GHSA-mrhx-c7xc-m3w5 (>= 4.6.6) — the whole tree resolves to one zod', () => {
  const copies = installedZodCopies();
  assert.ok(
    copies.length > 0,
    'no installed zod found — the guard must see at least the root copy (node_modules/zod); if node_modules is missing, install first',
  );
  const stale = copies.filter((c) => !atLeastFloor(parseVersion(c.version)));
  assert.deepEqual(
    stale,
    [],
    `vulnerable zod copy(ies) installed (< ${FLOOR.major}.${FLOOR.minor}.${FLOOR.patch}, GHSA-mrhx-c7xc-m3w5): ` +
      stale.map((c) => `${c.path}@${c.version}`).join(', ') +
      ' — package.json overrides must keep the whole tree on a fixed zod',
  );
  const versions = new Set(copies.map((c) => c.version));
  assert.ok(
    versions.size === 1,
    `expected ONE resolved zod version across the tree, got ${[...versions].sort().join(' and ')} — dedupe drift, review the overrides pin`,
  );
});

it('#98: no nested zod copy re-lands inside the @x402 SDK vendor chain', () => {
  const nested = installedZodCopies().filter((c) =>
    SDK_CHAIN_PACKAGES.some((prefix) => c.path.startsWith(prefix + '/node_modules/')),
  );
  assert.deepEqual(
    nested,
    [],
    'nested zod copy(ies) reappeared inside the @x402 SDK chain (previously zod@3.25.76 under @x402/core and @x402/evm): ' +
      nested.map((c) => `${c.path}@${c.version}`).join(', '),
  );
});