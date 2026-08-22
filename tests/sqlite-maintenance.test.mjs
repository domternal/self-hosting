import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const maintenancePath = join(root, 'collab-server', 'scripts', 'sqlite-maintenance.mjs');
let sqliteEntry = null;
try {
  sqliteEntry = createRequire(pathToFileURL(maintenancePath)).resolve('better-sqlite3');
} catch {
  // The public repository reaches this branch until its registry install can
  // exist. The same byte-identical test resolves the Pro workspace install by
  // walking up from examples/self-hosting/collab-server.
}
const dependencyAvailable = sqliteEntry !== null && existsSync(sqliteEntry);

test(
  'restore preserves committed WAL data in a verified rollback before replacing the database',
  { skip: dependencyAvailable ? false : 'requires the registry-produced collab install' },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'domternal-sqlite-restore-'));
    const live = join(directory, 'live.sqlite');
    const source = join(directory, 'source.sqlite');
    try {
      const crashRecoveryDatabase = (path, table, value) => `
        import Database from ${JSON.stringify(
          pathToFileURL(sqliteEntry).href
        )};
        const db = new Database(${JSON.stringify(path)});
        db.pragma('journal_mode = WAL');
        db.pragma('wal_autocheckpoint = 0');
        db.exec(${JSON.stringify(`CREATE TABLE ${table}(value TEXT); INSERT INTO ${table} VALUES ('${value}')`)});
        process.kill(process.pid, 'SIGKILL');
      `;
      for (const fixture of [
        [live, 'values_to_keep', 'from-wal'],
        [source, 'replacement', 'new-from-wal'],
      ]) {
        const child = spawnSync(
          process.execPath,
          ['--input-type=module', '-e', crashRecoveryDatabase(...fixture)],
          { encoding: 'utf8' }
        );
        assert.equal(child.signal, 'SIGKILL', child.stderr);
      }
      assert.equal(existsSync(`${live}-wal`), true, 'fixture must really contain crash-recovery WAL');
      assert.equal(
        existsSync(`${source}-wal`),
        true,
        'restore input must really contain crash-recovery WAL'
      );

      const { default: Database } = await import(
        pathToFileURL(sqliteEntry).href
      );
      const { integrityCheck, restoreDatabase } = await import(pathToFileURL(maintenancePath).href);
      process.env.COLLAB_MAINTENANCE_OFFLINE = '1';
      const rollback = await restoreDatabase(source, live);
      assert.ok(rollback);
      // Prove restore removed the stale target sidecars before any subsequent
      // open legitimately recreates them for the database's persistent WAL mode.
      assert.equal(existsSync(`${live}-wal`), false);
      assert.equal(existsSync(`${live}-shm`), false);
      integrityCheck(rollback);
      const oldDatabase = new Database(rollback, { readonly: true });
      assert.equal(oldDatabase.prepare('SELECT value FROM values_to_keep').pluck().get(), 'from-wal');
      oldDatabase.close();
      const restored = new Database(live, { readonly: true });
      assert.equal(restored.prepare('SELECT value FROM replacement').pluck().get(), 'new-from-wal');
      restored.close();
    } finally {
      delete process.env.COLLAB_MAINTENANCE_OFFLINE;
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

test(
  'backup refuses to overwrite an existing destination',
  { skip: dependencyAvailable ? false : 'requires the registry-produced collab install' },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'domternal-sqlite-backup-'));
    try {
      const source = join(directory, 'source.sqlite');
      const destination = join(directory, 'existing.sqlite');
      const { default: Database } = await import(
        pathToFileURL(sqliteEntry).href
      );
      const database = new Database(source);
      database.exec('CREATE TABLE probe(value TEXT)');
      database.close();
      writeFileSync(destination, 'do not overwrite');
      const { backupDatabase } = await import(pathToFileURL(maintenancePath).href);
      await assert.rejects(backupDatabase(source, destination), /Refusing to overwrite/u);
      assert.equal(Buffer.from('do not overwrite').equals(readFileSync(destination)), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

test(
  'restore never overwrites a pre-existing rollback path',
  { skip: dependencyAvailable ? false : 'requires the registry-produced collab install' },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'domternal-sqlite-rollback-'));
    const live = join(directory, 'live.sqlite');
    const source = join(directory, 'source.sqlite');
    const timestamp = Date.parse('2026-08-21T12:34:56.789Z');
    const RealDate = Date;
    const rollback = `${live}.before-restore-2026-08-21T12-34-56.789Z-${String(process.pid)}`;
    try {
      const { default: Database } = await import(
        pathToFileURL(sqliteEntry).href
      );
      for (const [path, value] of [
        [live, 'live'],
        [source, 'replacement'],
      ]) {
        const database = new Database(path);
        database.exec('CREATE TABLE probe(value TEXT)');
        database.prepare('INSERT INTO probe VALUES (?)').run(value);
        database.close();
      }
      writeFileSync(rollback, 'operator-owned rollback');
      globalThis.Date = class extends RealDate {
        constructor(...args) {
          super(...(args.length === 0 ? [timestamp] : args));
        }

        static now() {
          return timestamp;
        }
      };
      const { restoreDatabase } = await import(pathToFileURL(maintenancePath).href);
      process.env.COLLAB_MAINTENANCE_OFFLINE = '1';
      await assert.rejects(restoreDatabase(source, live), /Refusing to overwrite existing backup/u);
      assert.equal(readFileSync(rollback, 'utf8'), 'operator-owned rollback');
      const unchanged = new Database(live, { readonly: true });
      assert.equal(unchanged.prepare('SELECT value FROM probe').pluck().get(), 'live');
      unchanged.close();
    } finally {
      globalThis.Date = RealDate;
      delete process.env.COLLAB_MAINTENANCE_OFFLINE;
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
