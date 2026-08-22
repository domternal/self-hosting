#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXACT_RUNTIME_DEPENDENCIES } from '../collab-server/scripts/check-artifacts.mjs';

const NODE_IMAGE_TAG = 'node:22.23.2-alpine3.24';
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
  for (const required of ['ci.yml', 'codeql.yml', 'dependency-review.yml']) {
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
      : ['push', 'pull_request', 'merge_group'];
    problems.push(...requiredWorkflowEventProblems(text, path, requiredEvents));
    if (/\b(?:docker\s+push|npm\s+publish|pnpm\s+publish|gh\s+release)\b/u.test(text)) {
      problems.push(`${path} contains a forbidden publish/push command`);
    }
  }

  const ci = read(root, '.github/workflows/ci.yml', problems);
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
    'db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28',
    '.github/workflows/codeql.yml',
    problems
  );
  requireText(
    read(root, '.github/workflows/dependency-review.yml', problems),
    'a1d282b36b6f3519aa1f3fc636f609c47dddb294',
    '.github/workflows/dependency-review.yml',
    problems
  );

  for (const path of ['OPERATIONS.md', 'docs/MAINTAINER-RELEASE-CHECKLIST.md', '.github/dependabot.yml']) {
    if (!existsSync(join(root, path))) problems.push(`${path} is missing`);
  }
  const operations = read(root, 'OPERATIONS.md', problems);
  problems.push(...backupImportPolicyProblems(containerE2e, operations));
  const dependabot = read(root, '.github/dependabot.yml', problems);
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
  const problems = collectPolicyProblems(root);
  if (problems.length > 0) {
    console.error('[self-hosting-policy] FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('[self-hosting-policy] OK - supply-chain, container and CI policy verified');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
