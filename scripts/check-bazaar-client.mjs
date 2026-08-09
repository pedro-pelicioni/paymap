#!/usr/bin/env node
/**
 * scripts/check-bazaar-client.mjs — point the STOCK bazaar client at any deployment.
 *
 * `npm run verify:api` drives `withBazaar` against the api/ function modules in-process.
 * That proves the handlers are right. It does not prove a *deployment* is right: routing,
 * rewrites, the CDN and the edge all sit between a client and those handlers, and the bug
 * this script exists to catch — search returning `items` where the shipped
 * `SearchDiscoveryResourcesResponse` declares `resources` — was only ever visible from
 * outside.
 *
 * So this is the same assertion, over the public internet, against a URL you choose.
 *
 *   node scripts/check-bazaar-client.mjs https://paymap.dev
 *   node scripts/check-bazaar-client.mjs https://<preview>.vercel.app
 *
 * Vercel preview deployments sit behind Deployment Protection. To reach one, create a
 * Protection Bypass for Automation secret (Project → Settings → Deployment Protection)
 * and export it:
 *
 *   VERCEL_AUTOMATION_BYPASS_SECRET=… node scripts/check-bazaar-client.mjs <preview-url>
 *
 * Exit code is 0 only if a stock consumer can read the catalog AND construct a payment
 * from a search result.
 */

import { withBazaar } from '@x402/extensions/bazaar';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { PaymentRequirementsSchema } from '@x402/core/schemas';

const base = (process.argv[2] ?? 'https://paymap.dev').replace(/\/$/, '');
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  failures++;
  console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`);
};

// Deployment Protection is a property of the host, not of our contract. Passing the bypass
// header keeps the request identical to a stock one in every way that the wire shape cares
// about, while letting the check reach a preview at all.
const fetchImpl = bypass
  ? (url, init = {}) =>
      fetch(url, {
        ...init,
        headers: { ...(init.headers ?? {}), 'x-vercel-protection-bypass': bypass },
      })
  : fetch;

console.log(`\nstock @x402/extensions bazaar client → ${base}\n`);

// Reachability first, so a protected or dead host reports as that rather than as a
// conformance failure. Those are very different diagnoses.
try {
  const probe = await fetchImpl(`${base}/discovery/health`, { redirect: 'manual' });
  if (probe.status >= 300 && probe.status < 400) {
    const loc = probe.headers.get('location') ?? '';
    console.log(`  host redirects (${probe.status}) → ${loc.slice(0, 80)}`);
    console.log(
      loc.includes('vercel.com/sso')
        ? '\n  Deployment Protection is on. Set VERCEL_AUTOMATION_BYPASS_SECRET and retry.\n'
        : '\n  Unexpected redirect; not a conformance result.\n',
    );
    process.exit(2);
  }
  if (!probe.ok) {
    console.log(`\n  /discovery/health returned ${probe.status}; host is not serving.\n`);
    process.exit(2);
  }
  const h = await probe.json();
  console.log(`  serving commit ${h?.build?.commitShort ?? '?'} · mode ${h?.mode ?? '?'} · ${h?.records ?? '?'} records\n`);
} catch (err) {
  console.log(`\n  cannot reach ${base}: ${err.message}\n`);
  process.exit(2);
}

const client = withBazaar(new HTTPFacilitatorClient({ url: base, fetch: fetchImpl }));

/* ---------- search: the envelope the shipped type declares ---------- */

let search;
try {
  search = await client.extensions.bazaar.search({ query: 'invoice ocr', limit: 3 });
} catch (err) {
  bad('search() threw', err.message);
}

if (search) {
  if (Array.isArray(search.resources)) {
    ok(`search returns \`resources\` (${search.resources.length} result(s))`);
  } else {
    bad(
      'search does not return `resources`',
      `SearchDiscoveryResourcesResponse declares \`resources\`; got keys [${Object.keys(search).join(', ')}]`,
    );
  }

  // The failure this whole exercise is about: a consumer iterating the declared field.
  // Deliberately no `?? []` here. An earlier draft had one, which made this check pass
  // against the very deployment it exists to catch — iterating an empty fallback throws
  // nothing, so "iteration works" was true and meaningless. Iterate what the client
  // actually handed back, and let it throw if that is undefined.
  try {
    const names = [];
    for (const r of search.resources) names.push(r.serviceName ?? r.resource);
    names.length
      ? ok(`iterating the result set works — ${names.join(', ')}`)
      : bad('search returned zero results', 'expected at least one hit for "invoice ocr"');
  } catch (err) {
    bad('iterating search.resources throws', err.message);
  }
}

/* ---------- item shape: can a stock consumer actually pay? ---------- */

const first = search?.resources?.[0];
if (!first) {
  bad('no search result to inspect', 'cannot check the item shape');
} else {
  typeof first.resource === 'string'
    ? ok(`\`resource\` is a URL string — ${first.resource}`)
    : bad('`resource` is not a string', `DiscoveryResource declares \`resource: string\`; got ${typeof first.resource}`);

  if (!Array.isArray(first.accepts) || first.accepts.length === 0) {
    bad('item carries no `accepts`', 'a consumer cannot construct a payment from this result');
  } else {
    const parsed = PaymentRequirementsSchema.safeParse(first.accepts[0]);
    parsed.success
      ? ok(`accepts[0] validates against @x402/core's own PaymentRequirementsSchema — ${first.accepts[0].amount} on ${first.accepts[0].network}`)
      : bad('accepts[0] fails PaymentRequirementsSchema', JSON.stringify(parsed.error.issues?.[0] ?? parsed.error));
  }

  typeof first.lastUpdated === 'string' && !Number.isNaN(Date.parse(first.lastUpdated))
    ? ok(`\`lastUpdated\` is ISO 8601 — ${first.lastUpdated}`)
    : bad('`lastUpdated` is missing or not ISO 8601', `got ${JSON.stringify(first.lastUpdated)}`);
}

/* ---------- list: the other envelope, deliberately different ---------- */

try {
  const list = await client.extensions.bazaar.listResources({ limit: 2 });
  Array.isArray(list.items)
    ? ok(`list returns \`items\` (${list.items.length}) — the asymmetry with search is the spec's`)
    : bad('list does not return `items`', `got keys [${Object.keys(list).join(', ')}]`);
} catch (err) {
  bad('listResources() threw', err.message);
}

console.log(
  failures === 0
    ? '\nPASS — a stock consumer can read this catalog and construct a payment from it.\n'
    : `\nFAIL — ${failures} check(s) failed. A stock consumer cannot use this deployment.\n`,
);
process.exit(failures === 0 ? 0 : 1);
