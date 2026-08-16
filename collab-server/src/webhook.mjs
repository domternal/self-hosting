// Minimal webhook notifier. Deliberately NOT @hocuspocus/extension-webhook:
// that extension hard-depends on @hocuspocus/transformer, which ships the
// whole @tiptap editor as a dependency just to serialize documents. This
// helper posts the same HMAC-signed JSON shape with zero dependencies, and
// document content stays out of the payload (fetch it via the REST API when
// the receiver needs it).
import { createHmac } from 'node:crypto';

/**
 * @param {object} options
 * @param {string} options.url Endpoint receiving POSTed events.
 * @param {string} [options.secret] HMAC-SHA256 key; empty disables signing.
 * @param {boolean} [options.quiet] Suppress delivery-failure warnings.
 */
export function createWebhookNotifier({ url, secret = '', quiet = false }) {
  /**
   * Fire-and-forget: collaboration must never stall on a slow receiver.
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
    // Bounded delivery: without a cutoff a hung receiver keeps a socket and
    // an in-flight request pinned for undici's 300 second default, per event.
    fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) }).catch((error) => {
      if (!quiet) {
        console.warn(`[webhook] delivery failed for "${event}":`, error?.message ?? error);
      }
    });
  };
}
