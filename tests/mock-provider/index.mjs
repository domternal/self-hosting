import { createServer } from 'node:http';

const webhookRecords = [];

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  if (request.method === 'GET' && request.url === '/hooks/records') {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json',
    });
    response.end(JSON.stringify(webhookRecords));
    return;
  }
  if (request.method === 'DELETE' && request.url === '/hooks/records') {
    webhookRecords.length = 0;
    response.writeHead(204, { 'cache-control': 'no-store' });
    response.end();
    return;
  }
  if (request.method === 'POST' && request.url === '/hooks/collab') {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (webhookRecords.length === 100) webhookRecords.shift();
      webhookRecords.push({
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'] ?? null,
        signature: request.headers['x-hocuspocus-signature-256'] ?? null,
        body,
      });
      response.writeHead(204);
      response.end();
    });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not found"}');
    return;
  }

  const chunks = [];
  let bytes = 0;
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) request.destroy();
    else chunks.push(chunk);
  });
  request.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":"invalid json"}');
      return;
    }
    if (body.mode === 'error') {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
      response.end('{"error":"mock rate limit"}');
      return;
    }
    if (body.mode === 'redirect') {
      response.writeHead(307, { location: 'http://example.invalid/credential-sink' });
      response.end();
      return;
    }

    const observation = {
      authorizationMatched:
        request.headers.authorization ===
        'Bearer e2e-only-not-a-secret-provider-key-0001',
      contentType: request.headers['content-type'] ?? null,
      cookieForwarded: request.headers.cookie !== undefined,
      body,
    };
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    response.write(`data: ${JSON.stringify(observation)}\n\n`);
    setTimeout(() => response.end('data: [DONE]\n\n'), 25);
  });
});

server.listen(1260, '0.0.0.0');
