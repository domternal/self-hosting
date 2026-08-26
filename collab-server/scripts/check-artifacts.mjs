#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EXACT_RUNTIME_DEPENDENCIES } from './runtime-dependencies.mjs';

export { EXACT_RUNTIME_DEPENDENCIES } from './runtime-dependencies.mjs';

function readJson(path, problems) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(
      `${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function isInside(parent, candidate) {
  const fromParent = relative(parent, candidate);
  return (
    fromParent !== '..' &&
    !fromParent.startsWith(`..${sep}`) &&
    !isAbsolute(fromParent)
  );
}

function packagePath(nodeModules, packageName) {
  return join(nodeModules, ...packageName.split('/'));
}

function requireRegularFileWithin(parent, path, label, problems) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile()) {
      problems.push(`${label} is not a regular file`);
      return;
    }
    if (metadata.size === 0) {
      problems.push(`${label} is empty`);
      return;
    }
    const real = realpathSync(path);
    if (!isInside(parent, real)) problems.push(`${label} resolves outside its deployed directory`);
  } catch (error) {
    problems.push(`${label} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function findNativeModules(root) {
  if (!existsSync(root)) return [];
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.node')) found.push(path);
    }
  }
  return found;
}

/**
 * Validate the files that are actually deployed, not merely the source
 * manifest. npm's frozen lock provides transitive integrity; this checker
 * additionally proves the exact direct closure and the
 * Alpine-native SQLite binding survived the multi-stage copy.
 */
export function runtimeArtifactProblems(runtimeRoot) {
  const requestedRoot = resolve(runtimeRoot);
  const root = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot;
  const problems = [];
  const manifest = readJson(join(root, 'package.json'), problems);
  const lock = readJson(join(root, 'package-lock.json'), problems);

  if (manifest !== null) {
    const actual = manifest.dependencies ?? {};
    for (const [name, expected] of Object.entries(EXACT_RUNTIME_DEPENDENCIES)) {
      if (actual[name] !== expected) {
        problems.push(
          `package.json dependency ${name} is ${JSON.stringify(actual[name])}, expected ${expected}`
        );
      }
    }
    for (const name of Object.keys(actual)) {
      if (!(name in EXACT_RUNTIME_DEPENDENCIES)) {
        problems.push(`package.json has unclassified runtime dependency ${name}`);
      }
    }
    if (Object.keys(manifest.devDependencies ?? {}).length > 0) {
      problems.push('runtime manifest must not declare devDependencies');
    }
  }

  if (lock !== null) {
    if (!Number.isInteger(lock.lockfileVersion) || lock.lockfileVersion < 3) {
      problems.push('package-lock.json must use lockfileVersion 3 or newer');
    }
    const lockedDirect = lock.packages?.['']?.dependencies;
    if (lockedDirect === null || typeof lockedDirect !== 'object' || Array.isArray(lockedDirect)) {
      problems.push('package-lock.json has no root production dependency mapping');
    } else {
      for (const [name, expected] of Object.entries(EXACT_RUNTIME_DEPENDENCIES)) {
        if (lockedDirect[name] !== expected) {
          problems.push(
            `package-lock.json root dependency ${name} is ${JSON.stringify(lockedDirect[name])}, expected ${expected}`
          );
        }
      }
      for (const name of Object.keys(lockedDirect)) {
        if (!(name in EXACT_RUNTIME_DEPENDENCIES)) {
          problems.push(`package-lock.json has unclassified root dependency ${name}`);
        }
      }
    }
  }

  const nodeModulesPath = join(root, 'node_modules');
  let nodeModules = null;
  try {
    if (!lstatSync(nodeModulesPath).isDirectory()) {
      problems.push('runtime node_modules is not a real directory');
    }
    nodeModules = realpathSync(nodeModulesPath);
    if (!isInside(root, nodeModules) && nodeModules !== root) {
      problems.push('node_modules resolves outside the runtime root');
    }
  } catch (error) {
    problems.push(
      `runtime has no readable node_modules: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (nodeModules !== null) {
    for (const [name, expected] of Object.entries(EXACT_RUNTIME_DEPENDENCIES)) {
      const installedRoot = packagePath(nodeModules, name);
      let realPackageRoot;
      try {
        if (!lstatSync(installedRoot).isDirectory()) {
          problems.push(`${name} is not a real package directory`);
          continue;
        }
        realPackageRoot = realpathSync(installedRoot);
        if (!isInside(nodeModules, realPackageRoot)) {
          problems.push(`${name} resolves outside the deployed node_modules tree`);
          continue;
        }
      } catch (error) {
        problems.push(
          `${name} is missing from node_modules: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      const installed = readJson(join(realPackageRoot, 'package.json'), problems);
      if (installed !== null) {
        if (installed.name !== name) {
          problems.push(`${name} package.json names ${JSON.stringify(installed.name)}`);
        }
        if (installed.version !== expected) {
          problems.push(`${name} installed version is ${installed.version}, expected ${expected}`);
        }
      }
    }

    const sqliteRoot = packagePath(nodeModules, 'better-sqlite3');
    const sqliteManifest = readJson(join(sqliteRoot, 'package.json'), problems);
    if (sqliteManifest !== null && sqliteManifest.name !== 'better-sqlite3') {
      problems.push('the installed native SQLite package is not better-sqlite3');
    }
    const nativeModules = findNativeModules(sqliteRoot);
    if (nativeModules.length === 0) {
      problems.push('better-sqlite3 has no compiled .node binding');
    }
    for (const nativeModule of nativeModules) {
      try {
        const realNative = realpathSync(nativeModule);
        if (!isInside(nodeModules, realNative)) {
          problems.push(`native SQLite binding resolves outside node_modules: ${nativeModule}`);
        }
        if (!lstatSync(nativeModule).isFile()) {
          problems.push(`native SQLite binding is not a regular file: ${nativeModule}`);
        }
      } catch (error) {
        problems.push(
          `native SQLite binding is unreadable: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  for (const required of [
    'LICENSE',
    'index.mjs',
    'src/create-server.mjs',
    'src/document-name.mjs',
    'src/rest.mjs',
    'src/secret-setting.mjs',
    'src/thread-gc.mjs',
    'src/webhook.mjs',
    'scripts/check-artifacts.mjs',
    'scripts/check-lockfile.mjs',
    'scripts/runtime-dependencies.mjs',
    'scripts/sqlite-maintenance.mjs',
  ]) {
    requireRegularFileWithin(root, join(root, required), `runtime ${required}`, problems);
  }
  return problems;
}

export function smokeTestNativeSqlite(runtimeRoot) {
  const root = resolve(runtimeRoot);
  const requireFromRuntime = createRequire(join(root, 'package.json'));
  const Database = requireFromRuntime('better-sqlite3');
  const database = new Database(':memory:');
  try {
    database.exec('CREATE TABLE artifact_probe(value TEXT NOT NULL); INSERT INTO artifact_probe VALUES (\'ok\')');
    const value = database.prepare('SELECT value FROM artifact_probe').pluck().get();
    if (value !== 'ok') throw new Error('native SQLite round-trip returned an unexpected value');
  } finally {
    database.close();
  }
}

function main() {
  const root = process.argv[2] ?? '.';
  const problems = runtimeArtifactProblems(root);
  if (problems.length > 0) {
    console.error('[collab-artifacts] FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  try {
    smokeTestNativeSqlite(root);
  } catch (error) {
    console.error(
      `[collab-artifacts] FAILED: native SQLite could not load and execute: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exitCode = 1;
    return;
  }
  console.log('[collab-artifacts] OK - frozen MIT runtime and native binding verified');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
