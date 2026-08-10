# STELLARSIGHT — Integration Contract (read this first)

Monorepo, plain npm workspaces, Node 22, ESM (`"type": "module"`). No TypeScript build step
anywhere except `apps/web` (Vite). Everything must run with `node <file>.mjs` or `npm run dev`.

Deadline is hard. Prefer WORKING over COMPLETE. Never leave a broken import.

## Ports (fixed, do not change)

| Service | Port | Owner |
|---|---|---|
| facilitator (`/verify`, `/settle`, `/supported`) | 4021 | apps/facilitator |
| bazaar index (`/discovery/*`) | 4022 | packages/index served by apps/facilitator |
| seller paid API | 4023 | apps/seller |
| web (Vite dev) | 5173 | apps/web |

## Shared env — `/.env` at repo root (written by scripts/setup-testnet.mjs)

```
STELLAR_NETWORK=stellar:testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
HORIZON_URL=https://horizon-testnet.stellar.org
NETWORK_PASSPHRASE=Test SDF Network ; September 2015

ISSUER_SECRET=S...        # issues the SXT SEP-41 test asset
ISSUER_PUBLIC=G...
ASSET_CODE=SXT
ASSET_SAC=C...            # SAC contract id — this is `asset` in PaymentRequirements

SELLER_SECRET=S...        # payTo account (has SXT trustline)
SELLER_PUBLIC=G...

PAYER_SECRET=S...         # the agent's wallet (has SXT trustline + balance)
PAYER_PUBLIC=G...

FEEPAYER_SECRET=S...      # facilitator sponsors network fees (RFP 3.1 areFeesSponsored)
FEEPAYER_PUBLIC=G...

FACILITATOR_URL=http://localhost:4021
INDEX_URL=http://localhost:4022
SELLER_URL=http://localhost:4023
```

## packages/index — public API (ESM named exports from `packages/index/src/index.mjs`)

```js
export function createCatalog()                    // -> Catalog
// Catalog:
//   upsert(record) -> { ok: boolean, dropped: string[], reason?: string }
//   list({ type, payTo, scheme, network, extensions, limit=20, offset=0 }) -> { items, total, limit, offset }
//   search({ query, limit=20, cursor, ...filters }) -> { items, partialResults, pagination:{limit,cursor} }
//   NOTE: both return INTERNAL records. The wire projection happens in discovery.mjs.
//   size() -> number
export function validateResourceBlock(block)       // soft-drop -> { value, dropped: string[] }
export function validateRouteTemplate(t)           // -> { valid: boolean, reason?: string }
export function scoreHybrid(query, docs)           // BM25 + field-boost -> ranked docs
```

### The INTERNAL record shape

This is what `upsert()` takes, what the store holds and what `list()`/`search()` return.
It is **not** what goes on the wire — see the next section.

```js
{
  id: string,                 // `${resource.url}` or `${resource.url}#${input.toolName}` for MCP
  resource: { url, serviceName?, tags?, iconUrl?, description? },
  type: "http" | "mcp",
  network: "stellar:testnet",
  scheme: "exact",
  payTo: "G...",
  asset: "C...",
  maxAmountRequired: "10000",
  input: { type, method?, queryParams?, body?, toolName?, inputSchema? },
  output: { type, format?, example? },
  routeTemplate?: string,
  extensions: ["bazaar"],
  lastSeenAt: number,         // ms epoch
  settlements: number         // count of observed settled payments
}
```

### The WIRE shape — `DiscoveryResource`

`packages/index/src/discovery.mjs` (`toDiscoveryResource`) projects the internal record
onto the type the shipped SDK declares (`@x402/extensions/dist/esm/index-*.d.mts`). Two
of the three transport adapters go through it:

| Adapter | Serves | Goes through `discovery.mjs`? |
|---|---|---|
| `packages/index/src/serverless.mjs` (via `api/discovery/*.mjs`) | `stellarsight.xyz` | yes |
| `packages/index/src/http.mjs` (`mountDiscoveryRoutes`) | any Express host | yes |
| `apps/facilitator/src/server.mjs:559,584` | the local index on `:4022` | **no — KNOWN DRIFT** |

The facilitator hand-rolls its own `/discovery/resources` and `/discovery/search` and
returns `catalog.list()` / `catalog.search()` verbatim, so **the local index on `:4022`
still serves the INTERNAL record shape** while the deployed API serves the wire shape
above. It should call `mountDiscoveryRoutes(indexApp, catalog)` instead. That change also
requires updating `apps/agent/src/bazaar.mjs` (`summarise`, `describeRecord`), which reads
`rec.resource.url`. Until both land, do not assume `:4022` and `stellarsight.xyz` agree.

```js
{
  // ---- spec DiscoveryResource ----
  resource: "https://api.example/v1/thing",   // a URL STRING, not the block above
  type: "http" | "mcp",
  x402Version: 2,
  accepts: [                                  // x402 v2 PaymentRequirements
    { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra }
  ],
  lastUpdated: "2026-08-07T12:00:00.000Z",    // ISO 8601, from lastSeenAt
  serviceName?, description?, tags?, iconUrl?, mimeType?,   // TOP LEVEL, not nested
  extensions: { bazaar: { info: { input, output }, routeTemplate?, schema? } },  // object MAP

  // ---- additive, STELLARSIGHT-native: not spec, ignored by a spec consumer ----
  id, network, scheme, payTo, asset, maxAmountRequired,     // mirrors of accepts[0]
  input, output, routeTemplate,
  lastSeenAt, firstSeenAt, settlements, seeded,
  _score, _explain
}
```

Three things a stock consumer needs that the internal record does not give it, and the
reasons they are easy to get wrong:

1. **`resource` is a URL string.** The presentation fields move to the top level.
2. **`accepts` is required** — without it a client cannot construct a payment from a
   search result. **x402 v2 `PaymentRequirements` names the price `amount`, NOT
   `maxAmountRequired`**; the v1 name fails `PaymentRequirementsSchema` in the installed
   `@x402/core`.
3. **`lastUpdated` is ISO 8601**, where the record keeps epoch ms in `lastSeenAt`.

## HTTP surfaces — do not rename fields

- `GET  /supported` -> `{ kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true, asset } }] }`
- `POST /verify`  -> `{ isValid, invalidReason|null, payer }`
- `POST /settle`  -> `{ success, errorReason|null, transaction, network, payer }` + header `EXTENSION-RESPONSES`
- `GET  /discovery/resources?type&payTo&scheme&network&extensions&limit&offset`
  -> `{ x402Version, items: DiscoveryResource[], pagination: { limit, offset, total } }`
  (plus flat `total`/`limit`/`offset`)
- `GET  /discovery/search?query&limit&cursor&...filters`
  -> `{ x402Version, resources: DiscoveryResource[], partialResults, pagination: { limit, cursor } }`
- `EXTENSION-RESPONSES` header = base64(JSON) of `{ bazaar: { status: "success"|"processing"|"rejected", rejectedReason? } }`

**The two discovery envelopes differ deliberately, and so does their pagination.**
`DiscoveryResourcesResponse` names the array **`items`** and paginates by
offset/total; `SearchDiscoveryResourcesResponse` names it **`resources`** and paginates
by cursor. `withBazaar()` returns the parsed body untransformed, so a search response
carrying only `items` makes `search.resources` `undefined` and throws on iteration.
Search currently ALSO emits `items` as a deprecated duplicate alias of the same array,
for one release. New consumers must read `resources`.

None of this is asserted by reading the field names this repo emits — that is a belief,
not an observation, and it is how the `items`/`resources` divergence shipped in the first
place. `npm run verify:api` imports the real `withBazaar` from `@x402/extensions`, drives
it against the actual handlers over a socket, and validates every `accepts` entry with
`@x402/core`'s own `PaymentRequirementsSchema`. Change a field name here and that harness
is what tells you.

## apps/web contract

Reads from `INDEX_URL`. **MUST render fully with a baked-in fallback fixture** at
`apps/web/src/data/fixture.json` when the API is unreachable — the demo cannot depend on
localhost being up. Show a small "LIVE / DEMO" pill reflecting which source is active.

Routes: `/` (landing), `/console` (live search + payment loop viewer).

## Assets

Generated assets land in `apps/web/public/assets/`. Web must degrade gracefully (CSS-only
fallback) if an asset file is missing.
