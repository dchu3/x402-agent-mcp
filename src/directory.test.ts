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

const { addToDirectory, loadDirectory, clearDirectoryCache, atomicWriteFileSync, advertisedPriceUsd, findEntryForUrl, recordLiveness } = await import('./directory.js');
import type { LivenessRecord } from './directory.js';

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

// ---------------------------------------------------------------------------
// Issue #30 — advertisedPriceUsd: the directory's advertised price for a URL's
// endpoint path (hostname + pathname match). Pure read over the cached
// directory; any error ⇒ undefined. This is the shared helper x402_check-
// _payment switched to (replacing its inline duplicate) and the rule 4.6 seed
// uses.
// ---------------------------------------------------------------------------

it('advertisedPriceUsd matches hostname + path and tolerates garbage', () => {
  writeFileSync(overridePath, JSON.stringify({
    endpoints: [
      { ...entry, base_url: 'https://priced.invalid', endpoints: [{ path: '/score', method: 'POST', price_usdc: '0.05', description: 'd' }] },
      { ...entry, base_url: 'https://malformed.invalid', endpoints: [{ path: '/x', method: 'GET', price_usdc: 'oops', description: 'd' }] },
      { ...entry, base_url: 'not-a-url' },
    ],
    categories: [], last_updated: '2026-09-21',
  }), 'utf8');
  clearDirectoryCache();
  assert.equal(advertisedPriceUsd('https://priced.invalid/score'), 0.05);
  assert.equal(advertisedPriceUsd('https://priced.invalid/other'), undefined, 'no matching path ⇒ undefined');
  assert.equal(advertisedPriceUsd('https://stranger.invalid/score'), undefined, 'no matching host ⇒ undefined');
  assert.equal(advertisedPriceUsd('https://priced.invalid'), undefined, 'no path at all ⇒ undefined');
  assert.equal(advertisedPriceUsd('not-a-url'), undefined, 'unparseable URL ⇒ undefined (never throws)');
  // The malformed-price and malformed-base_url entries never throw — the scan
  // skips them and keeps looking at the rest of the directory.
  assert.equal(advertisedPriceUsd('https://malformed.invalid/x'), undefined, 'a non-numeric price_usdc ⇒ undefined');
});

// ---------------------------------------------------------------------------
// Issue #34 — liveness records (L4): findEntryForUrl (origin match) locates
// the entry a URL belongs to; recordLiveness persists the entry's most recent
// probe through the SAME atomic write path addToDirectory uses (the
// X402_DIRECTORY_PATH override is consulted first; the repo-root file stays
// untouched).
// ---------------------------------------------------------------------------

function writeLivenessFixture(): void {
  writeFileSync(overridePath, JSON.stringify({
    endpoints: [
      { ...entry, name: 'LiveSvc', base_url: 'https://live.invalid', source: 'seed' },
      { ...entry, name: 'PortSvc', base_url: 'https://port.invalid:8443/' },
      { ...entry, name: 'Malformed', base_url: 'not-a-url' },
    ],
    categories: [], last_updated: '2026-09-21',
  }), 'utf8');
  clearDirectoryCache();
}

const RECORD: LivenessRecord = {
  probed_at: '2026-09-25T12:00:00.000Z',
  status: 'live_402',
  latency_ms: 42,
  probe_url: 'https://live.invalid',
  accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', payTo: '0xabc', asset: '0xdef' }],
};

it('findEntryForUrl matches by origin — host case, default port, and trailing slash all normalised', () => {
  writeLivenessFixture();
  assert.equal(findEntryForUrl('https://live.invalid/some/path?q=1')?.name, 'LiveSvc');
  assert.equal(findEntryForUrl('https://LIVE.invalid/x')?.name, 'LiveSvc', 'host match is case-insensitive');
  assert.equal(findEntryForUrl('https://live.invalid:443/x')?.name, 'LiveSvc', 'the default https port normalises away');
  assert.equal(findEntryForUrl('https://live.invalid/x'), findEntryForUrl('https://live.invalid'), 'paths on the query URL are irrelevant to the origin match');
  assert.equal(findEntryForUrl('http://live.invalid/x'), undefined, 'scheme is part of the origin — http ≠ https');
  assert.equal(findEntryForUrl('https://port.invalid:8443/api')?.name, 'PortSvc', 'a non-default port is part of the origin');
  assert.equal(findEntryForUrl('https://port.invalid/api'), undefined, 'origin 443 ≠ origin 8443');
  assertRepoRootUntouched();
});

it('findEntryForUrl never throws: malformed directory base_urls and unparseable input URLs never match', () => {
  writeLivenessFixture();
  assert.equal(findEntryForUrl('https://not-a-url/x'), undefined, 'a malformed DIRECTORY entry can never match');
  assert.equal(findEntryForUrl('not a url'), undefined, 'unparseable input ⇒ undefined');
  assert.equal(findEntryForUrl(''), undefined);
  assert.equal(findEntryForUrl('https://stranger.invalid/x'), undefined, 'no matching host ⇒ undefined');
  assertRepoRootUntouched();
});

it('recordLiveness writes the record atomically to the override file (never the repo root) and survives a cold reload', () => {
  writeLivenessFixture();
  assert.equal(recordLiveness('https://live.invalid', RECORD), true);
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), [], 'atomic write leaves no temp files');
  clearDirectoryCache();
  const reloaded = loadDirectory();
  const saved = reloaded.endpoints.find((e) => e.name === 'LiveSvc');
  assert.deepEqual(saved?.liveness, RECORD, 'the record round-trips through the file — accepts included');
  assertRepoRootUntouched();
});

it('recordLiveness locates the entry by ORIGIN — case/default-port/trailing-path spellings land on the same entry, and the cache reflects it immediately', () => {
  writeLivenessFixture();
  const errorRecord: LivenessRecord = { probed_at: '2026-09-25T13:00:00.000Z', status: 'error', latency_ms: 10000, probe_url: 'https://live.invalid' };
  assert.equal(recordLiveness('https://LIVE.invalid:443/some/path', errorRecord), true, 'the origin-normalised spelling matches the same entry');
  assert.equal(findEntryForUrl('https://live.invalid/x')?.liveness?.status, 'error', 'the cached directory reflects the latest probe without a reload');
  assert.equal(findEntryForUrl('https://live.invalid/x')?.liveness?.accepts, undefined, 'error records carry no accepts snapshot');
  const onFile = JSON.parse(readFileSync(overridePath, 'utf-8'));
  assert.equal(onFile.endpoints.find((e: any) => e.name === 'LiveSvc').liveness.status, 'error');
  assertRepoRootUntouched();
});

it('recordLiveness returns false for a base_url with no directory entry — nothing is written', () => {
  writeLivenessFixture();
  const before = readFileSync(overridePath, 'utf-8');
  assert.equal(recordLiveness('https://stranger.invalid', RECORD), false, 'no entry matches ⇒ false');
  assert.equal(readFileSync(overridePath, 'utf-8'), before, 'an unknown origin must not dirty the directory file');
  // ...nor does a match against a malformed-entry lookup crash it.
  assert.equal(recordLiveness('https://not-a-url', RECORD), false);
  assert.equal(readFileSync(overridePath, 'utf-8'), before);
  assertRepoRootUntouched();
});
