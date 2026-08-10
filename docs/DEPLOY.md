# Deploying STELLARSIGHT

The repo deploys as a **single Vercel project**: the Vite site in `apps/web` becomes the
static output, and the three files in `api/discovery/` become Node.js Vercel Functions
that serve the public x402 Bazaar discovery API.

Nothing about local development changes. `npm run dev:all` still runs the index on
`:4022` out of `apps/facilitator`, and the serverless handlers import the same
`packages/index` modules rather than reimplementing anything.

---

## What gets deployed

| Path | Served by | Notes |
|---|---|---|
| `/`, `/console`, assets | `apps/web/dist` | SPA, via the catch-all rewrite |
| `GET /discovery/resources` | `api/discovery/resources.mjs` | filters + offset pagination |
| `POST /discovery/resources` | `api/discovery/resources.mjs` | auto-cataloging — off unless configured |
| `GET /discovery/search` | `api/discovery/search.mjs` | ranked, results under `resources`, `partialResults`, cursor |
| `GET /discovery/health` | `api/discovery/health.mjs` | mode, record count, commit |

Everything under `/discovery/*` belongs to the API. An unknown path there returns 404
rather than the single-page app.

### Routing, and the trap in it

`vercel.json` ends with the SPA catch-all `"/(.*)" → "/index.html"`. **Rewrites are
evaluated in order and the first match wins**, so a catch-all placed above the discovery
rules would swallow every API request and return HTML with a 200. The discovery rewrites
are therefore listed first and the catch-all is last:

```json
"rewrites": [
  { "source": "/discovery/resources", "destination": "/api/discovery/resources" },
  { "source": "/discovery/search",    "destination": "/api/discovery/search" },
  { "source": "/discovery/health",    "destination": "/api/discovery/health" },
  { "source": "/discovery/:path*",    "destination": "/api/discovery/:path*" },
  { "source": "/(.*)",                "destination": "/index.html" }
]
```

`npm run verify:api` asserts that ordering against the real `vercel.json` — if anyone ever
moves the catch-all up, that check fails.

---

## First deploy

Connect the repo in the Vercel dashboard, or `vercel link && vercel --prod` from the repo
root. **Project settings that must be right:**

- **Root Directory** — the repository root (*not* `apps/web`). The `api/` directory and
  `packages/index` both live above `apps/web`; pointing the root at `apps/web` hides them
  and the discovery endpoints will 404.
- **Framework Preset** — *Other*. `vercel.json` already pins `buildCommand`,
  `installCommand` and `outputDirectory`.
- **Node.js version** — 22.x.

Everything else is in `vercel.json` and needs no dashboard equivalent.

---

## The custom domain

`stellarsight.xyz` is served from an apex `A` record and a `www` `CNAME` at the registrar,
with the registrar's own nameservers left in place. Vercel's nameserver option is the
alternative, not an addition — taking it moves the whole zone, so every unrelated record
(`_dmarc`, and anything for email) has to be recreated on the Vercel side. It is only
required for wildcard domains, which this project does not use.

> **The CNAME target is per-project.** Vercel issues a unique hostname such as
> `d1d4fc829fe7bc7c.vercel-dns-017.com`. Older guides say `cname.vercel-dns.com` — do not
> paste that from memory, and do not reuse a value from another project. The same goes for
> the apex `A` record: read both off the project's Domains screen.

Check the authoritative answer rather than a cached resolver, then the deployment itself:

```bash
dig @<registrar-ns> stellarsight.xyz A +short
curl -s https://stellarsight.xyz/discovery/health | jq '.mode, .records, .build.commitShort'
```

---

## Environment variables

**None are required.** With an empty environment the API serves a read-only catalog
seeded from `packages/index/src/seed.mjs` at cold start. That is the intended baseline: a
public Bazaar that answers out of the box beats a write-capable one that needs setup
nobody has done.

| Variable | Required | Effect |
|---|---|---|
| `KV_REST_API_URL` | no | Redis/KV **REST** endpoint. With the token, switches the catalog to `kv` mode. |
| `KV_REST_API_TOKEN` | no | Bearer token for the above. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | no | Accepted as aliases when you wire Upstash up yourself. |
| `KV_REDIS_URL` | no | Redis **protocol** connection URL, `redis://` or `rediss://` (TLS). Used when no REST pair is set. |
| `REDIS_URL` | no | Accepted as an alias for `KV_REDIS_URL`. |
| `STELLARSIGHT_WRITE_TOKEN` | no | Enables `POST /discovery/resources`. Callers must send `Authorization: Bearer <value>`. |
| `STELLARSIGHT_KV_KEY` | no | Redis hash key. Default `stellarsight:catalog:v1`. |
| `STELLARSIGHT_KV_TTL_MS` | no | How long a store snapshot is reused before re-reading. Default `5000`. |
| `STELLARSIGHT_KV_TIMEOUT_MS` | no | Per-command timeout against the store. Default `4000`. |
| `STELLARSIGHT_REDIS_CONNECT_TIMEOUT_MS` | no | Connect timeout, protocol transport only. Default `2000`. |
| `STELLARSIGHT_CACHE_S_MAXAGE` | no | CDN `s-maxage` on the read endpoints. Default `60`. |
| `STELLARSIGHT_CACHE_SWR` | no | CDN `stale-while-revalidate`. Default `600`. |
| `SEED_CATALOG` | no | `0` boots an empty catalog instead of the seed corpus. |
| `VITE_INDEX_URL` | no | Build-time override for where the web console points. Leave unset. |

A missing, empty or malformed value never crashes a request. A configured-but-unreachable
store falls back to the seeded catalog and reports the failure on `/discovery/health`.

### Two ways to reach Redis, and which one you get

Which of these you can use is decided by whoever provisioned the database:

- **REST** — `KV_REST_API_URL` + `KV_REST_API_TOKEN`. An HTTPS API, stateless, no
  connection to hold. Vercel KV and Upstash both expose it. **Preferred when present**,
  because a function that may be frozen mid-request is a bad place to own a TCP socket.
- **Redis protocol** — `KV_REDIS_URL`, e.g.
  `rediss://default:<password>@<host>.example.com:6379`. Spoken over TCP through the
  `redis` package.

**The Vercel Marketplace Redis integrations give you the connection URL and no REST
endpoint at all.** If you provision Redis from the Marketplace, the protocol variable is
the only one you will have — set it and leave the REST pair unset.

> **Custom Prefix tip.** When you connect a Marketplace database to the project, Vercel
> asks for an environment-variable prefix. Enter **`KV`** and the connection URL lands as
> `KV_REDIS_URL`, which is exactly what this code reads — no aliasing, no copy-paste of a
> credential. With a different prefix, add `KV_REDIS_URL` (or `REDIS_URL`) yourself,
> pointing at the same value.

`GET /discovery/health` reports which one is live as `durableStore.transport`
(`"rest"`, `"redis"`, or `null` when unconfigured). The password never appears there:
`host` is host-only and every error string is scrubbed of credentials before it is
returned.

**Connections and the plan cap.** The protocol transport opens **one** connection per
warm function instance: nothing connects at module load, the first request that needs the
store connects, concurrent requests on a cold instance share that single in-flight
connect, and the client is then reused for the life of the instance rather than closed per
request. A connection that has gone away — idle timeout, server restart — is detected and
rebuilt once, transparently. This matters: the free tiers cap at around 30 connections.

---

## Catalog state: the two modes

### `seed` — the zero-configuration default

Each cold start builds a catalog from `packages/index/src/seed.mjs` through the normal
`catalog.upsert` path, so the seeded records pass the same integrity validation as live
traffic. `asSeedRecord` pins them to `settlements: 0` and flags them `seeded: true`, so
nothing in the catalog ever claims a payment that did not happen.

Reads work. Writes return `503` with a reason naming the variables to set.

The three real seller routes (`/v1/fx/usd-brl`, `/v1/cep/:cep`, `/v1/ocr/nota-fiscal`)
are **not** seeded into the deployment: `apps/seller` binds to `localhost:4023` and there
is no publicly reachable instance of it. Baking `http://localhost:4023/...` into a public
Bazaar would advertise resources nobody can reach. When a public seller exists, it enters
the catalog through the write path below.

### `kv` — durable and shared

Point the deployment at a Redis — either `KV_REST_API_URL` + `KV_REST_API_TOKEN`, or
`KV_REDIS_URL` (see [above](#two-ways-to-reach-redis-and-which-one-you-get)) — and the
catalog gains a shared, persistent layer:

- **Cold start**: seed corpus first, then every record in the store. Store records win on
  a shared `id`, and because `seeded` is re-derived on each upsert, a real announcement
  clears the seed flag — the same ordering `apps/facilitator` relies on locally.
- **Storage**: one Redis hash, `id -> JSON(record)`. A hash rather than one blob because
  `HSET` on a field is atomic, so two function instances cataloging different resources
  concurrently cannot clobber each other.
- **Propagation**: a write forces the next read on that instance to reload; other
  instances pick it up within `STELLARSIGHT_KV_TTL_MS`.

Add `STELLARSIGHT_WRITE_TOKEN` to open the write path.

**Why writes need a token even though the store variables are enough to make them work:**
an unauthenticated write endpoint on a public discovery index is a spam magnet, and
catalog integrity is the load-bearing part of this project. The validator would still
soft-drop hostile *fields*, but nothing stops volume. So a store makes writes possible,
the token makes them permitted, and the absence of either is reported plainly rather than
silently accepted.

---

## Verifying a deployment with curl

Replace `stellarsight.xyz` with your own deployment URL.

```bash
# 1. Which mode is live, how many records, which commit
curl -s https://stellarsight.xyz/discovery/health | jq

# 2. Search — ranked, with the score breakdown. NOTE the array is `resources`, not
#    `items`: the search and list envelopes differ deliberately (see CONTRACT.md).
curl -s 'https://stellarsight.xyz/discovery/search?query=invoice%20ocr&limit=3' | jq \
  '.resources[] | {resource, name: .serviceName, score: ._score, price: .accepts[0].amount}'

# 3. The full _explain on the top hit
curl -s 'https://stellarsight.xyz/discovery/search?query=invoice%20ocr&limit=1' \
  | jq '.resources[0]._explain'

# 4. List with filters — the LIST endpoint uses `items` and offset pagination
curl -s 'https://stellarsight.xyz/discovery/resources?type=mcp&limit=5' | jq '.total, .items[].resource'

# 5. Cursor pagination
CURSOR=$(curl -s 'https://stellarsight.xyz/discovery/search?query=stellar&limit=2' | jq -r .pagination.cursor)
curl -s "https://stellarsight.xyz/discovery/search?query=stellar&limit=2&cursor=$CURSOR" | jq '.resources[].id'

# 5b. What a stock consumer sees: the payable offer, straight off a search hit
curl -s 'https://stellarsight.xyz/discovery/search?query=invoice%20ocr&limit=1' \
  | jq '.resources[0] | {resource, x402Version, lastUpdated, accepts}'

# 6. CORS preflight — must answer 204 with Access-Control-Allow-Origin: *
curl -s -i -X OPTIONS https://stellarsight.xyz/discovery/resources | head -8

# 7. The SPA catch-all must NOT shadow the API: this must be JSON, not text/html
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  'https://stellarsight.xyz/discovery/search?query=test'

# 8. Write path (kv mode + STELLARSIGHT_WRITE_TOKEN only)
curl -s -X POST https://stellarsight.xyz/discovery/resources \
  -H "Authorization: Bearer $STELLARSIGHT_WRITE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"resource":{"url":"https://api.example.com/v1/thing","serviceName":"Thing",
        "description":"Does a thing, described well enough to be discoverable.",
        "tags":["thing"]},
       "type":"http","payTo":"G...","asset":"C...","maxAmountRequired":"1000",
       "input":{"type":"http","method":"GET"},"output":{"type":"json"},
       "extensions":["bazaar"]}' | jq
```

There are three healthy states, not two, and `/discovery/health` names which one you are in:

| `mode` | `writable` | `durableStore.transport` | What it means |
|---|---|---|---|
| `seed` | `false` | `null` | No store configured. Reads work off the seed corpus; `POST` is `503`. |
| `kv` | `false` | `redis` / `rest` | Store attached, but no `STELLARSIGHT_WRITE_TOKEN`. Reads work and survive cold starts; `POST` is still `503`, with a reason saying so. |
| `kv` | `true` | `redis` / `rest` | Both set. `POST` is `401` until the caller presents the token. |

`records` is non-zero in all three, and step 7 prints `200 application/json` in all three.
The middle row is the easiest to misread as broken: a store really is attached, and writes
really are refused, on purpose.

---

## Verifying before you deploy

```bash
npm run verify:api
```

This imports the actual `api/discovery/*.mjs` files, drives them with mock and real Node
`req`/`res` objects, and asserts the response shapes, every filter, both pagination
styles, `_explain`, CORS, the preflight, cache headers, the write path in all four of its
states, graceful degradation on a broken store, and the `vercel.json` rewrite ordering.

`npx vercel dev` is the more faithful check but needs an authenticated Vercel account.

The durable store has its own suite in `test/store-transport.test.mjs` — transport
selection, credential scrubbing and graceful degradation run with no Redis at all. The
end-to-end round trip skips unless you point it at one:

```bash
docker run -d -p 6399:6379 redis:7-alpine
STELLARSIGHT_TEST_REDIS_URL=redis://127.0.0.1:6399 npm test
```

---

## The web console: LIVE vs DEMO

`apps/web/src/lib/api.ts` resolves the API base as:

- `VITE_INDEX_URL` if set (an explicit override wins everywhere),
- otherwise `''` in a production build — a **same-origin relative base**, so the deployed
  console calls its own `/discovery/*` with no CORS hop and no configuration,
- otherwise `http://localhost:4022` in the dev server.

The pill in the header reads **LIVE** when the API answered and **DEMO** when it fell back
to `apps/web/src/data/fixture.json`. That fallback is required by `CONTRACT.md` and is
untouched — the console renders fully even if the API is down.

---

## Known behaviour

- **`/discovery/integrity` returns 404.** The console probes it opportunistically for a
  live validation ledger; no build of the index exposes it yet (the local index on `:4022`
  does not either), so the console falls back to its baked ledger. The probe is wrapped in
  a `try`/`catch` and the 404 is expected.
- **`GET /discovery/search` without a `query` parameter is a 400**, per the bazaar spec.
  A present-but-empty `query` is a browse over the whole filtered catalog.
- **Cold starts.** The first request after an idle period pays for module load plus
  seeding. The console allows 4s in production before falling back to DEMO.
