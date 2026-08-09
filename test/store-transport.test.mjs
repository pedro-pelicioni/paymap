/**
 * test/store-transport.test.mjs — the durable store speaks two transports.
 *
 * Run with:  node --test test/
 *
 * `packages/index/src/store.mjs` reaches Redis either over an HTTPS REST API
 * (`KV_REST_API_*`, Vercel KV / Upstash) or over the native protocol
 * (`KV_REDIS_URL`, which is all the Vercel Marketplace Redis integration hands out).
 * Three properties are under test:
 *
 *   SELECTION   — the right transport is chosen, REST wins when both are present, and
 *                 no combination of junk in the environment is anything but `null`.
 *   DISCRETION  — no password ever reaches a caller. `host` is host-only and every
 *                 `reason` string is scrubbed, because node-redis puts the connection
 *                 URL (password and all) straight into its error messages.
 *   DEGRADATION — an unreachable store answers `{ ok: false, reason }`. It never throws,
 *                 never hangs, and never takes the process down with an unhandled
 *                 `error` event.
 *
 * The end-to-end round trip against a real server runs only when PAYMAP_TEST_REDIS_URL
 * points at one, and skips cleanly otherwise:
 *
 *   docker run -d -p 6399:6379 redis:7-alpine
 *   PAYMAP_TEST_REDIS_URL=redis://127.0.0.1:6399 npm test
 *
 * Every credential below is an obvious placeholder. Nothing here talks to a real service.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, readStoreConfig, closeStoreClient, DEFAULT_STORE_KEY } from '../packages/index/src/store.mjs';

/** Obvious fakes. Never a real credential, not even a shape-accurate one. */
const REST_ENV = { KV_REST_API_URL: 'https://kv.example.test', KV_REST_API_TOKEN: 'placeholder-rest-token' };
const REDIS_URL = 'redis://default:placeholder-password@redis.example.test:6379';

const RECORD = {
  id: 'https://api.example.test/v1/echo',
  resource: { url: 'https://api.example.test/v1/echo', serviceName: 'Echo' },
};

/* ══════════════════════════════════════════════════════════════════════════
   SELECTION
   ══════════════════════════════════════════════════════════════════════════ */

test('selection: the REST pair alone yields the rest transport', () => {
  const cfg = readStoreConfig(REST_ENV);
  assert.equal(cfg.transport, 'rest');
  assert.equal(cfg.host, 'kv.example.test');
  assert.equal(cfg.key, DEFAULT_STORE_KEY);
  assert.equal(createStore(REST_ENV).transport, 'rest');
});

test('selection: KV_REDIS_URL alone yields the redis transport', () => {
  const cfg = readStoreConfig({ KV_REDIS_URL: REDIS_URL });
  assert.equal(cfg.transport, 'redis');
  assert.equal(createStore({ KV_REDIS_URL: REDIS_URL }).transport, 'redis');
});

test('selection: REDIS_URL is accepted as an alias', () => {
  assert.equal(readStoreConfig({ REDIS_URL }).transport, 'redis');
});

test('selection: rediss:// (TLS) is accepted', () => {
  const cfg = readStoreConfig({ KV_REDIS_URL: 'rediss://default:placeholder@redis.example.test:6380' });
  assert.equal(cfg.transport, 'redis');
  assert.equal(cfg.host, 'redis.example.test:6380');
});

test('selection: REST wins when both are configured', () => {
  // REST is stateless, so it is the better fit for a function that may be frozen
  // mid-request — and anyone already on Vercel KV must keep exactly what they have.
  const cfg = readStoreConfig({ ...REST_ENV, KV_REDIS_URL: REDIS_URL });
  assert.equal(cfg.transport, 'rest');
});

test('selection: an unusable REST pair falls through to the protocol URL', () => {
  const cfg = readStoreConfig({ KV_REST_API_URL: 'not a url', KV_REST_API_TOKEN: 'x', KV_REDIS_URL: REDIS_URL });
  assert.equal(cfg.transport, 'redis');
});

test('selection: junk and half-configured environments are null, never a throw', () => {
  for (const env of [
    {},
    { KV_REST_API_URL: '' },
    { KV_REST_API_URL: 'https://kv.example.test' }, // url without a token
    { KV_REST_API_TOKEN: 'token-without-a-url' },
    { KV_REST_API_URL: 'not a url', KV_REST_API_TOKEN: 'x' },
    { KV_REDIS_URL: '' },
    { KV_REDIS_URL: 'not a url' },
    { KV_REDIS_URL: 'https://redis.example.test' }, // right shape, wrong protocol
    { KV_REDIS_URL: 'redis://' }, // no host
  ]) {
    assert.equal(readStoreConfig(env), null, `expected null for ${JSON.stringify(env)}`);
    assert.equal(createStore(env), null, `expected null store for ${JSON.stringify(env)}`);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   DISCRETION
   ══════════════════════════════════════════════════════════════════════════ */

test('discretion: host is host-only — no scheme, no user, no password', () => {
  const store = createStore({ KV_REDIS_URL: REDIS_URL });
  assert.equal(store.host, 'redis.example.test:6379');
  assert.equal(store.host.includes('placeholder-password'), false);
  assert.equal(store.host.includes('@'), false);
  assert.equal(store.host.includes('//'), false);
});

test('discretion: a failed protocol command never leaks the password', async () => {
  // Port 1 on the loopback refuses instantly, so this is a fast, real connect failure.
  const store = createStore({
    KV_REDIS_URL: 'redis://default:placeholder-password@127.0.0.1:1',
    PAYMAP_REDIS_CONNECT_TIMEOUT_MS: '250',
  });
  const loaded = await store.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.records.length, 0);
  assert.ok(loaded.reason, 'a failure must carry a reason');
  assert.equal(loaded.reason.includes('placeholder-password'), false, `password leaked: ${loaded.reason}`);
  await closeStoreClient();
});

/* ══════════════════════════════════════════════════════════════════════════
   DEGRADATION
   ══════════════════════════════════════════════════════════════════════════ */

test('degradation: an unreachable protocol store answers, it does not throw or hang', async () => {
  const env = { KV_REDIS_URL: 'redis://127.0.0.1:1', PAYMAP_REDIS_CONNECT_TIMEOUT_MS: '250' };
  const store = createStore(env);

  const ping = await store.ping();
  assert.equal(ping.ok, false);
  assert.ok(ping.reason);

  const put = await store.put(RECORD);
  assert.equal(put.ok, false);

  // The unhandled-`error`-event crash would have taken the process down by now, so
  // reaching this line at all is part of the assertion.
  await closeStoreClient();
});

test('degradation: an invalid record is rejected before any connection is attempted', async () => {
  const store = createStore({ KV_REDIS_URL: 'redis://127.0.0.1:1' });
  assert.equal((await store.put({})).ok, false);
  assert.equal((await store.remove('')).ok, false);
});

/* ══════════════════════════════════════════════════════════════════════════
   REST, unchanged
   ══════════════════════════════════════════════════════════════════════════ */

test('rest: the round trip still speaks the REST command protocol', async () => {
  const hash = new Map();
  const seen = [];
  const store = createStore(REST_ENV, {
    fetch: async (url, init) => {
      seen.push({ url, auth: init.headers.Authorization });
      const [verb, , field, value] = JSON.parse(init.body);
      const reply = (result) => new Response(JSON.stringify({ result }), { status: 200 });
      if (verb === 'HSET') {
        hash.set(field, value);
        return reply(1);
      }
      if (verb === 'HLEN') return reply(hash.size);
      if (verb === 'HGETALL') return reply([...hash].flat());
      return reply(null);
    },
  });

  assert.deepEqual(await store.put(RECORD), { ok: true });
  assert.deepEqual(await store.ping(), { ok: true, count: 1 });
  const loaded = await store.load();
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.records, [RECORD]);
  assert.equal(seen[0].url, 'https://kv.example.test');
  assert.equal(seen[0].auth, 'Bearer placeholder-rest-token');
});

/* ══════════════════════════════════════════════════════════════════════════
   END TO END, against a real server — skipped unless one is pointed at
   ══════════════════════════════════════════════════════════════════════════ */

const LIVE_URL = process.env.PAYMAP_TEST_REDIS_URL;

test(
  'redis: a real server round-trips a record and reuses one connection',
  { skip: LIVE_URL ? false : 'set PAYMAP_TEST_REDIS_URL to run against a real Redis' },
  async () => {
    const env = { KV_REDIS_URL: LIVE_URL, PAYMAP_KV_KEY: `paymap:test:${Date.now()}` };
    const store = createStore(env);
    try {
      assert.equal(store.transport, 'redis');
      assert.deepEqual(await store.put(RECORD), { ok: true });

      const loaded = await store.load();
      assert.equal(loaded.ok, true);
      assert.deepEqual(loaded.records, [RECORD]);

      assert.deepEqual(await store.ping(), { ok: true, count: 1 });

      // A second store object over the same URL must share the cached connection rather
      // than open a new one — the whole point of the module-level singleton.
      const second = createStore(env);
      assert.deepEqual(await second.ping(), { ok: true, count: 1 });

      // Concurrent callers on a cold client must share one in-flight connect.
      await closeStoreClient();
      const burst = await Promise.all([store.ping(), store.ping(), store.ping(), store.ping()]);
      assert.deepEqual(burst, [
        { ok: true, count: 1 },
        { ok: true, count: 1 },
        { ok: true, count: 1 },
        { ok: true, count: 1 },
      ]);

      assert.deepEqual(await store.remove(RECORD.id), { ok: true });
      assert.deepEqual(await store.ping(), { ok: true, count: 0 });
    } finally {
      await closeStoreClient();
    }
  },
);

test(
  'redis: a server error reply is reported without discarding the connection',
  { skip: LIVE_URL ? false : 'set PAYMAP_TEST_REDIS_URL to run against a real Redis' },
  async () => {
    // A key holding a string is a WRONGTYPE for HGETALL. The server answering "no" is not
    // the connection failing, and treating it as one would rebuild a socket per request
    // for as long as the mistake lasted.
    const key = `paymap:test:wrongtype:${Date.now()}`;
    const clash = createStore({ KV_REDIS_URL: LIVE_URL, PAYMAP_KV_KEY: key });
    try {
      const store = createStore({ KV_REDIS_URL: LIVE_URL, PAYMAP_KV_KEY: `${key}:ok` });
      assert.deepEqual(await store.put(RECORD), { ok: true }); // opens the connection

      const { createClient } = await import('redis');
      const observer = createClient({ url: LIVE_URL });
      observer.on('error', () => {});
      await observer.connect();
      await observer.set(key, 'not a hash');

      const loaded = await clash.load();
      assert.equal(loaded.ok, false);
      assert.match(loaded.reason, /WRONGTYPE/);

      // Same cached connection, still usable.
      assert.deepEqual(await store.ping(), { ok: true, count: 1 });

      await observer.del([key, `${key}:ok`]);
      await observer.destroy();
    } finally {
      await closeStoreClient();
    }
  },
);
