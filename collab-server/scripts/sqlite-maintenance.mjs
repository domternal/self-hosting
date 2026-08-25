#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

function databasePath(raw) {
  const path = raw ?? process.env.SQLITE_PATH ?? '/data/collab.sqlite';
  if (path === ':memory:') throw new Error('Maintenance requires an on-disk SQLite database.');
  return resolve(path);
}

function existingPath(raw) {
  return realpathSync(resolve(raw));
}

// Resolve symlinks in the parent without following the destination itself.
// That gives aliases one canonical name while preserving the exclusive-create
// guarantee for a destination entry that already exists (including a symlink).
function newPath(raw) {
  const absolute = resolve(raw);
  return join(realpathSync(dirname(absolute)), basename(absolute));
}

export function integrityCheck(rawPath) {
  const path = resolve(rawPath);
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = database.pragma('integrity_check');
    const messages = rows.map((row) => row.integrity_check);
    if (messages.length !== 1 || messages[0] !== 'ok') {
      throw new Error(`SQLite integrity_check failed: ${messages.join('; ')}`);
    }
  } finally {
    database.close();
  }
}

function syncFile(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function backupDatabase(rawSource, rawDestination) {
  const source = existingPath(rawSource);
  const destination = newPath(rawDestination);
  if (source === destination) throw new Error('Backup destination must differ from the live database.');
  const database = new Database(source, { readonly: true, fileMustExist: true });
  let destinationOwned = false;
  try {
    // Reserve the name atomically. A separate existsSync check has a race in
    // which another process can create an operator-owned backup before SQLite
    // opens it. better-sqlite3 can safely populate this zero-byte file.
    let descriptor;
    try {
      descriptor = openSync(destination, 'wx', 0o600);
      destinationOwned = true;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'EEXIST') {
        throw new Error(`Refusing to overwrite existing backup ${destination}.`, { cause: error });
      }
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    await database.backup(destination);
    integrityCheck(destination);
    syncFile(destination);
    syncDirectory(dirname(destination));
  } catch (error) {
    // The command must never leave a path that looks like a successful backup
    // after verification or durability failed. The preflight guaranteed this
    // invocation created it, so cleanup cannot delete an operator-owned file.
    if (destinationOwned) rmSync(destination, { force: true });
    throw error;
  } finally {
    database.close();
  }
}

export async function restoreDatabase(rawSource, rawTarget) {
  const source = existingPath(rawSource);
  const requestedTarget = resolve(rawTarget);
  const target = existsSync(requestedTarget) ? existingPath(requestedTarget) : newPath(requestedTarget);
  if (process.env.COLLAB_MAINTENANCE_OFFLINE !== '1') {
    throw new Error(
      'Restore requires COLLAB_MAINTENANCE_OFFLINE=1 after the collaboration service has been stopped.'
    );
  }
  if (source === target) throw new Error('Restore source must differ from the live database.');
  integrityCheck(source);

  const suffix = new Date().toISOString().replaceAll(':', '-');
  const candidate = `${target}.restore-${process.pid}-${Date.now()}`;
  const rollback = `${target}.before-restore-${suffix}-${String(process.pid)}`;
  let candidateOwned = false;
  let rollbackOwned = false;
  try {
    // The restore input can itself be a live WAL-mode database. Materialize a
    // consistent SQLite snapshot instead of copying only its main file and
    // silently dropping committed pages that still live in its WAL.
    await backupDatabase(source, candidate);
    candidateOwned = true;
    if (existsSync(target)) {
      // A byte copy of the main file is NOT a backup when crash-recovery data
      // still lives in -wal. SQLite's online backup API reads one consistent
      // snapshot including committed WAL pages, then verifies it before any
      // live file or sidecar is touched.
      await backupDatabase(target, rollback);
      rollbackOwned = true;
    }
    for (const sidecar of [`${target}-journal`, `${target}-shm`, `${target}-wal`]) {
      rmSync(sidecar, { force: true });
    }
    renameSync(candidate, target);
    candidateOwned = false;
    syncDirectory(dirname(target));
  } catch (error) {
    if (candidateOwned) rmSync(candidate, { force: true });
    // Everything after the rollback copy can leave the live database stripped
    // of its sidecars or already replaced, and only the success line in main()
    // ever names the rollback. An operator whose rename failed would be told
    // what broke and not where the old database went. The flag is what
    // separates that from a failure to CREATE the rollback, where the file on
    // disk is the operator's own and the live database was never touched.
    if (rollbackOwned) {
      throw new Error(
        `Restore failed after the rollback copy was created: ${error instanceof Error ? error.message : String(error)}. Previous database preserved at ${rollback}.`,
        { cause: error }
      );
    }
    throw error;
  }
  return rollbackOwned ? rollback : null;
}

async function main() {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'check') {
    const path = databasePath(first);
    integrityCheck(path);
    console.log(`[sqlite-maintenance] OK - integrity verified: ${path}`);
    return;
  }
  if (command === 'backup' && first) {
    const source = databasePath(second);
    const destination = resolve(first);
    await backupDatabase(source, destination);
    console.log(`[sqlite-maintenance] OK - consistent backup created: ${destination}`);
    return;
  }
  if (command === 'restore' && first) {
    const source = resolve(first);
    const target = databasePath(second);
    const rollback = await restoreDatabase(source, target);
    console.log(`[sqlite-maintenance] OK - restored ${source} to ${target}`);
    if (rollback) console.log(`[sqlite-maintenance] Previous database preserved at ${rollback}`);
    return;
  }
  console.error(
    'Usage: sqlite-maintenance.mjs check [database] | backup <destination> [database] | restore <backup> [database]'
  );
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main().catch((error) => {
    console.error(`[sqlite-maintenance] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
