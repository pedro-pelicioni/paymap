/**
 * GET /discovery/integrity — Vercel binding.
 *
 * The web console fetches this on every load to render the catalog-integrity ledger;
 * before this file existed the request fell through `/discovery/:path*` to the 404
 * handler, and a reviewer with devtools open saw two red 404s on a site whose pitch is
 * "checked, not believed". The verdicts come from the shared hostile-corpus replay in
 * packages/index/src/integrity-replay.mjs — the same module that bakes the frontend's
 * offline fallback, so the two can never drift.
 */

import { integrityHandler } from '../../packages/index/src/serverless.mjs';

export default function handler(req, res) {
  return integrityHandler(req, res);
}
