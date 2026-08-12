# Reference AI proxy

A zero-dependency streaming proxy for the Domternal Pro [AI assistant](https://domternal.dev/v1/pro/ai/). The editor calls this endpoint; this endpoint holds the provider key and forwards the stream. That is the whole job, and it is the recommended production setup: an API key shipped to arbitrary users' browsers is compromised by definition, and several providers reject browser calls outright.

What it does:

- **Caller authentication**: your app sends `Authorization: Bearer <token>` (the editor's `headers` option takes an async function, so short-lived session tokens work). The example checks the static `AI_TOKENS` list; replace the check in `src/create-proxy.mjs` with your real session lookup.
- **Key isolation**: the upstream request is built from scratch. The caller's headers are never forwarded, so session tokens and cookies cannot leak to the provider, and the provider key never reaches the browser.
- **Streaming passthrough**: request bodies pass through untouched in whichever wire dialect the editor speaks (`openai-chat` or `anthropic-messages`), and the SSE reply streams back chunk by chunk with backpressure. Provider errors pass through with their status, so the editor's transport maps them for the UI.
- **Limits**: a 1 MB request-body cap, an upstream timeout (120 s default), and an abort when the reader closes the tab, so nobody keeps provider tokens burning for a closed window.
- **No content logging**: nothing here logs request or response bodies, because prompts carry your users' document text. Keep it that way in your edits; log status codes and durations if you need observability.
- **Production guards**: with `NODE_ENV=production` the proxy refuses to start with placeholder tokens, and refuses to start with no tokens at all unless `AI_ALLOW_UNAUTHENTICATED=1` says a gateway in front of it authenticates every request.

What it deliberately does not do: rate limiting and usage quotas belong in your gateway or in the session check you plug in, where you know who the user is.

## Run

```bash
cp .env.example .env   # then set UPSTREAM_URL, PROVIDER_API_KEY, AI_TOKENS
node --env-file=.env index.mjs
```

Requires Node >= 22. There is nothing to install. The proxy binds to `127.0.0.1` by default; set `HOST` to expose it deliberately (the Docker setup does).

Check it works before wiring the editor (openai-chat dialect shown; send one of your `AI_TOKENS` values):

```bash
curl -sN -X POST http://127.0.0.1:1250/ \
  -H "authorization: Bearer change-me" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"Say hi"}]}'
```

The reply streams back as `data:` lines. A provider error passes through with its original status and body, so a wrong key or model name is diagnosed from this one command.

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

Deploy the proxy on the same origin as your app when you can; that needs no CORS at all. Cross-origin setups list the exact app origins in `ALLOWED_ORIGINS`, which are reflected per request, never `*`.

## Local models

Ollama, LM Studio and vLLM speak the OpenAI dialect and need no key:

```bash
UPSTREAM_URL=http://127.0.0.1:11434/v1/chat/completions PROVIDER=none AI_TOKENS=dev node index.mjs
```
