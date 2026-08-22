import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildMarkdownReport,
  checkActionUpdates,
  checkDockerUpdates,
  checkNpmUpdates,
  checkToolUpdates,
  collectInventory,
  compareSemver,
  fetchJson,
  latestGitHubRelease,
  parseSemver,
  rowsRequireAttention,
} from '../scripts/check-updates.mjs';

function json(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

function routes(definitions) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = input instanceof URL ? input.href : String(input);
    calls.push({ url, options });
    const route = definitions.find((candidate) =>
      typeof candidate.match === 'string' ? url === candidate.match : candidate.match.test(url)
    );
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return typeof route.response === 'function' ? route.response(url, options) : route.response;
  };
  return { fetchImpl, calls };
}

function githubReleaseRoutes(repository, tag, sha, { annotated = false } = {}) {
  const release = {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/${repository}/releases/tag/${tag}`,
  };
  const routesList = [
    { match: `https://api.github.com/repos/${repository}/releases/latest`, response: json(release) },
    {
      match: `https://api.github.com/repos/${repository}/git/ref/tags/${tag}`,
      response: json({ object: { type: annotated ? 'tag' : 'commit', sha: annotated ? 'a'.repeat(40) : sha } }),
    },
  ];
  if (annotated) {
    routesList.push({
      match: `https://api.github.com/repos/${repository}/git/tags/${'a'.repeat(40)}`,
      response: json({ object: { type: 'commit', sha } }),
    });
  }
  return routesList;
}

test('stable semantic versions compare numerically and prereleases are rejected', () => {
  assert.deepEqual(parseSemver('v13.0.3'), { major: 13, minor: 0, patch: 3 });
  assert.equal(parseSemver('13.0.3-rc.1'), null);
  assert.equal(parseSemver('013.0.3'), null);
  assert.equal(compareSemver('2.10.0', '2.9.99'), 1);
  assert.equal(compareSemver('v2.10.0', '2.10.0'), 0);
  assert.equal(compareSemver('2.10.0', '3.0.0'), -1);
  assert.throws(() => compareSemver('latest', '3.0.0'), /non-stable/u);
});

test('metadata requests enforce the host allowlist and do not forward tokens outside GitHub', async () => {
  const mock = routes([
    { match: 'https://api.github.com/example', response: json({ ok: true }) },
    { match: 'https://registry.npmjs.org/example/latest', response: json({ version: '1.0.0' }) },
  ]);
  await fetchJson('https://api.github.com/example', { fetchImpl: mock.fetchImpl, token: 'secret' });
  await fetchJson('https://registry.npmjs.org/example/latest', { fetchImpl: mock.fetchImpl, token: 'secret' });
  assert.equal(mock.calls[0].options.headers.authorization, 'Bearer secret');
  assert.equal(mock.calls[1].options.headers.authorization, undefined);
  assert.equal(mock.calls[0].options.redirect, 'error');
  await assert.rejects(
    fetchJson('https://example.test/metadata', { fetchImpl: mock.fetchImpl }),
    /Refusing update metadata request/u
  );
  await assert.rejects(
    fetchJson('http://api.github.com/example', { fetchImpl: mock.fetchImpl }),
    /Refusing update metadata request/u
  );
});

test('metadata requests enforce declared and streamed size limits', async () => {
  await assert.rejects(
    fetchJson('https://api.github.com/large', {
      fetchImpl: async () => json({ ok: true }, { headers: { 'content-length': '101' } }),
      maximumBytes: 100,
    }),
    /100 byte limit/u
  );
  await assert.rejects(
    fetchJson('https://api.github.com/large', {
      fetchImpl: async () => json({ value: 'x'.repeat(200) }),
      maximumBytes: 100,
    }),
    /100 byte limit/u
  );
});

test('metadata requests abort after the configured timeout', async () => {
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  await assert.rejects(
    fetchJson('https://api.github.com/slow', { fetchImpl, timeoutMs: 5 }),
    /5 ms timeout/u
  );
});

test('npm checks URL-encode scoped names and report stable updates', async () => {
  const mock = routes([
    {
      match: 'https://registry.npmjs.org/%40scope%2Fpackage/latest',
      response: json({ version: '1.3.0' }),
    },
  ]);
  const rows = await checkNpmUpdates(new Map([['@scope/package', '1.2.0']]), { fetchImpl: mock.fetchImpl });
  assert.equal(rows[0].status, 'update');
  assert.equal(rows[0].latest, '1.3.0');
  assert.match(mock.calls[0].url, /%40scope%2Fpackage/u);
});

test('the exact better-sqlite3 deferral ends after 13.0.3', async () => {
  for (const [latest, expected] of [
    ['13.0.2', 'deferred'],
    ['13.0.3', 'deferred'],
    ['13.0.4', 'update'],
    ['14.0.0', 'update'],
  ]) {
    const rows = await checkNpmUpdates(new Map([['better-sqlite3', '12.11.1']]), {
      fetchImpl: async () => json({ version: latest }),
    });
    assert.equal(rows[0].status, expected, latest);
  }
  const changedCurrent = await checkNpmUpdates(new Map([['better-sqlite3', '12.11.0']]), {
    fetchImpl: async () => json({ version: '13.0.3' }),
  });
  assert.equal(changedCurrent[0].status, 'update');
});

test('npm lookup failures become explicit errors without throwing away other results', async () => {
  const rows = await checkNpmUpdates(
    new Map([
      ['available', '1.0.0'],
      ['missing', '1.0.0'],
    ]),
    {
      fetchImpl: async (input) => input.href.includes('/missing/')
        ? new Response('', { status: 404 })
        : json({ version: '1.0.0' }),
    }
  );
  assert.deepEqual(rows.map((row) => row.status), ['current', 'error']);
  assert.match(rows[1].detail, /HTTP 404/u);
});

test('Docker checks only the validated Node major and Alpine line', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const mock = routes([
    {
      match: /\/v2\/repositories\/library\/node\/tags\?.*page_size=25/u,
      response: json({
        next: null,
        results: [
          { name: '22.24.1-alpine3.24' },
          { name: '22.24.0-alpine3.23' },
          { name: '23.1.0-alpine3.24' },
          { name: '22.24.2-alpine3.24-rc.1' },
        ],
      }),
    },
    {
      match: 'https://hub.docker.com/v2/repositories/library/node/tags/22.23.2-alpine3.24',
      response: json({ digest }),
    },
    {
      match: 'https://nodejs.org/dist/index.json',
      response: json([{ version: 'v22.23.2', lts: 'Jod' }]),
    },
    {
      match: /\/v2\/repositories\/library\/node\/tags\?.*page_size=100/u,
      response: json({ results: [{ name: '22.23.2-alpine3.24' }] }),
    },
  ]);
  const rows = await checkDockerUpdates({
    reference: `node:22.23.2-alpine3.24@${digest}`,
    version: '22.23.2',
    alpine: '3.24',
    digest,
  }, { fetchImpl: mock.fetchImpl });
  assert.equal(rows[0].status, 'update');
  assert.equal(rows[0].latest, 'node:22.24.1-alpine3.24');
});

test('Docker detects digest replacement even when the exact tag is current', async () => {
  const oldDigest = `sha256:${'a'.repeat(64)}`;
  const newDigest = `sha256:${'b'.repeat(64)}`;
  const mock = routes([
    {
      match: /\/v2\/repositories\/library\/node\/tags\?.*page_size=25/u,
      response: json({ next: null, results: [{ name: '22.23.2-alpine3.24' }] }),
    },
    {
      match: 'https://hub.docker.com/v2/repositories/library/node/tags/22.23.2-alpine3.24',
      response: json({ digest: newDigest }),
    },
    {
      match: 'https://nodejs.org/dist/index.json',
      response: json([{ version: 'v22.23.2', lts: 'Jod' }]),
    },
    {
      match: /\/v2\/repositories\/library\/node\/tags\?.*page_size=100/u,
      response: json({ results: [{ name: '22.23.2-alpine3.24' }] }),
    },
  ]);
  const rows = await checkDockerUpdates({
    reference: `node:22.23.2-alpine3.24@${oldDigest}`,
    version: '22.23.2',
    alpine: '3.24',
    digest: oldDigest,
  }, { fetchImpl: mock.fetchImpl });
  assert.equal(rows[0].status, 'update');
  assert.match(rows[0].detail, new RegExp(newDigest, 'u'));
});

test('Docker reports newer Node LTS and Alpine lines as manual updates', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const mock = routes([
    {
      match: /\/v2\/repositories\/library\/node\/tags\?.*page_size=25/u,
      response: json({ next: null, results: [{ name: '22.23.2-alpine3.24' }] }),
    },
    {
      match: 'https://hub.docker.com/v2/repositories/library/node/tags/22.23.2-alpine3.24',
      response: json({ digest }),
    },
    {
      match: 'https://nodejs.org/dist/index.json',
      response: json([
        { version: 'v25.1.0', lts: false },
        { version: 'v24.13.0', lts: 'Krypton' },
        { version: 'v22.23.2', lts: 'Jod' },
      ]),
    },
    {
      match: /\/v2\/repositories\/library\/node\/tags\?.*page_size=100/u,
      response: json({
        results: [
          { name: '22.23.2-alpine3.25' },
          { name: '22.23.2-alpine3.24' },
        ],
      }),
    },
  ]);
  const rows = await checkDockerUpdates({
    reference: `node:22.23.2-alpine3.24@${digest}`,
    version: '22.23.2',
    alpine: '3.24',
    digest,
  }, { fetchImpl: mock.fetchImpl });
  assert.deepEqual(rows.map((row) => row.status), ['current', 'update', 'update']);
  assert.equal(rows[1].latest, '24.13.0');
  assert.equal(rows[2].latest, '3.25');
});

test('GitHub releases resolve annotated tags to immutable commits', async () => {
  const sha = 'b'.repeat(40);
  const mock = routes(githubReleaseRoutes('owner/action', 'v2.3.4', sha, { annotated: true }));
  const release = await latestGitHubRelease('owner/action', { fetchImpl: mock.fetchImpl, githubToken: 'token' });
  assert.deepEqual(release, {
    version: 'v2.3.4',
    sha,
    url: 'https://github.com/owner/action/releases/tag/v2.3.4',
  });
  assert.equal(mock.calls.length, 3);
  assert.ok(mock.calls.every((call) => call.options.headers.authorization === 'Bearer token'));
});

test('GitHub repositories without Releases fall back to the latest stable tag', async () => {
  const stableSha = 'c'.repeat(40);
  const mock = routes([
    {
      match: 'https://api.github.com/repos/owner/action/releases/latest',
      response: new Response('', { status: 404 }),
    },
    {
      match: 'https://api.github.com/repos/owner/action/tags?per_page=100',
      response: json([
        { name: 'v3.0.0-rc.1', commit: { sha: 'd'.repeat(40) } },
        { name: 'v2.10.0', commit: { sha: stableSha } },
        { name: 'v2.9.9', commit: { sha: 'e'.repeat(40) } },
      ]),
    },
  ]);
  const release = await latestGitHubRelease('owner/action', { fetchImpl: mock.fetchImpl });
  assert.equal(release.version, 'v2.10.0');
  assert.equal(release.sha, stableSha);
});

test('GitHub Action checks compare the resolved release commit, not a mutable tag', async () => {
  const current = 'a'.repeat(40);
  const latest = 'b'.repeat(40);
  const mock = routes([
    ...githubReleaseRoutes('current/action', 'v1.0.0', current),
    ...githubReleaseRoutes('outdated/action', 'v2.0.0', latest),
  ]);
  const rows = await checkActionUpdates(new Map([
    ['current/action', current],
    ['outdated/action', current],
  ]), { fetchImpl: mock.fetchImpl });
  assert.deepEqual(rows.map((row) => row.status), ['current', 'update']);
});

test('CodeQL follows the v4 action channel instead of CodeQL bundle releases', async () => {
  const current = 'a'.repeat(40);
  const latest = 'b'.repeat(40);
  const mock = routes([
    {
      match: 'https://api.github.com/repos/github/codeql-action/git/ref/tags/v4',
      response: json({ object: { type: 'commit', sha: latest } }),
    },
  ]);
  const rows = await checkActionUpdates(
    new Map([['github/codeql-action', current]]),
    { fetchImpl: mock.fetchImpl }
  );
  assert.equal(rows[0].status, 'update');
  assert.equal(rows[0].latest, `v4 (${latest})`);
  assert.ok(mock.calls.every((call) => !call.url.includes('/releases/latest')));
});

test('actionlint and Trivy tool checks compare stable upstream releases', async () => {
  const sha = 'f'.repeat(40);
  const mock = routes([
    ...githubReleaseRoutes('aquasecurity/trivy', 'v0.72.0', sha),
    ...githubReleaseRoutes('rhysd/actionlint', 'v1.7.13', sha),
  ]);
  const rows = await checkToolUpdates(new Map([
    ['aquasecurity/trivy', '0.72.0'],
    ['rhysd/actionlint', '1.7.12'],
  ]), { fetchImpl: mock.fetchImpl });
  assert.deepEqual(rows.map((row) => row.status), ['current', 'update']);
});

test('repository inventory includes runtime npm dependencies and deduplicates pinned infrastructure', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'domternal-update-checker-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['service', 'second', '.github/workflows']) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, 'service/package.json'), JSON.stringify({ dependencies: { runtime: '1.2.3' }, devDependencies: { ignored: '9.9.9' } }));
  writeFileSync(join(root, 'second/package.json'), JSON.stringify({ dependencies: { runtime: '1.2.3' } }));
  const dockerReference = `node:22.23.2-alpine3.24@sha256:${'a'.repeat(64)}`;
  writeFileSync(join(root, 'service/Dockerfile'), `FROM ${dockerReference}\nFROM ${dockerReference} AS runtime\n`);
  writeFileSync(join(root, 'second/Dockerfile'), `FROM ${dockerReference}\n`);
  writeFileSync(join(root, '.github/workflows/ci.yml'), `
jobs:
  check:
    steps:
      - uses: owner/action@${'b'.repeat(40)} # v1
      - uses: owner/action/subpath@${'b'.repeat(40)} # v1
      - uses: aquasecurity/trivy-action@${'c'.repeat(40)}
        with:
          version: v0.72.0
        env:
          ACTIONLINT_VERSION: 1.7.12
`);
  const inventory = collectInventory(root);
  assert.deepEqual([...inventory.npm], [['runtime', '1.2.3']]);
  assert.equal(inventory.docker.reference, dockerReference);
  assert.deepEqual([...inventory.actions], [
    ['owner/action', 'b'.repeat(40)],
    ['aquasecurity/trivy-action', 'c'.repeat(40)],
  ]);
  assert.deepEqual([...inventory.tools], [
    ['rhysd/actionlint', '1.7.12'],
    ['aquasecurity/trivy', '0.72.0'],
  ]);
});

test('repository inventory rejects mutable action refs and inconsistent Docker pins', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'domternal-update-checker-hostile-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['one', 'two', '.github/workflows']) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, 'one/package.json'), '{}');
  writeFileSync(join(root, 'one/Dockerfile'), `FROM node:22.1.0-alpine3.24@sha256:${'a'.repeat(64)}\n`);
  writeFileSync(join(root, 'two/Dockerfile'), `FROM node:22.1.0-alpine3.24@sha256:${'b'.repeat(64)}\n`);
  writeFileSync(join(root, '.github/workflows/ci.yml'), `
steps:
  - uses: owner/action@v1
  - uses: aquasecurity/trivy-action@${'c'.repeat(40)}
    with:
      version: v0.72.0
    env:
      ACTIONLINT_VERSION: 1.7.12
`);
  assert.throws(() => collectInventory(root), /Node Docker images are inconsistent/u);
  writeFileSync(join(root, 'two/Dockerfile'), `FROM node:22.1.0-alpine3.24@sha256:${'a'.repeat(64)}\n`);
  assert.throws(() => collectInventory(root), /full commit SHA/u);
});

test('Markdown summaries escape untrusted table content and explain the read-only behavior', () => {
  const report = buildMarkdownReport([
    {
      category: 'npm',
      dependency: 'unsafe|name\nnext',
      current: '1.0.0',
      latest: '2.0.0',
      status: 'update',
      detail: 'review|required\nnow',
      url: 'https://example.test/release',
    },
  ]);
  assert.match(report, /Dependency updates available/u);
  assert.match(report, /unsafe\\\|name next/u);
  assert.match(report, /review\\\|required now/u);
  assert.match(report, /does not install updates or create pull requests/u);
});

test('acknowledged incompatible updates still trigger the weekly notification', () => {
  const rows = [{ status: 'deferred' }];
  assert.equal(rowsRequireAttention(rows), true);
  assert.match(buildMarkdownReport(rows), /Dependency updates available/u);
});
