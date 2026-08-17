// Reusable AI proxy factory. All configuration comes in as options (no
// process.env in here), so the same module can back the local entrypoint,
// tests, or a route inside your own server framework.
//
// The job is deliberately small: hold the provider API key server-side,
// check that the caller is one of YOUR users, and stream the reply back.
// A key shipped to arbitrary browsers is compromised by definition; this
// proxy is the recommended alternative. The editor already speaks the
// provider's wire dialect (openai-chat or anthropic-messages), so request
// bodies pass through untouched and the proxy stays protocol-agnostic.
//
// Nothing here logs request or response bodies: prompts carry your users'
// document text. Keep it that way in your own edits; if you need
// observability, log status codes and durations, never content.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

// Request-body ceiling: prompts ride along with document context, but stay
// far below this. One token holder must not be able to buffer the process
// into the ground.
const BODY_LIMIT_BYTES = 1024 * 1024;

// The size cap alone is per request, so a caller could hold many connections
// that announce a body and then stall, pinning one buffer each until Node's
// 300 s default reaps them. Uploading a prompt takes well under this.
const BODY_IDLE_MS = 20_000;

/**
 * Auth header shape per provider family. 'none' is for local models
 * (Ollama, LM Studio, vLLM) that take no key.
 * @param {'openai' | 'anthropic' | 'none'} provider
 * @param {string} apiKey
 */
function providerHeaders(provider, apiKey) {
  if (provider === 'openai') return { authorization: `Bearer ${apiKey}` };
  if (provider === 'anthropic') return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  return {};
}

/**
 * Caller authorization, run on every request. The default accepts the
 * static token list from the environment: your app sends one of them as
 * "Authorization: Bearer <token>" (the editor's `headers` option takes an
 * async function, so a short-lived session token works too). Replace the
 * body with your real check (verify a JWT, hit your session store); the
 * incoming string is whatever your app put in that header. The call site
 * awaits, so an async replacement is a drop-in.
 *
 * An empty token list accepts every caller. The entrypoint refuses that
 * configuration in production unless AI_ALLOW_UNAUTHENTICATED=1 states
 * that a gateway in front of this process authenticates every request.
 *
 * @param {string} token
 * @param {Set<string>} tokens
 */
function authorizeRequest(token, tokens) {
  if (tokens.size === 0) return true;
  return tokens.has(token);
}

/**
 * @param {object} options
 * @param {string} options.upstreamUrl Full provider or gateway endpoint,
 *   e.g. https://api.openai.com/v1/chat/completions
 * @param {'openai' | 'anthropic' | 'none'} [options.provider] Which auth
 *   header the upstream expects. Default 'openai'.
 * @param {string} [options.apiKey] Provider API key; stays on this server.
 * @param {Set<string>} options.tokens Accepted caller tokens.
 * @param {Set<string>} [options.allowedOrigins] Browser origins allowed to
 *   call the proxy cross-origin. Empty means same-origin deployment: no
 *   CORS headers are emitted at all, which is the safest default.
 * @param {number} [options.requestTimeoutMs] Upstream cutoff. Default 120s,
 *   generous because reasoning models stream slowly at the start.
 * @param {object} [options.dispatcher] Custom undici dispatcher for the
 *   upstream fetch. Node's own fetch cuts a request whose headers or next
 *   body chunk take longer than 300 s (undici's defaults) no matter what
 *   requestTimeoutMs says; a fork that truly needs longer silent gaps
 *   passes a dispatcher whose headersTimeout/bodyTimeout allow them.
 */
export function createAiProxy({
  upstreamUrl,
  provider = 'openai',
  apiKey = '',
  tokens,
  allowedOrigins = new Set(),
  requestTimeoutMs = 120_000,
  dispatcher,
}) {
  if (dispatcher !== undefined && typeof dispatcher?.dispatch !== 'function') {
    // A node:http Agent reads like a synonym and is the realistic mistake;
    // passed through it would fail every request with a silent 502 instead
    // of failing startup with a sentence.
    throw new TypeError(
      'createAiProxy: dispatcher must be an undici Dispatcher (an object with a dispatch method).'
    );
  }
  /** @param {string | undefined} origin */
  function corsHeaders(origin) {
    if (origin === undefined || !allowedOrigins.has(origin)) return {};
    // Reflect only origins from the allow list, never '*': the responses
    // are per-user and the request carries credentials. retry-after is not
    // CORS-safelisted, so it must be exposed for the editor's backoff to
    // read it cross-origin.
    return {
      'access-control-allow-origin': origin,
      'access-control-expose-headers': 'retry-after',
      vary: 'origin',
    };
  }

  /** @param {import('node:http').ServerResponse} res */
  function json(res, status, extraHeaders, body) {
    if (res.destroyed || res.writableEnded || res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
    res.end(JSON.stringify(body));
  }

  /** @param {import('node:http').IncomingMessage} req */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let received = 0;
      // Reaps a caller who announces a body and then goes quiet, so pinned
      // buffers are bounded by how fast a client uploads rather than by how
      // many connections it is willing to open.
      /** @type {ReturnType<typeof setTimeout>} */
      let idle;
      const arm = () => {
        idle = setTimeout(() => {
          const error = new Error('Request body stalled');
          error.statusCode = 408;
          req.destroy(error);
          reject(error);
        }, BODY_IDLE_MS);
      };
      const settle = () => {
        clearTimeout(idle);
      };
      arm();
      req.on('data', (chunk) => {
        settle();
        arm();
        received += chunk.length;
        if (received > BODY_LIMIT_BYTES) {
          // Destroying mid-stream tears down the socket, so the caller sees
          // a reset rather than a polite 413: answering politely would mean
          // reading the rest of an oversized body first, which is the exact
          // thing the limit exists to refuse.
          const error = new Error('Request body too large');
          error.statusCode = 413;
          req.destroy(error);
          reject(error);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        settle();
        resolve(Buffer.concat(chunks));
      });
      req.on('error', (error) => {
        settle();
        reject(error);
      });
      req.on('close', settle);
    });
  }

  return createServer((req, res) => {
    // Computed outside the async flow so the error handler below can attach
    // it too: a cross-origin caller cannot read an error body that arrives
    // without the allow-origin header.
    const cors = corsHeaders(req.headers.origin);
    void (async () => {
      // Preflight: the editor sends JSON with an Authorization header, so
      // cross-origin browsers ask first. Same-origin setups never get here.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...cors,
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '86400',
        });
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        // RFC 9110 requires Allow alongside a 405.
        json(res, 405, { ...cors, allow: 'POST, OPTIONS' }, { error: 'POST only' });
        return;
      }

      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!(await authorizeRequest(token, tokens))) {
        // RFC 6750 requires WWW-Authenticate alongside a bearer 401.
        json(res, 401, { ...cors, 'www-authenticate': 'Bearer' }, { error: 'Missing or invalid bearer token' });
        return;
      }

      const body = await readBody(req);

      // The upstream request is built from scratch: the caller's headers are
      // never forwarded, so the session token above and any cookies cannot
      // leak to the provider. Only the provider auth from THIS server's
      // configuration goes out.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      // A reader who closed the tab must not keep provider tokens burning.
      res.on('close', () => controller.abort());

      let upstream;
      try {
        upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream, application/json',
            ...providerHeaders(provider, apiKey),
          },
          body,
          signal: controller.signal,
          // A followed redirect would resend the body, with the provider
          // auth attached, to whatever host the upstream names: x-api-key
          // is a custom header the fetch spec does not strip cross-origin.
          // Refusing also turns a misconfigured UPSTREAM_URL into a loud,
          // diagnosable failure instead of confusing provider errors.
          redirect: 'error',
          ...(dispatcher === undefined ? {} : { dispatcher }),
        });
      } catch (error) {
        clearTimeout(timeout);
        const timedOut = controller.signal.aborted && !res.destroyed;
        // undici's redirect refusal rejects with TypeError 'fetch failed'
        // whose cause message is exactly 'unexpected redirect' (probed on
        // Node 22 and 24). Matched exactly: a substring test would also
        // catch genuine network errors whose cause embeds a hostname that
        // happens to contain the word.
        const redirected = !timedOut && error?.cause?.message === 'unexpected redirect';
        // One operator-facing line for the silent-502 set (DNS, TLS,
        // connect refusals, redirect refusals): status and cause only,
        // never content, per the logging policy above. Aborts are the
        // caller's own doing and the timeout already answers 504.
        if (!controller.signal.aborted) {
          console.error('[ai-proxy] upstream fetch failed:', error?.cause?.message ?? error?.message);
        }
        json(res, timedOut ? 504 : 502, cors, {
          error: timedOut
            ? 'Upstream timed out'
            : redirected
              ? 'Upstream redirected; set UPSTREAM_URL to the final endpoint'
              : 'Upstream unreachable',
        });
        return;
      }

      // Status and content type pass through untouched, so provider errors
      // reach the editor transport, which already maps them for the UI.
      // retry-after passes too: the editor's backoff honors it on 429/529,
      // and stripping it here would silently degrade that to blind retries.
      const retryAfter = upstream.headers.get('retry-after');
      res.writeHead(upstream.status, {
        ...cors,
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
        ...(retryAfter === null ? {} : { 'retry-after': retryAfter }),
      });

      if (upstream.body === null) {
        clearTimeout(timeout);
        res.end();
        return;
      }
      try {
        // Chunk-by-chunk relay with backpressure; buffering the whole reply
        // would defeat streaming, which is the point of the endpoint.
        await new Promise((resolve, reject) => {
          const stream = Readable.fromWeb(upstream.body);
          stream.pipe(res);
          stream.on('error', reject);
          res.on('finish', resolve);
          res.on('close', resolve);
        });
      } finally {
        clearTimeout(timeout);
        // A relay that failed mid-body must NOT be finished politely:
        // end() writes the chunked terminator, which presents the
        // truncated reply as complete. Dropping the socket lets the client
        // see the cut and surface or retry it. Clean completions never get
        // here with an open stream (pipe already ended the response).
        if (!res.writableEnded) res.destroy();
      }
    })().catch((error) => {
      const tagged = typeof error?.statusCode === 'number';
      const status = tagged ? error.statusCode : 500;
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(status, { 'content-type': 'application/json', ...cors });
        // Only errors minted in this file carry a statusCode; anything else
        // (say a replaced authorizeRequest that throws) must not leak its
        // internals to an unauthenticated caller.
        res.end(
          JSON.stringify({
            error: tagged && error instanceof Error ? error.message : 'Internal error',
          })
        );
      }
    });
  });
}
