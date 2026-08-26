import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import {
  collectThreadGarbage,
  createThreadGarbageCollector,
} from '../src/thread-gc.mjs';

const DAY = 24 * 60 * 60 * 1000;

function comment(values = {}) {
  const map = new Y.Map();
  for (const [key, value] of Object.entries(values)) map.set(key, value);
  return map;
}

function thread({ comments = [], ...values } = {}) {
  const map = new Y.Map();
  for (const [key, value] of Object.entries(values)) map.set(key, value);
  const list = new Y.Array();
  map.set('comments', list);
  if (comments.length > 0) list.push(comments);
  return map;
}

function documentWith(entries) {
  const document = new Y.Doc();
  const threads = document.getMap('comments');
  document.transact(() => {
    for (const [id, value] of Object.entries(entries)) threads.set(id, value);
  });
  return { document, threads };
}

test('waits a full server-observed margin before reclaiming dead threads', () => {
  const collect = createThreadGarbageCollector();
  const observedAt = 30 * DAY;
  const { document, threads } = documentWith({
    live: thread({ comments: [comment({ body: 'keep me' })] }),
    tombstoned: thread({
      deletedAt: 2,
      gcObservedDeadAt: -1_000_000,
      comments: [comment({ body: '', deletedAt: 2 })],
    }),
    legacyEmpty: thread({ createdAt: 1 }),
  });

  assert.equal(collect(threads, { minAgeMs: DAY, now: observedAt }), 0);
  assert.equal(collect(threads, { minAgeMs: DAY, now: observedAt + DAY - 1 }), 0);
  assert.equal(collect(threads, { minAgeMs: DAY, now: observedAt + DAY }), 2);
  assert.deepEqual([...threads.keys()], ['live']);
  document.destroy();
});

test('uses one Yjs transaction for body repair and physical removals', () => {
  const collect = createThreadGarbageCollector();
  const { document, threads } = documentWith({
    remove: thread({ deletedAt: 1, comments: [comment({ body: '', deletedAt: 1 })] }),
    repair: thread({
      comments: [
        comment({ body: 'deleted reply', deletedAt: 1 }),
        comment({ body: 'live reply' }),
      ],
    }),
  });
  collect(threads, { minAgeMs: 10, now: 10 });
  const repairComments = threads.get('repair').get('comments');
  repairComments.get(0).set('body', 'merged back after the first sweep');
  let transactions = 0;
  document.on('afterTransaction', () => {
    transactions += 1;
  });

  assert.equal(collect(threads, { minAgeMs: 10, now: 20 }), 1);
  assert.equal(transactions, 1);
  assert.equal(threads.has('remove'), false);
  assert.equal(repairComments.get(0).get('body'), '');
  assert.equal(repairComments.get(1).get('body'), 'live reply');
  document.destroy();
});

test('future and stale client clocks cannot shorten or indefinitely extend the margin', () => {
  const collect = createThreadGarbageCollector();
  const observedAt = 100 * DAY;
  const { document, threads } = documentWith({
    skewed: thread({
      deletedAt: observedAt + 10_000 * DAY,
      gcObservedDeadAt: observedAt + 20_000 * DAY,
    }),
  });

  assert.equal(collect(threads, { minAgeMs: DAY, now: observedAt }), 0);
  assert.equal(collect(threads, { minAgeMs: DAY, now: observedAt + DAY - 1 }), 0);
  assert.equal(collect(threads, { minAgeMs: DAY, now: observedAt + DAY }), 1);
  document.destroy();
});

test('rejects every non-finite or wrongly typed clock and age option without mutation', () => {
  const collect = createThreadGarbageCollector();
  const { document, threads } = documentWith({ dead: thread({ deletedAt: 1 }) });
  const before = Y.encodeStateAsUpdate(document);

  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1', null]) {
    assert.throws(() => collect(threads, { minAgeMs: DAY, now }), /now must be a finite number/u);
  }
  for (const minAgeMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
    assert.throws(
      () => collect(threads, { minAgeMs, now: 1 }),
      /minAgeMs must be a finite non-negative number/u
    );
  }
  assert.deepEqual(Y.encodeStateAsUpdate(document), before);
  document.destroy();
});

test('malformed deletion stamps are unknown and can never cause early collection', () => {
  const collect = createThreadGarbageCollector();
  const invalid = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1'];
  const entries = {};
  for (const [index, stamp] of invalid.entries()) {
    entries[`thread-${String(index)}`] = thread({
      deletedAt: stamp,
      comments: [comment({ body: 'thread body' })],
    });
    entries[`comment-${String(index)}`] = thread({
      comments: [comment({ body: 'comment body', deletedAt: stamp })],
    });
  }
  const { document, threads } = documentWith(entries);

  assert.equal(collect(threads, { minAgeMs: 1, now: 1 }), 0);
  assert.equal(collect(threads, { minAgeMs: 1, now: Number.MAX_SAFE_INTEGER }), 0);
  assert.equal(threads.size, invalid.length * 2);
  for (const value of threads.values()) {
    assert.equal(value.get('comments').get(0).get('body').endsWith('body'), true);
  }
  document.destroy();
});

test('a backward server clock restarts the full observation margin', () => {
  const collect = createThreadGarbageCollector();
  const { document, threads } = documentWith({ dead: thread({ deletedAt: 1 }) });

  assert.equal(collect(threads, { minAgeMs: DAY, now: 100 }), 0);
  assert.equal(collect(threads, { minAgeMs: DAY, now: 90 }), 0);
  assert.equal(collect(threads, { minAgeMs: DAY, now: 90 + DAY - 1 }), 0);
  assert.equal(collect(threads, { minAgeMs: DAY, now: 90 + DAY }), 1);
  document.destroy();
});

test('revival clears observation and re-deletion opens a new full margin', () => {
  const collect = createThreadGarbageCollector();
  const item = thread({ deletedAt: 1, comments: [comment({ body: 'reply' })] });
  const { document, threads } = documentWith({ redeleted: item });

  assert.equal(collect(threads, { minAgeMs: DAY, now: 100 }), 0);
  item.delete('deletedAt');
  assert.equal(collect(threads, { minAgeMs: DAY, now: 150 }), 0);
  item.set('deletedAt', 160);
  assert.equal(collect(threads, { minAgeMs: DAY, now: 160 }), 0);
  assert.equal(collect(threads, { minAgeMs: DAY, now: 100 + DAY }), 0);
  assert.equal(collect(threads, { minAgeMs: DAY, now: 160 + DAY }), 1);
  document.destroy();
});

test('a changed dead generation restarts the margin even without an observed live pass', () => {
  const collect = createThreadGarbageCollector();
  const item = thread({ deletedAt: 1 });
  const { document, threads } = documentWith({ redeleted: item });

  assert.equal(collect(threads, { minAgeMs: DAY, now: 100 }), 0);
  item.set('deletedAt', 200);
  assert.equal(collect(threads, { minAgeMs: DAY, now: 100 + DAY }), 0);
  assert.equal(collect(threads, { minAgeMs: DAY, now: 100 + 2 * DAY - 1 }), 0);
  assert.equal(collect(threads, { minAgeMs: DAY, now: 100 + 2 * DAY }), 1);
  document.destroy();
});

test('a Y.Doc unload and reload restarts the full margin for the same scope', () => {
  const collect = createThreadGarbageCollector();
  const first = documentWith({ dead: thread({ deletedAt: 1 }) });
  assert.equal(collect(first.threads, { minAgeMs: DAY, now: 1, scope: 'tenant/doc' }), 0);
  first.document.destroy();

  const second = documentWith({ dead: thread({ deletedAt: 1 }) });
  assert.equal(
    collect(second.threads, { minAgeMs: DAY, now: 1 + DAY, scope: 'tenant/doc' }),
    0
  );
  assert.equal(
    collect(second.threads, { minAgeMs: DAY, now: 1 + 2 * DAY - 1, scope: 'tenant/doc' }),
    0
  );
  assert.equal(
    collect(second.threads, { minAgeMs: DAY, now: 1 + 2 * DAY, scope: 'tenant/doc' }),
    1
  );
  second.document.destroy();
});

test('same-stamp revival and re-deletion cannot inherit the old observation', () => {
  const collect = createThreadGarbageCollector();
  const item = thread({ deletedAt: 1, comments: [comment({ body: 'reply' })] });
  const { document, threads } = documentWith({ redeleted: item });

  assert.equal(collect(threads, { minAgeMs: DAY, now: 100 }), 0);
  document.transact(() => {
    item.delete('deletedAt');
    item.set('deletedAt', 1);
  });
  assert.equal(collect(threads, { minAgeMs: DAY, now: 100 + DAY }), 0);
  assert.equal(collect(threads, { minAgeMs: DAY, now: 100 + 2 * DAY - 1 }), 0);
  assert.equal(collect(threads, { minAgeMs: DAY, now: 100 + 2 * DAY }), 1);
  document.destroy();
});

test('malformed peer data is skipped while valid deleted bodies are repaired', () => {
  const collect = createThreadGarbageCollector();
  const malformedThread = new Y.Map();
  malformedThread.set('comments', 'not an array');
  const mixed = thread({
    comments: ['not a map', comment({ body: 'purge me', deletedAt: 1 })],
  });
  const { document, threads } = documentWith({
    primitive: 'not a thread',
    malformedThread,
    mixed,
  });

  assert.equal(collect(threads, { minAgeMs: 1, now: 1 }), 0);
  assert.equal(collect(threads, { minAgeMs: 1, now: 1_000 }), 0);
  assert.equal(threads.get('primitive'), 'not a thread');
  assert.equal(threads.get('malformedThread'), malformedThread);
  assert.equal(mixed.get('comments').get(1).get('body'), '');
  document.destroy();
});

test('supports a zero margin and a transaction-free live no-op', () => {
  const collect = createThreadGarbageCollector();
  const zero = documentWith({ dead: thread({ deletedAt: 1 }) });
  assert.equal(collect(zero.threads, { minAgeMs: 0, now: 2 }), 0);
  assert.equal(collect(zero.threads, { minAgeMs: 0, now: 2 }), 1);
  assert.equal(zero.threads.size, 0);
  zero.document.destroy();

  const { document, threads } = documentWith({
    live: thread({ comments: [comment({ body: 'unchanged' })] }),
  });
  let transactions = 0;
  document.on('afterTransaction', () => {
    transactions += 1;
  });
  assert.equal(collect(threads, { minAgeMs: DAY, now: 10 }), 0);
  assert.equal(transactions, 0);
  document.destroy();
});

test('validates the threads map and explicit scope', () => {
  assert.throws(() => collectThreadGarbage({}, { now: 1 }), /threads must be a Y.Map/u);
  const threads = new Y.Map();
  for (const scope of ['', 0, false, null]) {
    assert.throws(
      () => collectThreadGarbage(threads, { now: 1, scope }),
      /scope must be a non-empty string or object/u
    );
  }
});
