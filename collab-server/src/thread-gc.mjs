import * as Y from 'yjs';

const DEFAULT_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function deletionStamp(value) {
  if (value === undefined || value === null) return { state: 'live' };
  if (!Number.isFinite(value)) return { state: 'unknown' };
  return { state: 'deleted', value };
}

function threadState(thread) {
  const threadDeletion = deletionStamp(thread.get('deletedAt'));
  if (threadDeletion.state === 'unknown') return { state: 'unknown' };
  const comments = thread.get('comments');
  if (!(comments instanceof Y.Array)) return { state: 'unknown' };

  const signature = [
    threadDeletion.state === 'deleted' ? `thread:${String(threadDeletion.value)}` : 'thread:live',
    `length:${String(comments.length)}`,
  ];
  let hasLiveComment = false;
  let hasUnknownComment = false;
  comments.forEach((comment, index) => {
    if (!(comment instanceof Y.Map)) {
      hasUnknownComment = true;
      signature.push(`${String(index)}:unknown`);
      return;
    }
    const deleted = deletionStamp(comment.get('deletedAt'));
    const id = typeof comment.get('id') === 'string' ? comment.get('id') : '';
    if (deleted.state === 'unknown') {
      hasUnknownComment = true;
      signature.push(`${String(index)}:${id}:unknown`);
    } else if (deleted.state === 'deleted') {
      signature.push(`${String(index)}:${id}:deleted:${String(deleted.value)}`);
    } else {
      hasLiveComment = true;
      signature.push(`${String(index)}:${id}:live`);
    }
  });

  if (hasUnknownComment) return { state: 'unknown' };
  if (threadDeletion.state !== 'deleted' && hasLiveComment) return { state: 'live' };
  return { state: 'dead', signature: signature.join('|') };
}

function collectBodyRepairs(thread, repairs) {
  const threadDeleted = deletionStamp(thread.get('deletedAt')).state === 'deleted';
  const comments = thread.get('comments');
  if (!(comments instanceof Y.Array)) return;

  comments.forEach((comment) => {
    if (!(comment instanceof Y.Map)) return;
    const commentDeleted = deletionStamp(comment.get('deletedAt')).state === 'deleted';
    const body = comment.get('body');
    if ((threadDeleted || commentDeleted) && typeof body === 'string' && body.length > 0) {
      repairs.push(comment);
    }
  });
}

function validateOptions(options) {
  const minAgeMs = options.minAgeMs === undefined ? DEFAULT_MIN_AGE_MS : options.minAgeMs;
  const now = options.now === undefined ? Date.now() : options.now;
  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) {
    throw new RangeError('collectThreadGarbage: minAgeMs must be a finite non-negative number.');
  }
  if (!Number.isFinite(now)) {
    throw new TypeError('collectThreadGarbage: now must be a finite number.');
  }
  return { minAgeMs, now };
}

/**
 * Create an authoritative collector with process-local observation state.
 * Client-writable deletion timestamps classify state but never determine its
 * age. A dead generation must remain continuously observed by this collector
 * for the whole margin. Restarting the process or moving a document to another
 * instance safely restarts the margin and can only delay collection.
 */
export function createThreadGarbageCollector() {
  const statesByThreads = new WeakMap();

  function stateFor(threads, scope) {
    let state = statesByThreads.get(threads);
    if (state) {
      if (state.scope !== scope) {
        state.scope = scope;
        state.observations.clear();
      }
      return state;
    }

    state = {
      observations: new Map(),
      origin: Object.freeze({ source: 'thread-gc' }),
      scope,
    };
    threads.observeDeep((events, transaction) => {
      if (transaction.origin === state.origin) return;
      const affected = new Set();
      let unknownPath = false;
      for (const event of events) {
        const topLevelId = event.path?.[0];
        if (typeof topLevelId === 'string') {
          affected.add(topLevelId);
          continue;
        }
        if (event.target === threads && event.keysChanged instanceof Set) {
          for (const id of event.keysChanged) affected.add(id);
          continue;
        }
        unknownPath = true;
      }
      if (unknownPath) state.observations.clear();
      else for (const id of affected) state.observations.delete(id);
    });
    statesByThreads.set(threads, state);
    return state;
  }

  /**
   * Reclaim dead comment threads from an authoritative, serialized server hook.
   * Observation is always bound to the current Y.Map identity, so unloading and
   * reloading a document restarts the safety margin. `scope` identifies the
   * binding and changing it on the same map also restarts the margin. Returns
   * the number of removed thread entries.
   */
  return function collectThreadGarbage(threads, options = {}) {
    if (!(threads instanceof Y.Map)) {
      throw new TypeError('collectThreadGarbage: threads must be a Y.Map.');
    }
    const { minAgeMs, now } = validateOptions(options);
    const scope = options.scope === undefined ? threads : options.scope;
    if (
      !(
        (typeof scope === 'string' && scope.length > 0) ||
        (typeof scope === 'object' && scope !== null)
      )
    ) {
      throw new TypeError('collectThreadGarbage: scope must be a non-empty string or object.');
    }

    const state = stateFor(threads, scope);
    const { observations } = state;

    const seen = new Set();
    const doomed = [];
    const bodyRepairs = [];
    threads.forEach((thread, id) => {
      seen.add(id);
      if (!(thread instanceof Y.Map)) {
        observations.delete(id);
        return;
      }
      collectBodyRepairs(thread, bodyRepairs);
      const state = threadState(thread);
      if (state.state !== 'dead') {
        observations.delete(id);
        return;
      }

      const previous = observations.get(id);
      if (
        previous === undefined ||
        previous.signature !== state.signature ||
        now < previous.observedAt
      ) {
        observations.set(id, { observedAt: now, signature: state.signature });
        return;
      }
      if (now - previous.observedAt >= minAgeMs) doomed.push(id);
    });

    for (const id of observations.keys()) {
      if (!seen.has(id)) observations.delete(id);
    }
    for (const id of doomed) observations.delete(id);
    if (doomed.length === 0 && bodyRepairs.length === 0) return 0;
    const apply = () => {
      for (const comment of bodyRepairs) comment.set('body', '');
      for (const id of doomed) threads.delete(id);
    };
    if (threads.doc) threads.doc.transact(apply, state.origin);
    else apply();
    return doomed.length;
  };
}

export const collectThreadGarbage = createThreadGarbageCollector();
