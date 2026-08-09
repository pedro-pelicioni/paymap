# PAYMAP — what to fix next

Output of a five-lens audit (RFP gap, security, correctness, product, ecosystem). Every
finding below was produced with executed evidence — live curls, probes against
`createCatalog()`, the stock SDK driven against production — not inspection alone.

## Where this actually stands

The engineering is strong and the honesty posture is the project's best asset: the `replay`
pill on the payment loop, the `DEMO` catalog fallback, `SEARCH-QUALITY.md` §4 admitting there
are no numbers yet. That posture is also the vulnerability, because it sets the standard the
rest of the repo is then measured against.

**The single biggest thing between this and a funded proposal: the README makes conformance
claims that a reviewer can falsify in under a minute, and one of them is inverted — PAYMAP
is the non-conformant party, not the ecosystem.** On a bid scored explicitly on "drift, not
inability", a falsified conformance claim costs more than the underlying defect.

---

## The plan, ranked by impact ÷ effort

### 1. Retract conformance finding #3, and fix the seller it accuses — 5h · RFP 3.6

`README.md:281-287` claims `@x402/core` is wrong to require the `PAYMENT-REQUIRED` header for
v2. It is not wrong. `specs/transports-v2/http.md` calls that header "the canonical HTTP
transport location for the PaymentRequired object" and shows 402 examples with empty bodies.
`apps/seller/src/server.mjs:319` builds the whole challenge into the JSON body, never sets
`PAYMENT-REQUIRED`, and `:350` reads only `x-payment` — never `payment-signature`.

A stock `@x402/fetch` client against the seller fails twice: it throws parsing the 402, and
past that it sends only `PAYMENT-SIGNATURE`, which the seller ignores — an infinite 402 loop.
The repo has never run one; `wrapFetchWithPayment` appears nowhere outside `node_modules`.

Findings #1 and #2 verify as true, but both match the published spec, so neither is an
upstream defect — reframe them as "we read `dist` instead of trusting examples".

Delete #3. Set the header, accept `payment-signature`, and delete the `accepts`-array body
fallback at `apps/agent/src/pay.mjs:334` — that leniency is what hides your own server's
non-conformance.

### 2. Make the discovery wire shape match the shipped types — 8h · RFP 3.2, 3.6

`@x402/extensions@2.21.0` declares two deliberately different envelopes: the list endpoint
uses `items` with offset pagination, **search uses `resources`** with cursor pagination
(`index-CarYqId7.d.mts:848-880`). `packages/index/src/discovery.mjs:116` emits `items` on
search, so `withBazaar(client).search({query})` — three lines from the package's own README —
returns `undefined` and throws on iteration.

The item shape diverges too: the spec's `DiscoveryResource` has `resource` as a **URL string**,
plus `accepts: PaymentRequirements[]`, `x402Version` and `lastUpdated` (ISO 8601). PAYMAP
sends `resource` as an object, no `accepts` at all, and `lastSeenAt` as epoch ms. So even on
the list endpoint, a stock consumer cannot construct a payment from a result.

`README.md` and `CONTRACT.md:79` both call these endpoints "spec-exact". This is the RFP's
literal acceptance test — unmodified canonical client — failing on the largest budget line.

Emit `resources` on search (keep `items` as an additive alias), project records into the spec
shape, and replace the harness assertion with one that drives the real SDK.

### 3. Fix the Catalog Integrity ledger — 1h to relabel, 8h to implement · RFP 3.2, 3.6

`README.md:135` says "It is not a mockup — those are real verdicts from the validator,
timestamped." It is a mockup: eight constants from `apps/web/src/data/integrity.json` with
`now - minutesAgo`. `/discovery/integrity` returns 404. Three of its rule ids
(`resource/icon-url-origin`, `payment/payto-checksum`, `payment/network-mismatch`) do not
exist in `integrity.mjs`, and two contradict the real limits — it advertises "99 > 16" against
`MAX_TAGS = 5`.

The `payment/payto-checksum` entry is the worst of it: it advertises a validation that item 6
below proves does not exist. A reviewer pulling that thread finds a real security gap behind a
claim that it is handled.

Relabel it tonight; implement the real endpoint when there is time. `validateResourceBlock`
already produces structured verdicts on every upsert — it just discards them.

### 4. Reconcile the checkable numbers — 1h · credibility

`npm test` reports 84 (81 pass, 3 skipped); the README badge and Running-it section say 70.
"20 settled transactions" counts 8 setup and cleanup operations — trustlines, the SAC deploy,
a legacy-asset return — alongside 12 actual x402 payments. `PaymentLoop.tsx:16` already
filters to `/^demo:/` for exactly this reason, so the distinction is understood internally and
not stated externally.

Trivial individually. Disproportionate here because `README.md:25` opens with "You do not have
to take any claim in this README on trust" and then hands the reviewer a four-row table. The
first row they check is the one that does not match.

### 5. Fix the stemmer — 5h · RFP 3.2

`rank.mjs:112-136` runs the plural-stripping loop twice, so a word that was already singular
gets eaten: `address` → `addres` → `addr`, while `addresses` → `address` → `addres`. They
never meet. Live right now: `?query=addresses` returns **0 results**, `?query=address` returns
3. Same for rate/rates, process/processes, license/licenses, analysis/analyses.

`SEARCH-QUALITY.md:43` names analyzer mismatch as "the most common silent cause of bad
recall", and `:58` claims the stemmer "leaves everything else alone". Both false today. The
comment at `rank.mjs:116` even spells out the mechanism without noticing the singular case.

Nothing in 84 tests covers a morphological variant, so it passes green.

### 6. Bind catalog writes to proof of control — 12h · RFP 3.2, 3.6

RFP 3.6 names it in so many words: "a discovery index that does not let anyone spoof another
seller's listing or pricing." Today the index fails that sentence literally.

`recordId()` keys purely on `resource.url`; `upsert()` ends in an unconditional `store.set`.
Any holder of the single global `PAYMAP_WRITE_TOKEN` can rewrite a competitor's `payTo`,
`asset` and price — and the monotonic merge **keeps the victim's settlement count**, so the
hijacked listing ranks as more trustworthy than an honest new one. Confirmed by execution.

Compounding it, `integrity.mjs` validates only `resource.*`. The fields that move money —
`payTo`, `asset`, `maxAmountRequired`, `network` — are stored verbatim. A probe stored
`payTo: '<img src=x onerror=alert(1)>' + RTL-override + NUL` with `dropped: []` — the same
payload the suite correctly rejects for `serviceName`.

And `lastSeenAt` / `settlements` are caller-supplied and merged with `Math.max`, so one POST
with `lastSeenAt: 4102444800000` buys permanent position 1 with no API path back. There is no
DELETE route, so remediation is manual Redis surgery.

The self-authenticating design already exists at `apps/facilitator/src/server.mjs:457` —
records derived from an observed settlement. It just is not the deployed write path.

### 7. Ship the search evaluation harness — 24h · RFP 3.2

The RFP calls search quality the hardest part of the scope and asks for "a REAL answer on
natural-language search quality and how it is evaluated". `SEARCH-QUALITY.md` is the strongest
document in the repo and it says, honestly, that there are no numbers.

Honesty about having no numbers still scores as no numbers against a competitor with a table.

Ship the judgement set (60–100 graded rows), `npm run eval:search` printing nDCG@10 /
Recall@20 / MRR, the ablation table so each weight in `RANK_WEIGHTS` justifies itself, and a
CI gate. `buildIndex` and `scoreHybrid` are already exported — this is a fixture plus a
scorer, not a refactor.

**Do the query logging this week regardless.** `SEARCH-QUALITY.md` §6 says it cannot be
backfilled, and paymap.dev has been serving search since `2607f84` with none.

### 8. Two ecosystem contributions — 5h total · highest signal per hour

**A spec PR to `specs/extensions/bazaar.md`.** It specifies query parameters for both
discovery endpoints exhaustively and never defines the `/discovery/resources` response body.
Its one sentence on the subject (line 451) says search "mirrors the list endpoint" — wrong
twice: different array key, structurally different pagination. No duplicate issue or PR
exists. Precedent is good: #3039 (an SSRF fix touching the same file) merged 2026-08-04.

**A comment on `stellar/x402-stellar#50`.** The reference endpoint the issue itself cites,
`https://x402.org/facilitator/discovery/resources`, returns **404**, and
`/facilitator/supported` advertises `builder-code`, `eip2612GasSponsoring`,
`erc20ApprovalGasSponsoring` — **no `bazaar`**. So the issue's open task has no reference
answer. Also correct the thread's `stellar-mainnet` claim: `@x402/stellar` ships
`stellar:pubnet` and `NetworkSchemaV2` requires the colon.

**Order matters: do items 1 and 2 first.** Posting a live endpoint that `withBazaar` cannot
read, in front of the maintainers who score the RFP, inverts the whole play.

### 9. Give the live site something real — 14h · RFP 3.2, 3.1

`/discovery/health` says `records: 27, seededRecords: 27, liveRecords: 0`. All 27 seed URLs
are `.example` hosts that resolve to nothing. Auto-cataloging — "the core new capability" —
exists only in the local facilitator, so the hosted index can never observe a settlement, and
the only hosted write path is an operator bearer token, which is the separate registration
3.2 says must not be required.

Deploy the facilitator and seller, or a settle webhook that writes the same Redis. Until then,
hide seeded records behind `?includeSeeded=1` so a reviewer's first query does not return an
unreachable hostname.

---

## The one thing

**Item 2 — make `withBazaar()` work against paymap.dev.**

It is the RFP's largest budget line, its literal acceptance test, and a claim the README
already makes. Today three lines from the SDK's own README return `undefined` against your
flagship. Fixing it turns the strongest sentence you can write in the proposal — *"the only
live independent Bazaar discovery endpoint on Stellar, validated against the shipped
`@x402/extensions` types"* — from a claim into a fact, and it unblocks item 8, which is where
the ecosystem-alignment score actually comes from.

Item 1 is more urgent but it is one hour of deleting a paragraph. Do it tonight; then spend
the real time on item 2.

---

## What not to do

**Do not file the three README conformance findings upstream.** #3 is backwards; #1 and #2 are
true but match the published spec, so they are documentation drift in third-party examples,
not x402 defects. Filing them puts a wrong spec reading in front of the exact maintainers who
score you — in a repo where a competing SCF applicant is already posting correct analysis on
`#72`. Retracting a public conformance claim costs far more standing than never making one.

**Do not build the on-chain Soroban registry.** The RFP calls it an optional stretch and
explains the rent/TTL burden plus the roughly doubled settlement cost.

**Do not chase mainnet or an audit yet.** Both are committed deliverables *of the funded
work*, not prerequisites for the proposal. Shipping a half-configured pubnet path now buys
nothing and creates a second surface to keep conformant.

**Do not write `scheme_upto_stellar.md` this month.** `#72` already has a working
`exact` + `upto` implementation with testnet proofs, opened 3 August. Competing head-on there
is bad ROI; a substantive comment on the design costs two hours and scores on the same
criterion.

**Do not polish the landing page further.** It is already the best-looking artifact in this
round. Adding a `/docs` route (6h) is worth it — pure decoration is not.
