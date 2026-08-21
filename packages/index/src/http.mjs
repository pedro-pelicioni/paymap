/**
 * packages/index/src/http.mjs — STELLARSIGHT discovery endpoints, Express binding.
 *
 * [spec: the bazaar extension defines GET /discovery/resources and GET /discovery/search]
 *
 * This module has NO side effects on import: it only defines and exports
 * `mountDiscoveryRoutes`. The caller owns the Express app, the port and the listen call.
 *
 * The wire format itself lives in packages/index/src/discovery.mjs, shared with the
 * serverless binding in packages/index/src/serverless.mjs — including the projection of
 * an internal catalog record onto the spec's `DiscoveryResource`.
 *
 * apps/facilitator/src/server.mjs mounts this module too, so the local index on :4022 and
 * the deployed API serve byte-identical envelopes. That was not always true — the
 * facilitator used to hand-roll the same two routes and return catalog.list()/search()
 * verbatim, i.e. the internal record shape, and CONTRACT.md carried the difference as
 * KNOWN DRIFT. One definition, two bindings, no drift to track.
 *
 * Query parameter names and response field names are checked against the installed
 * `@x402/extensions` / `@x402/core` declarations by `npm run verify:api`, which drives
 * the real `withBazaar()` client against the handlers. Do not rename them without
 * re-running it.
 */

import { listResources, searchResources } from './discovery.mjs';
import { integrityHandler } from './serverless.mjs';

/**
 * mountDiscoveryRoutes(app, catalog)
 *
 * Adds:
 *   GET /discovery/resources?type&payTo&scheme&network&extensions&limit&offset
 *   GET /discovery/search?query&limit&cursor&type&payTo&scheme&network&extensions
 *
 * @param {{ get: Function }} app       an Express-style app
 * @param {object} catalog             the object returned by createCatalog()
 * @param {{ basePath?: string }} [opts]
 * @returns {{ paths: string[] }}
 */
export function mountDiscoveryRoutes(app, catalog, opts = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('mountDiscoveryRoutes: app must expose .get()');
  if (!catalog || typeof catalog.list !== 'function' || typeof catalog.search !== 'function') {
    throw new TypeError('mountDiscoveryRoutes: catalog must be the object returned by createCatalog()');
  }

  const base = opts.basePath ?? '/discovery';
  const resourcesPath = `${base}/resources`;
  const searchPath = `${base}/search`;

  /**
   * [spec: GET /discovery/resources — "Lists discoverable x402 resources."]
   * Offset pagination. `pagination` is echoed alongside the flat fields so a client can
   * read either shape.
   */
  app.get(resourcesPath, (req, res) => {
    const { status, body } = listResources(catalog, req.query ?? {});
    res.status(status).json(body);
  });

  /**
   * [spec: GET /discovery/search — natural-language `query` is REQUIRED; response
   *  carries `partialResults` and `pagination { limit, cursor }`.]
   *
   * An absent `query` parameter is a 400. A present-but-empty `query` is a browse:
   * the whole (filtered) catalog ordered by the quality prior alone.
   */
  app.get(searchPath, (req, res) => {
    const { status, body } = searchResources(catalog, req.query ?? {});
    res.status(status).json(body);
  });

  /**
   * GET /discovery/integrity — the hostile-corpus replay, same handler as the deployed
   * function (an Express req/res is a superset of the bare Node pair it expects). The
   * web console fetches this on every load; before it was mounted here too, dev on
   * :4022 404'd where stellarsight.xyz answered — the exact endpoint-drift class this
   * module exists to prevent.
   */
  const integrityPath = `${base}/integrity`;
  app.get(integrityPath, (req, res) => integrityHandler(req, res));

  /**
   * Two rejection behaviours the deployed API has always had and this binding did not,
   * found by scripts/verify-rejections.mjs running against both:
   *
   *   - a wrong method answered Express's bare 404 instead of a 405 naming `Allow`
   *   - an unknown /discovery path answered Express's HTML 404 instead of the JSON one
   *     that names the endpoints actually served
   *
   * Both are the same class of drift this module exists to prevent — the wire contract
   * differing by which binding happens to be answering — so they are closed here rather
   * than documented as a known difference. The serverless side owns the shapes; this
   * repeats them.
   */
  const allow = 'GET, HEAD, OPTIONS';
  for (const p of [resourcesPath, searchPath, integrityPath]) {
    app.all(p, (req, res, next) => {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      // POST /discovery/resources is the write path; the caller mounts it separately.
      if (req.method === 'POST' && p === resourcesPath) return next();
      if (req.method === 'OPTIONS') {
        res.set('Allow', allow).status(204).end();
        return undefined;
      }
      res
        .set('Allow', p === resourcesPath ? `${allow}, POST` : allow)
        .status(405)
        .json({ error: 'method_not_allowed', message: `allowed methods: ${p === resourcesPath ? `${allow}, POST` : allow}` });
      return undefined;
    });
  }

  return { paths: [resourcesPath, searchPath, integrityPath] };
}

/**
 * mountDiscoveryFallback(app, { basePath, endpoints })
 *
 * The JSON 404 for unknown /discovery/* paths — the Express counterpart of
 * api/discovery/unknown.mjs, which exists so a mistyped endpoint never answers
 * `200 text/html` (deployed) or Express's HTML 404 (local). Same shape either way.
 *
 * Mounted SEPARATELY from mountDiscoveryRoutes, and it must be mounted LAST: it matches
 * every remaining path under `basePath`, so anything the caller registers afterwards —
 * notably `POST /discovery/resources`, the write path the facilitator owns — would never
 * be reached. The caller owns the app and therefore owns this ordering.
 */
export function mountDiscoveryFallback(app, opts = {}) {
  const base = opts.basePath ?? '/discovery';
  const endpoints = opts.endpoints ?? [`${base}/resources`, `${base}/search`, `${base}/integrity`];
  app.use(base, (req, res) => {
    const path = `${base}${req.path === '/' ? '' : req.path}`;
    res.status(404).json({
      ok: false,
      reason: `no such discovery endpoint: ${path}. This facilitator serves ${endpoints.join(', ')}.`,
      endpoints,
    });
  });
  return { endpoints };
}

export default { mountDiscoveryRoutes, mountDiscoveryFallback };
