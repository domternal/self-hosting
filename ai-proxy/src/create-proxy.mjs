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
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Request-body ceiling: prompts ride along with document context, but stay
// far below this. One token holder must not be able to buffer the process
// into the ground.
const BODY_LIMIT_BYTES = 1024 * 1024;

// The size cap alone is per request, so a caller could hold many connections
// that announce a body and then stall, pinning one buffer each until Node's
// 300 s default reaps them. Uploading a prompt takes well under this.
const BODY_IDLE_MS = 20_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const MAX_BEARER_TOKEN_BYTES = 4_096;
const MAX_PROVIDER_KEY_BYTES = 4_096;
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/u;
const JSON_CONTENT_TYPE = /^application\/json\s*(?:;.*)?$/iu;
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function hasAsciiControl(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

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
 * Caller authorization, and the whole decision: the call site runs this on
 * every request, the empty-token-list case included, and accepts only a
 * literal true. The default accepts the static token list; your app sends one
 * as "Authorization: Bearer <token>" (the editor's `headers` option takes an
 * async function, so a short-lived session token works too). Replace the body
 * with your real check; `token` is null when no usable bearer token arrived,
 * worth refusing before any lookup so anonymous traffic cannot become a flood
 * of session lookups. The call site awaits, so async is a drop-in.
 *
 * An empty token list accepts every caller, decided here so a replacement
 * that ignores `tokens` still governs every request. The entrypoint refuses
 * that configuration in production unless AI_ALLOW_UNAUTHENTICATED=1 states
 * that a gateway, or a replacement here, authenticates every request.
 *
 * @param {string | null} token
 * @param {Set<string>} tokens
 * @param {readonly Buffer[]} acceptedTokenDigests
 */
function authorizeRequest(token, tokens, acceptedTokenDigests) {
  if (tokens.size === 0) return true;
  if (token === null) return false;
  // Digests, so both sides are 32 bytes: timingSafeEqual throws on a length
  // mismatch, and a string compare settles a wrong-length guess sooner than a
  // wrong-content one, leaking the secret's length. Compare yours this way.
  const candidate = createHash('sha256').update(token).digest();
  let accepted = false;
  for (const digest of acceptedTokenDigests) {
    // Always visit the complete list, so a match does not reveal its position
    // through a shorter request-authentication path.
    accepted = timingSafeEqual(candidate, digest) || accepted;
  }
  return accepted;
}

function validateTokenSet(tokens) {
  if (!(tokens instanceof Set)) throw new TypeError('createAiProxy: tokens must be a Set.');
  for (const token of tokens) {
    if (
      typeof token !== 'string' ||
      token === '' ||
      Buffer.byteLength(token, 'utf8') > MAX_BEARER_TOKEN_BYTES ||
      !BEARER_TOKEN.test(token)
    ) {
      throw new TypeError(
        `createAiProxy: tokens must contain only header-safe bearer tokens up to ${String(MAX_BEARER_TOKEN_BYTES)} bytes.`
      );
    }
  }
}

function bearerToken(req) {
  const distinct = req.headersDistinct?.authorization;
  if (distinct !== undefined && distinct.length !== 1) return null;
  const header = distinct?.[0] ?? req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/iu.exec(header);
  return match?.[1] ?? null;
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
 *   upstream fetch. The reference keeps a 300 s total cutoff; a fork that
 *   raises it must also raise the dispatcher's headers and body timeouts.
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
  let endpoint;
  try {
    endpoint = new URL(upstreamUrl);
  } catch {
    throw new TypeError('createAiProxy: upstreamUrl must be a valid HTTP(S) URL.');
  }
  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.hash !== ''
  ) {
    throw new TypeError(
      'createAiProxy: upstreamUrl must be an HTTP(S) URL without credentials or a fragment.'
    );
  }
  if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'none') {
    throw new TypeError('createAiProxy: provider must be openai, anthropic or none.');
  }
  validateTokenSet(tokens);
  // Tokens are static configuration. Hash them once at construction instead
  // of doing synchronous SHA-256 work for every accepted token on every
  // request. This also snapshots the validated set, so later caller mutation
  // cannot inject an unvalidated credential into a running proxy.
  const acceptedTokens = new Set(tokens);
  const acceptedTokenDigests = [...acceptedTokens].map((token) =>
    createHash('sha256').update(token).digest()
  );
  if (
    typeof apiKey !== 'string' ||
    Buffer.byteLength(apiKey, 'utf8') > MAX_PROVIDER_KEY_BYTES ||
    hasAsciiControl(apiKey)
  ) {
    throw new TypeError(
      `createAiProxy: apiKey must be header-safe text up to ${String(MAX_PROVIDER_KEY_BYTES)} bytes.`
    );
  }
  if (!(allowedOrigins instanceof Set)) {
    throw new TypeError('createAiProxy: allowedOrigins must be a Set.');
  }
  for (const origin of allowedOrigins) {
    if (typeof origin !== 'string') {
      throw new TypeError('createAiProxy: allowedOrigins must contain canonical HTTP(S) origins.');
    }
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError('createAiProxy: allowedOrigins must contain canonical HTTP(S) origins.');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.origin !== origin
    ) {
      throw new TypeError('createAiProxy: allowedOrigins must contain canonical HTTP(S) origins.');
    }
  }
  // Origins are static configuration too. Keep the validated snapshot rather
  // than the caller-owned Set, whose later mutation could otherwise widen the
  // browser trust boundary with a value that never passed validation.
  const acceptedOrigins = new Set(allowedOrigins);
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new TypeError(
      `createAiProxy: requestTimeoutMs must be a whole number from 1 to ${String(MAX_REQUEST_TIMEOUT_MS)}.`
    );
  }
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
    if (origin === undefined || !acceptedOrigins.has(origin)) return {};
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
    res.writeHead(status, {
      'content-type': 'application/json',
      ...extraHeaders,
      ...SECURITY_HEADERS,
    });
    res.end(JSON.stringify(body));
  }

  /** @param {import('node:http').IncomingMessage} req */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let received = 0;
      let finished = false;
      // Reaps a caller who announces a body and then goes quiet, so pinned
      // buffers are bounded by how fast a client uploads rather than by how
      // many connections it is willing to open.
      /** @type {ReturnType<typeof setTimeout>} */
      let idle;
      const settle = () => {
        clearTimeout(idle);
      };
      const fail = (error) => {
        if (finished) return;
        finished = true;
        settle();
        req.destroy(error);
        reject(error);
      };
      const arm = () => {
        idle = setTimeout(() => {
          const error = new Error('Request body stalled');
          error.statusCode = 408;
          fail(error);
        }, BODY_IDLE_MS);
        idle.unref();
      };
      arm();
      req.on('data', (chunk) => {
        if (finished) return;
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
          fail(error);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (finished) return;
        finished = true;
        settle();
        resolve(Buffer.concat(chunks));
      });
      req.on('error', (error) => {
        if (finished) return;
        finished = true;
        settle();
        reject(error);
      });
      req.on('close', () => {
        if (finished) return;
        finished = true;
        settle();
        reject(new Error('Request body closed before completion'));
      });
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
          ...SECURITY_HEADERS,
        });
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        // RFC 9110 requires Allow alongside a 405.
        json(res, 405, { ...cors, allow: 'POST, OPTIONS' }, { error: 'POST only' });
        return;
      }

      const token = bearerToken(req);
      // Literal true only, as on the collaboration server: a replacement that
      // returns a response object or a non-empty string by accident must not
      // read as consent.
      if ((await authorizeRequest(token, acceptedTokens, acceptedTokenDigests)) !== true) {
        // RFC 6750 requires WWW-Authenticate alongside a bearer 401.
        json(
          res,
          401,
          { ...cors, 'www-authenticate': 'Bearer' },
          { error: 'Missing or invalid bearer token' }
        );
        return;
      }

      // The shipped Authorization header forces a CORS preflight on its own,
      // but gateway mode or replacement auth may omit it. In those setups,
      // text/plain, a form encoding or no type leaves the POST CORS-simple and
      // able to reach the upstream without an origin check. Requiring JSON
      // closes that path. Parameters follow the media type.
      if (!JSON_CONTENT_TYPE.test(req.headers['content-type'] ?? '')) {
        json(res, 415, cors, { error: 'Content-Type must be application/json' });
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
        upstream = await fetch(endpoint, {
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
          console.error(
            '[ai-proxy] upstream fetch failed:',
            error?.cause?.message ?? error?.message
          );
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
        ...SECURITY_HEADERS,
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
        // pipeline, not pipe: a failed write to the response is emitted, not
        // thrown, and pipe re-emits on a destination nobody listens on, so
        // one reader's broken socket takes the process down with every other
        // user's stream.
        await pipeline(Readable.fromWeb(upstream.body), res);
      } finally {
        clearTimeout(timeout);
        // A relay that failed mid-body must NOT be finished politely:
        // end() writes the chunked terminator, which presents the
        // truncated reply as complete. Dropping the socket lets the client
        // see the cut and surface or retry it. Clean completions never get
        // here with an open stream (pipeline already ended the response).
        if (!res.writableEnded) res.destroy();
      }
    })().catch((error) => {
      const tagged = typeof error?.statusCode === 'number';
      const status = tagged ? error.statusCode : 500;
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(status, {
          'content-type': 'application/json',
          ...cors,
          ...SECURITY_HEADERS,
        });
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
