import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the directory in a temp dir BEFORE importing directory.js,
// following the PAYMENT_LOG_PATH pattern in casper-fetch.test.ts.
const dir = mkdtempSync(join(tmpdir(), 'x402-directory-test-'));
const overridePath = join(dir, 'endpoints.json');
const env = { ...process.env };
process.env.X402_DIRECTORY_PATH = overridePath;

const { addToDirectory, loadDirectory, clearDirectoryCache, atomicWriteFileSync } = await import('./directory.js');

// endpoints.json at the repo root is gitignored operator data; its absence
// (clean checkout) is the normal case. Snapshot it once at module load if it
// exists so every test below can assert — unconditionally — that the flow
// never creates it, deletes it, or changes its contents.
const REPO_ROOT_ENDPOINTS = join(import.meta.dirname, '..', 'endpoints.json');
const repoRootSnapshot = existsSync(REPO_ROOT_ENDPOINTS)
  ? createHash('md5').update(readFileSync(REPO_ROOT_ENDPOINTS)).digest('hex')
  : null;

function assertRepoRootUntouched(): void {
  if (!existsSync(REPO_ROOT_ENDPOINTS)) {
    assert.equal(repoRootSnapshot, null, 'repo-root endpoints.json must not be created or deleted by the flow');
    return;
  }
  assert.ok(repoRootSnapshot !== null, 'repo-root endpoints.json must not be created by the flow');
  assert.equal(
    createHash('md5').update(readFileSync(REPO_ROOT_ENDPOINTS)).digest('hex'),
    repoRootSnapshot,
    'repo-root endpoints.json must not be modified'
  );
}

const template = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'endpoints.example.json'), 'utf-8'));

const entry = {
  name: 'IsolationTestSvc',
  description: 'test',
  base_url: 'https://isolation-test.invalid',
  chain: 'base',
  category: 'test',
  tags: [],
  endpoints: [{ path: '/x', method: 'GET', price_usdc: '0.01', description: 'd' }],
};

afterEach(() => {
  clearDirectoryCache();
  process.env = { ...env, X402_DIRECTORY_PATH: overridePath };
  if (existsSync(overridePath)) rmSync(overridePath);
});
after(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

it('addToDirectory with override writes to override path only, not repo root', () => {
  writeFileSync(overridePath, JSON.stringify(template, null, 2) + '\n');
  assert.equal(addToDirectory(entry), true);
  const written = JSON.parse(readFileSync(overridePath, 'utf-8'));
  assert.equal(written.endpoints.length, 1);
  assert.equal(written.endpoints[0].base_url, 'https://isolation-test.invalid');
  assertRepoRootUntouched();
});

it('loadDirectory with override reads the override file first', () => {
  writeFileSync(overridePath, JSON.stringify(template, null, 2) + '\n');
  const loaded = loadDirectory();
  assert.deepEqual(loaded.categories, template.categories);
  assert.deepEqual(loaded.endpoints, template.endpoints);
  assertRepoRootUntouched();
});

it('loadDirectory with override set but absent falls back read-only to the repo file', () => {
  assert.equal(existsSync(overridePath), false);
  const loaded = loadDirectory();
  assert.ok(Array.isArray(loaded.endpoints));
  // The fallback is read-only w.r.t. the repo-root file when it exists
  // (override remains absent). In a clean checkout the template fallback
  // seeds the override path — the designated writable location — instead;
  // either way the repo-root file is never created or modified.
  assert.equal(existsSync(overridePath), repoRootSnapshot === null);
  if (repoRootSnapshot === null) {
    const seeded = JSON.parse(readFileSync(overridePath, 'utf-8'));
    assert.deepEqual(seeded.endpoints, template.endpoints);
  }
  assertRepoRootUntouched();
});

it('repo-root endpoints.json is unchanged after the full addToDirectory flow', () => {
  writeFileSync(overridePath, JSON.stringify(template, null, 2) + '\n');
  addToDirectory(entry);
  addToDirectory({ ...entry, name: 'OtherSvc', base_url: 'https://other.invalid' });
  const written = JSON.parse(readFileSync(overridePath, 'utf-8'));
  assert.equal(written.endpoints.length, 2);
  assertRepoRootUntouched();
});

// --- #18.3: corrupt-file recovery + atomic writes ---

function cleanCorruptEvidence(): void {
  for (const f of readdirSync(dir).filter((f) => f.startsWith('endpoints.json.corrupt-'))) {
    rmSync(join(dir, f));
  }
}

function quarantinedFiles(): string[] {
  return readdirSync(dir).filter((f) => f.startsWith('endpoints.json.corrupt-'));
}

it('corrupt endpoints.json is quarantined and the directory recovers to empty', () => {
  cleanCorruptEvidence();
  const garbage = '{"endpoints": [ broken';
  writeFileSync(overridePath, garbage);
  const loaded = loadDirectory();
  assert.deepEqual(loaded.endpoints, [], 'corrupt file must recover to an empty directory, not crash');
  assert.deepEqual(loaded.categories, []);
  const evidence = quarantinedFiles();
  assert.equal(evidence.length, 1, 'exactly one corrupt-evidence file');
  assert.match(evidence[0], /endpoints\.json\.corrupt-/);
  assert.equal(readFileSync(join(dir, evidence[0]), 'utf-8'), garbage, 'corrupt evidence preserved verbatim');
  assertRepoRootUntouched();
});

it('valid JSON with a non-directory shape is quarantined too (never crashes the MCP)', () => {
  cleanCorruptEvidence();
  writeFileSync(overridePath, '{"not": "a directory"}');
  const loaded = loadDirectory();
  assert.deepEqual(loaded.endpoints, []);
  assert.equal(quarantinedFiles().length, 1, 'shape-invalid file quarantined as evidence');
  assertRepoRootUntouched();
});

it('after corrupt recovery, addToDirectory rebuilds a valid directory', () => {
  cleanCorruptEvidence();
  writeFileSync(overridePath, 'CORRUPT');
  const loaded = loadDirectory(); // quarantines + caches empty
  assert.equal(loaded.endpoints.length, 0);
  assert.equal(addToDirectory(entry), true, 'write after recovery must succeed');
  clearDirectoryCache();
  const reloaded = loadDirectory();
  assert.equal(reloaded.endpoints.length, 1);
  assert.equal(reloaded.endpoints[0].base_url, entry.base_url);
  assertRepoRootUntouched();
});

it('atomic write leaves no temp files behind on success', () => {
  const target = join(dir, 'atomic-target.json');
  atomicWriteFileSync(target, '{"ok":true}');
  assert.equal(readFileSync(target, 'utf-8'), '{"ok":true}');
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), [], 'no temp file leftovers');
});

it('atomic write cleans up its temp file on failure (read-only directory)', () => {
  const roDir = join(dir, 'readonly');
  mkdirSync(roDir);
  chmodSync(roDir, 0o555);
  try {
    assert.throws(() => atomicWriteFileSync(join(roDir, 'target.json'), 'data'));
  } finally {
    chmodSync(roDir, 0o755); // restore so cleanup can remove the dir
  }
  assert.deepEqual(readdirSync(roDir).filter((f) => f.includes('.tmp-')), [], 'temp file removed after failed write');
});
