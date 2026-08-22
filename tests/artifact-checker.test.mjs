import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  EXACT_RUNTIME_DEPENDENCIES,
  runtimeArtifactProblems,
} from '../collab-server/scripts/check-artifacts.mjs';

function write(path, contents = '') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function json(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'domternal-artifacts-'));
  const lockPackages = { '': { dependencies: EXACT_RUNTIME_DEPENDENCIES } };
  for (const [name, version] of Object.entries(EXACT_RUNTIME_DEPENDENCIES)) {
    lockPackages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
      integrity: `sha512-${Buffer.alloc(64, 9).toString('base64')}`,
    };
  }
  json(join(root, 'package.json'), {
    name: 'domternal-collab-server',
    version: '0.0.0',
    dependencies: EXACT_RUNTIME_DEPENDENCIES,
  });
  json(join(root, 'package-lock.json'), {
    name: 'domternal-collab-server',
    lockfileVersion: 3,
    packages: lockPackages,
  });
  write(join(root, 'LICENSE'), 'MIT fixture\n');
  write(join(root, 'index.mjs'), 'export {};\n');
  for (const path of [
    'src/create-server.mjs',
    'src/document-name.mjs',
    'src/rest.mjs',
    'src/secret-setting.mjs',
    'src/webhook.mjs',
    'scripts/check-artifacts.mjs',
    'scripts/check-lockfile.mjs',
    'scripts/runtime-dependencies.mjs',
    'scripts/sqlite-maintenance.mjs',
  ]) {
    write(join(root, path), 'export {};\n');
  }
  for (const [name, version] of Object.entries(EXACT_RUNTIME_DEPENDENCIES)) {
    const packageRoot = join(root, 'node_modules', ...name.split('/'));
    json(join(packageRoot, 'package.json'), { name, version });
  }
  for (const name of ['@domternal-pro/core', '@domternal-pro/extension-comments']) {
    const packageRoot = join(root, 'node_modules', ...name.split('/'));
    write(join(packageRoot, 'LICENSE.md'), 'commercial fixture\n');
    write(join(packageRoot, 'THIRD-PARTY-LICENSES.md'), 'notices fixture\n');
  }
  const sqliteRoot = join(root, 'node_modules', 'better-sqlite3');
  json(join(sqliteRoot, 'package.json'), { name: 'better-sqlite3', version: '12.11.1' });
  write(join(sqliteRoot, 'build', 'Release', 'better_sqlite3.node'), 'fixture');
  return root;
}

test('accepts an exact, self-contained runtime with native SQLite and legal files', () => {
  const root = fixture();
  try {
    assert.deepEqual(runtimeArtifactProblems(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a missing commercial notice and native binding', () => {
  const root = fixture();
  try {
    rmSync(
      join(root, 'node_modules', '@domternal-pro', 'extension-comments', 'THIRD-PARTY-LICENSES.md')
    );
    rmSync(join(root, 'node_modules', 'better-sqlite3', 'build'), { recursive: true });
    const problems = runtimeArtifactProblems(root);
    assert.ok(problems.some((problem) => problem.includes('THIRD-PARTY-LICENSES.md')));
    assert.ok(problems.some((problem) => problem.includes('no compiled .node binding')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an empty commercial license artifact', () => {
  const directory = fixture();
  try {
    writeFileSync(
      join(directory, 'node_modules', '@domternal-pro', 'core', 'LICENSE.md'),
      ''
    );
    assert.ok(
      runtimeArtifactProblems(directory).some((problem) =>
        problem.includes('@domternal-pro/core/LICENSE.md is empty')
      )
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a dependency symlink that escapes deployed node_modules', () => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'domternal-artifacts-outside-'));
  try {
    const packageRoot = join(root, 'node_modules', '@domternal', 'core');
    rmSync(packageRoot, { recursive: true });
    json(join(outside, 'package.json'), { name: '@domternal/core', version: '0.15.0' });
    symlinkSync(outside, packageRoot, 'dir');
    assert.ok(
      runtimeArtifactProblems(root).some((problem) =>
        problem.includes('@domternal/core is not a real package directory')
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
