#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMERCIAL_RELEASES,
  lockfileProblems,
} from '../collab-server/scripts/check-lockfile.mjs';

export { COMMERCIAL_RELEASES, lockfileProblems };

const PUBLIC_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const REGISTRY_TIMEOUT_MS = 15_000;
const UNPUBLISHED_TRANSITION_MODE = '--verify-unpublished-transition';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function releaseCoordinates(release) {
  const separator = release.lastIndexOf('@');
  const name = release.slice(0, separator);
  const version = release.slice(separator + 1);
  if (separator <= 0 || name === '' || version === '') return null;
  return { name, version };
}

async function inspectRegistryRelease(release, fetchImpl) {
  const coordinates = releaseCoordinates(release);
  if (coordinates === null) {
    return { problem: `${release} is not a valid exact package release coordinate` };
  }
  const { name, version } = coordinates;
  const url = `${PUBLIC_REGISTRY_ORIGIN}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
      },
    });
  } catch (error) {
    return { problem: `${release} public registry lookup failed: ${errorMessage(error)}` };
  }

  if (!Number.isInteger(response?.status)) {
    return { problem: `${release} public registry lookup returned no valid HTTP status` };
  }
  if (response.status === 404) return { absent: true };
  if (response.status < 200 || response.status >= 300) {
    return {
      problem: `${release} public registry lookup returned HTTP ${String(response.status)}, expected 2xx metadata or 404`,
    };
  }

  let metadata;
  try {
    metadata = await response.json();
  } catch (error) {
    return { problem: `${release} public registry metadata is malformed: ${errorMessage(error)}` };
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { problem: `${release} public registry metadata is not an object` };
  }
  if (metadata.name !== name || metadata.version !== version) {
    return {
      problem:
        `${release} public registry metadata has name ${JSON.stringify(metadata.name)} ` +
        `and version ${JSON.stringify(metadata.version)}`,
    };
  }
  return { absent: false };
}

/**
 * Verify that omitting the deployment lock remains an unpublished-release
 * transition, not a way to skip frozen dependency and container gates.
 *
 * @param {typeof globalThis.fetch} fetchImpl
 * @returns {Promise<string[]>}
 */
export async function unpublishedTransitionProblems(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    return ['public registry verification requires a fetch implementation'];
  }
  const results = await Promise.all(
    COMMERCIAL_RELEASES.map((release) => inspectRegistryRelease(release, fetchImpl))
  );
  const problems = results.flatMap((result) => (result.problem ? [result.problem] : []));
  if (problems.length > 0) return problems;
  if (results.some((result) => result.absent === true)) return [];
  return [
    `collab-server/package-lock.json is required because every commercial release is now public: ${COMMERCIAL_RELEASES.join(', ')}`,
  ];
}

async function main() {
  if (process.argv[2] === UNPUBLISHED_TRANSITION_MODE) {
    if (process.argv.length !== 3) {
      console.error(`Usage: node scripts/require-lockfile.mjs ${UNPUBLISHED_TRANSITION_MODE}`);
      process.exitCode = 1;
      return;
    }
    const problems = await unpublishedTransitionProblems();
    if (problems.length > 0) {
      console.error('[dependency-lock] FAILED:');
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      '[dependency-lock] OK - at least one exact commercial release remains unpublished; the missing-lock transition is still valid'
    );
    return;
  }

  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const lockPath = join(repositoryRoot, 'collab-server', 'package-lock.json');

  if (!existsSync(lockPath)) {
    console.error(`
[dependency-lock] BLOCKED: collab-server/package-lock.json does not exist.

This is an external release-order blocker, not a lockfile that may be guessed:
${COMMERCIAL_RELEASES.map((release) => `  - ${release} must exist on the public npm registry`).join('\n')}

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

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
