# STELLARSIGHT — Technical Architecture

**Stellar Community Fund #45 · RFP track · "x402 Facilitator with Bazaar (discovery) support"**

This document is the engineering companion to the SCF submission. It describes what runs
today on `stellar:testnet`, exactly how it uses Stellar, and what the award funds on top of
it. Everything below is in the public repository
[github.com/pedro-pelicioni/stellarsight](https://github.com/pedro-pelicioni/stellarsight)
(Apache-2.0), and the hosted deployment is [stellarsight.xyz](https://stellarsight.xyz).

Claims here are written to be checked, not believed. Where a section states a number, the
command that produces it is named. Where something is not built, it says so in the same
sentence rather than in a footnote.

---

## Table of contents

1. [System overview](#1-system-overview)
2. [The payment path, in Stellar terms](#2-the-payment-path-in-stellar-terms)
3. [The Bazaar: the facilitator-side catalog](#3-the-bazaar-the-facilitator-side-catalog)
4. [Search](#4-search)
5. [The agent and seller surfaces](#5-the-agent-and-seller-surfaces)
6. [The `upto` scheme (planned, Tranche 2)](#6-the-upto-scheme-planned-tranche-2)
7. [Security and trust model](#7-security-and-trust-model)
8. [Monitoring and operations](#8-monitoring-and-operations)
9. [Deployment topology](#9-deployment-topology)
10. [Architecture mapped to the funded tranches](#10-architecture-mapped-to-the-funded-tranches)
11. [Operating as a public good](#11-operating-as-a-public-good)
- [Appendix A — Verify this in 60 seconds](#appendix-a--verify-this-in-60-seconds)
- [Appendix B — Repository map](#appendix-b--repository-map)

---

## 1. System overview

### 1.1 The gap this fills, stated precisely

Stellar can already settle an x402 payment. The `@x402/stellar` package implements the
`exact` scheme, and this project composes it rather than reimplementing it. What Stellar
does **not** have is the other half of the protocol:

| Piece | Status |
|---|---|
| The `bazaar` extension spec defines `GET /discovery/resources` and `GET /discovery/search` | Exists, in the x402 spec |
| `@x402/extensions/bazaar` implements them | **No.** Its own README states it ships client and server helpers and no facilitator-side catalog implementation |
| Stellar has a Bazaar | **No.** [`stellar/x402-stellar#50`](https://github.com/stellar/x402-stellar/issues/50), "Explore Bazaar support for Stellar", open and unassigned since April 2026 |

An agent that can pay but cannot discover is an agent with a wallet and no map. The RFP
names discovery as the highest-value part of the scope and says settlement is largely
solved. This architecture takes that literally: the catalog is the product, and the
payment loop exists around it so the catalog can be populated by something real.

### 1.2 The invariants

Three properties hold everywhere in this design, and every later section is downstream of
them.

**The facilitator is non-custodial.** It holds no user funds, has no deposit or withdrawal
path, and cannot move money. Every settlement is a direct SEP-41 transfer from the buyer's
account to the seller's, authorized by the buyer's own signature over the full invocation.
A fully compromised facilitator can refuse service and can waste its own sponsored fees. It
cannot redirect a payment, change an amount, or move funds it was not authorized to move.

**The catalog is a trust boundary.** Discovery metadata is attacker-controlled: clients
echo the `resource` block back inside the payment payload, and everything the catalog
returns will be read by an LLM-driven agent that then sends money. Validation is therefore
mechanical and adversarial, and 66 of the repository's tests exist only to attack it.

**Listings are born from settled Stellar payments.** A resource enters the catalog when a
settlement carrying the discovery extension succeeds, and the entry is bound to that
payment's recipient. This is the anti-spam mechanism and it is Stellar-specific: account
and trustline reserves put a real cost on manufacturing fake listings, which an off-chain
registry cannot charge.

### 1.3 What runs today, and what the award funds

| Component | Today | Award adds |
|---|---|---|
| Facilitator (`/supported`, `/verify`, `/settle`) | Live, testnet, `exact` scheme, fees sponsored | Channel-account pool, `upto`, mainnet with USDC |
| Bazaar catalog | Live and durable at stellarsight.xyz | Per-seller identity, ownership re-verification |
| Search | Live, BM25 hybrid, nDCG@10 **0.864** measured | Golden set to 150–200 queries, CPU-only semantic layer |
| Agent surface | MCP over stdio, 4 tools | Hosted HTTP MCP, TS/Go/Python adapter tests |
| Threat model + monitoring plan | Published, v0.1 | Implemented, alerts firing |
| `upto` scheme | Published position, no contract | Spec upstream, contract on testnet |
| Network | `stellar:testnet` only | `stellar:pubnet`, 30 days measured uptime |

### 1.4 The stack in one paragraph

Node ≥22, pure ESM, no build step outside the web console. One Express app is the
facilitator; one npm workspace (`packages/index`) is the catalog, its ranker and its
integrity validator; the same modules are mounted three ways — locally on `:4022`, as
Vercel Functions under `/discovery/*`, and inside the facilitator process — so there is one
definition of the wire format and no surface can drift from it. State that must outlive a
process lives in a Redis-compatible store. Nothing else is stateful. All Stellar
cryptography is delegated to `@x402/stellar`; this project never signs or verifies by hand.

---

## 2. The payment path, in Stellar terms

### 2.1 Protocol surface

x402 **v2** throughout. The 402 challenge travels in the `PAYMENT-REQUIRED` response
header, the signed payload arrives in `PAYMENT-SIGNATURE`, the receipt returns in
`PAYMENT-RESPONSE`, and cataloging outcomes are reported in `EXTENSION-RESPONSES`. The v1
spellings (`X-PAYMENT`, the challenge in the JSON body) are still accepted and emitted for
compatibility, and nothing depends on them.

Networks are CAIP-2 identifiers: `stellar:testnet` today, `stellar:pubnet` at Tranche 3.
`GET /supported` advertises:

```json
{ "kinds": [ { "x402Version": 2, "scheme": "exact", "network": "stellar:testnet",
               "extra": { "areFeesSponsored": true, "asset": "CAYCPWN5…GPO2" } } ] }
```

### 2.2 The buyer signs an authorization entry, not a transaction

This is the Stellar-specific heart of the flow and the reason the fee model works.

A Soroban authorization entry (CAP-0046-11) binds the payer's signature to the entire
invocation tree: the contract being called, the function, and every argument. It does
**not** bind the transaction envelope, the source account, or the fee. So the buyer can
authorize *exactly this payment* while a different account submits it and pays for it.

```
buyer                          facilitator                        Stellar
  │                                 │                                │
  │  GET /v1/thing                  │                                │
  ├────────────────────────────────>│  (seller) 402 + PAYMENT-REQUIRED
  │<────────────────────────────────┤                                │
  │                                 │                                │
  │  sign SorobanAuthorizationEntry │                                │
  │  over SAC.transfer(from,to,amt) │                                │
  │  + signatureExpirationLedger    │                                │
  │                                 │                                │
  │  PAYMENT-SIGNATURE ────────────>│                                │
  │                                 │  POST /verify                  │
  │                                 │   simulate ───────────────────>│
  │                                 │<─────────────────── result ────┤
  │                                 │  POST /settle                  │
  │                                 │   rebuild tx, FEEPAYER as      │
  │                                 │   source, wrap in fee-bump ───>│
  │                                 │<──────────── tx hash ──────────┤
  │<───── 200 + PAYMENT-RESPONSE ───┤                                │
```

### 2.3 SEP-41 / SAC

The payment itself is a SEP-41 `transfer` on a Stellar Asset Contract. Any SEP-41 asset is
accepted; the scheme is asset-agnostic by construction.

On testnet the deployment issues **its own** classic asset (`SXT`) and wraps it with
`createStellarAssetContract`, so `npm run setup` runs start to finish with no Circle faucet
captcha and no API key. That is a deliberate developer-experience decision, not a shortcut:
the `exact` scheme accepts any SEP-41 token and USDC is only the default. **Mainnet launches
on the Circle USDC SAC** (Tranche 3, deliverable 3.1), with additional assets enabled by
configuration.

Amounts are integer strings in atomic units, 7 decimals. In x402 **v2** the price field on
`PaymentRequirements` is `amount`; the v1 name `maxAmountRequired` fails
`PaymentRequirementsSchema` in the installed `@x402/core`, so an `accepts` entry built with
it is silently unusable. Both are read on input; only `amount` is emitted.

### 2.4 Fee sponsorship and the 500,000-stroop ceiling

The facilitator's `FEEPAYER` account is both the transaction source and the fee-bump
signer, so **the paying agent needs zero XLM** — it holds only the asset it is paying with.

`maxTransactionFeeStroops` is a safety ceiling, not a fee that gets paid: `@x402/stellar`
simulates the transfer and refuses at `/verify`, before any money moves, if the
simulation-derived fee exceeds it. The library default is 50,000.

That default is too tight for this scheme and was breaking payments intermittently. A
SEP-41 SAC transfer with a sponsored fee bump simulates around **57,000 stroops** on testnet
today, above the default, and the margin moves with network load — so the failure appears
under load and disappears when you go looking for it. Observed during development: four
consecutive `/verify` rejections at 57,031–57,038 stroops, then a settlement that squeaked
through at max_fee 57,227 an hour later.

The ceiling is therefore set to **500,000 stroops (0.05 XLM)**: 8.7× the observed
simulation, still small enough to catch a genuinely runaway transaction, which is what a
ceiling is for. The derivation is in the source next to the constant
(`apps/facilitator/src/server.mjs`), so a reviewer can audit the reasoning and not just the
number. Independently, the Vellar submission reports hitting the same 50,000 default as a
hard blocker for policy-governed payments and raising it to the same 500,000 — two projects
converging on the number from opposite directions.

### 2.5 Replay and expiry are enforced on-chain

There is deliberately **no facilitator-side replay cache**. Soroban consumes the
authorization nonce when the call executes, and `signatureExpirationLedger` bounds the
window. A cache would be a second source of truth that can be poisoned, out-of-sync, or
bypassed by a second facilitator instance; the ledger cannot. Client-side, a replayed or
expired authorization is mapped to a distinct machine-readable code
(`STELLARSIGHT_REPLAY_REJECTED`, `STELLARSIGHT_AUTH_EXPIRED`) so the caller can tell the two
apart.

### 2.6 One fee-payer is the current bottleneck, and it is measured

A Stellar account has one sequence number. Today every settlement is signed and fee-bumped
from a single `FEEPAYER`, so concurrent settlements do not run concurrently — they collide.

This is measured rather than assumed, by a controlled experiment
(`npm run load:baseline`, published in [LOAD-BASELINE.md](LOAD-BASELINE.md)):

| | Attempted | Succeeded |
|---|---|---|
| Serial (one at a time) | 4 | **4 — 100%** |
| Concurrent | 10 | **1 — 10%** |

Same payment, same stack, same signer, same network; only the timing changed. The serial
control group is what makes the attribution honest: `@x402/stellar` collapses a rejected
submission into `settle_exact_stellar_transaction_submission_failed` without surfacing the
underlying `tx_bad_seq`, so the error text alone proves nothing.

**Tranche 1, deliverable 1.1** replaces this with a pool of channel accounts, each with its
own sequence number, round-robin leased, with sequence-drift quarantine and reconciliation,
targeting 25–50 concurrent settlements with zero sequence-number failures.

---

## 3. The Bazaar: the facilitator-side catalog

### 3.1 Cataloging is a side effect of getting paid

There is no seller registration step. When a settlement succeeds and its payload carries
the discovery extension, the facilitator projects the payment into a catalog record and
upserts it. The seller middleware additionally pre-registers a route at boot, so a resource
is discoverable **before** its first payment; the settlement then promotes it, increments
its observed settlement count, and clears any demo flag.

Two properties make this trustworthy rather than merely convenient:

- **The listing is bound to the settled payment's recipient.** Payment terms come from the
  settlement, not from seller-supplied text, so nobody can list a service under another
  seller's `payTo` or quote a price they do not charge.
- **The index stays off-chain.** An on-chain registry is an explicit non-goal: the RFP calls
  it an optional stretch and it costs Soroban storage rent, TTL management, and a doubled
  settlement cost. The chain is the source of truth for *payments*; the catalog is an index
  over them.

### 3.2 One wire format, three mountings

The internal catalog record and the spec's `DiscoveryResource` are different shapes, and
the projection between them lives in exactly one place (`packages/index/src/discovery.mjs`,
`toDiscoveryResource`). Three adapters mount it:

| Adapter | Serves |
|---|---|
| `packages/index/src/serverless.mjs` via `api/discovery/*` | stellarsight.xyz |
| `packages/index/src/http.mjs` (`mountDiscoveryRoutes`) | any Express host |
| `apps/facilitator/src/server.mjs` | the local index on `:4022` |

The spec puts the URL in `resource` as a **string** with presentation fields at the top
level and payment terms in `accepts[]`; the internal record nests them. STELLARSIGHT-native
fields (`id`, `settlements`, `seeded`, `_score`, `_explain`, and flat mirrors of
`accepts[0]`) ride along as additive keys that a spec client ignores.

The two envelopes differ deliberately, and that asymmetry is the spec's rather than ours:
the list endpoint returns `items` with offset pagination, search returns `resources` with a
cursor. `GET /health` on `:4022` reports `wireShape: "spec"` so the agreement is checkable
rather than asserted.

### 3.3 Durability and graceful degradation

The catalog has three states, and `/discovery/health` reports which one is live:

| Mode | Condition | Behaviour |
|---|---|---|
| `seed`, read-only | no store configured | serves the seeded corpus; **never fails** |
| `kv`, not writable | store configured, no write token | durable reads, writes refused with a reason |
| `kv`, writable | store + `STELLARSIGHT_WRITE_TOKEN` | auto-cataloging on |

A public Bazaar that answers out of the box beats a write-capable one that needs setup
nobody has done, so the read-only baseline must never break. A store that is configured but
unreachable degrades to the seeded catalog and says so on `/health` rather than returning
500.

Both writers — the facilitator's settle path and the authenticated announce path — persist
the **post-validation** record, never the raw request body, so the store can never be used
to smuggle a field past the validator. Durability is reported, not assumed: a rejected
durable write is surfaced in the response instead of being swallowed.

### 3.4 Catalog integrity

The facilitator is a trust boundary, so every discovery field is treated as hostile input.
66 adversarial tests enforce the rules; the ones that matter most:

- **`routeTemplate` traversal.** The spec's normative regex `^/[a-zA-Z0-9_/:.\-~%]+$`
  *permits* `%`, so the `..` check must run **after** percent-decoding, and must survive
  double and triple encoding (`%252e%252e`). Decoding is fixed-point, capped at five passes,
  and a malformed `%` fails closed.
- **`iconUrl` SSRF.** Rejects `127.0.0.1`, decimal `2130706433`, `0x7f.1`, `0177.0.0.1`,
  `[::1]`, `0.0.0.0`, `169.254.169.254`, percent-encoded hosts, userinfo tricks, and the
  `data:` / `file:` / `javascript:` schemes.
- **Caps and control characters.** `serviceName` 32, tags 5 × 32, description 512, dedupe
  before cap, control characters and RTL overrides stripped.

The invariant that ties them together is **soft-drop**: a hostile field is dropped and the
legitimate metadata around it survives. That is what the spec requires and the part that is
easy to get wrong — rejecting the whole record would let one bad field erase a real listing.
Every outcome is reported back to the caller in `EXTENSION-RESPONSES` with a non-null reason.

### 3.5 Provenance: demo breadth vs real resources

The catalog ships a 27-record demo corpus on `.example` hosts. It exists so the ranker has a
realistic spread to rank — completeness and freshness vary on purpose, which is what makes
`_explain` legible instead of constant. Every seeded record is flagged `seeded: true` and
pinned to `settlements: 0`, so demo breadth can never inflate an observed-settlement total,
and the flag survives the wire projection.

`?seeded=false` returns only resources that were announced or paid for. Deleting the corpus
would hide the ranker; labelling it and making the split queryable costs nothing and is
checkable. A real announcement sharing an id with a seed record promotes it and clears the
flag.

---

## 4. Search

### 4.1 Ranking

Field-weighted BM25 (Okapi, `k1 = 1.2`, `b = 0.75`) over a bag of tokens built from
`serviceName` ×3, `description` ×2, tags ×2, parameter names and their per-parameter
descriptions ×2, `output.format` ×1 and URL path segments ×1. The analyzer casefolds, folds
accents, splits camelCase, strips stopwords and suffixes.

A quality prior is blended on top of relevance:

```
score = 1.00·bm25 + 0.12·completeness + 0.08·popularity + 0.05·recency
```

The prior caps at **0.25** against relevance's 1.00, so quality breaks ties and never
overrides relevance. A test asserts that a 900,000-settlement record loses to a
zero-settlement, 200-day-stale record when the query matches the latter. Every result
carries `_explain` with the four components, asserted by test to sum exactly to `_score`.

There is **no LLM in the default ranking path**. Results stay reproducible and query cost
stays at zero.

### 4.2 Measured quality, with a gate

`npm run eval:search` runs 50 hand-graded queries ([`eval/golden.jsonl`](../eval/golden.jsonl))
through the real `catalog.search`:

| Metric | Value |
|---|---|
| nDCG@10 | **0.864** |
| Recall@20 | **0.905** |
| MRR@10 | **0.920** |
| Precision@1 | 0.896 |
| No-match silence | 0.500 |

Graded 0–3, exponential gain `2^rel - 1`, judged documents at grade ≥2 counted as answers
for the binary metrics. CI fails the build on a regression greater than 0.02 against
[`eval/baseline.json`](../eval/baseline.json). Thirteen tests check the metric arithmetic
itself, because a published nDCG is only worth the maths behind it.

**The caveats belong next to the numbers.** The corpus is the 27-record demo catalog, so
this is a *known-item* measurement, and the labels were written by the same person who wrote
the ranker. Tranche 1 takes the set to 150–200 queries plus a rolling sample from the live
catalog, which is where the second caveat stops applying.

### 4.3 What is not built

Two of the fifty queries have no right answer on purpose. Half of them still return
something — BM25 will match a stray token — and that is published as `no-match silence 0.5`
rather than quietly excluded.

The two weakest real queries, `will it rain tomorrow` and `logistics cost estimation`,
return **nothing at all**: pure paraphrases with zero lexical overlap. That is precisely the
failure a semantic layer fixes, and it is the evidence behind Tranche 2's CPU-only embedding
deliverable rather than a hunch. [SEARCH-QUALITY.md](SEARCH-QUALITY.md) documents the
cold-start problem honestly: popularity is worthless at launch and gameable forever, with
four unimplemented mitigations ranked.

---

## 5. The agent and seller surfaces

### 5.1 MCP

An MCP server exposes four tools — `stellarsight_search`, `stellarsight_browse`,
`stellarsight_describe`, `stellarsight_pay` — each with **input and output** schemas,
`structuredContent`, and a 17-code error enum where every rejection carries a non-null
reason. `describe` returns a call-construction brief: per-parameter types, descriptions,
examples and a `howToCall` block, so an agent can construct a valid call with no external
documentation.

The server holds no buyer keys on the discovery path. Signing stays client-side.

Today MCP is stdio-only. Tranche 2 adds a hosted HTTP endpoint and CI adapter tests proving
stock TypeScript, Go and Python discovery clients parse the responses.

### 5.2 Seller integration

`@stellarsight/express` is a drop-in paywall: price a route, take payment in a Stellar
token, and get listed in the Bazaar before the first payment.

```js
const paywall = stellarsightPaywall({ facilitator, payTo, asset });
app.get('/v1/thing', paywall.pay('/v1/thing', {
  price: '10000',
  serviceName: 'Thing API',
  description: 'Does the thing.',
  input: { queryParams: { q: { type: 'string', description: 'what to look up' } } },
}), handler);
```

Clone to a paid, discoverable endpoint is **59 seconds**, measured step by step with
`/usr/bin/time` in [QUICKSTART-SELLER.md](QUICKSTART-SELLER.md).

### 5.3 Conformance in both directions

Two harnesses, both driving **unmodified** upstream clients:

- `npm run verify:conformance` — a stock `@x402/fetch` client (`wrapFetchWithPayment`, no
  STELLARSIGHT code on the path) completes 402 → sign → settle → 200 and prints the settled
  hash.
- `npm run verify:api` — 46 checks driving the real `withBazaar()` client from
  `@x402/extensions` against the handlers, re-validating every `accepts` entry with
  `@x402/core`'s own `PaymentRequirementsSchema`.

This is not decoration. The conformance harness **caught a real drift in our own seller**:
it advertised `x402Version: 2` and answered 402 in the v1 wire format, so an unmodified
client threw while our own client — which carried a lenient fallback — did not. The fix was
to adopt the SDK codecs and delete the fallback so the bug cannot return quietly. The RFP
says drift, not inability, is the failure mode being screened for; this is the test that
screens for it.

---

## 6. The `upto` scheme (planned, Tranche 2)

### 6.1 Why there is no contract here yet

`exact` settles one fixed price quoted before the request. Metered services — token
billing, bandwidth, inference — need `upto`: the buyer authorizes a ceiling and the seller
settles only what was consumed. Discovery without metered pricing lists services an agent
cannot pay correctly, which is why this sits inside a discovery submission.

`upto` is **not solved on Stellar**, and the reason is visible in
[`stellar/x402-stellar#72`](https://github.com/stellar/x402-stellar/issues/72): at least four
independent implementations disagree on decisions that change what the client signs.

| Decision | Position A | Position B |
|---|---|---|
| Residual allowance after settling below the maximum | zeroed atomically | left to expire on its own ledger deadline |
| Zero-value settlement | submits a real transaction, consuming the nonce | submits nothing, to avoid a fee for a no-op |
| Rent and TTL responsibility | contract-side, monitored | operator-side |

Two of these produce observably different on-chain behaviour for the same logical payment. A
facilitator that assumes one and meets the other fails as a rejected settlement with a
generic reason, which is the worst kind of failure. Shipping a fifth incompatible contract
would add a data point, not a decision. Our full position is in
[upto-position.md](upto-position.md).

### 6.2 The contract we would ship

Deliberately minimal, because the audit surface should be one function:

```rust
// no admin, no upgrade path, no persistent storage, never holds a balance
fn settle_upto(env: Env, token: Address, payer: Address, pay_to: Address,
               max: i128, actual: i128) -> Result<(), Error>
```

- The payer signs `require_auth_for_args((token, pay_to, max))`. `actual` is supplied at
  settlement and is bounded by both the contract and the token allowance, so none of the
  recipient, the token or the ceiling can be changed after signing.
- `approve` is nested inside the payer's authorization tree; payout uses `transfer_from`, so
  funds move directly from payer to `pay_to` and the contract never holds a balance.
- Soroban consumes the authorization nonce when the call executes, so one signature settles
  once and cannot be replayed.
- **Three clocks, normatively ordered:** allowance expiration ≥ contract deadline ≥
  settlement time, all derived from the operator's advertised `maxTimeoutSeconds`.

Our bias, stated so it can be argued with: zero settlement **should** submit, because a
facilitator should never hold a live authorization it cannot invalidate; and the residual
**should** be zeroed atomically, because the payer's worst case should be bounded by the
transaction they signed rather than by an expiry they have to track.

### 6.3 What Tranche 2 delivers

The spec (`scheme_upto_stellar.md`) written against whatever the thread converges on and
opened upstream **before** the contract is funded, then the contract deployed to testnet and
integrated into `/verify` and `/settle`, with settled hashes published for the partial,
maximum and zero cases and a negative-test matrix covering above-maximum, altered recipient,
altered token, expired authorization, replay and unexpected sub-invocations.

Building it before mainnet is deliberate: the contract must be inside the audit scope, and
the audit gates mainnet.

---

## 7. Security and trust model

The full analysis is [THREAT-MODEL.md](THREAT-MODEL.md) — twelve threats, each with the
control that answers it and the test that proves it. Summary:

### 7.1 Trust boundaries

1. **Seller → facilitator.** Discovery metadata is attacker-controlled and echoed back
   inside payment payloads. Mitigated by the integrity validator (§3.4).
2. **Buyer → facilitator.** Payment payloads are attacker-controlled; all cryptographic
   validity is delegated to `@x402/stellar`, never reimplemented.
3. **Facilitator → Stellar.** Non-custodial by construction (§1.2).
4. **Catalog → agent.** Listing text is untrusted content, not instructions.

### 7.2 Risk register (abbreviated)

| Threat | Control today | Status |
|---|---|---|
| Path traversal in `routeTemplate` | decode-before-check, fixed-point, fail-closed | Tested |
| SSRF via `iconUrl` | host deny-list incl. IP literals in 3 bases | Tested |
| Catalog flooding | caps + soft-drop survival invariant | Tested |
| Listing hijack | bound to settled `payTo`; announce checks Host | **Partial** — no per-seller identity yet (T1) |
| Prompt injection via listing text | control chars stripped, lengths capped | **Partial** — no untrusted-content marking at the MCP boundary (T2) |
| Fee-payer drain | 500,000-stroop ceiling, refused at `/verify` | Ceiling yes, alerting no (T2) |
| Replay | Soroban nonce + `signatureExpirationLedger`, on-chain | Enforced by the ledger |
| Sequence contention as DoS | none | **Not defended** — measured (§2.6), fixed in T1 |
| Ranking manipulation | prior capped at 0.25; seeds pinned to 0 settlements | Gameable by real cheap settlements; stated |
| Store used to bypass validation | only post-validation records persisted | By construction |
| Store outage | read-only degradation + health reporting | Tested |
| Silent spec drift | stock-client conformance, nightly | Caught a real bug already |

### 7.3 Key management

One `FEEPAYER` secret in the deployment environment; the module derives the signer at load,
so a missing secret fails at boot rather than on the first settlement. No user keys are ever
held. Tranche 3 adds hardware-backed key storage, a documented rotation runbook, and
sponsor-account balance alerting before mainnet.

### 7.4 Residual risk, stated plainly

Bus factor of one, no external audit yet, testnet only, and a single shared write token that
is adequate for a demo catalog and inadequate for a public index with third-party sellers.
Each has a named mitigation and a tranche.

---

## 8. Monitoring and operations

[MONITORING.md](MONITORING.md) pairs every surface with a signal, a threshold and a
response, marking what runs today (✅) against what is funded work (⬜). The load-bearing
signals:

| Surface | Signal | Threshold |
|---|---|---|
| Settlement | success rate | < 95% over 15 min → page |
| Settlement | sequence-number failures | any, once the pool ships |
| Fee sponsorship | `FEEPAYER` balance | < 7 days of burn at trailing rate → page |
| Fee sponsorship | burn rate | > 3× trailing 24h median → possible drain |
| Catalog | store reachability | 2 consecutive failures → page |
| Catalog | soft-drop rate | > 20% of writes → probing or a broken seller |
| Search | nDCG@10 | > 0.02 below baseline → **build fails** (live today) |
| Conformance | nightly stock-client run | any failure → the RFP's named failure mode |

One severity split, because a solo maintainer with five severities has one severity: **page**
(fee-payer runway, settlement success, store unreachable, conformance failure) and **ticket**
(everything else).

Deliberately **not** monitored: per-payer behavioural profiling, and content moderation of
listings. Integrity validation is mechanical; judging what a service *is* would make the
facilitator an arbiter of what may be sold, which is the opposite of permissionless.

---

## 9. Deployment topology

### 9.1 Today

```
                    ┌───────────────────────────────────────────┐
   agents ─────────>│  stellarsight.xyz  (one origin)           │
   stock x402       │                                           │
   clients          │  /discovery/*  → packages/index           │──> Redis (durable catalog)
                    │  /supported /verify /settle → facilitator │──> Soroban RPC (testnet)
                    │  /v1/*         → reference seller         │──> Horizon (account reads)
                    └───────────────────────────────────────────┘
```

Serverless functions on Vercel; the discovery API, the facilitator and a real paid API answer
on the **same origin**, so discovery, payment and settlement are one deployment. Locally the
same modules bind to `:4021` (facilitator), `:4022` (index) and `:4023` (seller).

Two serverless caveats, stated rather than hidden: `/events` is SSE from a function, so a
stream ends when the function's clock does and the client reconnects; and `/settle` waits on
Stellar RPC, covered by `maxDuration` with room. Tranche 1 evaluates moving the settlement
path to a persistent host, and the cost is already in the budget.

### 9.2 What mainnet requires (Tranche 3)

Fail-closed startup unless the sponsor keys, the audited contract address, the asset
allowlist and measured fee ceilings are all configured. Two Soroban RPC providers with
failover. Circle USDC SAC as the launch asset. A public status page publishing 30 days of
uptime against a 99% target **with its exclusions stated** — planned maintenance and upstream
Stellar or RPC outages — because an availability number without exclusions is marketing.

### 9.3 Self-hosting

Apache-2.0 end to end, with **no AGPL anywhere in the dependency path** — which is why the
facilitator is self-hosted on `@x402/stellar` rather than depending on the OpenZeppelin
Channels relayer (AGPL-3.0-or-later, disqualifying for a permissively licensed project).
`npm install && npm run setup && npm run dev:all` reproduces the whole stack on testnet with
no faucet, no captcha and no API key.

---

## 10. Architecture mapped to the funded tranches

| Tranche | Architectural change | § |
|---|---|---|
| **T1** ($17,800, ~6 weeks) | Channel-account pool replaces the single fee-payer | §2.6 |
| | Per-seller identity: `payTo`/TOFU binding + ownership re-verification | §3.1, §7.2 |
| | Golden set to 150–200 queries + rolling live sample | §4.2 |
| | Wire shape locked by golden tests on all three surfaces | §3.2 |
| | Nightly stock-client conformance in public CI | §5.3 |
| **T2** ($26,700, ~12 weeks) | `upto` spec upstream, then the contract on testnet | §6 |
| | Monitoring plan becomes a running system with alerts | §8 |
| | CPU-only semantic layer, measured by the T1 harness | §4.3 |
| | Hosted HTTP MCP + TS/Go/Python adapter tests | §5.1 |
| | Auth-entry-shaped signer interface for smart accounts | §2.2 |
| **T3** ($35,600, mainnet ~month 4) | `stellar:pubnet` with Circle USDC | §9.2 |
| | 30 days measured uptime + public status page | §8 |
| | Security-review remediation (Audit Bank; fee excluded) | §7 |
| | Two reference integrations with real sellers | §3.1 |
| | Four months of post-launch operations | §8 |

---

## 11. Operating as a public good

**Decentralization.** The payment path is non-custodial and the correctness of a payment
never depends on trusting this operator (§1.2). Client helpers take a *list* of facilitators
with health checking rather than a single hardcoded operator, so adoption does not tie the
ecosystem to us. The whole stack is self-hostable, and the catalog's data model is the
spec's, not ours — a competing Bazaar can serve the same records.

**Privacy.** The catalog indexes *services*, not users. Operational metrics only:
settlement latency and success rate, catalog size, discovery query latency. No behavioural
profiling of payers, no usage data sold or shared. Payer addresses are already public
on-chain; nothing is aggregated into a dossier.

**Maintenance and stewardship.** Apache-2.0 from the first commit. Public CI that anyone can
run, on both Node versions the project claims to support. Tranche 3 funds four months of
post-launch operations and a handoff document naming the maintainer, the escalation path and
the responsibility boundary — because a service that dies when the grant ends is what the
RFP is trying to avoid. The failure mode the RFP screens for is drift as the spec moves, so
nightly conformance is scheduled to continue past the grant window.

---

## Appendix A — Verify this in 60 seconds

| Claim | Check | Time |
|---|---|---|
| Payments settle on Stellar | open any hash in [TESTNET-TXS.md](TESTNET-TXS.md) → `successful: true` | 10s |
| The buyer needs zero XLM | on that transaction, `fee_account` is the facilitator's FEEPAYER, not the payer | 15s |
| The catalog is live and durable | `curl -s https://stellarsight.xyz/discovery/health` → `mode=kv`, record counts, serving commit | 10s |
| Only real resources | `curl -s 'https://stellarsight.xyz/discovery/resources?seeded=false'` | 10s |
| Search is measured | `npm run eval:search` → nDCG@10 0.864, with the gate | 20s |
| Integrity is real | `npm test` → 151 tests, 66 adversarial | 30s |
| A stock client can pay us | `npm run verify:conformance` | 60s |
| The concurrency limit is real | `npm run load:baseline` | 2m |

## Appendix B — Repository map

| Path | What it is |
|---|---|
| `packages/index` | Catalog, BM25 ranker, integrity validator, wire projection, durable store |
| `packages/express` | Drop-in x402 paywall middleware for sellers (npm: `@stellarsight/express`) |
| `apps/facilitator` | Self-hosted x402 facilitator on `@x402/stellar`, fee sponsorship, settle-time cataloging |
| `apps/seller` | Reference paid API declaring discovery metadata |
| `apps/agent` | MCP server, payment client, narrated CLI (npm: `@stellarsight/agent`) |
| `apps/web` | Landing page and live console |
| `api/` | Vercel Functions — thin wrappers that import the modules above, never reimplement them |
| `scripts/` | Setup, demo loop, conformance harnesses, search evaluation, load baseline |
| `eval/` | Graded golden set, recorded baselines |
| `docs/` | This document, threat model, monitoring plan, search quality, `upto` position, testnet transactions |

---

*Apache-2.0 · Built in São Paulo, Brazil · [github.com/pedro-pelicioni/stellarsight](https://github.com/pedro-pelicioni/stellarsight)*
