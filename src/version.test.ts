import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from './version.js';

// Permanent guard against version re-divergence (#18.1): the single source of
// truth is src/version.ts; package.json must agree with it. package.json sits
// one level above dist-test/, same resolution the directory tests use for
// repo-root files.
it('VERSION matches package.json version (single source of truth)', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8')) as { version: string };
  assert.equal(VERSION, pkg.version);
});

// Regression guard for lockfile version drift (commit a36f9e1 bumped
// package.json 1.0.0 -> 1.3.0 but never regenerated package-lock.json, so
// `npm ci` was silently non-reproducible vs `npm install`). Both the root
// "version" and packages[""].version in package-lock.json must agree with
// the single source of truth.
it('VERSION matches package-lock.json root version (no lockfile drift)', () => {
  const lock = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package-lock.json'), 'utf-8')) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages['']?.version, VERSION);
});