#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXACT_RUNTIME_DEPENDENCIES } from './runtime-dependencies.mjs';

const PUBLIC_REGISTRY_ORIGIN = 'https://registry.npmjs.org';

function hasSha512Integrity(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/u);
  if (!match) return false;
  try {
    return Buffer.from(match[1], 'base64').length === 64;
  } catch {
    return false;
  }
}

/**
 * A public template lock is part of the product. Reject local/workspace links,
 * private registries, credential-bearing URLs and weak/missing integrity before
 * npm gets a chance to execute dependency lifecycle scripts.
 */
export function lockfileProblems(lock) {
  const problems = [];
  if (!Number.isInteger(lock?.lockfileVersion) || lock.lockfileVersion < 3) {
    problems.push('lockfileVersion must be 3 or newer');
  }
  const packages = lock?.packages;
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    return [...problems, 'lock has no packages mapping'];
  }
  const root = packages[''];
  const locked = root?.dependencies;
  for (const [name, expected] of Object.entries(EXACT_RUNTIME_DEPENDENCIES)) {
    if (locked?.[name] !== expected) {
      problems.push(`${name} root lock specifier is ${JSON.stringify(locked?.[name])}, expected ${expected}`);
    }
    const installed = packages[`node_modules/${name}`];
    if (installed?.version !== expected) {
      problems.push(`${name} locked package version is ${JSON.stringify(installed?.version)}, expected ${expected}`);
    }
  }
  for (const name of Object.keys(locked ?? {})) {
    if (!(name in EXACT_RUNTIME_DEPENDENCIES)) problems.push(`unclassified root dependency ${name}`);
  }
  for (const kind of ['devDependencies', 'optionalDependencies']) {
    if (Object.keys(root?.[kind] ?? {}).length > 0) {
      problems.push(`root lock contains unsupported ${kind}`);
    }
  }

  for (const [path, entry] of Object.entries(packages)) {
    if (path === '') continue;
    if (!path.startsWith('node_modules/') || path.includes('/../') || path.endsWith('/..')) {
      problems.push(`${path} is not a valid installed package path`);
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${path} lock entry is not an object`);
      continue;
    }
    if (entry.link === true) problems.push(`${path} is a forbidden link/workspace entry`);
    if (typeof entry.resolved !== 'string') {
      problems.push(`${path} has no public registry resolution`);
    } else {
      try {
        const resolved = new URL(entry.resolved);
        if (resolved.origin !== PUBLIC_REGISTRY_ORIGIN) {
          problems.push(`${path} resolves outside ${PUBLIC_REGISTRY_ORIGIN}`);
        }
        if (resolved.username !== '' || resolved.password !== '') {
          problems.push(`${path} registry URL contains credentials`);
        }
        if (resolved.search !== '' || resolved.hash !== '') {
          problems.push(`${path} registry URL contains a query or fragment`);
        }
      } catch {
        problems.push(`${path} has a non-URL registry resolution ${JSON.stringify(entry.resolved)}`);
      }
    }
    if (!hasSha512Integrity(entry.integrity)) {
      problems.push(`${path} has no valid sha512 registry integrity`);
    }
  }
  return problems;
}

export function readLockfileProblems(runtimeRoot) {
  const path = resolve(runtimeRoot, 'package-lock.json');
  if (!existsSync(path)) {
    return [`${path} is missing; generate and commit the real public-registry lock`];
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return [
      `${path} is missing or invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  return lockfileProblems(lock);
}

function main() {
  const root = process.argv[2] ?? '.';
  const problems = readLockfileProblems(root);
  if (problems.length > 0) {
    console.error('[dependency-lock] FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('[dependency-lock] OK - only integrity-pinned public registry artifacts are locked');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
