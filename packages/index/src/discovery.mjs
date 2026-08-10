/**
 * packages/index/src/discovery.mjs — transport-agnostic bazaar discovery request handling.
 *
 * [spec: the bazaar extension defines GET /discovery/resources and GET /discovery/search]
 *
 * This module owns the *semantics* of the two discovery endpoints: which query
 * parameters exist, how they are coerced, and the exact response envelope. It knows
 * nothing about Express, Node's `http` module or Vercel. It is the one DEFINITION of the
 * wire format, and it is where STELLARSIGHT's internal catalog record (CONTRACT.md) is
 * projected onto the type the shipped SDK declares — see `toDiscoveryResource`. The
 * catalog keeps its own shape; only the wire is spec-shaped.
 *
 * Adapters that funnel through it:
 *
 *   packages/index/src/http.mjs        -> Express (`mountDiscoveryRoutes`)
 *   packages/index/src/serverless.mjs  -> Node `(req, res)` handlers under /api
 *
 * KNOWN DRIFT: apps/facilitator/src/server.mjs does NOT. It hand-rolls the same two
 * routes and returns catalog.list()/search() verbatim, so the local index on :4022 still
 * serves the internal record shape while the deployment serves this one. See CONTRACT.md.
 *
 * No side effects on import. Field names here are checked against the installed
 * `@x402/extensions` / `@x402/core` type declarations by `npm run verify:api`, which
 * drives the real `withBazaar()` client against these handlers. Do not rename them
 * without re-running that harness.
 */

export const X402_VERSION = 2;

/**
 * `PaymentRequirements.maxTimeoutSeconds` is REQUIRED by the v2 schema but is a property
 * of the resource server's payment window, not of the catalog entry, so a discovery
 * record does not necessarily carry one. Fall back to the same 120s the reference seller
 * in this repo advertises (apps/seller/src/server.mjs) rather than emitting an invalid
 * `accepts` entry.
 */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 120;

/**
 * Query parsers disagree about repeated parameters: Express hands back an array,
 * URLSearchParams hands back the last value, Vercel hands back either. Take the first
 * value in every case and treat an empty string as "absent".
 */
export function firstString(v) {
  if (Array.isArray(v)) v = v[0];
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Filters shared by both endpoints. [spec: type, payTo, scheme, network, extensions] */
export function readFilters(q = {}) {
  return {
    type: firstString(q.type),
    payTo: firstString(q.payTo),
    scheme: firstString(q.scheme),
    network: firstString(q.network),
    // `extensions` is repeatable AND comma-separatable; the catalog's own asArray()
    // normalises both shapes, so it is passed through untouched.
    extensions: q.extensions,
  };
}

function failure(error, err) {
  return {
    status: 500,
    body: { error, message: String(err?.message ?? err) },
  };
}

/* ───────────────────────── record -> wire projection ───────────────────────── */

/** ms epoch -> ISO 8601. [spec: DiscoveryResource.lastUpdated is an ISO 8601 string] */
function isoFrom(ms) {
  const n = Number(ms);
  const d = new Date(Number.isFinite(n) && n > 0 ? n : Date.now());
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Internal `extensions: ["bazaar"]` -> spec `extensions: Record<string, unknown>`.
 *
 * [spec: `extensions.bazaar` carries `{ info: { input, output }, routeTemplate?, schema? }`
 *  — the same payload the resource server declared through `declareDiscoveryExtension`.]
 *
 * STELLARSIGHT stores that payload flattened onto the record (`input`, `output`,
 * `routeTemplate`), so the bazaar entry is rebuilt from those fields. Any other extension
 * key the record claims is echoed as `{}` — we know it was announced, we hold no payload
 * for it, and inventing one would be worse than an empty object.
 */
function extensionsMapOf(rec) {
  // An object is already in spec shape — pass it through untouched.
  if (rec?.extensions && typeof rec.extensions === 'object' && !Array.isArray(rec.extensions)) {
    return rec.extensions;
  }
  const declared = Array.isArray(rec?.extensions)
    ? rec.extensions.filter((e) => typeof e === 'string')
    : [];

  const out = {};
  for (const key of declared) out[key] = {};

  if (declared.includes('bazaar') || rec?.input || rec?.output) {
    const info = {};
    if (rec?.input !== undefined) info.input = rec.input;
    if (rec?.output !== undefined) info.output = rec.output;
    const bazaar = { info };
    if (typeof rec?.routeTemplate === 'string') bazaar.routeTemplate = rec.routeTemplate;
    const schema = rec?.input?.inputSchema ?? rec?.input?.schema;
    if (schema !== undefined) bazaar.schema = schema;
    out.bazaar = bazaar;
  }
  return out;
}

/**
 * Project one internal catalog record onto the `DiscoveryResource` the shipped SDK
 * declares (`@x402/extensions` -> `dist/esm/index-*.d.mts`):
 *
 *   { resource: string, type, x402Version, accepts: PaymentRequirements[],
 *     lastUpdated: ISO-8601, description?, mimeType?, serviceName?, tags?, iconUrl?,
 *     extensions?: Record<string, unknown> }
 *
 * Three things a stock consumer needs and the internal record does not give it:
 *
 *  1. `resource` is a URL STRING, not the `{ url, serviceName, ... }` block. The
 *     presentation fields move to the top level, which is where the spec puts them.
 *  2. `accepts` is how a client constructs a payment. It is built here from the record's
 *     scheme / network / asset / payTo / amount. **x402 v2 `PaymentRequirements` names the
 *     amount field `amount`, NOT `maxAmountRequired`** — the v1 name fails
 *     `PaymentRequirementsSchema` in the installed `@x402/core`, so an `accepts` entry
 *     built with it is silently unusable.
 *  3. `lastUpdated` is ISO 8601; the record keeps epoch ms in `lastSeenAt`.
 *
 * Everything STELLARSIGHT-native is kept as ADDITIVE fields the spec does not define and a
 * spec consumer therefore ignores: `id`, the flat `payTo`/`asset`/`maxAmountRequired`/
 * `network`/`scheme` mirrors of `accepts[0]`, `input`/`output`/`routeTemplate`,
 * `lastSeenAt`/`firstSeenAt`, `settlements`, `seeded`, and the ranking annotations
 * `_score` / `_explain`.
 *
 * @param {object} rec  an internal catalog record (see CONTRACT.md)
 * @returns {object}    a spec `DiscoveryResource` plus STELLARSIGHT's additive fields
 */
export function toDiscoveryResource(rec) {
  if (!rec || typeof rec !== 'object') return rec;

  const block = rec.resource && typeof rec.resource === 'object' ? rec.resource : {};
  // Already a spec-shaped item (string `resource`) — do not double-project.
  const url = typeof rec.resource === 'string' ? rec.resource : (block.url ?? rec.id ?? '');

  const scheme = typeof rec.scheme === 'string' ? rec.scheme : 'exact';
  const network = typeof rec.network === 'string' ? rec.network : 'stellar:testnet';
  const asset = typeof rec.asset === 'string' ? rec.asset : '';
  const payTo = typeof rec.payTo === 'string' ? rec.payTo : '';
  const amount = String(rec.maxAmountRequired ?? '0');
  const maxTimeoutSeconds = Number.isFinite(Number(rec.maxTimeoutSeconds))
    ? Number(rec.maxTimeoutSeconds)
    : DEFAULT_MAX_TIMEOUT_SECONDS;

  const serviceName = typeof rec.serviceName === 'string' ? rec.serviceName : block.serviceName;
  const description = typeof rec.description === 'string' ? rec.description : block.description;
  const tags = Array.isArray(rec.tags) ? rec.tags : block.tags;
  const iconUrl = typeof rec.iconUrl === 'string' ? rec.iconUrl : block.iconUrl;
  const mimeType = typeof rec.mimeType === 'string' ? rec.mimeType : block.mimeType;

  const out = {
    /* ── spec DiscoveryResource ─────────────────────────────────────────── */
    resource: url,
    type: rec.type ?? 'http',
    x402Version: X402_VERSION,
    // [spec: v2 PaymentRequirements = { scheme, network, asset, amount, payTo,
    //  maxTimeoutSeconds, extra }] — one entry, because a catalog record advertises
    //  exactly one priced way to call the resource.
    accepts: [{ scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra: {} }],
    lastUpdated: isoFrom(rec.lastSeenAt),
    ...(description !== undefined ? { description } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(serviceName !== undefined ? { serviceName } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(iconUrl !== undefined ? { iconUrl } : {}),
    extensions: extensionsMapOf(rec),

    /* ── additive, STELLARSIGHT-native: not in the spec, ignored by a spec client ── */
    id: rec.id ?? url,
    network,
    scheme,
    payTo,
    asset,
    // v1 name, kept so the existing filters, console and MCP agent keep reading; the
    // authoritative value for a payment is `accepts[0].amount`.
    maxAmountRequired: amount,
    ...(rec.input !== undefined ? { input: rec.input } : {}),
    ...(rec.output !== undefined ? { output: rec.output } : {}),
    ...(rec.routeTemplate !== undefined ? { routeTemplate: rec.routeTemplate } : {}),
    ...(rec.seeded !== undefined ? { seeded: rec.seeded } : {}),
    ...(rec.lastSeenAt !== undefined ? { lastSeenAt: rec.lastSeenAt } : {}),
    ...(rec.firstSeenAt !== undefined ? { firstSeenAt: rec.firstSeenAt } : {}),
    ...(rec.settlements !== undefined ? { settlements: rec.settlements } : {}),
    ...(rec._score !== undefined ? { _score: rec._score } : {}),
    ...(rec._explain !== undefined ? { _explain: rec._explain } : {}),
  };

  return out;
}

/** Project a page of internal records. */
export function toDiscoveryResources(records) {
  return Array.isArray(records) ? records.map(toDiscoveryResource) : [];
}

/* ─────────────────────────────── endpoints ─────────────────────────────── */

/**
 * [spec: GET /discovery/resources — "Lists discoverable x402 resources."]
 *
 * `DiscoveryResourcesResponse` names the array `items` and paginates by offset:
 * `pagination { limit, offset, total }`. The flat `total`/`limit`/`offset` are echoed
 * alongside as additive fields so a client can read either shape.
 *
 * The list and search envelopes differ DELIBERATELY — different array key, structurally
 * different pagination. See `searchResources`.
 *
 * @param {object} catalog  the object returned by createCatalog()
 * @param {object} q        the parsed query string
 * @returns {{ status: number, body: object }}
 */
export function listResources(catalog, q = {}) {
  try {
    const result = catalog.list({
      ...readFilters(q),
      limit: firstString(q.limit),
      offset: firstString(q.offset),
    });
    return {
      status: 200,
      body: {
        x402Version: X402_VERSION,
        items: toDiscoveryResources(result.items),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        pagination: { limit: result.limit, offset: result.offset, total: result.total },
      },
    };
  } catch (err) {
    return failure('discovery_failed', err);
  }
}

/**
 * [spec: GET /discovery/search — natural-language `query` is REQUIRED; "Response shape
 *  mirrors the list endpoint with a `resources` array and optional `pagination`", and
 *  the response carries `partialResults` plus `pagination { limit, cursor }`.]
 *
 * The array key here is `resources`, NOT `items`: `SearchDiscoveryResourcesResponse` in
 * the shipped `@x402/extensions` declares `resources`, while `DiscoveryResourcesResponse`
 * declares `items`, and `withBazaar()` returns the parsed body untransformed — so a
 * client reading `search.resources` gets `undefined` from an `items`-only envelope and
 * throws on iteration. `items` is emitted as a duplicate ALIAS of the same array for one
 * release, for consumers written against the old STELLARSIGHT envelope. It is not spec and
 * will be removed.
 *
 * An absent `query` parameter is a 400. A present-but-empty `query` is a browse: the
 * whole (filtered) catalog ordered by the quality prior alone.
 *
 * @param {object} catalog  the object returned by createCatalog()
 * @param {object} q        the parsed query string
 * @returns {{ status: number, body: object }}
 */
export function searchResources(catalog, q = {}) {
  if (q.query === undefined) {
    return {
      status: 400,
      body: {
        error: 'missing_query',
        message: 'the "query" parameter is required on /discovery/search',
      },
    };
  }
  try {
    const result = catalog.search({
      ...readFilters(q),
      query: Array.isArray(q.query) ? String(q.query[0] ?? '') : String(q.query),
      limit: firstString(q.limit),
      cursor: firstString(q.cursor),
    });
    const resources = toDiscoveryResources(result.items);
    return {
      status: 200,
      body: {
        x402Version: X402_VERSION,
        resources,
        // DEPRECATED alias — same array, old key. Remove after one release.
        items: resources,
        partialResults: result.partialResults,
        pagination: { limit: result.pagination.limit, cursor: result.pagination.cursor },
        total: result.total,
      },
    };
  } catch (err) {
    return failure('search_failed', err);
  }
}

export default {
  X402_VERSION,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  firstString,
  readFilters,
  toDiscoveryResource,
  toDiscoveryResources,
  listResources,
  searchResources,
};
