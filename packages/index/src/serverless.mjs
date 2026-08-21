/**
 * packages/index/src/serverless.mjs — the Node `(req, res)` adapter for the discovery API.
 *
 * `http.mjs` mounts the same two endpoints on an Express app for `npm run dev:all`.
 * This module mounts them on the bare Node request/response signature that Vercel
 * Functions use, so `api/discovery/*.mjs` are three-line files and the ranking,
 * validation and wire format all still come from packages/index. Nothing is duplicated.
 *
 * ─── WHY A SEPARATE ADAPTER ─────────────────────────────────────────────────────────
 *
 * Three things are true in a serverless deployment and false locally, and each one is
 * handled here rather than leaking into the catalog:
 *
 *   1. THE PROCESS IS EPHEMERAL. There is no long-lived heap to accumulate a catalog in,
 *      so one is built at cold start (seed corpus + whatever the durable store holds)
 *      and memoised in module scope for the life of the instance.
 *
 *   2. THERE IS NO SHARED MEMORY. Two concurrent invocations are two processes. A write
 *      that only touched the local Map would be invisible to every other instance and
 *      would vanish on scale-down, so writes go through packages/index/src/store.mjs and
 *      reads re-check the store on a short TTL.
 *
 *   3. THE CALLER IS SOMEONE ELSE'S AGENT. These endpoints exist to be called
 *      cross-origin by software nobody here wrote, so CORS is permissive and the
 *      responses carry CDN cache headers.
 *
 * ─── DEGRADATION ────────────────────────────────────────────────────────────────────
 *
 * With no environment variables at all this serves a read-only catalog seeded from
 * packages/index/src/seed.mjs. That is the baseline and it must never fail: a public
 * Bazaar that answers out of the box beats a write-capable one that needs setup nobody
 * has done. Configuring a durable store — either KV_REST_API_URL + KV_REST_API_TOKEN
 * (Redis REST API) or KV_REDIS_URL (Redis protocol) — upgrades it to a durable, shared
 * catalog; configuring STELLARSIGHT_WRITE_TOKEN on top of that opens the write path. Every one
 * of those is optional and a missing one is never an error.
 */

import { createCatalog } from './index.mjs';
import { seedCatalog } from './seed.mjs';
import { listResources, searchResources, X402_VERSION } from './discovery.mjs';
import { createStore } from './store.mjs';
import { replayHostileCorpus, VALIDATOR_ID } from './integrity-replay.mjs';

const BOOTED_AT = Date.now();

/** How long a durable-store snapshot is trusted before the next request re-reads it. */
const DEFAULT_STORE_TTL_MS = 5_000;
/** CDN caching for the read endpoints. The catalog changes rarely; staleness is cheap. */
const DEFAULT_S_MAXAGE = 60;
const DEFAULT_SWR = 600;
const MAX_WRITE_BODY_BYTES = 256 * 1024;

/* ────────────────────────────── HTTP plumbing ────────────────────────────── */

/**
 * [these endpoints exist to be called by other people's agents, from other origins]
 * The catalog is public, read-only by default and carries no credentials, so `*` is
 * correct rather than merely convenient.
 */
export const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
  'Access-Control-Max-Age': '86400',
});

function cacheControl(env = process.env) {
  const sMaxAge = Number.parseInt(env?.STELLARSIGHT_CACHE_S_MAXAGE ?? '', 10);
  const swr = Number.parseInt(env?.STELLARSIGHT_CACHE_SWR ?? '', 10);
  const s = Number.isFinite(sMaxAge) && sMaxAge >= 0 ? sMaxAge : DEFAULT_S_MAXAGE;
  const r = Number.isFinite(swr) && swr >= 0 ? swr : DEFAULT_SWR;
  // max-age=0 keeps browsers honest while s-maxage lets the CDN absorb the traffic.
  return `public, max-age=0, s-maxage=${s}, stale-while-revalidate=${r}`;
}

/**
 * Parse the query string. Vercel pre-parses it onto `req.query`; a bare Node server (and
 * the local harness) does not, so fall back to `req.url`.
 */
export function readQuery(req) {
  const q = req?.query;
  if (q && typeof q === 'object' && !Array.isArray(q)) return q;
  const out = Object.create(null);
  let params;
  try {
    params = new URL(req?.url ?? '/', 'http://localhost').searchParams;
  } catch {
    return out;
  }
  for (const [k, v] of params) {
    if (Object.prototype.hasOwnProperty.call(out, k)) {
      out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Read a JSON body. Vercel parses `application/json` onto `req.body` for us; anything
 * else (or the harness) streams. Never throws — a malformed body is a 400, not a 500.
 */
export async function readJsonBody(req) {
  const b = req?.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return { ok: true, value: b };
  if (typeof b === 'string' || Buffer.isBuffer(b)) {
    try {
      return { ok: true, value: JSON.parse(b.toString('utf8')) };
    } catch {
      return { ok: false, reason: 'request body is not valid JSON' };
    }
  }
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') {
    return { ok: false, reason: 'request body is required' };
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_WRITE_BODY_BYTES) return { ok: false, reason: 'request body too large' };
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return { ok: false, reason: 'request body is required' };
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: 'request body is not valid JSON' };
  }
}

/**
 * Write a JSON response using only the standard ServerResponse surface
 * (`setHeader`/`statusCode`/`end`) rather than Vercel's `res.json()` sugar, so the very
 * same handler runs unmodified under `node:http` and under the local test harness.
 */
export function sendJson(res, status, body, extraHeaders = {}) {
  for (const [k, v] of Object.entries({ ...CORS_HEADERS, ...extraHeaders })) {
    if (v !== undefined && v !== null) res.setHeader(k, String(v));
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(`${JSON.stringify(body, null, 2)}\n`);
  return res;
}

/**
 * Answer the CORS preflight. Returns true when the request was fully handled.
 * [an agent doing a cross-origin POST will preflight before it ever reaches the handler]
 */
export function handlePreflight(req, res, allow = 'GET, HEAD, OPTIONS') {
  if (req?.method !== 'OPTIONS') return false;
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  res.setHeader('Access-Control-Allow-Methods', allow);
  res.setHeader('Allow', allow);
  res.statusCode = 204;
  res.end();
  return true;
}

function methodNotAllowed(res, allow) {
  return sendJson(res, 405, { error: 'method_not_allowed', message: `allowed methods: ${allow}` }, {
    Allow: allow,
    'Cache-Control': 'no-store',
  });
}

/* ─────────────────────────── cold-start catalog ─────────────────────────── */

/**
 * The build/deploy identity, so `/discovery/health` can say exactly what it is serving.
 * All of these are Vercel system environment variables; every one is optional.
 */
export function buildInfo(env = process.env) {
  const e = env ?? {};
  const commit = e.VERCEL_GIT_COMMIT_SHA || e.GIT_COMMIT_SHA || null;
  return {
    commit,
    commitShort: commit ? String(commit).slice(0, 7) : null,
    ref: e.VERCEL_GIT_COMMIT_REF || null,
    message: e.VERCEL_GIT_COMMIT_MESSAGE || null,
    deploymentId: e.VERCEL_DEPLOYMENT_ID || null,
    deploymentUrl: e.VERCEL_URL || null,
    env: e.VERCEL_ENV || e.NODE_ENV || 'development',
    region: e.VERCEL_REGION || null,
    node: process.version,
  };
}

/** Module-scope memo. One per warm instance; rebuilt on the store TTL in `kv` mode. */
let cachedState = null;
let inflight = null;

function storeTtlMs(env = process.env) {
  const ttl = Number.parseInt(env?.STELLARSIGHT_KV_TTL_MS ?? '', 10);
  return Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_STORE_TTL_MS;
}

/**
 * Build a catalog from scratch: seed corpus first, durable store second.
 *
 * ORDER IS LOAD-BEARING. Seed records are catalog breadth — nobody ever paid for them —
 * and `asSeedRecord` pins them to `settlements: 0, seeded: true`. Store records are real
 * observations. Applying the store second means a real resource sharing an id with a
 * seed record overwrites it and clears the `seeded` flag, exactly as a live announcement
 * does against the long-running index in apps/facilitator.
 *
 * This function does not throw. A broken store yields a seeded catalog plus a recorded
 * `storeError`, which /discovery/health reports.
 */
async function buildState(env = process.env) {
  const catalog = createCatalog();
  const state = {
    catalog,
    mode: 'seed',
    store: null,
    storeConfigured: false,
    storeError: null,
    seeded: 0,
    fromStore: 0,
    loadedAt: Date.now(),
  };

  if (env?.SEED_CATALOG !== '0') {
    try {
      state.seeded = seedCatalog(catalog).inserted;
    } catch (err) {
      state.storeError = `seeding failed: ${String(err?.message ?? err)}`;
    }
  }

  let store = null;
  try {
    store = createStore(env);
  } catch (err) {
    // createStore is written not to throw; if it somehow does, stay read-only.
    state.storeError = `store init failed: ${String(err?.message ?? err)}`;
  }

  if (!store) return state;

  state.store = store;
  state.storeConfigured = true;

  const loaded = await store.load();
  if (!loaded.ok) {
    // Configured but unreachable. Serve the seeded catalog rather than an error page,
    // and say so on /discovery/health.
    state.storeError = loaded.reason ?? 'durable store unreachable';
    return state;
  }

  state.mode = 'kv';
  for (const rec of loaded.records) {
    try {
      if (catalog.upsert(rec).ok) state.fromStore++;
    } catch {
      /* one bad stored record must not break the boot */
    }
  }
  return state;
}

/**
 * getState({ force }) -> the memoised catalog state.
 *
 * In `seed` mode the catalog is immutable, so it is built once per instance and reused
 * forever. In `kv` mode it is rebuilt whenever the snapshot is older than the TTL, which
 * is how a write made by one instance becomes visible to the others.
 *
 * Concurrent callers share a single in-flight build. If a rebuild fails outright, the
 * previous state is kept — a stale catalog beats a 500.
 */
export async function getState({ env = process.env, force = false } = {}) {
  const fresh =
    cachedState &&
    !force &&
    (cachedState.mode === 'seed' || Date.now() - cachedState.loadedAt < storeTtlMs(env));
  if (fresh) return cachedState;

  if (!inflight) {
    inflight = buildState(env)
      .then((state) => {
        cachedState = state;
        inflight = null;
        return state;
      })
      .catch((err) => {
        inflight = null;
        if (cachedState) return cachedState;
        // Last resort: an empty but valid catalog. Still not a crash.
        cachedState = {
          catalog: createCatalog(),
          mode: 'seed',
          store: null,
          storeConfigured: false,
          storeError: String(err?.message ?? err),
          seeded: 0,
          fromStore: 0,
          loadedAt: Date.now(),
        };
        return cachedState;
      });
  }
  return inflight;
}

/** Test/harness helper: drop the memo so the next call rebuilds. */
export function resetState() {
  cachedState = null;
  inflight = null;
}

/* ───────────────────────────────  handlers  ─────────────────────────────── */

/**
 * GET  /discovery/resources — list, with the spec filters and offset pagination.
 * POST /discovery/resources — auto-cataloging. Requires a durable store AND a write
 *                             token; see `authorizeWrite`.
 */
export async function resourcesHandler(req, res, env = process.env) {
  const allow = 'GET, HEAD, POST, OPTIONS';
  if (handlePreflight(req, res, allow)) return res;

  if (req?.method === 'POST') return upsertResource(req, res, env);
  if (req?.method !== 'GET' && req?.method !== 'HEAD') return methodNotAllowed(res, allow);

  const { catalog } = await getState({ env });
  const { status, body } = listResources(catalog, readQuery(req));
  return sendJson(res, status, body, {
    'Cache-Control': status === 200 ? cacheControl(env) : 'no-store',
  });
}

/** GET /discovery/search — natural-language query, `partialResults`, cursor pagination. */
export async function searchHandler(req, res, env = process.env) {
  const allow = 'GET, HEAD, OPTIONS';
  if (handlePreflight(req, res, allow)) return res;
  if (req?.method !== 'GET' && req?.method !== 'HEAD') return methodNotAllowed(res, allow);

  const { catalog } = await getState({ env });
  const { status, body } = searchResources(catalog, readQuery(req));
  return sendJson(res, status, body, {
    'Cache-Control': status === 200 ? cacheControl(env) : 'no-store',
  });
}

/**
 * The health payload used to print the durable store's full `host:port`. That is an
 * unnecessary public disclosure for a project that ships a threat model: the address
 * narrows the attack surface hunt for free, and no reader of the PUBLIC endpoint needs
 * it — "which provider, reachable or not" is the diagnosable part. So the public answer
 * keeps the provider domain and drops the instance label and port. A self-hosting
 * operator who wants the full address back sets STELLARSIGHT_HEALTH_VERBOSE=1 on their
 * own deployment; the reason strings in store.mjs (operator logs, not public wire)
 * are unaffected.
 */
function maskStoreHost(host, env = process.env) {
  if (!host) return null;
  if (env?.STELLARSIGHT_HEALTH_VERBOSE === '1') return host;
  const name = String(host).split(':')[0];
  const labels = name.split('.');
  if (labels.length <= 2) return `…${labels.length === 2 ? `.${labels[1]}` : ''}` || '…';
  return `….${labels.slice(1).join('.')}`;
}

/**
 * GET /discovery/health — which mode is active, how many records, which build.
 *
 * Deliberately uncached: it reports the state of the instance answering right now, and a
 * CDN-cached answer from a different instance would be actively misleading.
 */
export async function healthHandler(req, res, env = process.env) {
  const allow = 'GET, HEAD, OPTIONS';
  if (handlePreflight(req, res, allow)) return res;
  if (req?.method !== 'GET' && req?.method !== 'HEAD') return methodNotAllowed(res, allow);

  const state = await getState({ env });
  const records = state.catalog.all ? state.catalog.all() : [];
  const seededCount = records.filter((r) => r?.seeded === true).length;

  let storeReachable = null;
  if (state.store) {
    const ping = await state.store.ping();
    storeReachable = ping.ok;
    if (!ping.ok && !state.storeError) state.storeError = ping.reason ?? null;
  }

  return sendJson(
    res,
    200,
    {
      ok: true,
      service: 'stellarsight-discovery',
      x402Version: X402_VERSION,
      extensions: ['bazaar'],
      // "which mode is active": `kv` = durable + writable, `seed` = read-only baseline.
      mode: state.mode,
      writable: writeState(state, env).enabled,
      records: state.catalog.size(),
      seededRecords: seededCount,
      liveRecords: records.length - seededCount,
      durableStore: {
        configured: state.storeConfigured,
        reachable: storeReachable,
        // Which of the two backends is live: `rest` (HTTPS API) or `redis` (TCP
        // protocol). An operator staring at a `reachable: false` needs to know which one
        // is being attempted before any of the rest of this is diagnosable.
        transport: state.store?.transport ?? null,
        host: maskStoreHost(state.store?.host, env),
        key: state.store?.key ?? null,
        loadedRecords: state.fromStore,
        error: state.storeError,
      },
      endpoints: [
        '/discovery/resources',
        '/discovery/search',
        '/discovery/health',
        '/discovery/integrity',
      ],
      build: buildInfo(env),
      catalogLoadedAt: state.loadedAt,
      instanceUptimeMs: Date.now() - BOOTED_AT,
    },
    { 'Cache-Control': 'no-store' },
  );
}

/* ─────────────────────────── integrity replay ───────────────────────────── */

/**
 * The replay is deterministic per build — same corpus, same validator, same verdicts —
 * so run it once per warm instance and remember when THIS instance ran it. That
 * timestamp is the only honest `generatedAt` the endpoint can claim: it is when these
 * verdicts were actually produced, not when some earlier build baked its copy.
 */
let integrityMemo = null;

function integrityState() {
  if (!integrityMemo) {
    const { entries, skipped } = replayHostileCorpus();
    integrityMemo = {
      generatedAt: new Date().toISOString(),
      at: Date.now(),
      entries,
      skippedCases: skipped.length,
    };
  }
  return integrityMemo;
}

/** Test/harness helper: drop the memo so the next call re-replays. */
export function resetIntegrityState() {
  integrityMemo = null;
}

/**
 * GET /discovery/integrity — the catalog-integrity ledger, served by the deployment.
 *
 * `source: "replay"` is load-bearing: these are verdicts from replaying a fixed hostile
 * corpus through the shipped validator, NOT observations of live traffic. The web
 * console keys its "replay" banner off that field — a payload that ever carries real
 * observations must say `source: "observed"` instead, and nothing else may.
 */
export async function integrityHandler(req, res, env = process.env) {
  const allow = 'GET, HEAD, OPTIONS';
  if (handlePreflight(req, res, allow)) return res;
  if (req?.method !== 'GET' && req?.method !== 'HEAD') return methodNotAllowed(res, allow);

  const parsed = Number.parseInt(readQuery(req)?.limit ?? '', 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 20;

  const state = integrityState();
  return sendJson(
    res,
    200,
    {
      ok: true,
      source: 'replay',
      generatedAt: state.generatedAt,
      commit: buildInfo(env).commitShort,
      validator: VALIDATOR_ID,
      note: 'Replay of a fixed hostile corpus through the shipped validator. Every rule, verdict and reason is the validator’s own output. Not observed traffic.',
      total: state.entries.length,
      skippedCases: state.skippedCases,
      integrity: state.entries.slice(0, limit).map((e) => ({ at: state.at, ...e })),
    },
    // Deterministic per build, so let the CDN keep it.
    { 'Cache-Control': cacheControl(env) },
  );
}

/* ─────────────────────────────── write path ─────────────────────────────── */

/**
 * Why writes need a token even though the store env vars are enough to make them work:
 *
 * an unauthenticated write endpoint on a public discovery index is a spam magnet, and
 * catalog integrity is the part of this project that is actually load-bearing. Anyone
 * could otherwise fill the Bazaar with records whose `resource` block is chosen to be
 * rendered on other agents' screens. The integrity validator would still soft-drop the
 * hostile FIELDS, but nothing stops volume. So: a durable store makes writes *possible*,
 * STELLARSIGHT_WRITE_TOKEN makes them *permitted*, and the absence of either is reported
 * plainly instead of silently accepted.
 */
function writeState(state, env = process.env) {
  const token = typeof env?.STELLARSIGHT_WRITE_TOKEN === 'string' ? env.STELLARSIGHT_WRITE_TOKEN.trim() : '';
  if (!state.storeConfigured) {
    return {
      enabled: false,
      // Name BOTH transports. A reason that only mentions the REST pair sends anyone
      // holding a Vercel Marketplace Redis — which issues a connection URL and no REST
      // endpoint whatsoever — hunting for variables their provider will never give them.
      reason:
        'catalog is read-only: no durable store is configured. Set KV_REST_API_URL and KV_REST_API_TOKEN (Redis REST API), or KV_REDIS_URL (a redis:// or rediss:// connection URL, which is what the Vercel Marketplace Redis integration provides), to enable auto-cataloging.',
    };
  }
  if (!token) {
    return {
      enabled: false,
      reason:
        'catalog is read-only: a durable store is configured but STELLARSIGHT_WRITE_TOKEN is unset, and an unauthenticated public write endpoint is refused by design.',
    };
  }
  return { enabled: true, token };
}

/** Constant-time-ish bearer comparison. The token is short and this is not a side channel worth optimising, but avoid the early exit anyway. */
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function bearerOf(req) {
  const raw = req?.headers?.authorization ?? req?.headers?.Authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1].trim() : '';
}

/**
 * POST /discovery/resources — the auto-cataloging write path.
 *
 * The record goes through `catalog.upsert`, i.e. through the same integrity validation
 * as live settle traffic in apps/facilitator: soft-dropped fields are reported back in
 * `dropped`, identity failures are a 400. Only the POST-VALIDATION record is persisted,
 * so the durable store can never be used to smuggle a field past the validator.
 */
async function upsertResource(req, res, env = process.env) {
  const state = await getState({ env });
  const write = writeState(state, env);

  if (!write.enabled) {
    return sendJson(
      res,
      503,
      { ok: false, dropped: [], mode: state.mode, reason: write.reason },
      { 'Cache-Control': 'no-store' },
    );
  }

  if (!tokenMatches(bearerOf(req), write.token)) {
    return sendJson(
      res,
      401,
      { ok: false, dropped: [], reason: 'a valid `Authorization: Bearer <STELLARSIGHT_WRITE_TOKEN>` header is required' },
      { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' },
    );
  }

  const body = await readJsonBody(req);
  if (!body.ok) {
    return sendJson(res, 400, { ok: false, dropped: [], reason: body.reason }, { 'Cache-Control': 'no-store' });
  }

  let result;
  try {
    result = state.catalog.upsert(body.value);
  } catch (err) {
    return sendJson(
      res,
      400,
      { ok: false, dropped: [], reason: String(err?.message ?? err) },
      { 'Cache-Control': 'no-store' },
    );
  }

  if (!result?.ok) {
    return sendJson(
      res,
      400,
      { ok: false, dropped: result?.dropped ?? [], reason: result?.reason ?? 'upsert rejected' },
      { 'Cache-Control': 'no-store' },
    );
  }

  const stored = state.catalog.get(result.id);
  const persisted = await state.store.put(stored);
  if (!persisted.ok) {
    // The in-memory copy is live on this instance but would vanish on scale-down.
    // Say so rather than claiming a durable write that did not happen.
    return sendJson(
      res,
      502,
      {
        ok: false,
        id: result.id,
        dropped: result.dropped ?? [],
        reason: `record validated but the durable store rejected it: ${persisted.reason}`,
      },
      { 'Cache-Control': 'no-store' },
    );
  }

  // Force the next read to re-load, so this write is visible immediately.
  cachedState = { ...state, loadedAt: 0 };

  return sendJson(
    res,
    200,
    { ok: true, id: result.id, dropped: result.dropped ?? [], mode: state.mode, durable: true },
    { 'Cache-Control': 'no-store' },
  );
}

export default {
  resourcesHandler,
  searchHandler,
  healthHandler,
  integrityHandler,
  getState,
  resetState,
  resetIntegrityState,
  buildInfo,
  readQuery,
  readJsonBody,
  sendJson,
  handlePreflight,
  CORS_HEADERS,
};
