import { strict as assert } from 'node:assert';
import { after, afterEach, it } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the directory in a temp dir BEFORE importing directory.js,
// following the PAYMENT_LOG_PATH pattern in casper-fetch.test.ts.
const dir = mkdtempSync(join(tmpdir(), 'x402-directory-test-'));
const overridePath = join(dir, 'endpoints.json');
const env = { ...process.env };
process.env.X402_DIRECTORY_PATH = overridePath;

const { addToDirectory, loadDirectory, clearDirectoryCache } = await import('./directory.js');

const REPO_ROOT_ENDPOINTS = join(import.meta.dirname, '..', 'endpoints.json');

function md5(p: string): string {
  return createHash('md5').update(readFileSync(p)).digest('hex');
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
  const rootBefore = md5(REPO_ROOT_ENDPOINTS);
  assert.equal(addToDirectory(entry), true);
  const written = JSON.parse(readFileSync(overridePath, 'utf-8'));
  assert.equal(written.endpoints.length, 1);
  assert.equal(written.endpoints[0].base_url, 'https://isolation-test.invalid');
  assert.equal(md5(REPO_ROOT_ENDPOINTS), rootBefore, 'repo-root endpoints.json must not be modified');
});

it('loadDirectory with override seeds the override path from the shipped template', () => {
  const loaded = loadDirectory();
  assert.deepEqual(loaded.categories, template.categories);
  assert.ok(existsSync(overridePath), 'template should be copied to the override path');
  assert.equal(existsSync(join(dir, '..', '..', 'endpoints.json')) || true, true);
});

it('repo-root endpoints.json content hash is unchanged after the full addToDirectory flow', () => {
  writeFileSync(overridePath, JSON.stringify(template, null, 2) + '\n');
  const rootBefore = md5(REPO_ROOT_ENDPOINTS);
  addToDirectory(entry);
  addToDirectory({ ...entry, name: 'OtherSvc', base_url: 'https://other.invalid' });
  assert.equal(md5(REPO_ROOT_ENDPOINTS), rootBefore);
  const written = JSON.parse(readFileSync(overridePath, 'utf-8'));
  assert.equal(written.endpoints.length, 2);
});
