import assert from 'node:assert/strict';
import test from 'node:test';
import { EXACT_RUNTIME_DEPENDENCIES } from '../collab-server/scripts/check-artifacts.mjs';
import { lockfileProblems } from '../scripts/require-lockfile.mjs';

function validLock() {
  const packages = { '': { dependencies: EXACT_RUNTIME_DEPENDENCIES } };
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
  lock.packages['node_modules/@domternal-pro/core'] = {
    version: '0.1.0',
    resolved: 'file:../../private/core.tgz',
    link: true,
  };
  const problems = lockfileProblems(lock);
  assert.ok(problems.some((problem) => problem.includes('forbidden link/workspace')));
  assert.ok(problems.some((problem) => problem.includes('resolves outside')));
  assert.ok(problems.some((problem) => problem.includes('no valid sha512 registry integrity')));
});

test('rejects a plausible HTTPS private registry URL', () => {
  const lock = validLock();
  lock.packages['node_modules/yjs'].resolved = 'https://npm.internal.example/yjs.tgz';
  assert.ok(
    lockfileProblems(lock).some((problem) =>
      problem.includes('resolves outside https://registry.npmjs.org')
    )
  );
});

test('rejects registry lookalikes, URL credentials and query material', () => {
  const lock = validLock();
  lock.packages['node_modules/yjs'].resolved =
    'https://user:password@registry.npmjs.org:8443/yjs/-/yjs-13.6.31.tgz?token=secret';
  const problems = lockfileProblems(lock);
  assert.ok(problems.some((problem) => problem.includes('resolves outside')));
  assert.ok(problems.some((problem) => problem.includes('contains credentials')));
  assert.ok(problems.some((problem) => problem.includes('query or fragment')));
});
