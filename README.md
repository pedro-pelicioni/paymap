<div align="center">

<img src="apps/web/public/assets/stellarsight-mark.svg" width="96" alt="STELLARSIGHT">

# STELLARSIGHT

### Find *what to pay for* on Stellar.

**The facilitator-side Bazaar discovery layer for x402 — the piece that does not exist in public code today — and the whole payment loop around it, running end to end on Stellar testnet.**

`Apache-2.0` · `stellar:testnet` · **14 settled x402 payments** · **84 tests, 0 failing**

</div>

<br>


---

## For evaluators — verify this in 60 seconds

You do not have to take any claim in this README on trust. Every one of them is checkable:

| Claim | How to check it | Time |
|---|---|---|
| Payments really settle on Stellar | Open [`c1acc578…`](https://stellar.expert/explorer/testnet/tx/c1acc578032a3a06a88603f971d871703f45b1246e0f1aa8862500495edbfba6) → `successful: true` | 10s |
| The buyer needs **zero XLM** — fees are sponsored | On that transaction, `fee_account` is the facilitator's `FEEPAYER`, not the payer | 15s |
| Catalog integrity is real, not decorative | `npm test` → 84 tests, 0 failing (66 of them adversarial) | 30s |
| **You can actually run it** | `npm install && npm run setup` — no captcha, no faucet, no API key | 2 min |
| A developer can ship on it | [`docs/QUICKSTART-SELLER.md`](docs/QUICKSTART-SELLER.md) — clone → paid, discoverable endpoint. Every command timed with `/usr/bin/time` | 59s |

That last row is the one worth pausing on. Almost every x402-on-Stellar project requires a
Circle faucet captcha **and** an OpenZeppelin Channels API key before it will start. This one
requires neither, by design — see [Two blockers removed](#two-blockers-removed-by-design).

---

## Why this is not another paywall demo

Most x402 builds are variations on one idea: an agent paying for an API, a metered service,
a channel-mode feed, a middleware kit. They are good examples. They are also built on ground
that is **already solved**, and the SCF #45 RFP says so in plain language:

> *"settlement on Stellar is largely solved; the novel work is discovery, the agent facing
> interface, the upto scheme upstream, and conformance that holds as the spec moves."*

So we did not build a payment demo. **We built the part that is missing, then built the
payment demo around it** so you can watch the missing part work.

### The gap, precisely

| | |
|---|---|
| The [`bazaar` extension spec](https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md) defines `/discovery/resources` and `/discovery/search` | ✅ exists |
| `@x402/extensions/bazaar` implements them | ❌ **its own README states it ships only client and server helpers, and no facilitator-side catalog implementation** |
| Stellar has a Bazaar | ❌ [`stellar/x402-stellar#50`](https://github.com/stellar/x402-stellar/issues/50) — *"Explore Bazaar support for Stellar"* — **open and unassigned since April 2026**. The SDF repo's Dockerfile still reads `bazaar not used` |

An agent that can pay but cannot discover is an agent with a wallet and no map. STELLARSIGHT is
the map.

---

## The public discovery API

**Live at [`stellarsight.xyz`](https://stellarsight.xyz).** The same catalog that `packages/index`
serves on `:4022` also deploys as Vercel functions, so the Bazaar is a **public, hosted
endpoint any agent can call** — which is what the RFP asks for, and what does not exist for
Stellar anywhere else. Run the commands below and they answer.

| Method | Endpoint | What it does |
|---|---|---|
| `GET` | [`/discovery/resources`](https://stellarsight.xyz/discovery/resources?limit=3) | Paginated catalog, with the spec's `type`, `payTo`, `scheme`, `network`, `extensions`, `limit`, `offset` filters |
| `GET` | [`/discovery/search`](https://stellarsight.xyz/discovery/search?query=invoice%20ocr&limit=3) | Natural-language search. Results arrive under `resources`, with `partialResults`, `pagination { limit, cursor }`, and `_explain` per result |
| `GET` | [`/discovery/health`](https://stellarsight.xyz/discovery/health) | Catalog mode, record counts, durable-store transport, and the commit being served |
| `POST` | `/discovery/resources` | Auto-cataloging. Requires `Authorization: Bearer <STELLARSIGHT_WRITE_TOKEN>` |
| any | `/discovery/<anything else>` | `404` JSON naming the endpoints that do exist — never HTML, never a silent `200` |

CORS is `*`, because the point is for *other people's* agents to call it. Every rejection —
`401` without a write token, `404` on an unknown path, `503` with no durable store — carries
a non-null, human-readable `reason` that names what to do about it.

```bash
# Natural-language search over the catalog, ranked
curl -s 'https://stellarsight.xyz/discovery/search?query=invoice%20ocr&limit=3' | jq \
  '.resources[] | {resource, score: ._score, name: .serviceName}'

# The full score breakdown on the top hit — BM25 / completeness / settlements / recency
curl -s 'https://stellarsight.xyz/discovery/search?query=convert%20dollars%20to%20reais&limit=1' \
  | jq '.resources[0]._explain'

# List, with the spec filters. Note the envelopes differ deliberately: the list
# endpoint returns `items` with offset pagination, search returns `resources`
# with a cursor — that asymmetry is the spec's, not ours.
curl -s 'https://stellarsight.xyz/discovery/resources?type=mcp&limit=5' \
  | jq '.total, .items[].resource'

# Which mode the catalog is in, how many records, which commit is serving them
curl -s https://stellarsight.xyz/discovery/health | jq
```

Real output, at the time of writing:

```
$ curl -s 'https://stellarsight.xyz/discovery/search?query=invoice%20ocr&limit=3' …
  0.8098  Invoice OCR

$ curl -s https://stellarsight.xyz/discovery/health …
  mode=kv  transport=redis  records=27  writable=true  commit=c32e43d

$ curl -s -o /dev/null -w '%{http_code} %{content_type}' https://stellarsight.xyz/discovery/nope
  404 application/json; charset=utf-8
```

`/discovery/health` reports the commit it is serving, so a claim in this README can always
be checked against the code that is actually deployed.

`mode: kv` means a durable Redis store is attached and auto-catalogued resources survive
cold starts; with no store configured the same code runs read-only from the seeded catalog
and says so, rather than failing.

Both endpoints are **validated against the shipped `@x402/extensions` types** by
`npm run verify:api`, which drives the real `withBazaar()` client at them and re-checks every
`accepts` entry with `@x402/core`'s own `PaymentRequirementsSchema`. The two envelopes differ
deliberately, and that asymmetry is the spec's rather than ours: the list endpoint returns
`items` with offset pagination, search returns `resources` with a cursor.

That claim used to read "spec-exact — the same field names", asserted by reading the field
names this repo emits. It was false: search returned `items`, no item carried `accepts`, and
`withBazaar(client).search()` handed a stock consumer `undefined`. See
[Conformance findings](#conformance-findings). The assertion now observes what the client
returns instead of restating what the server believes.

CORS is `*` because the point is for *other people's* agents to call it.

The endpoints import `packages/index` directly; the ranking and the catalog-integrity
validation are the same code the local facilitator runs, not a reimplementation. Out of
the box the deployment serves a **read-only** catalog seeded at cold start. Attach a
Redis/KV store and a write token and the auto-cataloging write path turns on;
`/discovery/health` reports which of the two is active.

---

## What it looks like


**The Sight Board.** Every result is a *sight* — the observation a navigator takes to fix
position. Numbered, ranked, with a bearing readout, and a `_EXPLAIN` disclosure that breaks
the score into BM25 / metadata completeness / settlements / recency, each with its numeric
contribution and the matched terms with their `tf`, `idf` and field weight. Searching
re-orders the board with a FLIP animation.

**The Catalog Integrity ledger**, on the right, is a **replay**, and the panel says so on its
own first line. A fixed hostile corpus is pushed through the real validator by
[`apps/web/scripts/gen-integrity.mjs`](apps/web/scripts/gen-integrity.mjs) at build time, and
every rule, verdict and reason it renders is a string that
[`createCatalog().upsert()`](packages/index/src/index.mjs) actually returned — stamped with
the commit that produced it. It is evidence the validator works. It is **not** a claim that
anyone attacked the catalog today, and when the index does report live verdicts the panel
switches its label to say that instead.

```
REJECTED    resource.url                          javascript:alert(1)
            resource.url is missing or invalid
SOFT-DROP   routeTemplate                         /v1/%252e%252e/thing
            routeTemplate contains path traversal ".." after decoding
SOFT-DROP   resource.iconUrl                      http://169.254.169.254/latest/meta-data/
            iconUrl host rejected: IP literal host (decimal/octal/hex)
SOFT-DROP   resource.tags[5]:over-limit           ["invoice","inv","invoices", … 96 more]
            99 tags submitted, catalog keeps 5 — overflow dropped to contain index pollution
```

That third and fourth line matter: the record **survives**. Soft drop means a hostile field is
discarded and the legitimate metadata around it is kept — which is exactly what the spec
requires and exactly the invariant that is easy to get wrong.

An earlier version of this section said the ledger was live and not a mockup. It was neither:
the rows were hand-written, seven of their eight rule names existed nowhere in
`packages/index/src/integrity.mjs`, and the caps they quoted (16 tags, 2,000 characters)
contradicted the ones the code enforces (5 and 512). The generator exists so that cannot
recur — the numbers above are now read back off the validator's own output rather than
restated, so a drift between doc and code shows up as a failing build artifact instead of a
sentence nobody rechecked. `npm test` runs the 66 adversarial cases the corpus is drawn from.

---

## Scoped against SCF #45, RFP Track

STELLARSIGHT is built against the RFP *"X402 Facilitator with Bazaar (discovery) support"*, which
names the Bazaar discovery layer as the highest-value part of the scope and says it should
carry the largest share of the budget. Every component maps to a numbered requirement:

| RFP req. | In this repo | Status |
|---|---|---|
| **3.2 Bazaar discovery layer** — *"the core new capability"*, *"the hardest part of the scope"* | `packages/index` — `/discovery/resources` + `/discovery/search` readable by the stock `@x402/extensions` client, BM25 hybrid ranking with a published formula and per-result `_explain`, auto-cataloging from the discovery extension, soft-drop validation, `EXTENSION-RESPONSES` reporting | Working |
| **3.2 catalog integrity** — *"the facilitator is a trust boundary"* | 66 adversarial tests: `routeTemplate` traversal under single / double / triple percent-encoding, `iconUrl` SSRF evasion, tag flooding, external `$ref` | 66/66 passing |
| **3.1 Facilitator** — verify / settle / supported, fee sponsorship, self-facilitation | `apps/facilitator` — self-hosted on Apache-2.0 `@x402/stellar`, `extra.areFeesSponsored`, non-null reason on every rejection | Working, testnet |
| **3.3 Agent-facing MCP interface** | `apps/agent` — 4 MCP tools with input **and** output schemas, 17-code error enum | Settled payments via MCP |
| **3.6 Conformance** — *"drift, not inability, is the failure mode being screened for"* | `npm run verify:conformance` — an **unmodified** `@x402/fetch` client driven through a real 402 → sign → settle → 200. It caught v1 drift in our own seller | [Documented below](#conformance) |
| **3.2 seller helpers** — per-parameter descriptions that make an endpoint legible to an agent | `apps/seller`, declared via `declareDiscoveryExtension` | Working |
| **UX** — *"docs to a paid, discoverable endpoint appearing in the Bazaar in well under an hour"* | [`docs/QUICKSTART-SELLER.md`](docs/QUICKSTART-SELLER.md) — four steps, each ending in a `curl` check. A resource is listed on seller boot **and** re-cataloged on settle, so it is discoverable before its first payment | **59s** of commands, measured |

**What we deliberately did not build**, and why: no on-chain registry (the RFP itself calls
it an optional stretch and explains the rent/TTL cost and the doubled settlement cost); no
mainnet; no audit; no `upto` implementation — that scheme has [an active design
discussion](https://github.com/stellar/x402-stellar/issues/72) opened on 3 August 2026 that
deserves a considered answer rather than a rushed one.

The point is to leave behind a piece of public infrastructure the Stellar ecosystem is
currently missing, permissively licensed, that anyone can fork and run.

---

## Architecture

```
 seller ──declares metadata──►  STELLARSIGHT INDEX  ◄──natural-language search──  agent
    │                                  ▲                                           │
    │                                  │ auto-cataloged on settle (bazaar ext)     │
    └──────────►  SELF-HOSTED FACILITATOR  ◄────── 402 → sign → settle ────────────┘
                            │
                      stellar:testnet
```

| Component | What it is |
|---|---|
| `packages/index` | Catalog + BM25 hybrid search with explainable ranking, catalog-integrity validation |
| `api/discovery` | Vercel functions serving that same catalog as a public hosted API — no logic of their own |
| `apps/facilitator` | Self-hosted x402 facilitator on `@x402/stellar`, sponsoring network fees |
| `apps/seller` | Paid API declaring discovery metadata with per-parameter descriptions |
| `apps/agent` | MCP server + payment client + narrated CLI |
| `apps/web` | Landing page and live console |

---

## Two blockers removed by design

The two things that normally stall an x402 setup on Stellar were eliminated — not by
shortcut, but by decisions that are also architecturally better.

**1. No faucet, no captcha.** Rather than depending on Circle's web faucet for testnet USDC,
STELLARSIGHT **issues its own SEP-41 asset** (`SXT`) and wraps it in a SAC. The Stellar `exact`
scheme accepts any SEP-41 token — USDC is only the default. `npm run setup` therefore runs
start to finish with no web forms and no API keys.

**2. No third-party facilitator.** The facilitator is **self-hosted** on the Apache-2.0
package. That removes any dependency on the OpenZeppelin Relayer / OZ Channels — which is
**AGPL-3.0-or-later**, and therefore unusable by any project needing a permissive license —
while demonstrating the self-facilitation path the RFP asks for in 3.1.

The `FEEPAYER` account sponsors network fees, so the paying agent needs **zero XLM**.

---

## Running it

```bash
npm install
npm run setup      # generates accounts, issues the SXT asset, adds trustlines — all testnet
npm run dev:all    # facilitator :4021 · index :4022 · seller :4023
npm run dev:web    # console + landing on :5173
npm run demo       # full loop: discover → 402 → sign → settle → 200
npm test           # 84 tests
npm run verify:api # 46 checks, incl. the stock withBazaar() client against the handlers
npm run verify:conformance   # stock @x402/fetch client pays the seller, end to end
```

No API keys. No captcha. No mainnet. No real money.

**Listing your own paid endpoint** — the seller side, timed step by step from a clean clone —
is [`docs/QUICKSTART-SELLER.md`](docs/QUICKSTART-SELLER.md).

Deployment — including the routing trap where a SPA catch-all silently swallows
`/discovery/*` — is documented in [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Search ranking

The RFP states that search quality is the hardest part of the scope and the part existing
catalogs most often leave unimplemented. So the ranking here is not a `.includes()` filter:

- **BM25**, `k1 = 1.2`, `b = 0.75`, over a field-weighted document — `serviceName` ×3,
  `description` ×2, `tags` ×2, parameter names and their per-parameter descriptions ×2,
  `output.format` ×1, URL path segments ×1.
- **Blend:** `1.00·bm25 + 0.12·completeness + 0.08·popularity + 0.05·recency`. The quality
  prior caps at **0.25** against relevance's **1.00** — quality breaks ties, it never
  overrides relevance. A test asserts that a 900k-settlement record loses to a
  zero-settlement, 200-day-stale record when the query matches the latter.
- **`_explain` per result**, with the four parts asserted by test to sum exactly to `_score`.

[`docs/SEARCH-QUALITY.md`](docs/SEARCH-QUALITY.md) documents the retrieval rationale, an
nDCG@10 / Recall@20 / MRR evaluation plan with pooled graded labels, and an explicit
cold-start section stating plainly that popularity is worthless at launch and gameable
forever — with four unimplemented mitigations ranked.

---

## Conformance

We built against the shipped `dist` rather than against examples, because on this spec the
two disagree. Below: two places where the surrounding material lags the spec, and one place
where **we** were the party that had drifted.

### Where the documentation lags the spec

Neither of these is a defect in x402. Both match
[`specs/transports-v2/http.md`](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md)
exactly — it is the third-party material *around* the spec that still shows v1 shapes. They
are listed because reading `dist` instead of trusting an example is what kept us on the
right side of them, not because anything upstream needs fixing.

1. **v2 `PaymentRequirements` uses `amount`, not `maxAmountRequired`**, and resource metadata
   moved to `PaymentRequired.resource` as a `ResourceInfo`. The v1 layout is still what most
   examples show. Our facilitator and index read both shapes.
2. **v2 signs into the `PAYMENT-SIGNATURE` request header, not `X-PAYMENT`.** `X-PAYMENT` is
   the v1 spelling and is still what much of the surrounding documentation instructs. Our
   client sends both; our seller accepts both.

### Where we had drifted

Our own reference seller advertised `x402Version: 2` and then answered 402 in the **v1 wire
format**: the entire `PaymentRequired` object in the JSON body, no `PAYMENT-REQUIRED` header,
and a paywall that read only `x-payment`.

The spec is unambiguous — *"The `PAYMENT-REQUIRED` header is the canonical HTTP transport
location for the `PaymentRequired` object"*, with response bodies called a server
implementation concern and the spec's own 402 example shipping `{}`. `@x402/core` implements
exactly that: `getPaymentRequiredResponse` falls back to the body **only** when
`body.x402Version === 1`. Ours said `2`. So an unmodified `@x402/fetch` client did this:

```
THREW: Failed to parse payment requirements: Invalid payment required response
```

We had not noticed, because our own client carried a fallback that accepted any body with an
`accepts` array. Our agent could pay our seller. Nobody else's could.

**We found it by pointing a stock client at ourselves** — the acceptance test the RFP
specifies, and the only test that could have caught it. The fix: emit `PAYMENT-REQUIRED` and
`PAYMENT-RESPONSE` using `@x402/core`'s own codecs, accept `PAYMENT-SIGNATURE`, and **delete
the fallback in our client**, so the bug cannot return quietly. The v1 spellings and the JSON
body are still emitted for backward compatibility; nothing depends on them.

`npm run verify:conformance` is that test, kept. It drives an unmodified `@x402/fetch` client
— `wrapFetchWithPayment`, no STELLARSIGHT code anywhere on the path — through a real
402 → sign → settle → 200 against a running seller, and prints the settled hash:

```
1. Unpaid probe — the 402 must carry a PAYMENT-REQUIRED header
  PASS  HTTP 402 Payment Required
  PASS  PAYMENT-REQUIRED decoded — x402Version 2, 1 requirement(s)
2. Stock client — wrapFetchWithPayment drives 402 -> sign -> settle -> 200
  PASS  HTTP 200 in 8903ms
3. Settlement receipt — PAYMENT-RESPONSE header
  PASS  PAYMENT-RESPONSE decoded, success=true

CONFORMANCE CHECK PASSED
  tx  15c4fa24785ac42b1287d9336ad219552b07d7ff81cdf86c18edbc5c250e9726
```

An earlier version of this README framed the `PAYMENT-REQUIRED` requirement as an x402 defect
worth filing upstream. It was not — the SDK was right and we were wrong. Retracting that here
is cheaper than being corrected by a reviewer, and a conformance bug we found in ourselves,
with a stock-client test now standing over it, is the stronger story regardless.

---

## Catalog integrity

The facilitator is a **trust boundary**. Clients echo the `resource` block back inside the
payment payload, so every discovery field is attacker-controlled.

- **`routeTemplate`** — the normative regex `^/[a-zA-Z0-9_/:.\-~%]+$` **permits `%`**, so the
  `..` check must run **after percent-decoding**, and must survive double and triple encoding
  (`%252e%252e`). Malformed `%` fails closed.
- **`iconUrl`** — SSRF evasions: `127.0.0.1`, decimal `2130706433`, `0x7f.1`, `0177.0.0.1`,
  `[::1]`, `0.0.0.0`, `169.254.169.254`, percent-encoded hosts, userinfo tricks, and the
  `data:` / `file:` / `javascript:` schemes.
- **`serviceName` / `tags`** — control characters, RTL override, length caps, dedupe before
  cap, and the survival invariant: an invalid field is dropped, the surrounding metadata
  is kept.

Each test cites the spec rule it enforces.

---

## Testnet transactions

Real hashes produced by this code, with explorer links:
[`docs/TESTNET-TXS.md`](docs/TESTNET-TXS.md).

Twenty-two in total, and the split matters: **14 are x402 payments** — the demo loop, the MCP
agent, and the stock-client conformance run — and 8 are setup and cleanup, meaning trustlines,
the SAC deploy, minting the test asset, and returning a legacy balance. Only the first 14 are
evidence that the payment path works.

## License

Apache-2.0, public from the first commit.

---

<div align="center">

**[github.com/pedro-pelicioni/stellarsight](https://github.com/pedro-pelicioni/stellarsight)**

Built in São Paulo, Brazil.

</div>
