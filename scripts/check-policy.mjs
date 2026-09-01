#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXACT_RUNTIME_DEPENDENCIES } from '../collab-server/scripts/check-artifacts.mjs';

const NODE_IMAGE_TAG = 'node:22.23.2-alpine3.24';
const SUPPORTED_NODE_VERSION = '22.23.2';
const STABLE_RELEASE_TAG = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const RUNTIME_PACKAGE_MANAGER_CLEANUP_INSTRUCTION =
  'RUN rm -rf /opt/yarn-v1.22.22 /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/npm && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg';
const AI_PRODUCTION_START =
  'node --env-file-if-exists=.env --input-type=module --eval "process.env.NODE_ENV=\'production\'; await import(\'./index.mjs\')"';
const COLLAB_PRODUCTION_START =
  'node --env-file-if-exists=.env --input-type=module --eval "process.env.NODE_ENV=\'production\'; await import(\'./index.mjs\')"';
const CONTAINER_BACKUP_IMPORT = [
  '  compose(',
  '    [',
  "      'run',",
  "      '--rm',",
  "      '--no-deps',",
  "      '--no-TTY',",
  "      '--entrypoint',",
  "      'sh',",
  "      'collab-server',",
  "      '-ec',",
  `      'umask 077; set -C; cat > "$1"',`,
  "      'sh',",
  "      '/data/e2e-restore.sqlite',",
  '    ],',
  '    { input: readFileSync(hostBackup) }',
  '  );',
].join('\n');
const DOCUMENTED_BACKUP_IMPORTS = [
  [
    'docker compose run --rm --no-deps -T \\',
    '  --entrypoint sh collab-server \\',
    `  -ec 'umask 077; set -C; cat > "$1"' sh "$verify_path" < "$backup_path"`,
  ].join('\n'),
  [
    'docker compose run --rm --no-deps -T \\',
    '  --entrypoint sh collab-server \\',
    `  -ec 'umask 077; set -C; cat > "$1"' sh "$restore_input" < "$backup_path"`,
  ].join('\n'),
];

function read(root, path, problems) {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch (error) {
    problems.push(`${path} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

function count(text, fragment) {
  return text.split(fragment).length - 1;
}

function requireText(text, fragment, path, problems) {
  if (!text.includes(fragment)) problems.push(`${path} is missing ${JSON.stringify(fragment)}`);
}

export function actionReferenceProblems(text, path = 'workflow.yml') {
  const problems = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/u);
    if (!match || match[1].startsWith('./')) continue;
    if (match[1].startsWith('docker://')) {
      if (!/@sha256:[0-9a-f]{64}$/u.test(match[1])) {
        problems.push(`${path}:${String(index + 1)} container action is not pinned to a sha256 digest`);
      }
      continue;
    }
    const at = match[1].lastIndexOf('@');
    const revision = at === -1 ? '' : match[1].slice(at + 1);
    if (!/^[0-9a-f]{40}$/u.test(revision)) {
      problems.push(`${path}:${String(index + 1)} action is not pinned to a full commit SHA`);
    }
  }
  return problems;
}

function withoutYamlComment(raw) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && raw[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/u.test(raw[index - 1]))) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

function namesPullRequestTarget(value) {
  return /(?:^|[\s,[{])(?:pull_request_target|["']pull_request_target["'])(?=$|[\s,\]}:])/u.test(
    value
  );
}

export function workflowTriggerProblems(text, path = 'workflow.yml') {
  const problems = [];
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = withoutYamlComment(raw);
    if (line.trim() === '') continue;
    // Be intentionally conservative: reject the event token anywhere in
    // effective YAML, including flow collections and aliases defined outside
    // the `on` block. Comments are removed with quote-aware YAML rules above.
    if (namesPullRequestTarget(line)) {
      problems.push(`${path}:${String(index + 1)} uses the forbidden pull_request_target trigger`);
    }
  }
  return problems;
}

export function dependabotVersionUpdateProblems(
  text,
  path = '.github/dependabot.yml'
) {
  const problems = [];
  const expectedEcosystems = ['npm', 'docker', 'github-actions'];
  const sections = [...text.matchAll(/^\s*-\s+package-ecosystem:\s*['"]?([^'"\s#]+)['"]?\s*$/gmu)];

  for (const ecosystem of expectedEcosystems) {
    const matches = sections.filter((section) => section[1] === ecosystem);
    if (matches.length !== 1) {
      problems.push(`${path} must contain exactly one ${ecosystem} update entry`);
      continue;
    }
    const section = matches[0];
    const next = sections.find((candidate) => candidate.index > section.index);
    const body = text.slice(section.index, next?.index ?? text.length);
    if (!/^\s{4}open-pull-requests-limit:\s*0\s*(?:#.*)?$/mu.test(body)) {
      problems.push(`${path} ${ecosystem} version updates must keep open-pull-requests-limit at 0`);
    }
  }

  return problems;
}

export function issueRoutingProblems(
  text,
  path = '.github/ISSUE_TEMPLATE/config.yml'
) {
  const problems = [];
  for (const fragment of [
    'blank_issues_enabled: false',
    'https://github.com/domternal/domternal/issues/new?template=self_hosting_bug_report.yml',
    'https://github.com/domternal/domternal/issues/new?template=feature_request.yml',
    'https://github.com/domternal/self-hosting/security/policy',
  ]) {
    requireText(text, fragment, path, problems);
  }
  return problems;
}

function indentation(line) {
  return line.match(/^\s*/u)?.[0].length ?? 0;
}

export function checkoutCredentialProblems(text, path = 'workflow.yml') {
  const problems = [];
  const lines = text.split(/\r?\n/u);
  const isStepStart = (line) => /^\s*-\s+\S/u.test(line);
  for (const [index, line] of lines.entries()) {
    if (!/^\s*-?\s*uses:\s*actions\/checkout@/u.test(line)) continue;

    let stepStart = index;
    while (stepStart > 0 && !isStepStart(lines[stepStart])) {
      stepStart -= 1;
    }
    const stepIndent = indentation(lines[stepStart]);
    let stepEnd = lines.length;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      if (indentation(lines[candidate]) === stepIndent && isStepStart(lines[candidate])) {
        stepEnd = candidate;
        break;
      }
    }
    const step = lines.slice(stepStart, stepEnd).join('\n');
    if (!/^\s+persist-credentials:\s*false\s*(?:#.*)?$/mu.test(step)) {
      problems.push(
        `${path}:${String(index + 1)} checkout must set persist-credentials: false in the same step`
      );
    }
  }
  return problems;
}

export function rootPermissionProblems(text, path = 'workflow.yml') {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^permissions:/u.test(line));
  if (start === -1) return [`${path} must declare top-level permissions`];
  if (lines[start].trim() !== 'permissions:') {
    return [`${path}:${String(start + 1)} top-level permissions must be an explicit mapping`];
  }

  const permissions = new Map();
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (indentation(line) === 0) break;
    const match = line.match(/^\s{2}([a-z-]+):\s*([^#\s]+)\s*(?:#.*)?$/u);
    if (match) permissions.set(match[1], match[2]);
  }
  if (permissions.size !== 1 || permissions.get('contents') !== 'read') {
    return [`${path} top-level permissions must be exactly contents: read`];
  }
  return [];
}

export function requiredWorkflowEventProblems(
  text,
  path = 'workflow.yml',
  requiredEvents = ['push', 'pull_request', 'merge_group']
) {
  const lines = text.split(/\r?\n/u);
  const onStart = lines.findIndex((line) => line.trim() === 'on:' && indentation(line) === 0);
  if (onStart === -1) return [`${path} must use a block on: declaration`];

  const events = new Map();
  for (let index = onStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (indentation(line) === 0) break;
    const match = line.match(/^\s{2}([a-z_]+):/u);
    if (match) events.set(match[1], index);
  }

  const problems = [];
  for (const event of requiredEvents) {
    if (!events.has(event)) problems.push(`${path} must run on ${event}`);
  }
  for (const event of ['push', 'pull_request']) {
    if (!events.has(event) || !requiredEvents.includes(event)) continue;
    const start = events.get(event);
    const nextEvent = [...events.values()]
      .filter((line) => line > start)
      .sort((left, right) => left - right)[0] ?? lines.length;
    const block = lines.slice(start + 1, nextEvent).join('\n');
    if (!/^\s{4}branches:\s*\[main\]\s*(?:#.*)?$/mu.test(block)) {
      problems.push(`${path} ${event} must be limited to main`);
    }
  }
  return problems;
}

function workflowJobBlock(text, job) {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start === -1) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/u.test(lines[index]) || /^\S/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function workflowStepBlock(jobText, id) {
  const lines = jobText.split(/\r?\n/u);
  const idLine = lines.findIndex((line) => line === `        id: ${id}`);
  if (idLine === -1) return '';
  let start = idLine;
  while (start >= 0 && !/^      -\s+\S/u.test(lines[start])) start -= 1;
  if (start === -1) return '';
  let end = lines.length;
  for (let index = idLine + 1; index < lines.length; index += 1) {
    if (/^      -\s+\S/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

export function deploymentLockWorkflowProblems(
  text,
  path = '.github/workflows/ci.yml'
) {
  const problems = [];
  const staticPolicy = workflowJobBlock(text, 'static-policy');
  const dependencyLock = workflowJobBlock(text, 'dependency-lock');
  const containers = workflowJobBlock(text, 'containers');
  if (staticPolicy === '') problems.push(`${path} is missing the static-policy job`);
  if (dependencyLock === '') problems.push(`${path} is missing the dependency-lock job`);
  if (containers === '') problems.push(`${path} is missing the containers job`);
  if (problems.length > 0) return problems;

  for (const fragment of [
    'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    '          node-version: 22.23.2',
    '          package-manager-cache: false',
    '      - name: Require the committed deployment lock',
    '        run: node scripts/require-lockfile.mjs',
    '          node scripts/check-commercial-boundary.mjs',
  ]) {
    requireText(staticPolicy, fragment, path, problems);
  }
  const nodeSetup = staticPolicy.indexOf('          node-version: 22.23.2');
  const gateStep = staticPolicy.indexOf('        run: node scripts/require-lockfile.mjs');
  if (nodeSetup === -1 || gateStep === -1 || nodeSetup > gateStep) {
    problems.push(`${path} static-policy must select the supported Node release before the deployment-lock gate`);
  }
  for (const [jobName, jobText] of [
    ['static-policy', staticPolicy],
    ['dependency-lock', dependencyLock],
    ['containers', containers],
  ]) {
    if (/^\s+continue-on-error:/mu.test(jobText)) {
      problems.push(`${path} ${jobName} must not ignore any job or step failure`);
    }
  }

  if (/^    outputs:/mu.test(staticPolicy)) {
    problems.push(`${path} static-policy must not expose an optional deployment-lock output`);
  }

  if (!/^    needs:\s+static-policy\s*$/mu.test(dependencyLock)) {
    problems.push(`${path} dependency-lock must depend on static-policy`);
  }
  if (/^    if:/mu.test(dependencyLock)) {
    problems.push(`${path} dependency-lock must not be conditional`);
  }
  for (const fragment of [
    '      - name: Exercise local thread garbage collection',
    '        working-directory: collab-server',
    '        run: npm test',
  ]) {
    requireText(dependencyLock, fragment, path, problems);
  }
  if (!/^      -\s+dependency-lock\s*$/mu.test(containers)) {
    problems.push(`${path} containers must depend on the frozen dependency-lock job`);
  }
  return problems;
}

export function dependencyUpdateWorkflowProblems(
  text,
  path = '.github/workflows/dependency-update-report.yml'
) {
  const problems = [
    ...requiredWorkflowEventProblems(text, path, ['schedule', 'workflow_dispatch']),
    ...rootPermissionProblems(text, path),
    ...checkoutCredentialProblems(text, path),
    ...actionReferenceProblems(text, path),
    ...workflowTriggerProblems(text, path),
  ];
  const lines = text.split(/\r?\n/u);
  const onStart = lines.findIndex((line) => line.trim() === 'on:' && indentation(line) === 0);
  const events = [];
  if (onStart !== -1) {
    for (let index = onStart + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
      if (indentation(line) === 0) break;
      const match = line.match(/^\s{2}([a-z_]+):/u);
      if (match) events.push(match[1]);
    }
  }
  const expectedEvents = new Set(['schedule', 'workflow_dispatch']);
  for (const event of events) {
    if (!expectedEvents.has(event)) {
      problems.push(`${path} must not run on ${event}`);
    }
  }

  for (const fragment of [
    "cron: '17 6 * * 1'",
    'runs-on: ubuntu-24.04',
    'timeout-minutes: 10',
    'node-version: 22.23.2',
    'package-manager-cache: false',
    'GITHUB_TOKEN: ${{ github.token }}',
    'run: node scripts/check-updates.mjs',
  ]) {
    requireText(text, fragment, path, problems);
  }

  const actionReferences = [...text.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map(
    (match) => match[1]
  );
  const expectedActions = [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  ];
  if (
    actionReferences.length !== expectedActions.length ||
    expectedActions.some((reference) => !actionReferences.includes(reference))
  ) {
    problems.push(`${path} may use only the reviewed checkout and setup-node actions`);
  }
  if ((text.match(/^\s*run:/gmu) ?? []).length !== 1) {
    problems.push(`${path} must execute exactly one local read-only command`);
  }
  if ((text.match(/^\s*permissions:/gmu) ?? []).length !== 1) {
    problems.push(`${path} must declare permissions only once at the top level`);
  }
  if (/^\s*permissions:\s*write-all\s*(?:#.*)?$/mu.test(text)) {
    problems.push(`${path} must not grant write-all permissions`);
  }
  if (/^\s+[a-z-]+:\s*write\s*(?:#.*)?$/mu.test(text)) {
    problems.push(`${path} must not grant write permissions at any scope`);
  }
  if (/\b(?:git\s+push|gh\s+(?:issue|pr|release)|npm\s+publish|docker\s+push)\b/u.test(text)) {
    problems.push(`${path} must not create, publish or push anything`);
  }
  return problems;
}

export function releaseTagWorkflowProblems(
  text,
  path = '.github/workflows/ci.yml'
) {
  const problems = [];
  const lines = text.split(/\r?\n/u);
  const pushStart = lines.findIndex((line) => line === '  push:');
  let pushEnd = lines.length;
  for (let index = pushStart + 1; index < lines.length; index += 1) {
    if (/^  [a-z_]+:/u.test(lines[index])) {
      pushEnd = index;
      break;
    }
  }
  const push = pushStart === -1 ? '' : lines.slice(pushStart, pushEnd).join('\n').trimEnd();
  const expectedPush = [
    '  push:',
    '    branches: [main]',
    '    tags:',
    "      - 'v[0-9]*.[0-9]*.[0-9]*'",
  ].join('\n');
  if (push !== expectedPush) {
    problems.push(`${path} push must cover main and the reviewed vX.Y.Z release tag glob`);
  }
  const staticPolicy = workflowJobBlock(text, 'static-policy');
  const dependencyLock = workflowJobBlock(text, 'dependency-lock');
  const containers = workflowJobBlock(text, 'containers');
  for (const fragment of [
    'fetch-depth: 0',
    'node-version: 22.23.2',
    "if: github.ref_type == 'tag'",
    'run: node scripts/check-policy.mjs --release-tag "$GITHUB_REF_NAME"',
  ]) {
    requireText(staticPolicy, fragment, path, problems);
  }
  if (count(staticPolicy, 'run: node scripts/check-policy.mjs --release-tag "$GITHUB_REF_NAME"') !== 1) {
    problems.push(`${path} must contain exactly one source release preflight step`);
  }
  const preflight = staticPolicy.indexOf(
    'run: node scripts/check-policy.mjs --release-tag "$GITHUB_REF_NAME"'
  );
  const deploymentLock = staticPolicy.indexOf('run: node scripts/require-lockfile.mjs');
  if (preflight === -1 || deploymentLock === -1 || preflight > deploymentLock) {
    problems.push(`${path} must verify a release tag before the deployment-lock gate`);
  }
  const staticConditions = staticPolicy.match(/^\s+if:\s*.+$/gmu) ?? [];
  if (staticConditions.length !== 1 || staticConditions[0].trim() !== "if: github.ref_type == 'tag'") {
    problems.push(`${path} static-policy may condition only the release preflight step`);
  }
  if ((dependencyLock.match(/^\s+if:\s*.+$/gmu) ?? []).length !== 0) {
    problems.push(`${path} dependency-lock must run for every selected release tag`);
  }
  const containerConditions = (containers.match(/^\s+if:\s*.+$/gmu) ?? []).map((line) => line.trim());
  if (containerConditions.length !== 1 || containerConditions[0] !== 'if: always()') {
    problems.push(`${path} containers may condition only the final cleanup step`);
  }
  return problems;
}

export function releaseTagProblems(tag) {
  if (typeof tag !== 'string' || !STABLE_RELEASE_TAG.test(tag)) {
    return ['release tag must be a stable vX.Y.Z version without leading zeroes'];
  }
  return [];
}

export function releaseStateProblems({
  tag,
  nodeVersion,
  status,
  head,
  originMain,
  tagTarget,
  tagObjectType = null,
  githubActions = false,
  githubRefType = '',
  githubRefName = '',
  githubSha = '',
}) {
  const problems = [...releaseTagProblems(tag)];
  if (nodeVersion !== SUPPORTED_NODE_VERSION) {
    problems.push(`release verification requires Node ${SUPPORTED_NODE_VERSION}, received ${nodeVersion}`);
  }
  if (status !== '') problems.push('release verification requires a clean working tree');
  if (!COMMIT_SHA.test(head)) problems.push('HEAD did not resolve to a commit SHA');
  if (!COMMIT_SHA.test(originMain)) {
    problems.push('origin/main did not resolve to a commit SHA; fetch the current main branch first');
  } else if (COMMIT_SHA.test(head) && head !== originMain) {
    problems.push('release commit must exactly match the fetched origin/main commit');
  }
  if (tagTarget !== null && !COMMIT_SHA.test(tagTarget)) {
    problems.push('release tag did not resolve to a commit SHA');
  } else if (COMMIT_SHA.test(tagTarget ?? '') && COMMIT_SHA.test(head) && tagTarget !== head) {
    problems.push('release tag must resolve to the current HEAD commit');
  }
  if (tagTarget !== null && tagObjectType !== 'tag') {
    problems.push('an existing release tag must be annotated, not lightweight');
  }
  if (githubActions) {
    if (githubRefType !== 'tag') problems.push('GitHub release verification must run from a tag ref');
    if (githubRefName !== tag) problems.push('GitHub tag name does not match the requested release tag');
    if (githubSha !== head) problems.push('GitHub release SHA does not match the checked-out commit');
    if (tagTarget === null) problems.push('GitHub release tag is missing from the complete checkout');
  }
  return problems;
}

function releaseGit(root, arguments_, { allowMissing = false } = {}) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_WORK_TREE',
  ]) {
    delete env[name];
  }
  const result = spawnSync('git', arguments_, { cwd: root, encoding: 'utf8', env });
  if (result.status === 0) return result.stdout.trim();
  if (allowMissing) return null;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
  throw new Error(`git ${arguments_.join(' ')} failed: ${detail}`);
}

function releasePreflightProblems(root, tag) {
  const tagProblems = releaseTagProblems(tag);
  if (tagProblems.length > 0) return tagProblems;
  const head = releaseGit(root, ['rev-parse', '--verify', 'HEAD']);
  const originMain = releaseGit(root, ['rev-parse', '--verify', 'refs/remotes/origin/main']);
  const status = releaseGit(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const tagTarget = releaseGit(root, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], {
    allowMissing: true,
  });
  const tagObjectType = releaseGit(root, ['cat-file', '-t', `refs/tags/${tag}`], {
    allowMissing: true,
  });
  return releaseStateProblems({
    tag,
    nodeVersion: process.versions.node,
    status,
    head,
    originMain,
    tagTarget,
    tagObjectType,
    githubActions: process.env.GITHUB_ACTIONS === 'true',
    githubRefType: process.env.GITHUB_REF_TYPE ?? '',
    githubRefName: process.env.GITHUB_REF_NAME ?? '',
    githubSha: process.env.GITHUB_SHA ?? '',
  });
}

export function trivyMatrixCoverageProblems(
  text,
  path = '.github/workflows/ci.yml'
) {
  const problems = [];
  const lines = text.split(/\r?\n/u);
  const action = 'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25';
  const indexes = lines
    .map((line, index) => (line.includes(`uses: ${action}`) ? index : -1))
    .filter((index) => index !== -1);
  if (indexes.length !== 4) {
    problems.push(`${path} must run exactly four reviewed Trivy scan steps`);
    return problems;
  }
  for (const actionIndex of indexes) {
    let start = actionIndex;
    while (start > 0 && !/^\s*-\s+name:/u.test(lines[start])) start -= 1;
    const stepIndent = indentation(lines[start]);
    let end = lines.length;
    for (let index = actionIndex + 1; index < lines.length; index += 1) {
      if (indentation(lines[index]) === stepIndent && /^\s*-\s+name:/u.test(lines[index])) {
        end = index;
        break;
      }
    }
    const step = lines.slice(start, end).join('\n');
    if (/^\s+if:/mu.test(step)) {
      problems.push(`${path}:${String(actionIndex + 1)} Trivy must scan both architecture matrix entries`);
    }
    if (!/^\s+version:\s*v0\.74\.0\s*$/mu.test(step)) {
      problems.push(`${path}:${String(actionIndex + 1)} Trivy must use scanner v0.74.0`);
    }
  }
  return problems;
}

export function dependencyUpdateScriptProblems(
  text,
  path = 'scripts/check-updates.mjs'
) {
  const problems = [];
  const originBlock = text.match(
    /const ALLOWED_ORIGINS = new Set\(\[([\s\S]*?)\]\);/u
  )?.[1] ?? '';
  const origins = [...originBlock.matchAll(/['"](https:\/\/[^/'"]+)['"]/gu)]
    .map((match) => match[1])
    .sort();
  const expectedOrigins = [
    'https://api.github.com',
    'https://hub.docker.com',
    'https://nodejs.org',
    'https://registry.npmjs.org',
  ].sort();
  if (JSON.stringify(origins) !== JSON.stringify(expectedOrigins)) {
    problems.push(`${path} must keep the exact reviewed metadata origin allowlist`);
  }

  const fsImport = text.match(/import \{([^}]+)\} from 'node:fs';/u)?.[1] ?? '';
  const fsFunctions = fsImport.split(',').map((name) => name.trim()).filter(Boolean).sort();
  const expectedFsFunctions = ['appendFileSync', 'readFileSync', 'readdirSync'].sort();
  if (JSON.stringify(fsFunctions) !== JSON.stringify(expectedFsFunctions)) {
    problems.push(`${path} may only read repository files and append the Actions summary`);
  }
  if (/from ['"]node:(?:child_process|dgram|http|https|net|tls|worker_threads)['"]/u.test(text)) {
    problems.push(`${path} must not import process execution or raw network modules`);
  }
  if ((text.match(/\bfetchImpl\s*\(/gu) ?? []).length !== 1) {
    problems.push(`${path} must route every metadata request through the reviewed fetch gate`);
  }
  if (!/method:\s*'GET'/u.test(text) || /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/iu.test(text)) {
    problems.push(`${path} may issue only GET metadata requests`);
  }
  if (!/redirect:\s*'error'/u.test(text)) {
    problems.push(`${path} must refuse HTTP redirects`);
  }
  const summaryWrites = [...text.matchAll(/\bappendFileSync\s*\(([^\n]+)/gu)];
  if (
    summaryWrites.length !== 1 ||
    !summaryWrites[0][1].startsWith('process.env.GITHUB_STEP_SUMMARY, report.markdown,')
  ) {
    problems.push(`${path} may write only to the GitHub Actions job summary`);
  }
  return problems;
}

export function composePolicyProblems(text, path = 'docker-compose.yml') {
  const problems = [];
  if (/^\s+environment:\s*\{/mu.test(text)) {
    problems.push(`${path} must use block-style service environment mappings`);
  }
  for (const [fragment, minimum] of [
    ['read_only: true', 2],
    ['init: true', 2],
    ['restart: unless-stopped', 2],
    ['stop_grace_period: 30s', 2],
    ['no-new-privileges:true', 2],
    ['cap_drop:', 2],
    ['tmpfs:', 2],
    ['pids_limit:', 2],
    ['driver: local', 2],
    ['127.0.0.1:${', 3],
  ]) {
    if (count(text, fragment) < minimum) {
      problems.push(`${path} needs at least ${String(minimum)} occurrence(s) of ${fragment}`);
    }
  }
  for (const secret of [
    'COLLAB_TOKENS_FILE: /run/secrets/collab_tokens',
    'COLLAB_READONLY_TOKENS_FILE: /run/secrets/collab_readonly_tokens',
    'WEBHOOK_SECRET_FILE: /run/secrets/webhook_secret',
    'PROVIDER_API_KEY_FILE: /run/secrets/provider_api_key',
    'AI_TOKENS_FILE: /run/secrets/ai_tokens',
    'COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS:',
    'WEBHOOK_ALLOW_INSECURE_HTTP:',
    'UPSTREAM_ALLOW_INSECURE_HTTP:',
    'file: "${COLLAB_TOKENS_SOURCE_FILE:-./secrets/collab_tokens}"',
    'file: "${COLLAB_READONLY_TOKENS_SOURCE_FILE:-./secrets/collab_readonly_tokens}"',
    'file: "${WEBHOOK_SECRET_SOURCE_FILE:-./secrets/webhook_secret}"',
    'file: "${PROVIDER_API_KEY_SOURCE_FILE:-./secrets/provider_api_key}"',
    'file: "${AI_TOKENS_SOURCE_FILE:-./secrets/ai_tokens}"',
  ]) {
    requireText(text, secret, path, problems);
  }
  for (const environmentSecret of [
    'COLLAB_TOKENS',
    'COLLAB_READONLY_TOKENS',
    'WEBHOOK_SECRET',
    'PROVIDER_API_KEY',
    'AI_TOKENS',
  ]) {
    if (text.includes(`environment: ${environmentSecret}`)) {
      problems.push(
        `${path} must use file-backed secrets because environment-backed secrets are incompatible with read-only services`
      );
    }
  }
  for (const rawSecret of [
    'COLLAB_TOKENS',
    'COLLAB_READONLY_TOKENS',
    'WEBHOOK_SECRET',
    'PROVIDER_API_KEY',
    'AI_TOKENS',
  ]) {
    const exposed = new RegExp(`^\\s+["']?${rawSecret}["']?\\s*:`, 'mu');
    if (exposed.test(text)) problems.push(`${path} exposes ${rawSecret} directly in a service environment`);
  }
  requireText(text, '- collab-data:/data', path, problems);
  requireText(text, '- collab-network', path, problems);
  requireText(text, '- ai-network', path, problems);
  for (const [service, expected] of [
    ['collab-server', '1g'],
    ['ai-proxy', '512m'],
  ]) {
    const serviceBlock = composeServiceBlock(text, service);
    const limits = [...serviceBlock.matchAll(/^    mem_limit:\s*([^\s#]+)\s*(?:#.*)?$/gmu)].map(
      (match) => match[1]
    );
    if (limits.length !== 1 || limits[0] !== expected) {
      problems.push(`${path} ${service} must set exactly one mem_limit: ${expected}`);
    }
  }
  return problems;
}

export function backupImportPolicyProblems(containerE2e, operations) {
  const problems = [];
  if (count(containerE2e, CONTAINER_BACKUP_IMPORT) !== 1) {
    problems.push(
      'tests/container-e2e.mjs must use the exact binary-safe, no-clobber backup import contract'
    );
  }
  if (/compose\(\s*\[\s*["']cp["']\s*,\s*hostBackup\s*,/u.test(containerE2e)) {
    problems.push('tests/container-e2e.mjs must not copy a host backup into a container as root');
  }
  for (const expected of DOCUMENTED_BACKUP_IMPORTS) {
    if (count(operations, expected) !== 1) {
      problems.push(
        'OPERATIONS.md must use the exact binary-safe, unprivileged backup import contract'
      );
    }
  }
  if (/^\s*docker compose cp\s+[^\n]*\$backup_path[^\n]*collab-server:/mu.test(operations)) {
    problems.push('OPERATIONS.md must not copy a host backup into a container as root');
  }
  return problems;
}

export function finalDockerStageUserProblems(text, path = 'Dockerfile') {
  const problems = [];
  const stageStarts = [...text.matchAll(/^FROM(?:\s|$)/gmu)];
  if (stageStarts.length === 0) {
    problems.push(`${path} has no Docker stage`);
    return problems;
  }
  const finalStage = text.slice(stageStarts.at(-1).index);
  const users = [...finalStage.matchAll(/^USER\s+([^\s#]+)/gmu)].map((match) => match[1]);
  if (users.at(-1) !== 'node') {
    problems.push(`${path} final stage must keep node as its effective user`);
  }
  return problems;
}

function dockerLogicalInstructions(text) {
  const instructions = [];
  let pending = '';
  for (const rawLine of text.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (pending === '' && (trimmed === '' || trimmed.startsWith('#'))) continue;
    const continued = /\\\s*$/u.test(rawLine);
    const fragment = (continued ? rawLine.replace(/\\\s*$/u, '') : rawLine).trim();
    pending = `${pending}${pending === '' || fragment === '' ? '' : ' '}${fragment}`;
    if (!continued) {
      if (pending !== '') instructions.push(pending);
      pending = '';
    }
  }
  return instructions;
}

export function runtimePackageManagerProblems(text, path = 'Dockerfile') {
  const stageStarts = [...text.matchAll(/^FROM(?:\s|$)/gmu)];
  if (stageStarts.length === 0) return [`${path} has no Docker stage`];
  const finalStage = text.slice(stageStarts.at(-1).index);
  const instructions = dockerLogicalInstructions(finalStage);
  const cleanupIndexes = instructions
    .map((instruction, index) =>
      instruction === RUNTIME_PACKAGE_MANAGER_CLEANUP_INSTRUCTION ? index : -1
    )
    .filter((index) => index !== -1);
  if (cleanupIndexes.length !== 1) {
    return [`${path} final stage must remove the exact bundled npm, Corepack and Yarn tools`];
  }
  const firstUser = instructions.findIndex((instruction) => instruction.startsWith('USER '));
  if (firstUser !== -1 && cleanupIndexes[0] > firstUser) {
    return [`${path} must remove bundled package managers before dropping root privileges`];
  }
  return [];
}

function dockerfileProblems(text, path, expectedFromCount, expectedImage, problems) {
  if (/^#\s*syntax=/mu.test(text)) {
    problems.push(`${path} must use the daemon's bundled frontend, not a mutable external syntax image`);
  }
  const froms = text.match(/^FROM\s+([^\s]+)/gmu) ?? [];
  if (froms.length !== expectedFromCount) {
    problems.push(`${path} has ${String(froms.length)} stages, expected ${String(expectedFromCount)}`);
  }
  for (const from of froms) {
    if (from !== `FROM ${expectedImage}`) problems.push(`${path} has unpinned or unexpected base: ${from}`);
  }
  problems.push(...finalDockerStageUserProblems(text, path));
  requireText(text, 'STOPSIGNAL SIGTERM', path, problems);
  requireText(text, 'HEALTHCHECK', path, problems);
  requireText(text, '--chown=node:node', path, problems);
}

function workflowFiles(root) {
  const workflowRoot = join(root, '.github', 'workflows');
  if (!existsSync(workflowRoot)) return [];
  return readdirSync(workflowRoot)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => join('.github', 'workflows', name));
}

function composeServiceBlock(text, service) {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/u.test(lines[index])) {
      end = index;
      break;
    }
    if (/^\S/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function filesBelow(root, directory, problems) {
  const found = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(join(root, current), { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        problems.push(`${path} is a symlink inside a Docker runtime source directory`);
      } else if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        found.push(path.split('\\').join('/'));
      }
    }
  }
  return found.sort();
}

function dockerignoreAllowlistProblems(root, context, fixedFiles, sourceDirectories, problems) {
  const path = `${context}/.dockerignore`;
  const contextRoot = join(root, context);
  const text = read(root, path, problems);
  const rules = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (rules[0] !== '**') problems.push(`${path} must begin with the default-deny ** rule`);

  const expected = new Set(fixedFiles.map((file) => `!${file}`));
  for (const directory of sourceDirectories) {
    expected.add(`!${directory}/`);
    for (const file of filesBelow(contextRoot, directory, problems)) expected.add(`!${file}`);
  }
  const actual = new Set(rules.filter((rule) => rule.startsWith('!')));
  for (const rule of expected) {
    if (!actual.has(rule)) problems.push(`${path} does not allow required runtime file ${rule.slice(1)}`);
  }
  for (const rule of actual) {
    if (!expected.has(rule)) problems.push(`${path} has unclassified or overly broad allow rule ${rule}`);
  }
}

export function collectPolicyProblems(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const problems = [];
  const manifestText = read(root, 'collab-server/package.json', problems);
  try {
    const manifest = JSON.parse(manifestText);
    if (manifest.engines?.node !== '>=22.23.2 <23') {
      problems.push('collab-server/package.json must constrain bare-metal runs to validated Node 22');
    }
    const actual = manifest.dependencies ?? {};
    for (const [name, expected] of Object.entries(EXACT_RUNTIME_DEPENDENCIES)) {
      if (actual[name] !== expected) {
        problems.push(`collab-server/package.json must pin ${name} exactly to ${expected}`);
      }
    }
    for (const name of Object.keys(actual)) {
      if (!(name in EXACT_RUNTIME_DEPENDENCIES)) {
        problems.push(`collab-server/package.json has unclassified dependency ${name}`);
      }
    }
    if (
      manifest.scripts?.['check:database'] !==
      'node --env-file-if-exists=.env scripts/sqlite-maintenance.mjs check'
    ) {
      problems.push('collab-server check:database must honor SQLITE_PATH from the local .env file');
    }
    if (manifest.scripts?.start !== COLLAB_PRODUCTION_START) {
      problems.push('collab-server start must force production after loading the local .env file');
    }
  } catch (error) {
    problems.push(`collab-server/package.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const collabDockerfile = read(root, 'collab-server/Dockerfile', problems);
  const nodeImage = collabDockerfile.match(/^FROM\s+(node:[^\s]+)/mu)?.[1] ?? '';
  if (!new RegExp(`^${NODE_IMAGE_TAG.replaceAll('.', '\\.')}@sha256:[0-9a-f]{64}$`, 'u').test(nodeImage)) {
    problems.push(
      'collab-server/Dockerfile must pin the validated exact Node/Alpine tag to a sha256 digest'
    );
  }
  dockerfileProblems(collabDockerfile, 'collab-server/Dockerfile', 2, nodeImage, problems);
  problems.push(
    ...runtimePackageManagerProblems(collabDockerfile, 'collab-server/Dockerfile')
  );
  for (const fragment of [
    'apk add --no-cache g++ make python3',
    'npm_config_build_from_source=true',
    'NPM_CONFIG_USERCONFIG=/dev/null',
    'NPM_CONFIG_REGISTRY=https://registry.npmjs.org/',
    'NPM_CONFIG_REPLACE_REGISTRY_HOST=never',
    'npm ci --omit=dev --ignore-scripts --strict-peer-deps',
    'npm rebuild better-sqlite3',
    'package-lock.json',
    'scripts/check-lockfile.mjs /app',
    'AS dependencies',
    'AS runtime',
    'scripts/check-artifacts.mjs /app',
  ]) {
    requireText(collabDockerfile, fragment, 'collab-server/Dockerfile', problems);
  }
  const runtimeStage = collabDockerfile.slice(collabDockerfile.lastIndexOf(`FROM ${nodeImage}`));
  for (const tool of ['apk add', 'g++', 'make python3']) {
    if (runtimeStage.includes(tool)) problems.push(`collab runtime stage still contains build tool instruction ${tool}`);
  }
  if (/\bnpm install\b/u.test(collabDockerfile)) {
    problems.push('collab-server/Dockerfile must use npm ci, never npm install');
  }

  const aiDockerfile = read(root, 'ai-proxy/Dockerfile', problems);
  dockerfileProblems(aiDockerfile, 'ai-proxy/Dockerfile', 1, nodeImage, problems);
  problems.push(...runtimePackageManagerProblems(aiDockerfile, 'ai-proxy/Dockerfile'));
  if (/\b(?:npm|pnpm|yarn)\s+(?:install|ci)\b/u.test(aiDockerfile)) {
    problems.push('zero-dependency ai-proxy Dockerfile must not run a package-manager install');
  }
  try {
    const aiManifest = JSON.parse(read(root, 'ai-proxy/package.json', problems));
    if (aiManifest.engines?.node !== '>=22.23.2 <23') {
      problems.push('ai-proxy/package.json must constrain bare-metal runs to validated Node 22');
    }
    if (aiManifest.scripts?.start !== AI_PRODUCTION_START) {
      problems.push('ai-proxy start must force production after loading the local .env file');
    }
  } catch (error) {
    problems.push(`ai-proxy/package.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  requireText(
    read(root, 'collab-server/.env.example', problems),
    'NODE_ENV=production',
    'collab-server/.env.example',
    problems
  );
  requireText(
    read(root, 'ai-proxy/.env.example', problems),
    'NODE_ENV=production',
    'ai-proxy/.env.example',
    problems
  );
  if (read(root, '.nvmrc', problems).trim() !== '22.23.2') {
    problems.push('.nvmrc must select the exact validated Node release');
  }

  const mockDockerfile = read(root, 'tests/mock-provider/Dockerfile', problems);
  dockerfileProblems(mockDockerfile, 'tests/mock-provider/Dockerfile', 1, nodeImage, problems);

  dockerignoreAllowlistProblems(
    root,
    'collab-server',
    ['Dockerfile', 'LICENSE', 'package.json', 'package-lock.json', 'index.mjs'],
    ['src', 'scripts'],
    problems
  );
  dockerignoreAllowlistProblems(
    root,
    'ai-proxy',
    ['Dockerfile', 'LICENSE', 'package.json', 'index.mjs'],
    ['src'],
    problems
  );
  dockerignoreAllowlistProblems(
    root,
    'tests/mock-provider',
    ['Dockerfile', 'package.json', 'index.mjs'],
    [],
    problems
  );

  problems.push(...composePolicyProblems(read(root, 'docker-compose.yml', problems)));
  const e2eCompose = read(root, 'tests/docker-compose.e2e.yml', problems);
  requireText(e2eCompose, 'mock-provider:', 'tests/docker-compose.e2e.yml', problems);
  requireText(e2eCompose, 'mock-webhook:', 'tests/docker-compose.e2e.yml', problems);
  requireText(e2eCompose, '- collab-network', 'tests/docker-compose.e2e.yml', problems);
  requireText(e2eCompose, '- ai-network', 'tests/docker-compose.e2e.yml', problems);
  if (count(e2eCompose, "compress: 'false'") !== 2) {
    problems.push(
      'tests/docker-compose.e2e.yml must disable compression for both one-file mock logs'
    );
  }
  for (const imageName of ['COLLAB_IMAGE_REF', 'AI_IMAGE_REF', 'MOCK_IMAGE_REF']) {
    requireText(
      e2eCompose,
      `${imageName}:-`,
      'tests/docker-compose.e2e.yml',
      problems
    );
  }
  for (const service of ['collab-server', 'ai-proxy', 'mock-provider', 'mock-webhook']) {
    requireText(
      composeServiceBlock(e2eCompose, service),
      'pull_policy: never',
      `tests/docker-compose.e2e.yml service ${service}`,
      problems
    );
  }

  const gitignore = read(root, '.gitignore', problems);
  if (/^package-lock\.json\s*$/mu.test(gitignore)) {
    problems.push('.gitignore must not ignore the deployment package-lock.json');
  }
  for (const pattern of [
    '.envrc',
    '.direnv/',
    'secrets/',
    '.container-e2e-secrets-*/',
    '*.sqlite',
    '*.sqlite-journal',
    '*.sqlite-wal',
    '*.sqlite-shm',
    '*.sqlite.backup',
    '*.sqlite.before-restore-*',
    '*.sqlite.restore-*',
    '*.sqlite3',
    '*.sqlite3-journal',
    '*.sqlite3-wal',
    '*.sqlite3-shm',
    '*.sqlite3.backup',
    '*.sqlite3.before-restore-*',
    '*.sqlite3.restore-*',
    '*.db',
    '*.db-journal',
    '*.db-wal',
    '*.db-shm',
    '*.db.backup',
    '*.db.before-restore-*',
    '*.db.restore-*',
    '*.db3',
    '*.db3-journal',
    '*.db3-wal',
    '*.db3-shm',
    '*.db3.backup',
    '*.db3.before-restore-*',
    '*.db3.restore-*',
  ]) {
    requireText(gitignore, pattern, '.gitignore', problems);
  }

  for (const path of ['ai-proxy/.gitignore', 'collab-server/.gitignore']) {
    const serviceGitignore = read(root, path, problems);
    for (const pattern of ['.env', '.envrc', '.direnv/', 'node_modules/']) {
      requireText(serviceGitignore, pattern, path, problems);
    }
  }
  const collabGitignore = read(root, 'collab-server/.gitignore', problems);
  for (const pattern of ['backups/', '*.sqlite-wal', '*.db-wal']) {
    requireText(collabGitignore, pattern, 'collab-server/.gitignore', problems);
  }

  const containerE2e = read(root, 'tests/container-e2e.mjs', problems);
  for (const fragment of [
    "join(root, 'tests', 'websocket-client.mjs')",
    'createE2EProjectName(process.env.E2E_PROJECT_NAME)',
    'projectCollisionProblems(project, resourceInventory)',
    'verifyWebhookRecords(allWebhooks, websocketDocument)',
    'assert.equal(writerChangeCount, 1)',
    "WEBHOOK_URL: 'http://mock-webhook:1260/hooks/collab'",
    "WEBHOOK_ALLOW_INSECURE_HTTP: '1'",
    "mkdtempSync(join(root, '.container-e2e-secrets-'))",
    "['COLLAB_TOKENS_SOURCE_FILE', 'collab_tokens', WRITER_TOKEN]",
  ]) {
    requireText(containerE2e, fragment, 'tests/container-e2e.mjs', problems);
  }
  const websocketClient = read(root, 'tests/websocket-client.mjs', problems);
  for (const fragment of ['MessageReceiver', "expectedScope = readOnly ? 'readonly' : 'read-write'"]) {
    requireText(websocketClient, fragment, 'tests/websocket-client.mjs', problems);
  }
  for (const npmConfig of ['.npmrc', 'collab-server/.npmrc', 'ai-proxy/.npmrc']) {
    if (existsSync(join(root, npmConfig))) {
      problems.push(`${npmConfig} is forbidden; CI and Docker must use the explicit public-registry config`);
    }
  }
  const envExample = read(root, '.env.example', problems);
  for (const name of [
    'COLLAB_TOKENS_SOURCE_FILE',
    'COLLAB_READONLY_TOKENS_SOURCE_FILE',
    'WEBHOOK_SECRET_SOURCE_FILE',
    'PROVIDER_API_KEY_SOURCE_FILE',
    'AI_TOKENS_SOURCE_FILE',
    'COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS',
  ]) {
    requireText(envExample, `${name}=`, '.env.example', problems);
  }

  const workflows = workflowFiles(root);
  for (const required of [
    'ci.yml',
    'codeql.yml',
    'dependency-review.yml',
    'dependency-update-report.yml',
  ]) {
    if (!workflows.some((path) => path.endsWith(`/${required}`))) {
      problems.push(`.github/workflows/${required} is missing`);
    }
  }
  for (const path of workflows) {
    const text = read(root, path, problems);
    problems.push(...actionReferenceProblems(text, path));
    problems.push(...workflowTriggerProblems(text, path));
    problems.push(...checkoutCredentialProblems(text, path));
    problems.push(...rootPermissionProblems(text, path));
    const requiredEvents = path.endsWith('/dependency-review.yml')
      ? ['pull_request', 'merge_group']
      : path.endsWith('/dependency-update-report.yml')
        ? ['schedule', 'workflow_dispatch']
        : ['push', 'pull_request', 'merge_group'];
    problems.push(...requiredWorkflowEventProblems(text, path, requiredEvents));
    if (/\b(?:docker\s+push|npm\s+publish|pnpm\s+publish|gh\s+release)\b/u.test(text)) {
      problems.push(`${path} contains a forbidden publish/push command`);
    }
  }

  const dependencyUpdateWorkflow = read(
    root,
    '.github/workflows/dependency-update-report.yml',
    problems
  );
  problems.push(...dependencyUpdateWorkflowProblems(dependencyUpdateWorkflow));
  const dependencyUpdateScript = read(root, 'scripts/check-updates.mjs', problems);
  problems.push(...dependencyUpdateScriptProblems(dependencyUpdateScript));

  const ci = read(root, '.github/workflows/ci.yml', problems);
  problems.push(...deploymentLockWorkflowProblems(ci));
  problems.push(...releaseTagWorkflowProblems(ci));
  problems.push(...trivyMatrixCoverageProblems(ci));
  for (const fragment of [
    'docker compose',
    'build --check',
    'npm audit signatures',
    'npm audit --omit=dev',
    'ubuntu-24.04-arm',
    'if: always()',
    'ed142fd0673e97e23eac54620cfb913e5ce36c25',
    'printf \'%s\\n\' \'{}\' > "$RUNNER_TEMP/actionlint.yaml"',
    '-config-file "$RUNNER_TEMP/actionlint.yaml"',
  ]) {
    requireText(ci, fragment, '.github/workflows/ci.yml', problems);
  }
  if (count(ci, 'package-manager-cache: false') !== 3) {
    problems.push('.github/workflows/ci.yml must explicitly disable setup-node package-manager caching');
  }
  requireText(
    read(root, '.github/workflows/codeql.yml', problems),
    'cdf488f595d80d6e07e03d4674febd5ab45fa938',
    '.github/workflows/codeql.yml',
    problems
  );
  requireText(
    read(root, '.github/workflows/dependency-review.yml', problems),
    'a1d282b36b6f3519aa1f3fc636f609c47dddb294',
    '.github/workflows/dependency-review.yml',
    problems
  );

  for (const path of [
    'CONTRIBUTING.md',
    'SUPPORT.md',
    'OPERATIONS.md',
    'docs/MAINTAINER-RELEASE-CHECKLIST.md',
    '.github/dependabot.yml',
    '.github/ISSUE_TEMPLATE/config.yml',
    '.github/pull_request_template.md',
    'scripts/check-updates.mjs',
  ]) {
    if (!existsSync(join(root, path))) problems.push(`${path} is missing`);
  }
  const issueRouting = read(root, '.github/ISSUE_TEMPLATE/config.yml', problems);
  problems.push(...issueRoutingProblems(issueRouting));
  const operations = read(root, 'OPERATIONS.md', problems);
  problems.push(...backupImportPolicyProblems(containerE2e, operations));
  const dependabot = read(root, '.github/dependabot.yml', problems);
  problems.push(...dependabotVersionUpdateProblems(dependabot));
  for (const fragment of [
    'package-ecosystem: npm',
    'package-ecosystem: docker',
    'directories:',
    '- /collab-server',
    '- /ai-proxy',
    '- /tests/mock-provider',
    'group-by: dependency-name',
    'package-ecosystem: github-actions',
  ]) {
    requireText(dependabot, fragment, '.github/dependabot.yml', problems);
  }
  return problems;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== '--release-tag')) {
    console.error('[self-hosting-policy] FAILED: usage: node scripts/check-policy.mjs [--release-tag vX.Y.Z]');
    process.exitCode = 1;
    return;
  }
  let problems;
  try {
    problems = collectPolicyProblems(root);
    if (arguments_.length === 2) problems.push(...releasePreflightProblems(root, arguments_[1]));
  } catch (error) {
    console.error(`[self-hosting-policy] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  if (problems.length > 0) {
    console.error('[self-hosting-policy] FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  const release = arguments_.length === 2 ? ` and source release ${arguments_[1]}` : '';
  console.log(`[self-hosting-policy] OK - supply-chain, container and CI policy${release} verified`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
