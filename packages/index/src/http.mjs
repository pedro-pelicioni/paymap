/**
 * packages/index/src/http.mjs — PAYMAP discovery endpoints, Express binding.
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
 * KNOWN DRIFT: apps/facilitator/src/server.mjs does NOT use this module. It hand-rolls
 * the same two routes and returns catalog.list()/search() verbatim, so the local index on
 * :4022 still serves the internal record shape. See CONTRACT.md.
 *
 * Query parameter names and response field names are checked against the installed
 * `@x402/extensions` / `@x402/core` declarations by `npm run verify:api`, which drives
 * the real `withBazaar()` client against the handlers. Do not rename them without
 * re-running it.
 */

import { listResources, searchResources } from './discovery.mjs';

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

  return { paths: [resourcesPath, searchPath] };
}

export default { mountDiscoveryRoutes };
