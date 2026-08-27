#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockfileProblems } from '../collab-server/scripts/check-lockfile.mjs';

export { lockfileProblems };

function main() {
  if (process.argv.length !== 2) {
    console.error('Usage: node scripts/require-lockfile.mjs');
    process.exitCode = 2;
    return;
  }

  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const lockPath = join(repositoryRoot, 'collab-server', 'package-lock.json');
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    console.error(
      `[dependency-lock] FAILED: ${lockPath} is missing or invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exitCode = 1;
    return;
  }

  const problems = lockfileProblems(lock);
  if (problems.length > 0) {
    console.error('[dependency-lock] FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('[dependency-lock] OK - committed lock uses only integrity-pinned public registry artifacts');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
