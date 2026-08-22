#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockfileProblems } from '../collab-server/scripts/check-lockfile.mjs';

export { lockfileProblems } from '../collab-server/scripts/check-lockfile.mjs';

function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const lockPath = join(repositoryRoot, 'collab-server', 'package-lock.json');

  if (!existsSync(lockPath)) {
    console.error(`
[dependency-lock] BLOCKED: collab-server/package-lock.json does not exist.

This is an external release-order blocker, not a lockfile that may be guessed:
  - @domternal-pro/core@0.1.0 must exist on the public npm registry
  - @domternal-pro/extension-comments@0.1.0 must exist on the public npm registry

After both exact packages are published, generate the lock with the repository's
supported Node/npm version, review it, run npm ci --ignore-scripts
--strict-peer-deps, verify
signatures, rebuild only better-sqlite3 and run the container suite, then commit
the real registry-produced package-lock.json.
Never replace it with workspace links, private tarballs or hand-written entries.
`.trim());
    process.exitCode = 1;
    return;
  }

  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    console.error(
      `[dependency-lock] FAILED: package-lock.json is invalid JSON: ${
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
