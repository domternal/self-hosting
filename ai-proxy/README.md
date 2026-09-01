# Reference AI proxy

A zero-dependency streaming proxy for the Domternal Pro [AI assistant](https://domternal.dev/v1/pro/ai/). The editor calls this endpoint, and this endpoint holds the provider key and forwards the stream. That is the whole job, and it is the recommended production setup: an API key shipped to arbitrary users' browsers is compromised by definition, and several providers reject browser calls outright. This MIT server has no Domternal Pro package dependency and does not need, read or validate a Domternal Pro license key.

What it does:

- **Caller authentication**: your app sends `Authorization: Bearer <token>` (the editor's `headers` option takes an async function, so short-lived session tokens work). `authorizeRequest` in `src/create-proxy.mjs` decides every request and the shipped one checks the static `AI_TOKENS` list, comparing SHA-256 digests so a wrong-length guess cannot settle sooner than a wrong-content one. Replace it with your real session lookup.
- **Key isolation**: the upstream request is built from scratch. The caller's headers are never forwarded, so session tokens and cookies cannot leak to the provider, and the provider key never reaches the browser.
- **Streaming passthrough**: request bodies pass through untouched in whichever wire dialect the editor speaks (`openai-chat` or `anthropic-messages`), and the SSE reply streams back chunk by chunk with backpressure. Provider errors pass through with their status, so the editor's transport maps them for the UI.
- **Limits**: a 1 MB request-body cap with a 20 s stall cutoff on the upload (so a caller who announces a body and goes silent cannot pin buffers), an upstream timeout (120 s default, `REQUEST_TIMEOUT_MS` overrides it: slow local models can need more), and an abort when the reader closes the tab, so nobody keeps provider tokens burning for a closed window.
- **No content logging**: nothing here logs request or response bodies, because prompts carry your users' document text. Keep it that way in your edits, and log status codes and durations if you need observability.
- **Production guards**: unless `NODE_ENV` is exactly `development`, the proxy refuses placeholder, non-header-safe or sub-32-byte caller tokens; a hosted provider without a key; and an HTTP hosted-provider upstream unless `UPSTREAM_ALLOW_INSECURE_HTTP=1` explicitly declares trusted private transport. It refuses an empty `AI_TOKENS` unless `AI_ALLOW_UNAUTHENTICATED=1` states that a gateway in front of the process, or a replaced `authorizeRequest`, authenticates every request. An unset or unknown `NODE_ENV` counts as production, because a systemd unit, pm2 or a bare Kubernetes Deployment starts the process without one. SIGINT/SIGTERM drains active requests, with a 25-second hard cap.

What it deliberately does not do: aggregate connection limits, per-user rate limiting and usage quotas belong in your gateway or in the session check you plug in, where you know who the user is. The proxy caps each request, but those per-request bounds do not cap the memory or provider spend of many authorized requests at once.

The static `AI_TOKENS` list gets you running, and it is the first thing to replace. It reaches the browser, so any user can read it out of the network panel and spend your provider budget from a script, and withdrawing it cuts off every user at once. A per-user session check in `authorizeRequest` fixes both, and it is what makes limits and quotas possible at all, since a limit has to know who is calling. The "Replace the token check" section below shows two ready swaps.

You may not need to deploy this as a service. The editor asks for one thing: a URL that speaks `openai-chat` or `anthropic-messages`. If you already run a backend, the same job is one route inside it, and this directory then serves as a reference for what that route has to get right (authenticate the caller, build the upstream request from scratch, stream the reply, cap the body, time out, log no bodies) rather than as something to run alongside it.

## Run

Generate an independent caller token with `openssl rand -hex 32` and paste it
into `AI_TOKENS`. Keep it separate from the provider API key.

```bash
cp .env.example .env   # then set UPSTREAM_URL, PROVIDER, PROVIDER_API_KEY, AI_TOKENS
chmod 600 .env
npm start
```

Use Node 22.23.2. In this repository, `nvm use` at the root selects it; after
copying only this directory, select 22.23.2 with your own version manager.
There is nothing to install. The proxy binds to `127.0.0.1` by default, and
`HOST` exposes it deliberately (the Docker setup does). `npm start` forces
`NODE_ENV=production` after loading `.env`, so an inherited development setting
cannot weaken the guards. Placeholder or weak credentials fail before the
listener starts.

For mounted secrets, set `PROVIDER_API_KEY_FILE` or `AI_TOKENS_FILE` instead of
the matching direct variable; never set both. The root Compose file mounts
ignored host source files through these file forms, so secret values do not
appear in the container environment. See the root
[`OPERATIONS.md`](../OPERATIONS.md) for safe generation and rotation. If you
copy only this service directory, copy and adapt that runbook too.

Check it works before wiring the editor. The openai-chat dialect is shown, and the bearer value is one of your `AI_TOKENS`:

```bash
curl -sN -X POST http://127.0.0.1:1250/ \
  -H "authorization: Bearer replace-with-one-of-your-ai-tokens" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"Say hi"}]}'
```

The reply streams back as `data:` lines. A provider error passes through with its original status and body, so a wrong key or model name is diagnosed from this one command. Status codes minted by the proxy itself: 401 (missing or invalid caller token), 405 (any method but POST, with OPTIONS answered as the CORS preflight), 415 (the request did not announce `content-type: application/json`), 502 (upstream unreachable or redirecting: the proxy refuses to follow redirects, so point `UPSTREAM_URL` at the final endpoint), 504 (upstream timed out before answering) and 500 (anything unexpected). The JSON content type is a requirement, not a formality. The shipped `Authorization` header forces a CORS preflight on its own, but gateway mode or replacement authentication may omit that header. In those setups, `text/plain`, a form encoding or no type at all leaves a cross-site POST as a CORS simple request, which skips the preflight that checks the origin. Requiring JSON closes that path before the body is read. The check accepts parameters (`application/json; charset=utf-8`) and ignores case. An oversized or stalled request body tears the socket down rather than answering, so those two surface as a connection reset. A relay that fails after the stream started (the upstream dies mid-body, or the timeout fires mid-generation) is cut off rather than terminated politely, so a truncated reply never masquerades as a complete one. Every other status you see came from the provider.

## Wire the editor to it

```ts
Ai.configure({
  connection: {
    protocol: 'openai-chat',              // must match what UPSTREAM_URL speaks
    endpoint: 'https://your.app/ai',      // this proxy
    model: 'gpt-4o-mini',
    headers: async () => ({ authorization: `Bearer ${await sessionToken()}` }),
  },
});
```

No `apiKey` on the client: the proxy adds provider auth server-side (`PROVIDER=openai` sends `Authorization: Bearer`, `PROVIDER=anthropic` sends `x-api-key` plus `anthropic-version`, `PROVIDER=none` sends nothing, for local models).

Deploy the proxy on the same origin as your app when you can, which needs no CORS at all. Cross-origin setups list the exact app origins in `ALLOWED_ORIGINS`, which are reflected per request, never `*`.

## Replace the token check

`authorizeRequest` in `src/create-proxy.mjs` is the one spot to swap. The call site awaits it, so an async replacement is a drop-in: just make the function async.

It runs on every request, including when `AI_TOKENS` is empty, and the caller is accepted only when it returns `true`. What it receives is whatever your app put in the `Authorization: Bearer` header, or `null` when the request carried no usable bearer token at all. Refuse `null` before any lookup, so anonymous traffic cannot turn into a flood of session lookups.

The most portable check asks your app whether the token belongs to a live session. It works unchanged with any auth setup (your own session table, Auth0, Clerk, Supabase), because all of them can expose a "who am I" endpoint:

```js
async function authorizeRequest(token) {
  if (token === null) return false;
  const response = await fetch('https://your.app/api/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.ok;
}
```

If your app issues JWTs, verify them locally instead and skip the per-request network hop. Pin the accepted algorithm, issuer and audience, and require an expiry. Checking only the signature is not enough. The import adds a dependency to your copy, which is fine: zero dependencies describes the reference as shipped, not a rule for your fork. `src/create-proxy.mjs` deliberately reads no environment of its own, so take the secret in as an option from `index.mjs` the way every other setting arrives, and keep `process.env` out of the module.

```js
// index.mjs reads the environment and hands the secret over, so this
// module keeps no process.env of its own: replace the built-in
// authorizeRequest in src/create-proxy.mjs with the function returned by
// authorizeRequestWith(secret), wired from index.mjs.
import { jwtVerify } from 'jose';

function authorizeRequestWith(jwtSecret) {
  const secret = new TextEncoder().encode(jwtSecret);
  return async function authorizeRequest(token) {
    if (token === null) return false;
    try {
      await jwtVerify(token, secret, {
        algorithms: ['HS256'],
        issuer: 'https://your.app',
        audience: 'domternal-ai',
        requiredClaims: ['exp'],
      });
      return true;
    } catch {
      return false;
    }
  };
}
```

Replace the example issuer and audience with values fixed by your application.
Use a separate high-entropy signing secret, keep it server-side and do not use a
provider API key or caller token as the JWT secret.

For asymmetric tokens issued by an identity provider, use the provider's
documented HTTPS JWKS URL with `createRemoteJWKSet` from the same package. Keep
the expected algorithm, issuer, audience and required `exp` claim explicit in
`jwtVerify`; do not select a JWKS URL or accepted algorithm from untrusted token
claims. For example:

```js
import { createRemoteJWKSet, jwtVerify } from 'jose';

const issuer = 'https://your-issuer.example/';
const jwks = createRemoteJWKSet(
  new URL('https://your-issuer.example/.well-known/jwks.json'),
);

async function authorizeRequest(token) {
  if (token === null) return false;
  try {
    await jwtVerify(token, jwks, {
      algorithms: ['RS256'],
      issuer,
      audience: 'your-api-audience',
      requiredClaims: ['exp'],
    });
    return true;
  } catch {
    return false;
  }
}
```

A replacement owns the whole decision, the `AI_TOKENS` list included: the shipped body is the only code that reads that list, so once it is gone the list decides nothing at request time. The startup guard is a separate thing and still applies. In production the entrypoint refuses to start on an empty `AI_TOKENS` unless `AI_ALLOW_UNAUTHENTICATED=1` states that something else authenticates every request, which a replaced `authorizeRequest` does. So either set that variable and leave `AI_TOKENS` empty, or leave one real random token in it and let your own check ignore it; do not park a placeholder or a short value there, because the placeholder and 32-byte guards still read whatever the list holds. With the shipped function an empty list means the opposite of a closed door: every caller is accepted, which is exactly why that configuration has to be declared.

This function is also where per-user rate limits and quotas belong, because it is the first line that knows who is calling.

## Local models

Ollama, LM Studio and vLLM speak the OpenAI dialect and need no key:

```bash
NODE_ENV=development UPSTREAM_URL=http://127.0.0.1:11434/v1/chat/completions PROVIDER=none AI_TOKENS=dev-token node index.mjs
```

`NODE_ENV=development` in that line is load-bearing: anything else, an unset value included, counts as production, where the `dev-token` placeholder and any caller token under 32 bytes are refused before the listener starts.

Slow local models are the case where `REQUEST_TIMEOUT_MS` earns its keep. The reference accepts values up to `300000`, so every request still has a five-minute total ceiling. A fork that truly needs longer must raise the reviewed code limit and pass a custom undici dispatcher via `createAiProxy({ dispatcher })`, with `headersTimeout` and `bodyTimeout` raised to match.
