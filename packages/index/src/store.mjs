/**
 * packages/index/src/store.mjs — OPTIONAL durable catalog store.
 *
 * The catalog itself (packages/index/src/index.mjs) is in-memory by design: one process,
 * one Map, a JSON snapshot if you want one. That is exactly right for `npm run dev:all`
 * and wrong for a serverless deployment, where every cold start begins with an empty
 * process and no two invocations share a heap.
 *
 * This module is the escape hatch. When a Redis-compatible backend is configured the
 * deployment gains a durable, shared catalog and the auto-cataloging write path becomes
 * real. When it is NOT configured, `createStore()` returns `null` and the caller falls
 * back to the read-only seeded catalog.
 *
 * THE CONTRACT THAT MATTERS: nothing here ever throws and nothing here ever requires an
 * environment variable to exist. A missing, malformed or unreachable store degrades to
 * `null` or to `{ ok: false, reason }` — never to a 500 on a read path.
 *
 * ─── TWO TRANSPORTS, ONE STORE ──────────────────────────────────────────────────────
 *
 * Redis-as-a-service comes in two flavours and which one you get is decided by whoever
 * provisioned the database, not by this code:
 *
 *   rest    `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or the `UPSTASH_REDIS_REST_*` pair).
 *           An HTTPS endpoint: "POST a JSON array of the Redis command, get back
 *           `{ result }` or `{ error }`", which `fetch` covers entirely. Stateless, so it
 *           is the better fit for serverless and it is preferred when both are available.
 *
 *   redis   `KV_REDIS_URL` (or `REDIS_URL`) — `redis://` or `rediss://`. The native
 *           protocol over TCP, spoken through the `redis` package (node-redis, MIT).
 *           This is what the Vercel Marketplace Redis integration hands you: it exposes a
 *           connection URL and NO REST endpoint at all, so without this branch a
 *           Marketplace-provisioned database can never be reached.
 *
 * Both transports reduce to the same primitive — `command(['HSET', key, field, value])` —
 * so the storage layout, the validation and the failure semantics below are written once.
 *
 * ─── CONNECTIONS AND SERVERLESS ─────────────────────────────────────────────────────
 *
 * TCP and serverless mix badly, and the free tiers cap connections in the low tens. The
 * `redis` transport therefore:
 *
 *   · never connects at module load — the first *use* connects, so a cold instance that
 *     only ever serves a cached read pays nothing;
 *   · caches one client on a module-level singleton, so warm invocations reuse a single
 *     connection for the life of the instance;
 *   · shares ONE in-flight connect promise, so N concurrent requests against a cold
 *     instance open one socket rather than N;
 *   · never calls `quit()`/`disconnect()` per request — that would defeat the whole point;
 *   · treats a client that has gone away (idle timeout, server restart) as replaceable:
 *     the command is retried exactly once on a freshly built client;
 *   · bounds the connect with a short timeout, because a discovery read must never hang.
 *     On failure the caller falls back to the seeded catalog, which is by design.
 *
 * Storage layout — a single Redis HASH, `id -> JSON(record)`:
 *
 *   HGETALL starsight:catalog:v1            read the whole catalog (one round trip)
 *   HSET    starsight:catalog:v1 <id> <json>  upsert one record
 *   HDEL    starsight:catalog:v1 <id>         remove one record
 *
 * A hash rather than one JSON blob because HSET on a field is atomic: two lambda
 * instances cataloging different resources at the same moment cannot clobber each other,
 * which a read-modify-write of a single key absolutely would.
 */

export const DEFAULT_STORE_KEY = 'starsight:catalog:v1';
const DEFAULT_TIMEOUT_MS = 4000;
/** Short by design: a hung connect is worse than a seeded fallback. */
const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
/** Refuse to store an absurd record rather than filling the hash with junk. */
const MAX_RECORD_BYTES = 64 * 1024;

function trimmed(v) {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : '';
}

function positiveInt(raw, fallback) {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Everything that leaves this module as a string — a `reason`, a health `error` — goes
 * through here first.
 *
 * node-redis puts the connection URL in several of its error messages, and that URL
 * carries the password. `AggregateError`s from a failed connect can carry it twice. So:
 * strip any `scheme://<userinfo>@` and then blank the known secrets literally, in case a
 * provider ever echoes a bare token back in an error body.
 */
function scrubbed(value, secrets = []) {
  let s = String(value?.message ?? value ?? '');
  // `redis://default:hunter2@host:6379` -> `redis://***@host:6379`
  s = s.replace(/([a-zA-Z][\w+.-]*:\/\/)[^\s/@]*@/g, '$1***@');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) s = s.split(secret).join('***');
  }
  return s;
}

/**
 * readStoreConfig(env) -> config | null
 *
 * Transport selection, in order:
 *
 *   1. A usable REST pair wins. It is stateless, so it is strictly better suited to a
 *      function that may be frozen mid-request, and anyone already running on Vercel KV
 *      or Upstash REST must keep the exact behaviour they have today.
 *   2. Otherwise a `redis://`/`rediss://` connection URL.
 *   3. Otherwise `null` — not configured, read-only catalog, and that is a valid state.
 *
 * A REST pair that is present but unusable (unparseable URL, wrong scheme) does not
 * short-circuit: it falls through to the protocol branch and, failing that, to `null`.
 * Junk in the environment must never be the difference between "read-only" and "crash".
 *
 * THE RETURNED CONFIG CARRIES CREDENTIALS — `token` on the REST branch, and a connection
 * URL that embeds the password on the protocol branch. It is an internal value: never log
 * it, never serialise it, never put it in a response. `host` is the field that is safe to
 * print, and it is host-only for exactly that reason.
 */
export function readStoreConfig(env = process.env) {
  const e = env ?? {};
  const key = trimmed(e.STARSIGHT_KV_KEY) || DEFAULT_STORE_KEY;
  const timeoutMs = positiveInt(e.STARSIGHT_KV_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  const restUrl = trimmed(e.KV_REST_API_URL) || trimmed(e.UPSTASH_REDIS_REST_URL);
  const restToken = trimmed(e.KV_REST_API_TOKEN) || trimmed(e.UPSTASH_REDIS_REST_TOKEN);
  if (restUrl && restToken) {
    try {
      const parsed = new URL(restUrl);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return {
          transport: 'rest',
          url: parsed.origin,
          token: restToken,
          key,
          timeoutMs,
          // Host only — the token never leaves this module and the full URL is not echoed
          // anywhere a health endpoint might print it.
          host: parsed.host,
        };
      }
    } catch {
      /* unparseable REST URL: not a configured REST store. Try the protocol branch. */
    }
  }

  const redisUrl = trimmed(e.KV_REDIS_URL) || trimmed(e.REDIS_URL);
  if (redisUrl) {
    try {
      const parsed = new URL(redisUrl);
      if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') return null;
      if (!parsed.hostname) return null;
      return {
        transport: 'redis',
        url: redisUrl,
        key,
        timeoutMs,
        connectTimeoutMs: positiveInt(e.STARSIGHT_REDIS_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS),
        // `URL.host` is `hostname[:port]` — no scheme, no username, no password.
        host: parsed.host,
        // Held only so error strings can be scrubbed of it; never returned, never logged.
        secret: parsed.password || '',
      };
    } catch {
      return null; // an unparseable URL is not a configured store
    }
  }

  return null;
}

/**
 * HGETALL comes back as a flat `[field, value, field, value, ...]` array over the raw
 * REST protocol and over RESP2, but the official clients hand back an object. Accept both
 * so this works against whichever shape the provider is serving today.
 */
function hashEntries(result) {
  if (Array.isArray(result)) {
    const out = [];
    for (let i = 0; i + 1 < result.length; i += 2) out.push([String(result[i]), result[i + 1]]);
    return out;
  }
  if (result && typeof result === 'object') return Object.entries(result);
  return [];
}

/**
 * Bound any promise. A store call that never settles would hold a request open until the
 * platform kills it, which is a far worse failure than "the catalog fell back to seed".
 * The timer is unref'd so a pending bound never keeps a process alive.
 */
function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/* ───────────────────── the module-level node-redis singleton ───────────────────── */

/**
 * `{ id, client, promise }` for the one connection this instance is allowed to hold.
 *
 * `id` is the connection URL: if the environment changes underneath us (which only really
 * happens in tests, but costs nothing to handle) the old client is dropped rather than
 * silently reused against the wrong database.
 *
 * `promise` is the in-flight connect. Concurrent callers await the same one; that is the
 * whole guard against a cold instance opening one socket per simultaneous request.
 */
let redisSingleton = null;

/** The loaded `redis` module, kept only so `isErrorReply` has a class to test against. */
let redisModule = null;

/**
 * Did the SERVER answer with an error (`WRONGTYPE`, `NOAUTH`, …), or did the CONNECTION
 * fail? The distinction decides whether the socket is still good: a `-ERR` reply travelled
 * a perfectly healthy connection and throwing it away would mean rebuilding one on every
 * request for as long as the condition lasts.
 */
function isErrorReply(err) {
  const ErrorReply = redisModule?.ErrorReply ?? redisModule?.default?.ErrorReply;
  return typeof ErrorReply === 'function' && err instanceof ErrorReply;
}

/** Tear a client down without ever letting the teardown itself throw. */
function destroyClient(client) {
  try {
    if (typeof client?.destroy === 'function') client.destroy();
    else if (typeof client?.disconnect === 'function') client.disconnect();
  } catch {
    /* already gone */
  }
}

/** A client is reusable only while node-redis says it is both open and ready. */
function isUsable(client) {
  return Boolean(client) && client.isOpen === true && client.isReady === true;
}

/**
 * Build and connect one client. Resolves to `{ ok, client }` or `{ ok: false, reason }` —
 * it does not reject.
 */
async function connectRedis(cfg) {
  try {
    // Dynamic, so the REST deployment never pays to load node-redis and a deployment that
    // somehow shipped without the dependency degrades to read-only instead of crashing.
    // A literal specifier keeps it statically traceable by the bundler.
    redisModule ??= await import('redis');
  } catch (err) {
    return { ok: false, reason: `the 'redis' package is unavailable: ${scrubbed(err, [cfg.secret])}` };
  }

  const mod = redisModule;
  const createClient = mod?.createClient ?? mod?.default?.createClient;
  if (typeof createClient !== 'function') {
    return { ok: false, reason: "the 'redis' package did not export createClient" };
  }

  let client;
  try {
    client = createClient({
      url: cfg.url, // `rediss:` turns TLS on inside node-redis; nothing extra to do here
      socket: {
        connectTimeout: cfg.connectTimeoutMs,
        // No background reconnect loop. On a serverless instance a client that keeps
        // retrying in the background is a connection held against a hard per-plan cap for
        // an instance that may never be invoked again. Let it close; the next request
        // notices `isReady === false` and builds a new one.
        reconnectStrategy: false,
      },
      // Fail a command immediately when the socket is not writeable rather than queueing
      // it in the hope of a reconnect that will never come.
      disableOfflineQueue: true,
    });
  } catch (err) {
    return { ok: false, reason: scrubbed(err, [cfg.secret]) };
  }

  // BEFORE connect, and non-negotiable: an unhandled `error` event on an EventEmitter
  // takes the whole process down, and a socket dropped between requests emits exactly
  // that. Swallowing here is safe because the client's health is read back from
  // `isReady` and from command results, never from this listener.
  client.on('error', () => {});

  try {
    await withTimeout(client.connect(), cfg.connectTimeoutMs, 'redis connect');
  } catch (err) {
    destroyClient(client);
    return { ok: false, reason: scrubbed(err, [cfg.secret]) };
  }

  return { ok: true, client };
}

/**
 * The cached client, connecting first if needed.
 *
 * Resolves `{ ok: true, client, fresh }` — `fresh` says whether this call built the
 * connection, which is what tells the command layer whether a retry could possibly help.
 */
async function acquireRedis(cfg) {
  const entry = redisSingleton;

  if (entry && entry.id === cfg.url) {
    if (entry.promise) return entry.promise; // someone else is already connecting
    if (isUsable(entry.client)) return { ok: true, client: entry.client, fresh: false };
    redisSingleton = null; // dead or half-open: drop it and build a new one below
    destroyClient(entry.client);
  } else if (entry) {
    redisSingleton = null; // configuration changed underneath us
    if (entry.promise) entry.promise.then((r) => destroyClient(r?.client), () => {});
    else destroyClient(entry.client);
  }

  const next = { id: cfg.url, client: null, promise: null };
  const settle = (result) => {
    next.promise = null;
    if (result.ok) {
      next.client = result.client;
      return { ok: true, client: result.client, fresh: true };
    }
    // A failed connect must not be cached as "the connection", or every later request on
    // this instance would short-circuit against a stale failure.
    if (redisSingleton === next) redisSingleton = null;
    return { ok: false, reason: result.reason, fresh: true };
  };
  // `connectRedis` is written not to reject; the rejection handler is the guarantee that
  // it cannot, because a rejecting acquire would surface as a 500 on a read path.
  next.promise = connectRedis(cfg).then(settle, (err) =>
    settle({ ok: false, reason: scrubbed(err, [cfg.secret]) }),
  );
  redisSingleton = next;
  return next.promise;
}

/**
 * Close the cached connection. For test harnesses and one-shot scripts that want the
 * process to exit promptly — NEVER for a request path, where dropping the connection is
 * precisely the thing this module exists to avoid.
 */
export function closeStoreClient() {
  const entry = redisSingleton;
  redisSingleton = null;
  if (!entry) return Promise.resolve();
  if (entry.promise) return entry.promise.then((r) => destroyClient(r?.client), () => {});
  destroyClient(entry.client);
  return Promise.resolve();
}

/* ────────────────────────────────── transports ────────────────────────────────── */

/** REST: one HTTPS round trip per command. Unchanged behaviour, moved into a factory. */
function restCommand(cfg, fetchImpl) {
  return async function command(args) {
    let signal;
    try {
      signal = AbortSignal.timeout(cfg.timeoutMs);
    } catch {
      signal = undefined; // very old runtimes: run without a timeout rather than fail
    }
    try {
      const res = await fetchImpl(cfg.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args.map(String)),
        ...(signal ? { signal } : {}),
      });
      const text = await res.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        return { ok: false, reason: `store returned non-JSON (HTTP ${res.status})` };
      }
      if (!res.ok) {
        return {
          ok: false,
          reason: payload?.error
            ? scrubbed(payload.error, [cfg.token])
            : `store HTTP ${res.status}`,
        };
      }
      if (payload && payload.error) return { ok: false, reason: scrubbed(payload.error, [cfg.token]) };
      return { ok: true, result: payload?.result };
    } catch (err) {
      return { ok: false, reason: scrubbed(err, [cfg.token]) };
    }
  };
}

/**
 * Redis protocol: the same commands down a pooled TCP connection.
 *
 * `sendCommand` rather than the typed helpers (`hGetAll`, `hSet`, …) so both transports
 * encode a command the same way and so this survives node-redis renaming its sugar. RESP2
 * hands HGETALL back as a flat array, which `hashEntries` already understands.
 */
function redisProtocolCommand(cfg) {
  const secrets = [cfg.secret];
  return async function command(args) {
    const encoded = args.map(String);
    for (let attempt = 0; attempt < 2; attempt++) {
      const acquired = await acquireRedis(cfg);
      if (!acquired.ok) return { ok: false, reason: acquired.reason };

      try {
        const result = await withTimeout(
          acquired.client.sendCommand(encoded),
          cfg.timeoutMs,
          `redis ${encoded[0]}`,
        );
        return { ok: true, result };
      } catch (err) {
        // The server said no. The connection is fine; keep it and report the reply.
        if (isErrorReply(err)) return { ok: false, reason: scrubbed(err, secrets) };

        // Anything else and this client is suspect: an idle-timed-out socket, a restarted
        // server, a command that outran its bound. Drop it.
        if (redisSingleton?.client === acquired.client) redisSingleton = null;
        destroyClient(acquired.client);

        // Retry once, but only when the failed client was a cached one — a command that
        // just failed on a connection built milliseconds ago will fail again, and
        // doubling the latency of a genuinely broken store helps nobody.
        if (attempt === 0 && !acquired.fresh) continue;
        return { ok: false, reason: scrubbed(err, secrets) };
      }
    }
    return { ok: false, reason: 'redis command failed' };
  };
}

/**
 * createStore(env, opts) -> store | null
 *
 * Returns `null` — not a throwing stub, not a rejected promise — when no durable store is
 * configured. Callers branch on the null.
 *
 * store:
 *   kind      'kv'
 *   transport 'rest' | 'redis' — which path is live, for /discovery/health
 *   key       the Redis hash key in use
 *   host      the endpoint host, safe to print
 *   load()    -> { ok, records, reason? }
 *   put(rec)  -> { ok, reason? }
 *   remove(id) -> { ok, reason? }
 *   ping()    -> { ok, count?, reason? }
 */
export function createStore(env = process.env, opts = {}) {
  const cfg = readStoreConfig(env);
  if (!cfg) return null;

  let command;
  if (cfg.transport === 'rest') {
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') return null; // no fetch, no store — still not a crash
    command = restCommand(cfg, fetchImpl);
  } else {
    command = redisProtocolCommand(cfg);
  }

  return {
    kind: 'kv',
    transport: cfg.transport,
    key: cfg.key,
    host: cfg.host,

    /** Read every record. A parse failure on one field skips that field, not the load. */
    async load() {
      const r = await command(['HGETALL', cfg.key]);
      if (!r.ok) return { ok: false, records: [], reason: r.reason };
      const records = [];
      for (const [, raw] of hashEntries(r.result)) {
        if (raw === null || raw === undefined) continue;
        // A client configured for binary replies hands back a Buffer/Uint8Array, which is
        // an `object` but very much not a record. Decode it back to the JSON text first.
        const value = ArrayBuffer.isView(raw) ? new TextDecoder().decode(raw) : raw;
        if (typeof value === 'object') {
          records.push(value);
          continue;
        }
        try {
          const parsed = JSON.parse(String(value));
          if (parsed && typeof parsed === 'object') records.push(parsed);
        } catch {
          /* one corrupt field must not take the whole catalog down */
        }
      }
      return { ok: true, records };
    },

    /**
     * Persist ONE record under its own hash field. The caller passes the record the
     * catalog actually stored (post-validation), never the raw request body — the store
     * must not become a way to smuggle a field past packages/index/src/integrity.mjs.
     */
    async put(record) {
      const id = record?.id;
      if (typeof id !== 'string' || id.length === 0) {
        return { ok: false, reason: 'record.id is required to persist a record' };
      }
      let json;
      try {
        json = JSON.stringify(record);
      } catch (err) {
        return { ok: false, reason: `record is not serialisable: ${String(err?.message ?? err)}` };
      }
      if (json.length > MAX_RECORD_BYTES) {
        return { ok: false, reason: `record exceeds ${MAX_RECORD_BYTES} bytes` };
      }
      const r = await command(['HSET', cfg.key, id, json]);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },

    async remove(id) {
      if (typeof id !== 'string' || id.length === 0) {
        return { ok: false, reason: 'id is required' };
      }
      const r = await command(['HDEL', cfg.key, id]);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },

    /** Cheap reachability probe for the health endpoint. */
    async ping() {
      const r = await command(['HLEN', cfg.key]);
      if (!r.ok) return { ok: false, reason: r.reason };
      return { ok: true, count: Number(r.result) || 0 };
    },
  };
}

export default { createStore, readStoreConfig, closeStoreClient, DEFAULT_STORE_KEY };
