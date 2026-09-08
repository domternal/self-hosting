import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import * as Y from 'yjs';
import { connect, waitFor } from './fixtures/seed-client.mjs';

const writerToken = 'test-only-shutdown-writer-token-0001';
const viewerToken = 'test-only-shutdown-viewer-token-0001';

async function startEntrypoint(database, processes) {
  const child = fork(new URL('../index.mjs', import.meta.url), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      NODE_ENV: 'production',
      PORT: '0',
      HOST: '127.0.0.1',
      SQLITE_PATH: database,
      COLLAB_TOKENS: writerToken,
      COLLAB_READONLY_TOKENS: viewerToken,
      COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS: '1',
    },
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  const server = { child, exited, output: () => output };
  processes.push(server);
  await waitFor('the entrypoint websocket listener', () =>
    /WebSocket: ws:\/\/127\.0\.0\.1:\d+/.test(output) || child.exitCode !== null
  );
  const match = output.match(/WebSocket: ws:\/\/127\.0\.0\.1:(\d+)/);
  assert.ok(match, `The entrypoint must start successfully:\n${output}`);
  return { ...server, port: Number(match[1]) };
}

function readStored(database, name) {
  const db = new Database(database, { readonly: true });
  const document = new Y.Doc();
  try {
    const row = db.prepare('SELECT data FROM documents WHERE name = ?').get(name);
    if (row) Y.applyUpdate(document, row.data);
    return document;
  } finally {
    db.close();
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`the real entrypoint flushes a pending edit on ${signal} before restart`, { timeout: 30_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'domternal-shutdown-'));
    const database = join(directory, 'documents.sqlite');
    const processes = [];
    const clients = [];
    t.after(async () => {
      for (const client of clients) {
        await client.close();
        client.document.destroy();
      }
      for (const server of processes) {
        if (server.child.exitCode === null && server.child.signalCode === null) {
          server.child.kill('SIGTERM');
          const forced = setTimeout(() => server.child.kill('SIGKILL'), 5_000);
          await server.exited;
          clearTimeout(forced);
        }
      }
      await rm(directory, { recursive: true, force: true });
    });

    const name = 'pending-edit';
    const server = await startEntrypoint(database, processes);
    const writer = await connect({ port: server.port, documentName: name, token: writerToken });
    clients.push(writer);
    await writer.synced();
    const viewer = await connect({ port: server.port, documentName: name, token: viewerToken });
    clients.push(viewer);
    await viewer.synced();

    const before = Y.encodeStateVector(writer.document);
    writer.document.getText('shutdown-test').insert(0, 'Pending ordinary edit');
    writer.sendUpdate(Y.encodeStateAsUpdate(writer.document, before));
    await waitFor('the server to broadcast the ordinary edit', () =>
      viewer.document.getText('shutdown-test').toString() === 'Pending ordinary edit'
    );
    const pending = readStored(database, name);
    assert.equal(pending.getText('shutdown-test').toString(), '', 'The edit must still be pending when the signal arrives.');
    pending.destroy();

    server.child.kill(signal);
    const [code, exitSignal] = await server.exited;
    assert.equal(code, 0, server.output());
    assert.equal(exitSignal, null);
    assert.match(server.output(), new RegExp(`${signal} received`));
    assert.match(server.output(), /Graceful shutdown complete/);
    const persisted = readStored(database, name);
    assert.equal(persisted.getText('shutdown-test').toString(), 'Pending ordinary edit');
    assert.deepEqual(Y.encodeStateVector(persisted), Y.encodeStateVector(writer.document));
    persisted.destroy();

    const restarted = await startEntrypoint(database, processes);
    const restored = await connect({ port: restarted.port, documentName: name, token: viewerToken });
    clients.push(restored);
    await restored.synced();
    assert.equal(restored.document.getText('shutdown-test').toString(), 'Pending ordinary edit');
    assert.deepEqual(Y.encodeStateVector(restored.document), Y.encodeStateVector(writer.document));
  });
}
