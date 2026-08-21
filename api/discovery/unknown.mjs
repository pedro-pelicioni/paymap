/**
 * Catch-all for unknown /discovery/* paths.
 *
 * Without this, an unrecognised path falls through Vercel's rewrite chain to the SPA's
 * `/(.*) -> /index.html` rule and answers `200 text/html`. An agent that mistypes an
 * endpoint would then receive a success status and a page of markup, and have to infer
 * from the content type that something went wrong. That is the opposite of the contract
 * this project states everywhere else: every rejection carries a non-null, readable
 * reason.
 *
 * So: a real function that always exists, answers 404, and names what it does serve.
 *
 * The filename is deliberately plain. The first attempt used Vercel's dynamic-route form,
 * `[...path].mjs`, and the function silently never deployed — the `functions` glob in
 * vercel.json reads `[...]` as a character class rather than a literal name, so the
 * `includeFiles` entry never matched, the import of packages/index was never traced, and
 * the rewrite pointed at a destination that did not exist. Vercel then fell through to
 * the SPA catch-all and answered 200 text/html: the exact bug this file exists to fix.
 *
 * Instead, the rewrite `/discovery/:path*` targets this one concrete path. The three
 * specific rewrites are declared before it and win, so resources / search / health are
 * unaffected.
 */

import { handlePreflight, sendJson } from '../../packages/index/src/serverless.mjs';

const ENDPOINTS = [
  '/discovery/resources',
  '/discovery/search',
  '/discovery/health',
  '/discovery/integrity',
];

export default function handler(req, res) {
  if (handlePreflight(req, res, 'GET, HEAD, POST, OPTIONS')) return undefined;

  const path = (req.url || '').split('?')[0] || '/discovery';

  return sendJson(res, 404, {
    ok: false,
    reason: `no such discovery endpoint: ${path}. This facilitator serves ${ENDPOINTS.join(', ')}.`,
    endpoints: ENDPOINTS,
  });
}
