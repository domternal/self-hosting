import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { schema, upsertQuery } from '@hocuspocus/extension-sqlite';
import * as Y from 'yjs';
import { META_MAP } from '../src/create-server.mjs';
import { connect, waitFor } from './fixtures/seed-client.mjs';

async function startServer(database) {
  const child = fork(new URL('./fixtures/seed-server.mjs', import.meta.url), [database], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    exited.then(() => { throw new Error(`Server exited before listening:\n${output}`); }),
  ]);
  assert.equal(ready.type, 'ready');
  return {
    port: ready.port,
    child,
    exited,
    output: () => output,
    async request(message) {
      const response = once(child, 'message');
      child.send(message);
      return (await response)[0];
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.send({ type: 'shutdown' });
      }
      await exited;
    },
  };
}

function readStored(database, documentName) {
  const db = new Database(database, { readonly: true });
  try {
    return db.prepare('SELECT data FROM documents WHERE name = ?').get(documentName)?.data;
  } finally {
    db.close();
  }
}

async function resources(t) {
  const directory = await mkdtemp(join(tmpdir(), 'domternal-seed-'));
  const database = join(directory, 'documents.sqlite');
  const servers = [];
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const server of servers) await server.stop();
    for (const document of new Set(clients.map(client => client.document))) document.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    database,
    async server() {
      const server = await startServer(database);
      servers.push(server);
      return server;
    },
    async client(options) {
      const client = await connect(options);
      clients.push(client);
      return client;
    },
  };
}

for (const viewerFirst of [false, true]) {
  test(`seed identity survives SIGKILL on first observed update, viewerFirst=${viewerFirst}`, { timeout: 20_000 }, async t => {
    const fixture = await resources(t);
    const name = 'crash-seed';
    const server = await fixture.server();
    const retained = new Y.Doc();
    let killed = false;
    retained.on('update', () => {
      if (!killed && retained.getMap(META_MAP).get('seeded') === true) {
        killed = true;
        server.child.kill('SIGKILL');
      }
    });

    const survivor = await fixture.client({
      port: server.port, documentName: name,
      token: viewerFirst ? 'viewer' : 'writer', document: retained,
    });
    if (viewerFirst) {
      await survivor.synced();
      assert.equal(retained.getXmlFragment('default').length, 0);
      assert.equal(readStored(fixture.database, name), undefined);
      await fixture.client({ port: server.port, documentName: name, token: 'writer' });
    }
    await waitFor('the seeded update and forced stop', () => killed);
    const [, signal] = await server.exited;
    assert.equal(signal, 'SIGKILL');
    const expected = retained.getXmlFragment('default').toString();
    const vector = Y.encodeStateVector(retained);
    const stored = readStored(fixture.database, name);
    assert.ok(stored, 'The initial seed must be committed before a client can observe it.');
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, stored);
    assert.equal(persisted.getMap(META_MAP).get('seeded'), true);
    assert.equal(persisted.getXmlFragment('default').toString(), expected);
    assert.deepEqual(Y.encodeStateVector(persisted), vector);
    persisted.destroy();

    const restarted = await fixture.server();
    const reconnected = await fixture.client({
      port: restarted.port, documentName: name, token: 'writer', document: retained,
    });
    await reconnected.synced();
    assert.equal(retained.getXmlFragment('default').length, 2);
    assert.equal(retained.getXmlFragment('default').toString(), expected);
    assert.deepEqual(Y.encodeStateVector(retained), vector);
  });
}

for (const viewerFirst of [false, true]) {
  test(`concurrent writers share one committed seed, viewerFirst=${viewerFirst}`, { timeout: 20_000 }, async t => {
    const fixture = await resources(t);
    const name = 'concurrent-seed';
    const server = await fixture.server();
    const viewer = viewerFirst
      ? await fixture.client({ port: server.port, documentName: name, token: 'viewer' })
      : null;
    if (viewer) await viewer.synced();

    const writers = await Promise.all(Array.from({ length: 2 }, () =>
      fixture.client({ port: server.port, documentName: name, token: 'writer' })
    ));
    await Promise.all(writers.map(writer => writer.synced()));
    const expected = writers[0].document;
    assert.equal(expected.getXmlFragment('default').length, 2);
    assert.equal(expected.getMap(META_MAP).get('seeded'), true);
    const vector = Y.encodeStateVector(expected);
    const content = expected.getXmlFragment('default').toString();
    if (viewer) {
      await waitFor('the viewer to receive the committed seed', () =>
        viewer.document.getMap(META_MAP).get('seeded') === true
      );
    }
    for (const client of [...writers, ...(viewer ? [viewer] : [])]) {
      assert.equal(client.document.getXmlFragment('default').toString(), content);
      assert.deepEqual(Y.encodeStateVector(client.document), vector);
    }
    const stored = readStored(fixture.database, name);
    assert.ok(stored, 'Both writers must receive the same already committed seed.');
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, stored);
    assert.deepEqual(Y.encodeStateVector(persisted), vector);
    assert.equal(persisted.getXmlFragment('default').toString(), content);
    persisted.destroy();
  });
}

test('an intentionally empty owned document and a nonempty unowned document are never reseeded', { timeout: 20_000 }, async t => {
  const fixture = await resources(t);
  const db = new Database(fixture.database);
  db.exec(schema);
  const empty = new Y.Doc();
  empty.getMap(META_MAP).set('seeded', true);
  const nonempty = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText('Existing content')]);
  nonempty.getXmlFragment('default').insert(0, [paragraph]);
  for (const [name, document] of [['empty-owned', empty], ['nonempty-unowned', nonempty]]) {
    db.prepare(upsertQuery).run({ name, data: Buffer.from(Y.encodeStateAsUpdate(document)) });
  }
  db.close();
  const server = await fixture.server();
  for (const [name, expected] of [['empty-owned', empty], ['nonempty-unowned', nonempty]]) {
    const client = await fixture.client({ port: server.port, documentName: name, token: 'writer' });
    await client.synced();
    assert.equal(client.document.getXmlFragment('default').toString(), expected.getXmlFragment('default').toString());
    assert.deepEqual(Y.encodeStateVector(client.document), Y.encodeStateVector(expected));
    expected.destroy();
  }
});

test('viewer-only and version sibling connections do not seed or create a database row', { timeout: 20_000 }, async t => {
  const fixture = await resources(t);
  const server = await fixture.server();
  for (const [name, token] of [['viewer-only', 'viewer'], ['document-versions', 'writer'], ['document/versions', 'writer']]) {
    const client = await fixture.client({ port: server.port, documentName: name, token });
    await client.synced();
    assert.equal(client.document.getXmlFragment('default').length, 0);
    assert.notEqual(client.document.getMap(META_MAP).get('seeded'), true);
    assert.equal(readStored(fixture.database, name), undefined);
  }
});

for (const viewerFirst of [false, true]) {
  test(`a failed seed stays private and can be retried once storage recovers, viewerFirst=${viewerFirst}`, { timeout: 20_000 }, async t => {
    const fixture = await resources(t);
    const server = await fixture.server();
    const name = 'failed-seed';
    const viewer = viewerFirst
      ? await fixture.client({ port: server.port, documentName: name, token: 'viewer' })
      : null;
    if (viewer) await viewer.synced();
    await server.request({ type: 'query-only' });
    const writer = await fixture.client({ port: server.port, documentName: name, token: 'writer' });
    await waitFor('the rejected seed store', () => /readonly database/i.test(server.output()));
    const live = await server.request({ type: 'inspect', documentName: name });
    assert.equal(live.seeded, false);
    assert.equal(live.content, '');
    if (viewer) {
      assert.equal(viewer.document.getXmlFragment('default').length, 0);
      assert.notEqual(viewer.document.getMap(META_MAP).get('seeded'), true);
    }
    assert.equal(readStored(fixture.database, name), undefined);
    assert.equal(writer.status.synced, false);

    await writer.close();
    await server.request({ type: 'read-write' });
    const retry = await fixture.client({ port: server.port, documentName: name, token: 'writer' });
    await retry.synced();
    assert.equal(retry.document.getMap(META_MAP).get('seeded'), true);
    assert.equal(retry.document.getXmlFragment('default').length, 2);
    const stored = readStored(fixture.database, name);
    assert.ok(stored, 'A retry must still commit the seed before acknowledging sync.');
    const persisted = new Y.Doc();
    try {
      Y.applyUpdate(persisted, stored);
      assert.deepEqual(Y.encodeStateVector(persisted), Y.encodeStateVector(retry.document));
      if (viewer) {
        await waitFor('the viewer to receive the recovered seed', () =>
          viewer.document.getMap(META_MAP).get('seeded') === true
        );
        assert.equal(viewer.document.getXmlFragment('default').toString(), retry.document.getXmlFragment('default').toString());
        assert.deepEqual(Y.encodeStateVector(viewer.document), Y.encodeStateVector(retry.document));
      }
    } finally {
      persisted.destroy();
    }
  });
}
