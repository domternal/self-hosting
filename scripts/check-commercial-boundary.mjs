#!/usr/bin/env node
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_SERVICES = Object.freeze(['ai-proxy', 'collab-server']);
const GENERATED_DIRECTORIES = new Set(['.pnpm-store', 'coverage', 'dist', 'node_modules']);
const INTENTIONAL_FIXTURE_PATHS = new Set(['tests/commercial-boundary.test.mjs']);
const COMMERCIAL_NAMESPACE = ['@domternal', 'pro/'].join('-');
const LICENSE_ENVIRONMENT_SURFACE = ['DOMTERNAL', 'PRO', 'LICENSE'].join('_');
const LICENSE_ACTIVATION_APIS = Object.freeze([
  ['set', 'License', 'Key'].join(''),
  ['configure', 'Pro', 'License'].join(''),
]);
const PROSE_EXTENSIONS = new Set(['.md', '.mdx', '.rst']);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export const MAX_INSPECTED_FILE_BYTES = 1024 * 1024;

function portable(path) {
  return path.replaceAll('\\', '/');
}

function completeDmpKeys(source) {
  const keys = [];
  const pattern =
    /(?<![A-Za-z0-9_-])(DMP[12])\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/gu;
  const views = [source];
  const joinBoundary =
    /(['"`])(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*\+(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*(['"`])/gu;
  const joinedLiterals = source.replace(joinBoundary, '');
  if (joinedLiterals !== source) views.push(joinedLiterals);
  const literals = Array.from(
    source.matchAll(/(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/gu),
    (match) => match[2]
  );
  for (const [index, literal] of literals.entries()) {
    if (literal.includes('DMP')) views.push(literals.slice(index, index + 16).join(''));
  }
  const seen = new Set();

  for (const view of views) {
    for (const match of view.matchAll(pattern)) {
      try {
        const payloadBytes = Buffer.from(match[2], 'base64url');
        const signature = Buffer.from(match[3], 'base64url');
        if (
          payloadBytes.toString('base64url') !== match[2] ||
          signature.toString('base64url') !== match[3] ||
          signature.length !== 64
        ) {
          continue;
        }
        const payload = JSON.parse(payloadBytes.toString('utf8'));
        const expectedVersion = match[1] === 'DMP1' ? 1 : 2;
        if (
          payload === null ||
          typeof payload !== 'object' ||
          Array.isArray(payload) ||
          payload.v !== expectedVersion ||
          typeof payload.k !== 'number'
        ) {
          continue;
        }
        const isLegacyShape =
          expectedVersion === 1 &&
          typeof payload.o === 'string' &&
          typeof payload.p === 'string' &&
          typeof payload.s === 'number' &&
          typeof payload.e === 'string';
        const isCurrentNonCommercialShape =
          expectedVersion === 2 &&
          (payload.t === 'evaluation' || payload.t === 'internal') &&
          typeof payload.e === 'string' &&
          typeof payload.n === 'string';
        const isCurrentCommercialShape =
          expectedVersion === 2 &&
          payload.t === 'commercial' &&
          typeof payload.i === 'string' &&
          typeof payload.l === 'string' &&
          typeof payload.b === 'string' &&
          typeof payload.e === 'string' &&
          (payload.f === null || typeof payload.f === 'string') &&
          typeof payload.n === 'string';
        if (!isLegacyShape && !isCurrentNonCommercialShape && !isCurrentCommercialShape) {
          continue;
        }
        if (!seen.has(match[0])) {
          seen.add(match[0]);
          keys.push(match[0]);
        }
      } catch {
        // Non-canonical lookalikes cannot activate the verifier and are safe in
        // placeholders, documentation and negative test cases.
      }
    }
  }
  return keys;
}

function isManifest(path) {
  const name = basename(path);
  return name === 'package.json' || name === 'package-lock.json';
}

function isProse(path) {
  return PROSE_EXTENSIONS.has(extname(path).toLowerCase());
}

function containsCommercialNamespace(value) {
  return typeof value === 'string' && value.toLowerCase().includes(COMMERCIAL_NAMESPACE);
}

function licenseActivationApi(source) {
  for (const api of LICENSE_ACTIVATION_APIS) {
    const call = new RegExp(`\\b${api}\\s*(?:\\?\\.)?\\s*\\(\\s*[^)\\s]`, 'u');
    if (call.test(source)) return api;
  }
  return null;
}

function readSmallFile(path, label, problems) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    problems.push(
      `${label} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
  if (!metadata.isFile()) {
    problems.push(`${label} is not a regular file`);
    return undefined;
  }
  if (metadata.size > MAX_INSPECTED_FILE_BYTES) {
    problems.push(
      `${label} exceeds the ${String(MAX_INSPECTED_FILE_BYTES)} byte commercial-boundary scan limit`
    );
    return undefined;
  }

  let descriptor;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    problems.push(
      `${label} cannot be opened without following a symbolic link: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      problems.push(`${label} changed while being opened for the commercial-boundary scan`);
      return undefined;
    }
    if (opened.size > MAX_INSPECTED_FILE_BYTES) {
      problems.push(
        `${label} grew beyond the ${String(MAX_INSPECTED_FILE_BYTES)} byte commercial-boundary scan limit while being opened`
      );
      return undefined;
    }

    let bytes;
    try {
      bytes = readFileSync(descriptor);
    } catch (error) {
      problems.push(
        `${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
    const after = fstatSync(descriptor);
    if (
      bytes.length !== opened.size ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      problems.push(`${label} changed while being read for the commercial-boundary scan`);
      return undefined;
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function decodeUtf8(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function trackedFiles(root, problems) {
  let gitDirectory;
  let hasLocalGitMetadata = false;
  try {
    gitDirectory = lstatSync(join(root, '.git'));
    hasLocalGitMetadata = true;
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
      problems.push(
        `.git cannot be inspected: ${error instanceof Error ? error.message : String(error)}`
      );
      return new Set();
    }
  }
  if (
    hasLocalGitMetadata &&
    (!(gitDirectory.isDirectory() || gitDirectory.isFile()) || gitDirectory.isSymbolicLink())
  ) {
    problems.push('.git is not a regular Git metadata directory or file');
    return new Set();
  }

  const gitEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  );
  Object.assign(gitEnvironment, {
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
  });
  let repositoryRoot;
  try {
    repositoryRoot = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
      env: gitEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());
  } catch (error) {
    if (!hasLocalGitMetadata) return null;
    problems.push(
      `Git repository root cannot be inspected: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return new Set();
  }

  const repositoryPrefix = portable(relative(repositoryRoot, realpathSync(root)));
  if (repositoryPrefix === '..' || repositoryPrefix.startsWith('../')) {
    problems.push('commercial-boundary root is outside the containing Git repository');
    return new Set();
  }

  try {
    const arguments_ = ['-c', 'core.quotepath=false', 'ls-files', '--cached', '-z'];
    if (repositoryPrefix.length > 0) arguments_.push('--', repositoryPrefix);
    const output = execFileSync(
      'git',
      arguments_,
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: gitEnvironment,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const prefix = repositoryPrefix.length > 0 ? `${repositoryPrefix}/` : '';
    return new Set(
      output
        .split('\0')
        .filter(Boolean)
        .map(portable)
        .map((path) => (prefix.length > 0 && path.startsWith(prefix) ? path.slice(prefix.length) : path))
    );
  } catch (error) {
    problems.push(
      `tracked file inventory cannot be inspected: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return new Set();
  }
}

function inspectManifestValue(value, location, findings, seen) {
  if (typeof value === 'string') {
    if (containsCommercialNamespace(value)) findings.add(location);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      inspectManifestValue(entry, `${location}[${String(index)}]`, findings, seen);
    }
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const next = `${location}.${key}`;
    if (containsCommercialNamespace(key)) findings.add(next);
    inspectManifestValue(entry, next, findings, seen);
  }
}

function inspectFile(root, path, problems) {
  const label = portable(relative(root, path));
  const bytes = readSmallFile(path, label, problems);
  if (bytes === undefined) return;

  if (completeDmpKeys(bytes.toString('latin1')).length > 0) {
    problems.push(`${label} embeds a complete DMP1 or DMP2 license key`);
  }

  const source = decodeUtf8(bytes);
  if (source === null) {
    if (isManifest(path)) problems.push(`${label} is not valid UTF-8 text`);
    else problems.push(`${label} is binary or not valid UTF-8 text and is not allowed`);
    return;
  }

  // This source file necessarily contains the synthetic namespace, activation
  // and environment fixtures that prove the negative checks. It is exempt only
  // from those UTF-8 text checks. The all-byte key scan and binary policy above
  // always apply.
  if (INTENTIONAL_FIXTURE_PATHS.has(label)) return;

  if (!isProse(path)) {
    const activationApi = licenseActivationApi(source);
    if (activationApi !== null) {
      problems.push(`${label} calls the ${activationApi} Pro license activation surface`);
    }
    if (source.toUpperCase().includes(LICENSE_ENVIRONMENT_SURFACE)) {
      problems.push(
        `${label} references the ${LICENSE_ENVIRONMENT_SURFACE} Pro license environment surface`
      );
    }
  }

  if (source.toLowerCase().includes(COMMERCIAL_NAMESPACE)) {
    problems.push(`${label} references the commercial package namespace`);
  }

  if (!isManifest(path)) return;
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    problems.push(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const findings = new Set();
  inspectManifestValue(manifest, '$', findings, new Set());
  for (const location of findings) {
    problems.push(`${label} contains a commercial package reference at ${location}`);
  }
}

function inspectTree(root, problems, tracked) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let before;
    try {
      before = lstatSync(directory);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        const label = portable(relative(root, directory)) || '.';
        problems.push(`${label} is not a stable regular directory`);
        continue;
      }
    } catch (error) {
      const label = portable(relative(root, directory)) || '.';
      problems.push(
        `${label} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      const label = portable(relative(root, directory)) || '.';
      problems.push(
        `${label} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }

    try {
      const after = lstatSync(directory);
      if (!after.isDirectory() || after.isSymbolicLink() || !sameFileIdentity(before, after)) {
        const label = portable(relative(root, directory)) || '.';
        problems.push(`${label} changed while being read for the commercial-boundary scan`);
        continue;
      }
    } catch (error) {
      const label = portable(relative(root, directory)) || '.';
      problems.push(
        `${label} changed while being read for the commercial-boundary scan: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      const label = portable(relative(root, path));
      let metadata;
      try {
        metadata = lstatSync(path);
      } catch (error) {
        problems.push(
          `${label} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      if (metadata.isSymbolicLink()) {
        problems.push(`${label} is a symbolic link and cannot cross the MIT package boundary`);
        continue;
      }
      if (metadata.isDirectory()) {
        if (label === '.git') continue;
        if (tracked !== null && GENERATED_DIRECTORIES.has(entry.name)) {
          const prefix = `${label}/`;
          for (const trackedPath of tracked) {
            if (trackedPath.startsWith(prefix)) {
              problems.push(
                `${trackedPath} is tracked inside the excluded generated directory ${label}`
              );
            }
          }
          continue;
        }
        pending.push(path);
        continue;
      }
      if (!metadata.isFile()) {
        problems.push(`${label} is not a regular file or directory`);
        continue;
      }
      inspectFile(root, path, problems);
    }
  }
}

/** Check that the MIT repository remains independent from commercial packages and license wiring. */
export function commercialBoundaryProblems(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const problems = [];
  const tracked = trackedFiles(root, problems);
  if (tracked !== null) {
    for (const trackedPath of tracked) {
      const parts = trackedPath.split('/');
      for (let index = 0; index < parts.length - 1; index += 1) {
        if (!GENERATED_DIRECTORIES.has(parts[index])) continue;
        problems.push(
          `${trackedPath} is tracked inside the excluded generated directory ${parts
            .slice(0, index + 1)
            .join('/')}`
        );
        break;
      }
    }
  }
  let rootEntries;
  try {
    rootEntries = new Set(readdirSync(root));
  } catch (error) {
    return [
      `repository root cannot be inspected: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
  for (const service of REQUIRED_SERVICES) {
    if (!rootEntries.has(service)) problems.push(`${service} service directory is missing`);
  }
  inspectTree(root, problems, tracked);
  return [...new Set(problems)].sort();
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = commercialBoundaryProblems(root);
  if (problems.length > 0) {
    console.error('[commercial-boundary] FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    '[commercial-boundary] OK - MIT deployment surfaces contain no commercial packages or Pro license wiring'
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
