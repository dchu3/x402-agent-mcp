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