import { SQLite } from '@hocuspocus/extension-sqlite';
import { createCollabServer, META_MAP } from '../../src/create-server.mjs';

const server = createCollabServer({
  port: 0,
  host: '127.0.0.1',
  database: process.argv[2],
  tokens: new Set(['writer']),
  readOnlyTokens: new Set(['viewer']),
  authorizeDocument: () => true,
  quiet: true,
});

await server.listen();
const persistence = server.hocuspocus.configuration.extensions.find(extension => extension instanceof SQLite);
process.send({ type: 'ready', port: server.address.port });

process.on('message', async (message) => {
  if (message.type === 'query-only') {
    persistence.db.pragma('query_only = ON');
    process.send({ type: 'query-only' });
  } else if (message.type === 'read-write') {
    persistence.db.pragma('query_only = OFF');
    process.send({ type: 'read-write' });
  } else if (message.type === 'inspect') {
    const document = server.hocuspocus.documents.get(message.documentName);
    process.send({
      type: 'inspect',
      seeded: document?.getMap(META_MAP).get('seeded') === true,
      content: document?.getXmlFragment('default').toString() ?? '',
    });
  } else if (message.type === 'shutdown') {
    await server.destroy();
    persistence.db.close();
    process.exit(0);
  }
});
