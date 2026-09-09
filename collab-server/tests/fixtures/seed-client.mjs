import { IncomingMessage, MessageReceiver, MessageType, OutgoingMessage } from '@hocuspocus/server';
import * as Y from 'yjs';

export async function waitFor(description, condition) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

/** A protocol client that can retain its Y.Doc across an abrupt server stop. */
export async function connect({ port, documentName, token, document = new Y.Doc() }) {
  document.name = documentName;
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.binaryType = 'arraybuffer';
  const status = { synced: false, closed: false, error: null };
  let chain = Promise.resolve();

  const authenticate = () => {
    const message = new IncomingMessage(new Uint8Array());
    message.writeVarString(documentName);
    message.writeVarUint(MessageType.Auth);
    message.writeVarUint(0);
    message.writeVarString(token);
    message.writeVarString('4.6.0');
    socket.send(message.toUint8Array());
  };

  socket.addEventListener('close', () => { status.closed = true; });
  socket.addEventListener('message', event => {
    chain = chain.then(async () => {
      const bytes = new Uint8Array(event.data);
      const probe = new IncomingMessage(bytes);
      probe.readVarString();
      const type = probe.readVarUint();
      if (type === MessageType.Auth) {
        const authType = probe.readVarUint();
        if (authType === 0) authenticate();
        else if (authType === 1) throw new Error(probe.readVarString());
        return;
      }
      if (type === MessageType.CLOSE) {
        socket.close();
        return;
      }
      if (type === MessageType.SyncStatus) {
        status.synced ||= probe.readVarUint() === 1;
        return;
      }
      if (type !== MessageType.Sync && type !== MessageType.SyncReply) return;
      const message = new IncomingMessage(bytes);
      message.writeVarString(message.readVarString());
      await new MessageReceiver(message).apply(document, undefined, reply => {
        if (socket.readyState === WebSocket.OPEN) socket.send(reply);
      });
    }).catch(error => { status.error = error; });
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  authenticate();
  socket.send(new OutgoingMessage(documentName).createSyncMessage()
    .writeFirstSyncStepFor(document).toUint8Array());

  return {
    document,
    status,
    sendUpdate(update) {
      socket.send(new OutgoingMessage(documentName).createSyncMessage()
        .writeUpdate(update).toUint8Array());
    },
    async synced() {
      await waitFor('client sync', () => status.synced || status.error || status.closed);
      if (status.error) throw status.error;
      if (!status.synced) throw new Error('The client closed before syncing.');
    },
    async close() {
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.close();
        await waitFor('client close', () => status.closed);
      }
      await chain;
    },
  };
}
