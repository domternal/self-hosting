import assert from 'node:assert/strict';
import {
  IncomingMessage,
  MessageReceiver,
  MessageType,
  OutgoingMessage,
} from '@hocuspocus/server';
import * as Y from 'yjs';

/**
 * Minimal Hocuspocus protocol client for the registry-built runtime image.
 * It deliberately uses only dependencies already required by production.
 */
export async function runWebsocketClient({
  documentName,
  token,
  expectedInitial,
  nextValue,
  readOnly,
}) {
  const expectedScope = readOnly ? 'readonly' : 'read-write';
  const expectedSaved = !readOnly;
  const document = new Y.Doc();
  document.name = documentName;
  const socket = new WebSocket('ws://127.0.0.1:1234');
  socket.binaryType = 'arraybuffer';
  let scope = null;
  let fatalError = null;
  let shutdownRequested = false;
  let messageChain = Promise.resolve();
  const syncStatuses = [];

  function authenticationMessage() {
    const message = new IncomingMessage(new Uint8Array());
    message.writeVarString(documentName);
    message.writeVarUint(MessageType.Auth);
    message.writeVarUint(0);
    message.writeVarString(token);
    message.writeVarString('4.4.0');
    return message.toUint8Array();
  }

  async function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    throw new TypeError('Unexpected WebSocket message type.');
  }

  async function handleMessage(data) {
    const bytes = await bytesOf(data);
    const probe = new IncomingMessage(bytes);
    const address = probe.readVarString();
    assert.equal(address, documentName);
    const type = probe.readVarUint();
    if (type === MessageType.Auth) {
      const authType = probe.readVarUint();
      if (authType === 0) socket.send(authenticationMessage());
      else if (authType === 1) {
        throw new Error(`Authentication rejected: ${probe.readVarString()}`);
      } else if (authType === 2) scope = probe.readVarString();
      return;
    }
    if (type === MessageType.SyncStatus) {
      syncStatuses.push(probe.readVarUint() === 1);
      return;
    }
    if (type === MessageType.CLOSE) {
      socket.close(1000, probe.readVarString());
      return;
    }
    if (type !== MessageType.Sync && type !== MessageType.SyncReply) return;
    const message = new IncomingMessage(bytes);
    const responseAddress = message.readVarString();
    message.writeVarString(responseAddress);
    await new MessageReceiver(message).apply(document, undefined, (reply) => socket.send(reply));
  }

  socket.addEventListener('message', (event) => {
    messageChain = messageChain.then(() => handleMessage(event.data)).catch((error) => {
      fatalError = error;
    });
  });
  socket.addEventListener('close', () => {
    if (!shutdownRequested && fatalError === null) {
      fatalError = new Error('WebSocket closed before the test requested shutdown.');
    }
  });

  async function waitUntil(description, condition) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await messageChain;
      if (fatalError) throw fatalError;
      if (condition()) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  try {
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error('WebSocket open timed out.')), 10_000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolveOpen();
        },
        { once: true }
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          rejectOpen(new Error('WebSocket connection failed.'));
        },
        { once: true }
      );
    });

    socket.send(authenticationMessage());
    socket.send(
      new OutgoingMessage(documentName)
        .createSyncMessage()
        .writeFirstSyncStepFor(document)
        .toUint8Array()
    );
    await waitUntil(
      'authentication and initial Yjs sync',
      () =>
        scope !== null &&
        document.getMap('e2e').get('value') === expectedInitial &&
        syncStatuses.includes(true)
    );
    assert.equal(scope, expectedScope);
    const statusCount = syncStatuses.length;
    document.getMap('e2e').set('value', nextValue);
    socket.send(
      new OutgoingMessage(documentName)
        .createSyncMessage()
        .writeUpdate(Y.encodeStateAsUpdate(document))
        .toUint8Array()
    );
    await waitUntil('the server update acknowledgement', () =>
      syncStatuses.slice(statusCount).includes(expectedSaved)
    );

    shutdownRequested = true;
    await new Promise((resolveClose, rejectClose) => {
      const timer = setTimeout(
        () => rejectClose(new Error('WebSocket close timed out.')),
        5_000
      );
      socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer);
          resolveClose();
        },
        { once: true }
      );
      socket.close(1000, 'e2e-complete');
    });
    await messageChain;
    if (fatalError) throw fatalError;
    return { scope, saved: syncStatuses.slice(statusCount).at(-1) };
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    document.destroy();
  }
}
