#!/usr/bin/env node

import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_DOCKER_TAG_PAGES = 5;
const ALLOWED_ORIGINS = new Set([
  'https://api.github.com',
  'https://hub.docker.com',
  'https://nodejs.org',
  'https://registry.npmjs.org',
]);
const ACTION_CHANNEL_TAGS = new Map([
  ['github/codeql-action', 'v4'],
]);
const ACKNOWLEDGED_NPM_DEFERRALS = new Map([
  [
    'better-sqlite3',
    {
      current: '12.11.1',
      through: '13.0.3',
      reason:
        '@hocuspocus/extension-sqlite 4.6 requires better-sqlite3 12.x; ' +
        'review v13 after upstream compatibility is confirmed.',
    },
  ],
]);

class HttpStatusError extends Error {
  constructor(url, status) {
    super(`GET ${url} returned HTTP ${String(status)}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function ensureAllowedUrl(input) {
  const url = new URL(input);
  if (!ALLOWED_ORIGINS.has(url.origin) || url.username || url.password) {
    throw new Error(`Refusing update metadata request to ${url.origin}`);
  }
  return url;
}

async function readBoundedBody(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Response exceeds the ${String(maximumBytes)} byte limit`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel('response size limit exceeded');
      throw new Error(`Response exceeds the ${String(maximumBytes)} byte limit`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function fetchJson(
  input,
  {
    fetchImpl = globalThis.fetch,
    token,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maximumBytes = MAX_RESPONSE_BYTES,
  } = {}
) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  const url = ensureAllowedUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    accept: 'application/json',
    'user-agent': 'domternal-self-hosting-update-checker',
  };
  if (url.origin === 'https://api.github.com') {
    headers.accept = 'application/vnd.github+json';
    headers['x-github-api-version'] = '2022-11-28';
    if (token) headers.authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new HttpStatusError(url.href, response.status);
    const body = await readBoundedBody(response, maximumBytes);
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(`GET ${url.href} returned invalid JSON: ${message(error)}`);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`GET ${url.href} exceeded the ${String(timeoutMs)} ms timeout`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function parseSemver(input) {
  const match = String(input).match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return { major: parts[0], minor: parts[1], patch: parts[2] };
}

export function compareSemver(left, right) {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) throw new Error(`Cannot compare non-stable versions ${left} and ${right}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (parsedLeft[key] !== parsedRight[key]) return parsedLeft[key] < parsedRight[key] ? -1 : 1;
  }
  return 0;
}

function filesBelow(root, predicate) {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && predicate(path)) found.push(path);
    }
  };
  visit(root);
  return found.sort();
}

function addConsistent(map, name, value, description) {
  if (map.has(name) && map.get(name) !== value) {
    throw new Error(`${description} ${name} is pinned inconsistently to ${map.get(name)} and ${value}`);
  }
  map.set(name, value);
}

export function collectInventory(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const npm = new Map();
  for (const path of filesBelow(root, (candidate) => candidate.endsWith('/package.json'))) {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!parseSemver(version)) {
        throw new Error(`${relative(root, path)} must pin runtime dependency ${name} to an exact stable version`);
      }
      addConsistent(npm, name, version, 'npm dependency');
    }
  }

  const dockerReferences = [];
  for (const path of filesBelow(root, (candidate) => candidate.endsWith('/Dockerfile'))) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/^FROM\s+(node:(\d+\.\d+\.\d+)-alpine(\d+\.\d+)@(sha256:[0-9a-f]{64}))(?:\s|$)/gmu)) {
      dockerReferences.push({ path: relative(root, path), reference: match[1], version: match[2], alpine: match[3], digest: match[4] });
    }
  }
  if (dockerReferences.length === 0) throw new Error('No exact Node Docker image references were found');
  const dockerReference = dockerReferences[0];
  for (const candidate of dockerReferences.slice(1)) {
    if (candidate.reference !== dockerReference.reference) {
      throw new Error(`Node Docker images are inconsistent in ${dockerReference.path} and ${candidate.path}`);
    }
  }

  const actions = new Map();
  const workflows = filesBelow(root, (candidate) => /\/\.github\/workflows\/[^/]+\.ya?ml$/u.test(candidate));
  for (const path of workflows) {
    const text = readFileSync(path, 'utf8');
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/u);
      if (!match || match[1].startsWith('./') || match[1].startsWith('docker://')) continue;
      const reference = match[1];
      const at = reference.lastIndexOf('@');
      const source = at === -1 ? reference : reference.slice(0, at);
      const revision = at === -1 ? '' : reference.slice(at + 1);
      const parts = source.split('/');
      if (parts.length < 2 || !/^[0-9a-f]{40}$/u.test(revision)) {
        throw new Error(`${relative(root, path)}:${String(index + 1)} must pin the external action to a full commit SHA`);
      }
      addConsistent(actions, `${parts[0]}/${parts[1]}`, revision, 'GitHub Action');
    }
  }

  const actionlintVersions = new Set();
  const trivyVersions = new Set();
  for (const path of workflows) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/^\s*ACTIONLINT_VERSION:\s*['"]?v?(\d+\.\d+\.\d+)['"]?\s*$/gmu)) {
      actionlintVersions.add(match[1]);
    }
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const trivyUses = lines[index].match(/^(\s*)(-\s*)?uses:\s*aquasecurity\/trivy-action@/u);
      if (!trivyUses) continue;
      const stepIndent = trivyUses[2]
        ? trivyUses[1].length
        : Math.max(0, trivyUses[1].length - 2);
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const indent = lines[cursor].match(/^\s*/u)[0].length;
        if (indent <= stepIndent && /^\s*-\s+/u.test(lines[cursor])) break;
        const version = lines[cursor].match(/^\s*version:\s*['"]?v?(\d+\.\d+\.\d+)['"]?\s*$/u);
        if (version) trivyVersions.add(version[1]);
      }
    }
  }
  if (actionlintVersions.size !== 1) throw new Error('Exactly one consistent actionlint version must be configured');
  if (trivyVersions.size !== 1) throw new Error('Exactly one consistent Trivy scanner version must be configured');

  return {
    npm,
    docker: dockerReference,
    actions,
    tools: new Map([
      ['rhysd/actionlint', [...actionlintVersions][0]],
      ['aquasecurity/trivy', [...trivyVersions][0]],
    ]),
  };
}

function result(category, dependency, current, latest, status, detail, url) {
  return { category, dependency, current, latest, status, detail, url };
}

function updateStatus(current, latest) {
  return compareSemver(current, latest) < 0 ? 'update' : 'current';
}

function npmDeferral(name, current, latest) {
  const acknowledgement = ACKNOWLEDGED_NPM_DEFERRALS.get(name);
  if (!acknowledgement || current !== acknowledgement.current) return null;
  if (compareSemver(current, latest) < 0 && compareSemver(latest, acknowledgement.through) <= 0) {
    return acknowledgement;
  }
  return null;
}

export async function checkNpmUpdates(npmDependencies, options = {}) {
  const rows = [];
  for (const [name, current] of [...npmDependencies].sort(([left], [right]) => left.localeCompare(right))) {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
    try {
      const metadata = await fetchJson(url, options);
      const latest = metadata?.version;
      if (!parseSemver(latest)) throw new Error(`${name} returned an invalid latest stable version`);
      const acknowledgement = npmDeferral(name, current, latest);
      rows.push(result(
        'npm',
        name,
        current,
        latest,
        acknowledgement ? 'deferred' : updateStatus(current, latest),
        acknowledgement?.reason ?? '',
        `https://www.npmjs.com/package/${encodeURIComponent(name)}?activeTab=versions`
      ));
    } catch (error) {
      rows.push(result('npm', name, current, '?', 'error', message(error), url));
    }
  }
  return rows;
}

function parseNodeDockerTag(name) {
  const match = String(name).match(/^(\d+)\.(\d+)\.(\d+)-alpine(\d+\.\d+)$/u);
  if (!match) return null;
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  if (!parseSemver(version)) return null;
  return { name, version, alpine: match[4] };
}

export async function checkDockerUpdates(docker, options = {}) {
  const currentVersion = parseSemver(docker.version);
  if (!currentVersion) return [result('Docker', 'node', docker.reference, '?', 'error', 'The current Node image version is invalid', '')];
  try {
    const candidates = [];
    for (let page = 1; page <= MAX_DOCKER_TAG_PAGES; page += 1) {
      const url = new URL('https://hub.docker.com/v2/repositories/library/node/tags');
      url.searchParams.set('page_size', '25');
      url.searchParams.set('page', String(page));
      url.searchParams.set('name', `-alpine${docker.alpine}`);
      url.searchParams.set('ordering', 'last_updated');
      const metadata = await fetchJson(url, options);
      if (!Array.isArray(metadata?.results)) throw new Error('Docker Hub returned an invalid tag list');
      candidates.push(...metadata.results.map((entry) => parseNodeDockerTag(entry?.name)).filter(Boolean));
      if (!metadata.next || metadata.results.length < 25) break;
    }
    const compatible = candidates.filter((candidate) => {
      const version = parseSemver(candidate.version);
      return version.major === currentVersion.major && candidate.alpine === docker.alpine;
    });
    compatible.sort((left, right) => compareSemver(right.version, left.version));
    const latest = compatible[0];
    if (!latest) throw new Error(`Docker Hub returned no Node ${String(currentVersion.major)} Alpine ${docker.alpine} tags`);

    const tagUrl = `https://hub.docker.com/v2/repositories/library/node/tags/${encodeURIComponent(`${docker.version}-alpine${docker.alpine}`)}`;
    const currentTag = await fetchJson(tagUrl, options);
    if (!/^sha256:[0-9a-f]{64}$/u.test(currentTag?.digest ?? '')) {
      throw new Error('Docker Hub returned an invalid digest for the current Node tag');
    }
    const versionChanged = compareSemver(docker.version, latest.version) < 0;
    const digestChanged = currentTag.digest !== docker.digest;
    const latestReference = `node:${latest.name}`;
    const detail = [
      versionChanged ? 'A newer release exists on the validated Node and Alpine lines.' : '',
      digestChanged ? `The current exact tag now resolves to ${currentTag.digest}.` : '',
    ].filter(Boolean).join(' ');
    const rows = [result(
      'Docker',
      'library/node current line',
      docker.reference,
      versionChanged ? latestReference : `${latestReference}@${currentTag.digest}`,
      versionChanged || digestChanged ? 'update' : 'current',
      detail,
      `https://hub.docker.com/_/node/tags?name=${encodeURIComponent(latest.name)}`
    )];

    const nodeReleases = await fetchJson('https://nodejs.org/dist/index.json', options);
    if (!Array.isArray(nodeReleases)) throw new Error('Node.js returned an invalid release index');
    const latestLts = nodeReleases
      .filter((release) => release?.lts && parseSemver(release?.version))
      .sort((left, right) => compareSemver(right.version, left.version))[0];
    if (!latestLts) throw new Error('Node.js returned no stable LTS release');
    rows.push(result(
      'Runtime',
      'Node.js LTS',
      docker.version,
      latestLts.version.replace(/^v/u, ''),
      updateStatus(docker.version, latestLts.version),
      compareSemver(docker.version, latestLts.version) < 0
        ? 'A newer LTS requires an explicit compatibility review across engines, workflows and images.'
        : '',
      `https://nodejs.org/en/blog/release/${encodeURIComponent(latestLts.version)}`
    ));

    const alpineUrl = new URL('https://hub.docker.com/v2/repositories/library/node/tags');
    alpineUrl.searchParams.set('page_size', '100');
    alpineUrl.searchParams.set('name', `${docker.version}-alpine`);
    const alpineMetadata = await fetchJson(alpineUrl, options);
    if (!Array.isArray(alpineMetadata?.results)) {
      throw new Error('Docker Hub returned an invalid Alpine tag list');
    }
    const alpineLines = alpineMetadata.results
      .map((entry) => parseNodeDockerTag(entry?.name))
      .filter((candidate) => candidate?.version === docker.version)
      .map((candidate) => candidate.alpine)
      .sort((left, right) => compareSemver(`${right}.0`, `${left}.0`));
    const latestAlpine = alpineLines[0];
    if (!latestAlpine) {
      throw new Error(`Docker Hub returned no exact Alpine tags for Node ${docker.version}`);
    }
    rows.push(result(
      'Docker',
      'Alpine base line',
      docker.alpine,
      latestAlpine,
      updateStatus(`${docker.alpine}.0`, `${latestAlpine}.0`),
      latestAlpine !== docker.alpine
        ? 'A newer Alpine line requires an explicit native-module and container compatibility review.'
        : '',
      `https://hub.docker.com/_/node/tags?name=${encodeURIComponent(`${docker.version}-alpine${latestAlpine}`)}`
    ));
    return rows;
  } catch (error) {
    return [result('Docker', 'library/node', docker.reference, '?', 'error', message(error), 'https://hub.docker.com/_/node/tags')];
  }
}

function githubHeadersOptions(options) {
  return { ...options, token: options.githubToken ?? options.token };
}

async function resolveGitHubTag(repository, tag, options) {
  const encodedTag = tag.split('/').map(encodeURIComponent).join('/');
  let object = (await fetchJson(`https://api.github.com/repos/${repository}/git/ref/tags/${encodedTag}`, githubHeadersOptions(options)))?.object;
  for (let depth = 0; depth < 5 && object?.type === 'tag'; depth += 1) {
    object = (await fetchJson(`https://api.github.com/repos/${repository}/git/tags/${object.sha}`, githubHeadersOptions(options)))?.object;
  }
  if (object?.type !== 'commit' || !/^[0-9a-f]{40}$/u.test(object.sha ?? '')) {
    throw new Error(`${repository} release tag did not resolve to a commit`);
  }
  return object.sha;
}

export async function latestGitHubRelease(repository, options = {}) {
  try {
    const release = await fetchJson(`https://api.github.com/repos/${repository}/releases/latest`, githubHeadersOptions(options));
    if (release?.draft || release?.prerelease || typeof release?.tag_name !== 'string') {
      throw new Error(`${repository} returned an invalid latest stable release`);
    }
    const sha = await resolveGitHubTag(repository, release.tag_name, options);
    return {
      version: release.tag_name,
      sha,
      url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}`,
    };
  } catch (error) {
    if (!(error instanceof HttpStatusError) || error.status !== 404) throw error;
    const tags = await fetchJson(`https://api.github.com/repos/${repository}/tags?per_page=100`, githubHeadersOptions(options));
    if (!Array.isArray(tags)) throw new Error(`${repository} returned an invalid tag list`);
    const stable = tags
      .filter((tag) => parseSemver(tag?.name) && /^[0-9a-f]{40}$/u.test(tag?.commit?.sha ?? ''))
      .sort((left, right) => compareSemver(right.name, left.name))[0];
    if (!stable) throw new Error(`${repository} has no stable semantic-version release or tag`);
    return { version: stable.name, sha: stable.commit.sha, url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(stable.name)}` };
  }
}

export async function checkActionUpdates(actions, options = {}) {
  const rows = [];
  for (const [repository, current] of [...actions].sort(([left], [right]) => left.localeCompare(right))) {
    try {
      const channel = ACTION_CHANNEL_TAGS.get(repository);
      const latest = channel
        ? {
            version: channel,
            sha: await resolveGitHubTag(repository, channel, options),
            url: `https://github.com/${repository}/tree/${encodeURIComponent(channel)}`,
          }
        : await latestGitHubRelease(repository, options);
      rows.push(result('GitHub Action', repository, current, `${latest.version} (${latest.sha})`, current === latest.sha ? 'current' : 'update', '', latest.url));
    } catch (error) {
      rows.push(result('GitHub Action', repository, current, '?', 'error', message(error), `https://github.com/${repository}/releases`));
    }
  }
  return rows;
}

export async function checkToolUpdates(tools, options = {}) {
  const rows = [];
  for (const [repository, current] of [...tools].sort(([left], [right]) => left.localeCompare(right))) {
    try {
      const latest = await latestGitHubRelease(repository, options);
      if (!parseSemver(latest.version)) throw new Error(`${repository} returned a non-semantic stable release ${latest.version}`);
      rows.push(result('Tool', repository, current, latest.version.replace(/^v/u, ''), updateStatus(current, latest.version), '', latest.url));
    } catch (error) {
      rows.push(result('Tool', repository, current, '?', 'error', message(error), `https://github.com/${repository}/releases`));
    }
  }
  return rows;
}

function markdown(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/[\r\n]+/gu, ' ');
}

export function buildMarkdownReport(rows) {
  const alerts = rows.filter((row) => row.status === 'update');
  const errors = rows.filter((row) => row.status === 'error');
  const deferred = rows.filter((row) => row.status === 'deferred');
  const heading = errors.length > 0
    ? 'Dependency update check incomplete'
    : alerts.length > 0 || deferred.length > 0
      ? 'Dependency updates available'
      : 'Dependency versions are current';
  const output = [
    `## ${heading}`,
    '',
    `Checked ${String(rows.length)} dependency and tool entries. Updates: ${String(alerts.length)}. Deferred: ${String(deferred.length)}. Errors: ${String(errors.length)}.`,
    '',
    '| Category | Dependency | Current | Latest | Status | Detail |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const dependency = row.url ? `[${markdown(row.dependency)}](${row.url})` : markdown(row.dependency);
    output.push(`| ${markdown(row.category)} | ${dependency} | \`${markdown(row.current)}\` | \`${markdown(row.latest)}\` | ${markdown(row.status)} | ${markdown(row.detail)} |`);
  }
  output.push('', 'This workflow only reads public release metadata. It does not install updates or create pull requests, issues, commits, releases, or packages.', '');
  return output.join('\n');
}

export function rowsRequireAttention(rows) {
  return rows.some((row) => ['update', 'deferred', 'error'].includes(row.status));
}

export async function runUpdateCheck({ repositoryRoot, fetchImpl = globalThis.fetch, githubToken } = {}) {
  const inventory = collectInventory(repositoryRoot);
  const options = { fetchImpl, githubToken };
  const groups = await Promise.all([
    checkNpmUpdates(inventory.npm, options),
    checkDockerUpdates(inventory.docker, options),
    checkActionUpdates(inventory.actions, options),
    checkToolUpdates(inventory.tools, options),
  ]);
  const rows = groups.flat();
  return {
    rows,
    markdown: buildMarkdownReport(rows),
    failed: rowsRequireAttention(rows),
  };
}

async function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let report;
  try {
    report = await runUpdateCheck({
      repositoryRoot,
      githubToken: process.env.GITHUB_TOKEN,
    });
  } catch (error) {
    const rows = [result('Checker', 'repository inventory', '?', '?', 'error', message(error), '')];
    report = { rows, markdown: buildMarkdownReport(rows), failed: true };
  }
  console.log(report.markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.markdown, 'utf8');
  if (report.failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
