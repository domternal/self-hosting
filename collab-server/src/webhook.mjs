// Minimal webhook notifier. Deliberately NOT @hocuspocus/extension-webhook:
// that extension hard-depends on @hocuspocus/transformer, which ships an
// entire rich-text editor as a dependency just to serialize documents. This
// helper posts the same HMAC-signed JSON shape with zero dependencies, and
// document content stays out of the payload (fetch it via the REST API when
// the receiver needs it).
import { createHmac } from 'node:crypto';

/**
 * @param {object} options
 * @param {string} options.url Endpoint receiving POSTed events.
 * @param {string} [options.secret] HMAC-SHA256 key; empty disables signing.
 * @param {boolean} [options.quiet] Suppress delivery-failure warnings.
 * @param {number} [options.maxConcurrency] Maximum simultaneous deliveries.
 * @param {number} [options.maxQueue] Maximum waiting best-effort deliveries.
 */
export function createWebhookNotifier({
  url,
  secret = '',
  quiet = false,
  maxConcurrency = 4,
  maxQueue = 100,
}) {
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    throw new TypeError('createWebhookNotifier: url must be a valid HTTP(S) URL.');
  }
  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.hash !== ''
  ) {
    throw new TypeError(
      'createWebhookNotifier: url must be an HTTP(S) URL without credentials or a fragment.'
    );
  }
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 1_000) {
    throw new TypeError('createWebhookNotifier: maxConcurrency must be an integer from 1 to 1000.');
  }
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 0 || maxQueue > 100_000) {
    throw new TypeError('createWebhookNotifier: maxQueue must be an integer from 0 to 100000.');
  }

  let active = 0;
  let dropped = 0;
  const queue = [];
  const activeDocuments = new Set();

  function warn(message) {
    if (!quiet) console.warn(message);
  }

  async function deliver({ event, documentName, headers, body }) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
        // Never resend a signed body to a redirect target the configured
        // receiver controls. Operators must configure the final endpoint.
        redirect: 'error',
      });
      // The receiver body is irrelevant. Cancel it immediately so a server
      // cannot pin a connection by returning headers and then streaming
      // forever, and so successful keep-alive sockets return to the pool.
      if (response.body !== null) await response.body.cancel();
      if (!response.ok) throw new Error(`receiver answered HTTP ${String(response.status)}`);
    } catch (error) {
      warn(`[webhook] delivery failed for "${event}": ${error?.message ?? String(error)}`);
    } finally {
      active -= 1;
      activeDocuments.delete(documentName);
      drainQueue();
    }
  }

  function start(delivery) {
    active += 1;
    activeDocuments.add(delivery.documentName);
    void deliver(delivery);
  }

  function drainQueue() {
    while (active < maxConcurrency) {
      const index = queue.findIndex((delivery) => !activeDocuments.has(delivery.documentName));
      if (index === -1) return;
      const [next] = queue.splice(index, 1);
      start(next);
    }
  }

  /**
   * Bounded, best-effort fire-and-forget: collaboration never stalls on a
   * slow receiver, and a failing receiver cannot create unbounded sockets or
   * memory. Deployments that require guaranteed delivery need a durable
   * outbox; this reference intentionally drops after its finite queue fills.
   * The timestamp travels INSIDE the signed body, so a receiver can bound
   * replay: verify the signature, then refuse events older than its window.
   * @param {string} event
   * @param {Record<string, unknown>} payload
   */
  return function notify(event, payload) {
    const body = JSON.stringify({ event, payload, sentAt: new Date().toISOString() });
    const headers = { 'content-type': 'application/json' };
    if (secret) {
      // Same header contract as @hocuspocus/extension-webhook, so receivers
      // written against it verify this signature unchanged.
      const digest = createHmac('sha256', secret).update(body).digest('hex');
      headers['x-hocuspocus-signature-256'] = `sha256=${digest}`;
    }
    // One in-flight delivery per document preserves event order for that
    // document. Different documents still use the bounded global concurrency.
    // Payloads without a document name intentionally share the null lane.
    const documentName = typeof payload?.documentName === 'string' ? payload.documentName : null;
    const delivery = { event, documentName, headers, body };
    if (active < maxConcurrency && !activeDocuments.has(documentName)) {
      start(delivery);
      return;
    }
    if (queue.length < maxQueue) {
      queue.push(delivery);
      return;
    }
    dropped += 1;
    // Bound log volume too: one warning establishes the problem, then one per
    // hundred drops keeps a long incident visible without becoming its own
    // disk-exhaustion vector.
    if (dropped === 1 || dropped % 100 === 0) {
      warn(`[webhook] queue full: dropped ${String(dropped)} best-effort delivery attempt(s).`);
    }
  };
}
