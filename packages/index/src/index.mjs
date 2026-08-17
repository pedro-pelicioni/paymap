/**
 * packages/index/src/index.mjs — STELLARSIGHT bazaar catalog.
 * "Find what to pay for on Stellar."
 *
 * This is the facilitator-side half of the x402 `bazaar` extension: the catalog and
 * search index that turns observed `PaymentRequired` / `PaymentPayload` traffic into a
 * discoverable directory. The upstream `@x402/extensions/bazaar` package ships only
 * client and server helpers; the facilitator-side implementation does not exist in
 * public code, which is what this module provides.
 *
 * Design constraints:
 *   - Zero heavy dependencies. In-memory Maps + optional JSON snapshot persistence.
 *   - Every write goes through packages/index/src/integrity.mjs (trust boundary).
 *   - Ranking lives in packages/index/src/rank.mjs (BM25 + quality prior).
 *
 * Public API is fixed by CONTRACT.md — do not change these signatures.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateResourceBlock, validateRouteTemplate, validateJsonSchema } from './integrity.mjs';
import { scoreHybrid, buildIndex, RANK_WEIGHTS, FIELD_WEIGHTS } from './rank.mjs';

export { validateResourceBlock, validateRouteTemplate, validateJsonSchema } from './integrity.mjs';
export { scoreHybrid, RANK_WEIGHTS, FIELD_WEIGHTS, tokenize, completenessOf } from './rank.mjs';

/** Default snapshot location: packages/index/.catalog.json */
export const DEFAULT_PERSIST_PATH = fileURLToPath(new URL('../.catalog.json', import.meta.url));

const VALID_TYPES = new Set(['http', 'mcp']);
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/**
 * The record identity.
 *
 * [spec: "For MCP tools, the unique resource identifier is the tuple
 *  (resource.url, input.toolName). Since MCP multiplexes multiple tools over a single
 *  server endpoint, resource.url alone may not be unique."]
 *
 * So: HTTP resources key on the URL; MCP tools key on `url#toolName`. One MCP server
 * URL therefore yields as many catalog entries as it exposes tools.
 */
export function recordId(url, type, toolName) {
  return type === 'mcp' && toolName ? `${url}#${toolName}` : `${url}`;
}

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.filter((x) => x !== undefined && x !== null).map(String);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ─────────────────────────── opaque cursor ─────────────────────────── */

/**
 * [spec: pagination.cursor is an "advisory continuation cursor from previous page"]
 *
 * The cursor is opaque to clients: base64url of `{ o, f }` where `o` is the offset into
 * the ranked result set and `f` fingerprints the query + filters. If a client replays a
 * cursor against a different query the fingerprint mismatches and we restart from
 * offset 0 rather than returning results from someone else's result set.
 */
export function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

export function decodeCursor(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function fingerprint(query, filters) {
  const norm = JSON.stringify([
    String(query ?? '').trim().toLowerCase(),
    filters.type ?? '',
    filters.payTo ?? '',
    filters.scheme ?? '',
    filters.network ?? '',
    filters.seeded ?? '',
    [...asArray(filters.extensions)].sort(),
  ]);
  // Cheap non-cryptographic fingerprint (FNV-1a). It only needs to detect accidental
  // cursor reuse across queries, not resist forgery — a forged cursor can at worst
  // page through results the caller could already request directly.
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/* ─────────────────────────────── offerings ───────────────────────────── */

// A record can advertise more than one priced way to call the same resource — two
// upto profiles, or exact alongside upto. An offering's identity is everything
// EXCEPT the price: scheme, network, asset, payTo and the canonicalized `extra`
// bag. Keying on content rather than on a semantic field is deliberate: the spec
// has not yet named the profile discriminator (see issue #1), and a content key
// loses nothing no matter where that discriminator lands.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]))
      .join(',') +
    '}'
  );
}

export function offeringKeyOf(o) {
  return [o.scheme, o.network, o.asset, o.payTo, canonicalJson(o.extra ?? {})].join('|');
}

const EXTRA_MAX_BYTES = 2048;

// Soft-drop sanitizer for accepts.extra: a JSON round-trip clone (kills prototype
// pollution and non-JSON values), bounded in serialized size so a hostile announce
// cannot use `extra` as a storage amplifier.
function sanitizeExtra(extra) {
  if (extra === undefined || extra === null) return { value: undefined, ok: true };
  if (typeof extra !== 'object' || Array.isArray(extra)) return { value: undefined, ok: false };
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(extra));
  } catch {
    return { value: undefined, ok: false };
  }
  if (canonicalJson(clone).length > EXTRA_MAX_BYTES) return { value: undefined, ok: false };
  return { value: clone, ok: true };
}

// Records stored before `requirements` existed contribute their single tuple.
function offeringsOf(rec) {
  if (Array.isArray(rec.requirements) && rec.requirements.length) return rec.requirements;
  return [{ scheme: rec.scheme, network: rec.network, payTo: rec.payTo, asset: rec.asset }];
}

/* ─────────────────────────────── catalog ─────────────────────────────── */

/**
 * createCatalog(options?) -> Catalog
 *
 * options:
 *   persistPath  string   where save()/load() read and write (default packages/index/.catalog.json)
 *   autoPersist  boolean  write a snapshot after every successful upsert (default false)
 *   now          fn       clock injection for tests
 */
export function createCatalog(options = {}) {
  const persistPath = options.persistPath ?? DEFAULT_PERSIST_PATH;
  const now = options.now ?? (() => Date.now());

  /** @type {Map<string, object>} id -> record */
  const store = new Map();
  let indexCache = null; // invalidated on every mutation

  function invalidate() {
    indexCache = null;
  }

  function ensureIndex() {
    if (!indexCache) indexCache = buildIndex([...store.values()]);
    return indexCache;
  }

  /**
   * upsert(record) -> { ok, dropped, reason?, id? }
   *
   * Soft-drop applies to metadata; identity failures (missing/invalid url, unknown
   * type, MCP without toolName) are hard rejections because there is nothing to key on.
   */
  function upsert(record) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      return { ok: false, dropped: [], reason: 'record must be an object' };
    }

    const dropped = [];

    // 1. resource block — trust boundary
    const res = validateResourceBlock(record.resource);
    dropped.push(...res.dropped);
    if (!res.value.url) {
      return { ok: false, dropped, reason: 'resource.url is missing or invalid' };
    }

    // 2. type + MCP tuple key
    const type = record.type === 'mcp' ? 'mcp' : record.type === 'http' ? 'http' : null;
    if (!type) return { ok: false, dropped, reason: `type must be one of ${[...VALID_TYPES].join('|')}` };

    const input = record.input && typeof record.input === 'object' && !Array.isArray(record.input) ? { ...record.input } : {};
    if (type === 'mcp') {
      const toolName = typeof input.toolName === 'string' ? input.toolName.trim() : '';
      if (!toolName) {
        return { ok: false, dropped, reason: 'MCP resources require input.toolName (identity is the (url, toolName) tuple)' };
      }
      if (toolName.length > 128 || /[\u0000-\u001F\u007F-\u009F]/.test(toolName)) {
        return { ok: false, dropped, reason: 'input.toolName is malformed' };
      }
      input.toolName = toolName;
    }

    const id = recordId(res.value.url, type, input.toolName);

    // 3. routeTemplate — invalid template is discarded, caller falls back to the URL
    let routeTemplate;
    if (record.routeTemplate !== undefined) {
      const rt = validateRouteTemplate(record.routeTemplate);
      if (rt.valid) routeTemplate = record.routeTemplate;
      else dropped.push('routeTemplate');
    }

    // 4. JSON Schemas — external $ref/$id is an SSRF primitive for every consumer that
    //    later resolves it, so we refuse to store the schema at all. The record itself
    //    survives (soft drop) minus the schema.
    for (const key of ['inputSchema', 'schema']) {
      if (input[key] !== undefined) {
        const r = validateJsonSchema(input[key]);
        if (!r.valid) {
          delete input[key];
          dropped.push(`input.${key}`);
        }
      }
    }
    let output = record.output && typeof record.output === 'object' ? { ...record.output } : undefined;
    if (output?.schema !== undefined) {
      const r = validateJsonSchema(output.schema);
      if (!r.valid) {
        delete output.schema;
        dropped.push('output.schema');
      }
    }

    // 5. normalise the rest
    const previous = store.get(id);
    const incomingSettlements = Math.max(0, Number(record.settlements ?? 0) || 0);
    const incomingLastSeen = Number(record.lastSeenAt) || now();

    const network = typeof record.network === 'string' ? record.network : 'stellar:testnet';
    const scheme = typeof record.scheme === 'string' ? record.scheme : 'exact';
    const payTo = typeof record.payTo === 'string' ? record.payTo : '';
    const asset = typeof record.asset === 'string' ? record.asset : '';
    const maxAmountRequired =
      record.maxAmountRequired !== undefined ? String(record.maxAmountRequired) : '0';

    // 6. offerings — re-seeing an offering updates its price in place; a distinct
    //    offering (different scheme, asset, payTo or extra) is appended rather than
    //    overwriting the record. The top-level fields keep mirroring the offering
    //    seen most recently, which is what the single-tuple model always showed.
    const ex = sanitizeExtra(record.extra);
    if (!ex.ok) dropped.push('extra');
    const offering = {
      scheme,
      network,
      payTo,
      asset,
      maxAmountRequired,
      ...(ex.value !== undefined ? { extra: ex.value } : {}),
    };
    const requirements = (
      previous?.requirements ??
      (previous
        ? [
            {
              scheme: previous.scheme,
              network: previous.network,
              payTo: previous.payTo,
              asset: previous.asset,
              maxAmountRequired: previous.maxAmountRequired,
              ...(previous.extra !== undefined ? { extra: previous.extra } : {}),
            },
          ]
        : [])
    ).map((o) => ({ ...o }));
    const key = offeringKeyOf(offering);
    const existing = requirements.find((o) => offeringKeyOf(o) === key);
    if (existing) existing.maxAmountRequired = offering.maxAmountRequired;
    else requirements.push(offering);

    const stored = {
      id,
      resource: res.value,
      type,
      network,
      scheme,
      payTo,
      asset,
      maxAmountRequired,
      ...(ex.value !== undefined ? { extra: ex.value } : {}),
      requirements,
      input,
      output,
      ...(routeTemplate ? { routeTemplate } : {}),
      extensions: asArray(record.extensions).length ? asArray(record.extensions) : ['bazaar'],
      // Provenance. `seeded: true` marks a record that exists for catalog breadth only —
      // nobody ever paid for it — so a consumer can never present it as a live,
      // settle-backed resource. Deliberately NOT sticky: the flag is re-derived from the
      // incoming record on every upsert, so a live announcement for the same id (which
      // carries no flag) clears it and the real resource wins.
      ...(record.seeded === true ? { seeded: true } : {}),
      // Monotonic merge: re-observing a resource never loses settlement history and
      // never moves lastSeenAt backwards.
      lastSeenAt: previous ? Math.max(previous.lastSeenAt, incomingLastSeen) : incomingLastSeen,
      settlements: previous ? Math.max(previous.settlements, incomingSettlements) : incomingSettlements,
      firstSeenAt: previous ? previous.firstSeenAt : incomingLastSeen,
    };

    store.set(id, stored);
    invalidate();
    if (options.autoPersist) {
      try {
        save();
      } catch {
        /* persistence is best-effort; never fail an upsert on a disk error */
      }
    }
    return { ok: true, dropped, id };
  }

  /** Increment the usage signal for an observed settlement. */
  function recordSettlement(id, at = now()) {
    const rec = store.get(id);
    if (!rec) return { ok: false, reason: 'unknown resource id' };
    rec.settlements += 1;
    rec.lastSeenAt = Math.max(rec.lastSeenAt, at);
    invalidate();
    return { ok: true, settlements: rec.settlements };
  }

  function get(id) {
    return store.get(id) ?? null;
  }

  /**
   * [spec: GET /discovery/resources filters — type, payTo, scheme, network, extensions]
   *
   * Plus one filter the spec does not define, marked additive in the docs: `seeded`.
   *
   * The catalog ships a demo corpus so the ranker has something to rank — completeness
   * and freshness vary on purpose, which is what makes `_explain` legible instead of
   * constant. Those records are pinned `seeded: true, settlements: 0` and they are, by
   * construction, `.example` hostnames nobody can pay.
   *
   * An agent shopping for something it can actually call needs to exclude them, and a
   * reviewer asking "how much of this is real?" deserves an answer that is one query
   * rather than an eyeball count. `?seeded=false` gives both. The demo records stay in
   * the catalog — removing them would hide the ranker rather than clarify the catalog.
   */
  function matches(rec, f) {
    if (f.type && rec.type !== f.type) return false;
    // Requirement filters match ANY offering the record advertises, not only the
    // mirrored latest one — a resource whose second offering is upto must be
    // findable by ?scheme=upto.
    if (f.payTo && !offeringsOf(rec).some((o) => o.payTo === f.payTo)) return false;
    if (f.scheme && !offeringsOf(rec).some((o) => o.scheme === f.scheme)) return false;
    if (f.network && !offeringsOf(rec).some((o) => o.network === f.network)) return false;
    if (f.seeded !== undefined && f.seeded !== null) {
      const want = f.seeded === true || f.seeded === 'true' || f.seeded === '1';
      if (Boolean(rec.seeded) !== want) return false;
    }
    const wanted = asArray(f.extensions);
    if (wanted.length) {
      const have = new Set(rec.extensions ?? []);
      for (const w of wanted) if (!have.has(w)) return false;
    }
    return true;
  }

  function filtered(f) {
    return [...store.values()].filter((r) => matches(r, f));
  }

  /**
   * list(filters) -> { items, total, limit, offset }
   * Offset pagination, newest-seen first.
   */
  function list(filters = {}) {
    const limit = clampInt(filters.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(filters.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const all = filtered(filters).sort(
      (a, b) => b.lastSeenAt - a.lastSeenAt || String(a.id).localeCompare(String(b.id)),
    );
    return { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
  }

  /**
   * search({ query, limit, cursor, ...filters })
   *   -> { items, partialResults, pagination: { limit, cursor }, total }
   *
   * [spec: GET /discovery/search returns `partialResults` (boolean, matches truncated)
   *  and `pagination` with required `limit` and `cursor` (null when unavailable).]
   */
  function search(params = {}) {
    const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const query = params.query ?? '';
    const fp = fingerprint(query, params);

    let offset = 0;
    if (params.cursor) {
      const c = decodeCursor(params.cursor);
      // A cursor minted for a different query/filter set is advisory only — ignore it.
      if (c && c.f === fp && Number.isInteger(c.o) && c.o >= 0) offset = c.o;
    }

    const candidates = filtered(params);
    // Reuse the whole-catalog index when no filter narrowed the set (the common case).
    const useCache = candidates.length === store.size;
    const ranked = scoreHybrid(query, candidates, {
      now: now(),
      ...(useCache ? { index: ensureIndex() } : {}),
    });

    const items = ranked.slice(offset, offset + limit);
    const consumed = offset + items.length;
    const hasMore = consumed < ranked.length;

    return {
      items,
      // "truncated matches": there are further matches we did not return in this page.
      partialResults: hasMore,
      pagination: {
        limit,
        cursor: hasMore ? encodeCursor({ o: consumed, f: fp }) : null,
      },
      total: ranked.length,
    };
  }

  function size() {
    return store.size;
  }

  function all() {
    return [...store.values()];
  }

  function clear() {
    store.clear();
    invalidate();
  }

  /** Snapshot to JSON. Optional — the catalog is fully functional in memory. */
  function save(path = persistPath) {
    const payload = { version: 1, savedAt: now(), records: [...store.values()] };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path, count: store.size };
  }

  /** Restore a snapshot. Every record is re-validated — a snapshot is not trusted. */
  function load(path = persistPath) {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return { ok: false, reason: 'snapshot not found', count: 0 };
    }
    try {
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed?.records) ? parsed.records : [];
      let count = 0;
      for (const r of records) if (upsert(r).ok) count++;
      return { ok: true, count };
    } catch {
      return { ok: false, reason: 'snapshot is not valid JSON', count: 0 };
    }
  }

  return { upsert, list, search, size, get, all, clear, recordSettlement, save, load, persistPath };
}

export default { createCatalog, validateResourceBlock, validateRouteTemplate, scoreHybrid };
