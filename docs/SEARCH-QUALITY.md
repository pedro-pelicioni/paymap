# STELLARSIGHT — Search Quality

How the bazaar index decides what an agent sees, why it is built this way, and how we
would prove it works.

The catalog answers one question: *given a natural-language description of a capability,
which paid x402 resources on Stellar should an autonomous agent consider buying?* That
is a ranking problem, and ranking problems are only as good as the evidence behind them.
This document states the evidence we use, the exact arithmetic, and — importantly — the
places where we currently have no evidence at all.

---

## 1. Retrieval approach

**Lexical first, deliberately.** The index is field-weighted BM25 over an in-memory
inverted structure, with a small quality prior blended on top. There is no embedding
model, no vector store, no reranker.

That is a considered choice, not a shortcut:

- **The corpus is tiny and the documents are short.** A facilitator's catalog is
  hundreds to low thousands of entries, each a service name, a sentence of description,
  a handful of tags and a parameter list. BM25's term-saturation and length-normalization
  behaviour is well matched to short, keyword-dense technical text. Dense retrieval earns
  its keep on long, paraphrase-heavy documents; that is not this corpus yet.
- **The queries are largely nominal.** Agents search for capabilities by name: "exchange
  rate", "postal code lookup", "invoice OCR", "submit stellar transaction". Exact and
  near-exact term matching carries most of the signal.
- **Explainability is a product requirement, not a nicety.** An agent about to spend
  money should be able to see *why* a result was surfaced. Every number in the final
  score is an addend we can name and render. A bi-encoder cosine similarity is a single
  opaque float.
- **Zero-dependency, zero-latency, zero-cost.** The whole index rebuilds in milliseconds
  and runs inside the facilitator process. No model to host, no embeddings to invalidate
  when a publisher edits a description, no per-query inference cost on a service whose
  own transactions cost fractions of a cent.

Section 6 sets out what would change that calculus.

### Analysis pipeline

Applied identically to indexed documents and to queries — an analyzer mismatch is the
most common silent cause of bad recall:

1. **Casefold** and split `camelCase` boundaries (`toolName` → `tool name`), so
   identifier-style text is searchable as words.
2. **Accent folding**: NFD decomposition, then drop all combining marks (`café` → `cafe`,
   `Zürich` → `zurich`). This is text normalization, not a language feature — it removes
   a whole class of near-miss failures where indexed text and query spell the same word
   with different diacritics.
3. **Split** on any non-alphanumeric character (Unicode-aware).
4. **Stopword removal** against a curated English list.
5. **Light suffix stripping** — a deliberately conservative two-stage stemmer, not a
   full Porter implementation. It collapses the variants that actually matter in an API
   catalog (`price`/`prices`/`pricing` → `pric`, `query`/`queries` → `query`,
   `translate`/`translation` → `translat`, `transaction`/`transactions` → `transact`)
   and leaves everything else alone. Aggressive stemming trades precision for recall;
   on a corpus this small, precision is worth more.

### Field weighting

Rather than implement full BM25F, each field's tokens are **repeated** in the document
bag according to its weight. This raises term frequency for high-value fields *and*
raises document length proportionally, so a long description cannot cheaply out-rank a
precise service-name match — the standard "BM25F-lite" approximation.

| Field | Weight | Rationale |
|---|---:|---|
| `resource.serviceName` | **3** | The publisher's own one-line answer to "what is this". Highest precision per token. |
| `resource.description` | **2** | Rich but noisy; long enough that length normalization matters. |
| `resource.tags` | **2** | Curated, low-noise, but capped at 5 entries by the spec. |
| Parameter names + per-parameter descriptions | **2** | Strong capability signal: an endpoint taking `cep` is a postal-code endpoint regardless of how it is described. |
| `output.format` | **1** | Weak but real: distinguishes `quote` from `timeseries` from `transcript`. |
| URL path segments + `input.toolName` | **1** | Free signal, but path segments are noisy and easily gamed by a publisher choosing a keyword-stuffed path. |

---

## 2. The scoring formula

All constants live in `RANK_WEIGHTS` and `FIELD_WEIGHTS` in
`packages/index/src/rank.mjs` and are tunable without touching code.

### Relevance

Standard Okapi BM25, **k1 = 1.2**, **b = 0.75**:

```
idf(t)  = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))

bm25    = Σ  idf(t) · ( tf(t,d) · (k1 + 1) )
        t∈q         ─────────────────────────────────────────
                    tf(t,d) + k1 · (1 - b + b · |d| / avgdl)
```

where `tf` and `|d|` are computed over the **field-weighted** bag described above.

BM25 is unbounded, so it is squashed into `0..1` before blending:

```
bm25Norm = bm25 / (bm25 + BM25_SATURATION)      BM25_SATURATION = 6.0
```

Saturation rather than max-normalization is intentional: dividing by the best score in
the result set makes scores incomparable across queries and makes the top hit always
1.0, which destroys the ability to say "nothing here is a good match".

### Quality prior

Three signals, each normalized to `0..1`:

```
completeness = mean( hasDescription,          // description present, ≥ 20 chars
                     hasOutputSchema,          // output.format | example | schema
                     paramsDocumented,         // fraction of params carrying a description
                                               //   (no params → 1, nothing to document)
                     hasTags,                  // ≥ 1 tag survived validation
                     hasIconUrl )              // icon survived validation

popularity   = min(1, log1p(settlements) / log1p(POPULARITY_REFERENCE))
                                               // POPULARITY_REFERENCE = 5000

recency      = 0.5 ^ (ageDays / RECENCY_HALF_LIFE_DAYS)
                                               // RECENCY_HALF_LIFE_DAYS = 14
                                               // ageDays from lastSeenAt; never seen → 365
```

### The blend

```
_score = 1.00 · bm25Norm
       + 0.12 · completeness
       + 0.08 · popularity
       + 0.05 · recency
```

**The single most important property of these weights is their ratio.** The quality
prior contributes at most **0.25** against a relevance term worth up to **1.00**. Quality
is a tie-breaker between comparably relevant results — it can reorder near-neighbours,
and it can never let a popular, fresh, beautifully documented resource outrank one that
actually answers the query. `test/catalog-integrity.test.mjs` asserts exactly this: a
resource with 900,000 settlements loses to a zero-settlement, 200-day-stale resource when
the query matches the latter.

Within the prior, completeness is weighted highest (0.12) and recency lowest (0.05),
because completeness is the only one of the three that is (a) available on day one and
(b) expensive for a spammer to fake convincingly. See §5.

The blend is linear and every addend is exposed in `_explain.parts`, so the four numbers
always sum to `_score` — a test asserts this too. Nothing is hidden.

---

## 3. Why `_explain` exists

`scoreHybrid` attaches a full breakdown to every result: the analyzed query terms, per-term
`tf` / `df` / `idf` / contribution, which fields matched, each quality sub-score with its
inputs, and the four weighted parts. The console renders it.

This is not debug output that leaked into the API. When an agent is choosing where to
spend, "this ranked first because your query term *invoice* is rare in the catalog (idf
4.1) and appears in its service name and tags" is materially different information from
"score: 0.83". It also makes ranking regressions diagnosable in production without a
reproduction harness.

---

## 4. How this would be evaluated

The honest status: **there is no labeled evaluation set yet, so there are no quality
numbers to report.** What follows is the methodology we would run, not results we claim.

### Building the judgement set

Ranking cannot be evaluated without relevance labels, and the expensive part is the
labels, not the metrics.

1. **Harvest real queries.** Log every `/discovery/search` query with its result set and
   which result (if any) the agent subsequently paid. Target ~200 distinct queries
   spanning head ("exchange rate") and tail ("signed oracle price feed for a Soroban
   contract").
2. **Pool candidates.** For each query, union the top 20 from BM25-only, from
   completeness-only, and from a random sample. Pooling avoids the trap of only ever
   labeling what the current ranker already returns, which silently caps measured recall
   at whatever the incumbent achieves.
3. **Label graded relevance**, 0–3: 3 = directly answers the need; 2 = usable with
   adaptation; 1 = same domain, wrong capability; 0 = irrelevant. Graded rather than
   binary because nDCG needs gradations and because "same domain, wrong capability" is
   the failure mode that actually costs an agent money.
4. **Two annotators, measure agreement** (Cohen's κ). Below κ ≈ 0.6 the guidelines are
   ambiguous and the labels are not yet worth measuring against.

### Metrics

| Metric | What it answers | Why this one |
|---|---|---|
| **nDCG@10** | Is the *ordering* of the first page good? | Primary metric. Graded and position-discounted — matches how an agent actually consumes results. |
| **Recall@20** | Did we retrieve the right thing *at all*? | Separates retrieval failure from ranking failure. A low Recall@20 with healthy nDCG@10 means the analyzer is dropping matches; no amount of reranking fixes that. |
| **MRR** | How deep is the first correct answer? | The closest proxy for the agentic use case, where a client typically takes the top result and pays. |

Report per-query distributions, not just means. A mean nDCG of 0.7 hiding a cluster of
0.0 queries is a broken analyzer, and the mean will not tell you.

### Regression discipline

The judgement set becomes a fixture; nDCG@10 and Recall@20 run in CI against it. Any
weight change ships with its before/after delta. Tuning `RANK_WEIGHTS` by eyeballing a
demo query is how ranking systems quietly rot.

### Ablations worth running first

Each blend weight should have to justify itself: relevance-only, +completeness,
+popularity, +recency, and full. If a signal does not move nDCG@10 beyond noise, it is
complexity with no return and should be set to zero.

---

## 5. The cold-start problem — stated honestly

**Two of the three quality signals are worthless on day one, and one of them is
adversarial forever.**

### Usage signals are absent at launch

`settlements` is zero for every resource in a new catalog, so `popularity` is a constant
0 and contributes nothing but a uniform offset. `recency` is barely better: at launch
every resource was seen within the same short window, so the signal has almost no
variance. A ranker leaning on usage data has, on day one, no quality signal at all.

This is why `completeness` carries the largest weight in the prior. It is computable from
the very first `PaymentRequired` response the facilitator observes, it correlates with
publisher care, and it degrades gracefully — a resource with a description but no icon
scores between one with everything and one with nothing.

### Usage signals are gameable forever

`settlements` counts *observed settled payments*. A publisher can pay themselves. On a
network where a settlement costs a fraction of a cent and fees may be sponsored, buying
5,000 self-settlements to saturate `POPULARITY_REFERENCE` is cheap. The current weight
(0.08, capped) bounds the damage — a fully gamed popularity score buys at most 0.08 of
score, which cannot overcome a genuine relevance gap — but bounding an attack is not
defeating it.

Mitigations we have **not** implemented, in the order we would implement them:

1. **Count distinct payers, not payments.** `log1p(uniquePayers)` in place of
   `log1p(settlements)`. Raises the cost of self-dealing from *N* payments to *N*
   funded accounts.
2. **Discount payer concentration.** If one account is 90% of a resource's settlements,
   damp the signal — this is the Gini/entropy trick from ad click-fraud detection.
3. **Require payer account age or minimum balance** before a settlement counts toward
   popularity. Makes sybils cost real lumens, not just fees.
4. **Cap per-payer contribution per window.** A single account contributes at most a
   fixed amount of popularity credit per day regardless of volume.

### Completeness is gameable too, more mildly

A publisher can stuff `description` with keywords to farm both the completeness bonus and
BM25 term frequency. Three things blunt this: BM25's `b = 0.75` length normalization
penalizes padded documents; the spec's own caps (`serviceName` ≤ 32 chars, ≤ 5 tags)
limit the highest-weighted fields; and completeness is measured as *presence*, not
length, so the marginal return on a longer description is zero. The remaining exposure —
a genuinely long, keyword-dense, technically-accurate description — is difficult to
distinguish from a good description, which is the correct outcome.

### The honest summary

On day one this is a **lexical relevance engine with a documentation-quality
tie-breaker**. It is not a learned ranker and should not be described as one. The usage
signals are plumbed in, bounded, and ready to become meaningful once there is real
traffic — and they are deliberately weighted low enough that when they are wrong or
manipulated, they are wrong at the margins.

---

## 6. What we would measure and build next

In priority order, each with the observation that would trigger it:

1. **Ship the judgement set.** Everything below is unfalsifiable without it. This is
   the single highest-value next step.
2. **Click/pay-through logging.** Log `(query, ranked result ids, which id was paid)`.
   This is both the raw material for labels and, eventually, training data. It costs
   almost nothing to start and cannot be backfilled — every day it is not running is a
   day of evidence permanently lost.
3. **Query-level failure triage.** Bucket zero-result and zero-payment queries. These
   fall into distinct fixable classes: vocabulary mismatch (the user says "forex", the
   catalog says "exchange rate"), missing capability (a real gap in the catalog, which is
   *product* intelligence about what to recruit), and analyzer bugs.
4. **Synonym expansion before embeddings.** A hand-curated synonym map for the vocabulary
   mismatch cases (`forex`↔`fx`↔`exchange rate`, `postal code`↔`zip`↔`CEP`) is cheap,
   debuggable, and typically recovers most of what dense retrieval would — at a fraction
   of the operational cost. Trigger: vocabulary mismatch dominating the failure buckets.
5. **Hybrid dense retrieval, if and only if the data says so.** If, after synonyms,
   Recall@20 is still capped by lexical mismatch, add a bi-encoder over
   `serviceName + description + tags` and fuse with BM25 via Reciprocal Rank Fusion
   (RRF is preferable to score interpolation: no score calibration, no per-query tuning).
   Trigger: Recall@20 below ~0.85 with the failures concentrated in paraphrase.
6. **Learning-to-rank, at scale.** With enough labeled pairs, a small LambdaMART model
   over the existing features plus the usage signals. This is a real option only once
   the judgement set and traffic logs exist — which is why they are items 1 and 2.
7. **Price and reliability as ranking features.** An agent choosing where to spend cares
   about `maxAmountRequired` and about whether the endpoint actually settles. Uptime and
   settlement-success-rate are observable by the facilitator for free and are far harder
   to fake than settlement count, because failures are observed by the facilitator rather
   than reported by the publisher. This is probably the most under-exploited signal
   available.

---

## Appendix — where the code lives

| Concern | File |
|---|---|
| Analyzer, BM25, quality prior, `scoreHybrid`, `_explain` | `packages/index/src/rank.mjs` |
| Catalog, MCP tuple keying, filters, cursor pagination | `packages/index/src/index.mjs` |
| Trust-boundary validation (soft drop) | `packages/index/src/integrity.mjs` |
| `GET /discovery/resources`, `GET /discovery/search` | `packages/index/src/http.mjs` |
| Demo catalog with deliberately varied completeness | `packages/index/src/seed.mjs` |
| Adversarial test suite | `test/catalog-integrity.test.mjs` |
