import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXACT_RUNTIME_DEPENDENCIES } from '../collab-server/scripts/check-artifacts.mjs';
import {
  COMMERCIAL_RELEASES,
  lockfileProblems,
  unpublishedTransitionProblems,
} from '../scripts/require-lockfile.mjs';

const requireLockfileScript = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../scripts/require-lockfile.mjs'
);

function releaseCoordinates(release) {
  const separator = release.lastIndexOf('@');
  return {
    name: release.slice(0, separator),
    version: release.slice(separator + 1),
  };
}

function releaseUrl(release) {
  const { name, version } = releaseCoordinates(release);
  return `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

function registryFetch(responses, calls = []) {
  return async (url, options) => {
    calls.push({ options, url });
    const response = responses.get(url);
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`unexpected registry URL ${url}`);
    return response;
  };
}

function metadataResponse(release, overrides = {}) {
  const coordinates = releaseCoordinates(release);
  return {
    status: 200,
    async json() {
      return { ...coordinates, ...overrides };
    },
  };
}

function registryResponses(factory) {
  return new Map(COMMERCIAL_RELEASES.map((release) => [releaseUrl(release), factory(release)]));
}

function runRequireLockfileCli(fetchSource, ...args) {
  const preload = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = ${fetchSource};`)}`;
  return spawnSync(
    process.execPath,
    ['--import', preload, requireLockfileScript, ...args],
    { encoding: 'utf8' }
  );
}

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
    version: EXACT_RUNTIME_DEPENDENCIES['@domternal-pro/core'],
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

test('allows the missing-lock transition while any exact commercial release is absent', async () => {
  const calls = [];
  const responses = registryResponses((release) => metadataResponse(release));
  responses.set(releaseUrl(COMMERCIAL_RELEASES[0]), { status: 404 });
  assert.deepEqual(
    await unpublishedTransitionProblems(registryFetch(responses, calls)),
    []
  );
  assert.deepEqual(
    calls.map((call) => call.url).sort(),
    COMMERCIAL_RELEASES.map(releaseUrl).sort()
  );
  for (const call of calls) {
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.options.signal.aborted, false);
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.deepEqual(call.options.headers, {
      accept: 'application/json',
      'cache-control': 'no-cache',
    });
    assert.deepEqual(Object.keys(call.options).sort(), ['headers', 'method', 'redirect', 'signal']);
  }
});

test('requires the lock as soon as every exact commercial release is public', async () => {
  const problems = await unpublishedTransitionProblems(
    registryFetch(registryResponses((release) => metadataResponse(release)))
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /package-lock\.json is required/u);
  for (const release of COMMERCIAL_RELEASES) assert.ok(problems[0].includes(release));
});

test('fails closed for every unexpected public registry status', async () => {
  for (const status of [301, 401, 429, 500]) {
    const responses = registryResponses((release) => metadataResponse(release));
    responses.set(releaseUrl(COMMERCIAL_RELEASES[0]), { status });
    assert.match(
      (await unpublishedTransitionProblems(registryFetch(responses))).join('\n'),
      new RegExp(`HTTP ${String(status)}`, 'u')
    );
  }
});

test('fails closed for network errors even when another release is absent', async () => {
  const responses = registryResponses(() => ({ status: 404 }));
  responses.set(releaseUrl(COMMERCIAL_RELEASES[0]), new Error('registry unavailable'));
  assert.match(
    (await unpublishedTransitionProblems(registryFetch(responses))).join('\n'),
    /registry lookup failed: registry unavailable/u
  );
});

test('fails closed for malformed or mismatched exact-version metadata', async () => {
  const malformed = registryResponses((release) => metadataResponse(release));
  malformed.set(releaseUrl(COMMERCIAL_RELEASES[0]), {
    status: 200,
    async json() {
      throw new SyntaxError('invalid JSON');
    },
  });
  assert.match(
    (await unpublishedTransitionProblems(registryFetch(malformed))).join('\n'),
    /metadata is malformed: invalid JSON/u
  );

  for (const overrides of [
    { name: '@domternal-pro/not-the-package' },
    { version: '999.0.0' },
  ]) {
    const mismatched = registryResponses((release) => metadataResponse(release));
    mismatched.set(
      releaseUrl(COMMERCIAL_RELEASES[0]),
      metadataResponse(COMMERCIAL_RELEASES[0], overrides)
    );
    assert.match(
      (await unpublishedTransitionProblems(registryFetch(mismatched))).join('\n'),
      /metadata has name/u
    );
  }

  const nonObject = registryResponses((release) => metadataResponse(release));
  nonObject.set(releaseUrl(COMMERCIAL_RELEASES[0]), {
    status: 200,
    async json() {
      return null;
    },
  });
  assert.match(
    (await unpublishedTransitionProblems(registryFetch(nonObject))).join('\n'),
    /metadata is not an object/u
  );
});

test('the explicit CLI mode checks publication while the default mode still validates the lock', () => {
  const defaultRun = runRequireLockfileCli(
    `async () => { throw new Error('default lock validation must not fetch'); }`
  );
  assert.equal(defaultRun.status, 1);
  assert.match(defaultRun.stderr, /package-lock\.json does not exist/u);
  assert.doesNotMatch(defaultRun.stderr, /must not fetch/u);

  const unpublished = runRequireLockfileCli(
    'async () => ({ status: 404 })',
    '--verify-unpublished-transition'
  );
  assert.equal(unpublished.status, 0, unpublished.stderr);
  assert.match(unpublished.stdout, /missing-lock transition is still valid/u);

  const published = runRequireLockfileCli(
    `async (url) => {
      const [encodedName, encodedVersion] = new URL(url).pathname.slice(1).split('/');
      return {
        status: 200,
        async json() {
          return {
            name: decodeURIComponent(encodedName),
            version: decodeURIComponent(encodedVersion),
          };
        },
      };
    }`,
    '--verify-unpublished-transition'
  );
  assert.equal(published.status, 1);
  assert.match(published.stderr, /package-lock\.json is required/u);
});
