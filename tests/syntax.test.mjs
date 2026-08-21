import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function modules(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...modules(path));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) found.push(path);
  }
  return found;
}

for (const path of modules(root).sort()) {
  test(`Node parses ${relative(root, path)}`, () => {
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
