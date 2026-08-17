# Reference AI proxy

A zero-dependency streaming proxy for the Domternal Pro [AI assistant](https://domternal.dev/v1/pro/ai/). The editor calls this endpoint, and this endpoint holds the provider key and forwards the stream. That is the whole job, and it is the recommended production setup: an API key shipped to arbitrary users' browsers is compromised by definition, and several providers reject browser calls outright.

What it does:

- **Caller authentication**: your app sends `Authorization: Bearer <token>` (the editor's `headers` option takes an async function, so short-lived session tokens work). The example checks the static `AI_TOKENS` list. Replace the check in `src/create-proxy.mjs` with your real session lookup.
- **Key isolation**: the upstream request is built from scratch. The caller's headers are never forwarded, so session tokens and cookies cannot leak to the provider, and the provider key never reaches the browser.
- **Streaming passthrough**: request bodies pass through untouched in whichever wire dialect the editor speaks (`openai-chat` or `anthropic-messages`), and the SSE reply streams back chunk by chunk with backpressure. Provider errors pass through with their status, so the editor's transport maps them for the UI.
- **Limits**: a 1 MB request-body cap with a 20 s stall cutoff on the upload (so a caller who announces a body and goes silent cannot pin buffers), an upstream timeout (120 s default, `REQUEST_TIMEOUT_MS` overrides it: slow local models can need more), and an abort when the reader closes the tab, so nobody keeps provider tokens burning for a closed window.
- **No content logging**: nothing here logs request or response bodies, because prompts carry your users' document text. Keep it that way in your edits, and log status codes and durations if you need observability.
- **Production guards**: with `NODE_ENV=production` the proxy refuses to start with placeholder tokens, and refuses to start with no tokens at all unless `AI_ALLOW_UNAUTHENTICATED=1` says a gateway in front of it authenticates every request. An empty `AI_TOKENS` accepts every caller, which is exactly the state that flag opts into.

What it deliberately does not do: rate limiting and usage quotas belong in your gateway or in the session check you plug in, where you know who the user is.

The static `AI_TOKENS` list gets you running, and it is the first thing to replace. It reaches the browser, so any user can read it out of the network panel and spend your provider budget from a script, and withdrawing it cuts off every user at once. A per-user session check in `authorizeRequest` fixes both, and it is what makes limits and quotas possible at all, since a limit has to know who is calling. The "Replace the token check" section below shows two ready swaps.

You may not need to deploy this as a service. The editor asks for one thing: a URL that speaks `openai-chat` or `anthropic-messages`. If you already run a backend, the same job is one route inside it, and this directory then serves as a reference for what that route has to get right (authenticate the caller, build the upstream request from scratch, stream the reply, cap the body, time out, log no bodies) rather than as something to run alongside it.

## Run

```bash
cp .env.example .env   # then set UPSTREAM_URL, PROVIDER, PROVIDER_API_KEY, AI_TOKENS
node --env-file=.env index.mjs
```

Requires Node >= 22.9. There is nothing to install. The proxy binds to `127.0.0.1` by default, and `HOST` exposes it deliberately (the Docker setup does).

Check it works before wiring the editor. The openai-chat dialect is shown, and the bearer value is one of your `AI_TOKENS`:

```bash
curl -sN -X POST http://127.0.0.1:1250/ \
  -H "authorization: Bearer change-me" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"Say hi"}]}'
```

The reply streams back as `data:` lines. A provider error passes through with its original status and body, so a wrong key or model name is diagnosed from this one command. Status codes minted by the proxy itself: 401 (missing or invalid caller token), 405 (any method but POST, with OPTIONS answered as the CORS preflight), 502 (upstream unreachable or redirecting: the proxy refuses to follow redirects, so point `UPSTREAM_URL` at the final endpoint), 504 (upstream timed out before answering) and 500 (anything unexpected). An oversized or stalled request body tears the socket down rather than answering, so those two surface as a connection reset. A relay that fails after the stream started (the upstream dies mid-body, or the timeout fires mid-generation) is cut off rather than terminated politely, so a truncated reply never masquerades as a complete one. Every other status you see came from the provider.

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

The most portable check asks your app whether the token belongs to a live session. It works unchanged with any auth setup (your own session table, Auth0, Clerk, Supabase), because all of them can expose a "who am I" endpoint:

```js
async function authorizeRequest(token) {
  const response = await fetch('https://your.app/api/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.ok;
}
```

If your app issues JWTs, verify them locally instead and skip the per-request network hop. The import adds a dependency to your copy, which is fine: zero dependencies describes the reference as shipped, not a rule for your fork. `src/create-proxy.mjs` deliberately reads no environment of its own, so take the secret in as an option from `index.mjs` the way every other setting arrives, and keep `process.env` out of the module.

```js
// index.mjs reads the environment and hands the secret over, so this
// module keeps no process.env of its own: replace the built-in
// authorizeRequest in src/create-proxy.mjs with the function returned by
// authorizeRequestWith(secret), wired from index.mjs.
import { jwtVerify } from 'jose';

function authorizeRequestWith(jwtSecret) {
  const secret = new TextEncoder().encode(jwtSecret);
  return async function authorizeRequest(token) {
    try {
      await jwtVerify(token, secret); // signature and expiry
      return true;
    } catch {
      return false;
    }
  };
}
```

For tokens signed by an identity provider (Auth0 and Clerk issue RS256), verify against their published keys with `createRemoteJWKSet` from the same package instead of a shared secret.

Once a real check is in place, `AI_TOKENS` has no job left. This function is also where per-user rate limits and quotas belong, because it is the first line that knows who is calling.

## Local models

Ollama, LM Studio and vLLM speak the OpenAI dialect and need no key:

```bash
UPSTREAM_URL=http://127.0.0.1:11434/v1/chat/completions PROVIDER=none AI_TOKENS=dev-token node index.mjs
```

Slow local models are the case where `REQUEST_TIMEOUT_MS` earns its keep, with one runtime limit to know about: Node's own `fetch` cuts a request whose response headers or next chunk take longer than 300 s (undici's defaults), no matter how high the setting goes, and the proxy warns at startup when the configured value crosses that line. The value still bounds the total once tokens flow; only fully silent gaps hit the runtime cap first. A fork that truly needs longer silence can pass a custom undici dispatcher via `createAiProxy({ dispatcher })`, with `headersTimeout` and `bodyTimeout` raised to match.
