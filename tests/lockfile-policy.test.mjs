import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EXACT_RUNTIME_DEPENDENCIES,
} from '../collab-server/scripts/check-artifacts.mjs';
import {
  lockfileProblems,
  readLockfileProblems,
} from '../collab-server/scripts/check-lockfile.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireLockfileScript = resolve(root, 'scripts/require-lockfile.mjs');

function validLock() {
  const packages = { '': { dependencies: { ...EXACT_RUNTIME_DEPENDENCIES } } };
  const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
  for (const [name, version] of Object.entries(EXACT_RUNTIME_DEPENDENCIES)) {
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
      integrity,
    };
  }
  return { lockfileVersion: 3, packages };
}

test('accepts an exact lock made only from integrity-pinned public registry artifacts', () => {
  assert.deepEqual(lockfileProblems(validLock()), []);
});

test('rejects workspace links, private registries and missing integrity', () => {
  const lock = validLock();
  lock.packages['node_modules/yjs'] = {
    version: EXACT_RUNTIME_DEPENDENCIES.yjs,
    resolved: 'file:../../private/yjs.tgz',
    link: true,
  };
  const problems = lockfileProblems(lock);
  assert.ok(problems.some((problem) => problem.includes('forbidden link/workspace')));
  assert.ok(problems.some((problem) => problem.includes('resolves outside')));
  assert.ok(problems.some((problem) => problem.includes('no valid sha512 registry integrity')));
});

test('rejects registry lookalikes, URL credentials and query material', () => {
  const lock = validLock();
  lock.packages['node_modules/yjs'].resolved =
    'https://user:password@registry.npmjs.org:8443/yjs/-/yjs-13.6.32.tgz?token=secret';
  const problems = lockfileProblems(lock);
  assert.ok(problems.some((problem) => problem.includes('resolves outside')));
  assert.ok(problems.some((problem) => problem.includes('contains credentials')));
  assert.ok(problems.some((problem) => problem.includes('query or fragment')));
});

test('rejects undeclared root dependencies and unsupported development closure', () => {
  const lock = validLock();
  lock.packages[''].dependencies['unexpected-package'] = '1.0.0';
  lock.packages[''].devDependencies = { tool: '1.0.0' };
  const problems = lockfileProblems(lock);
  assert.ok(problems.some((problem) => problem.includes('unclassified root dependency')));
  assert.ok(problems.some((problem) => problem.includes('unsupported devDependencies')));
});

test('reports a missing lock as an unconditional deployment error', () => {
  const directory = mkdtempSync(join(tmpdir(), 'domternal-missing-lock-'));
  try {
    assert.match(readLockfileProblems(directory).join('\n'), /package-lock\.json is missing/u);
    assert.doesNotMatch(
      readLockfileProblems(directory).join('\n'),
      new RegExp(['@domternal', 'pro'].join('-'), 'u')
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the CLI validates the committed lock and rejects unsupported modes', () => {
  const valid = spawnSync(process.execPath, [requireLockfileScript], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /integrity-pinned public registry artifacts/u);

  const unsupported = spawnSync(
    process.execPath,
    [requireLockfileScript, '--verify-unpublished-transition'],
    { encoding: 'utf8' }
  );
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /Usage:/u);
});
