import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
      license: 'MIT',
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
    'src/thread-gc.mjs',
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
    json(join(packageRoot, 'package.json'), { name, version, license: 'MIT' });
    write(join(packageRoot, 'LICENSE'), 'MIT fixture\n');
  }
  const sqliteRoot = join(root, 'node_modules', 'better-sqlite3');
  write(join(sqliteRoot, 'build', 'Release', 'better_sqlite3.node'), 'fixture');
  return root;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function setPackageLicense(root, name, license) {
  const packagePath = join(root, 'node_modules', ...name.split('/'), 'package.json');
  const manifest = readJson(packagePath);
  if (license === undefined) delete manifest.license;
  else manifest.license = license;
  json(packagePath, manifest);

  const lockPath = join(root, 'package-lock.json');
  const lock = readJson(lockPath);
  if (license === undefined) delete lock.packages[`node_modules/${name}`].license;
  else lock.packages[`node_modules/${name}`].license = license;
  json(lockPath, lock);
}

function addProductionPackage(root, { name, version, license }) {
  const lockPath = join(root, 'package-lock.json');
  const lock = readJson(lockPath);
  lock.packages[`node_modules/${name}`] = {
    version,
    license,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
  };
  json(lockPath, lock);

  const packageRoot = join(root, 'node_modules', name);
  json(join(packageRoot, 'package.json'), { name, version, license });
  write(join(packageRoot, 'LICENSE'), `${license}\n`);
}

test('accepts an exact runtime with reviewed licenses, notices and native SQLite', () => {
  const root = fixture();
  try {
    assert.deepEqual(runtimeArtifactProblems(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts NOTICE as the deployed license notice for a production package', () => {
  const root = fixture();
  try {
    const packageRoot = join(root, 'node_modules', 'yjs');
    rmSync(join(packageRoot, 'LICENSE'));
    write(join(packageRoot, 'NOTICE'), 'MIT notice fixture\n');
    assert.deepEqual(runtimeArtifactProblems(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects missing license metadata in an installed production package', () => {
  const root = fixture();
  try {
    setPackageLicense(root, 'yjs', undefined);
    assert.ok(
      runtimeArtifactProblems(root).some((problem) =>
        problem.includes('yjs@13.6.32 has no valid string license metadata')
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a production package without a deployed license or notice file', () => {
  const root = fixture();
  try {
    rmSync(join(root, 'node_modules', 'yjs', 'LICENSE'));
    assert.ok(
      runtimeArtifactProblems(root).some((problem) =>
        problem.includes('yjs@13.6.32 has no top-level license or notice file')
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a new unapproved license in the transitive production closure', () => {
  const root = fixture();
  try {
    addProductionPackage(root, {
      name: 'transitive-runtime-helper',
      version: '1.2.3',
      license: 'GPL-3.0-only',
    });
    assert.ok(
      runtimeArtifactProblems(root).some((problem) =>
        problem.includes(
          'transitive-runtime-helper@1.2.3 uses unapproved license expression "GPL-3.0-only"'
        )
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a missing local GC source and native binding', () => {
  const root = fixture();
  try {
    rmSync(join(root, 'src', 'thread-gc.mjs'));
    rmSync(join(root, 'node_modules', 'better-sqlite3', 'build'), { recursive: true });
    const problems = runtimeArtifactProblems(root);
    assert.ok(problems.some((problem) => problem.includes('src/thread-gc.mjs')));
    assert.ok(problems.some((problem) => problem.includes('no compiled .node binding')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a dependency symlink that escapes deployed node_modules', () => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'domternal-artifacts-outside-'));
  try {
    const packageRoot = join(root, 'node_modules', 'yjs');
    rmSync(packageRoot, { recursive: true });
    json(join(outside, 'package.json'), {
      name: 'yjs',
      version: EXACT_RUNTIME_DEPENDENCIES.yjs,
    });
    symlinkSync(outside, packageRoot, 'dir');
    assert.ok(
      runtimeArtifactProblems(root).some((problem) =>
        problem.includes('yjs is not a real package directory')
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
