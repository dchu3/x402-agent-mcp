#!/usr/bin/env node
// Node-20-safe test runner (issue #57).
//
// `node --test "dist-test/**/*.test.js"` only expands glob patterns from Node
// >= 21 (v20.6 glob support never landed for `--test` arguments). On Node 20
// the quoted glob is treated as a literal path, matches no test files, and the
// run exits non-zero. This runner lists the files explicitly instead, so the
// suite runs identically on Node >= 20.

import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

const root = "dist-test";

function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTestFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

let files;
try {
  files = collectTestFiles(root);
} catch (err) {
  if (err && err.code === "ENOENT") {
    console.error(`run-tests: ${root}/ does not exist — build the test bundle first (npm test does this for you).`);
    process.exit(1);
  }
  throw err;
}

files.sort((a, b) => relative(".", a).localeCompare(relative(".", b)));

if (files.length === 0) {
  console.error(`run-tests: no *.test.js files found under ${root}/ — nothing to run.`);
  process.exit(1);
}

console.error(`run-tests: ${files.length} test file(s) under ${root}/`);
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);