/**
 * packages/index/src/rank.mjs — hybrid lexical ranking for the STELLARSIGHT bazaar index.
 * STELLARSIGHT: find what to pay for on Stellar.
 *
 * This is a real retrieval implementation, not a substring filter:
 *
 *   1. Field-weighted BM25 (Okapi, k1 = 1.2, b = 0.75) over a bag-of-tokens built by
 *      repeating each field's tokens `FIELD_WEIGHTS[field]` times. Repetition is the
 *      standard "BM25F-lite" trick: it raises tf for high-value fields AND raises the
 *      document length, so a long description cannot cheaply out-rank a precise
 *      serviceName match.
 *   2. A text analyzer: casefold -> Unicode accent folding -> camelCase split ->
 *      non-alphanumeric split -> stopword removal -> light two-pass suffix stripping.
 *      Accent folding is correct text normalization for any script and makes retrieval
 *      robust: a query matches regardless of diacritics.
 *   3. A quality prior blended on top of relevance: metadata completeness, log1p usage,
 *      and exponential recency decay.
 *
 * The blend is deliberately LINEAR over 0..1 components so that `_explain` is directly
 * renderable in a UI — every number below is a real addend of the final score.
 *
 * ─── SCORING FORMULA (exact) ────────────────────────────────────────────────────────
 *
 *   bm25Norm    = bm25 / (bm25 + BM25_SATURATION)          // 0..1, saturating
 *   completeness= mean(description, outputSchema, paramDocs, tags, iconUrl)   // 0..1
 *   popularity  = min(1, log1p(settlements) / log1p(POPULARITY_REFERENCE))    // 0..1
 *   recency     = 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS)                   // 0..1
 *
 *   _score = W.relevance    * bm25Norm
 *          + W.completeness * completeness
 *          + W.popularity   * popularity
 *          + W.recency      * recency
 *
 * With the default weights the quality prior can contribute at most 0.25 against a
 * relevance term worth up to 1.00. That is intentional: usage and freshness are
 * TIE-BREAKERS between comparably relevant results, never a way for a popular but
 * irrelevant resource to win. See docs/SEARCH-QUALITY.md for the rationale and for the
 * honest discussion of why `settlements` is gameable and absent on day one.
 */

/** Tunable knobs. Mutate this object (or pass `opts.weights`) to retune without edits. */
export const RANK_WEIGHTS = {
  // BM25 parameters
  k1: 1.2,
  b: 0.75,

  // Blend weights (addends of the final score)
  relevance: 1.0,
  completeness: 0.12,
  popularity: 0.08,
  recency: 0.05,

  // Normalisation constants
  BM25_SATURATION: 6.0, // bm25/(bm25+k): 6.0 puts a "good" 2-term match around ~0.5
  POPULARITY_REFERENCE: 5000, // settlements count that saturates the popularity signal
  RECENCY_HALF_LIFE_DAYS: 14, // a resource unseen for 14 days keeps half its recency credit
};

/**
 * Field boosts. Tokens from each field are repeated this many times in the document
 * bag before BM25 runs.
 */
export const FIELD_WEIGHTS = {
  serviceName: 3,
  description: 2,
  tags: 2,
  params: 2, // param names + per-param descriptions
  outputFormat: 1,
  url: 1, // url path segments
};

/* ────────────────────────────── analyzer ────────────────────────────── */

/** English stopwords, stored lowercase and accent-folded to match analyzer output. */
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'on', 'in', 'to', 'for', 'with',
  'at', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do',
  'does', 'did', 'have', 'has', 'had', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'this', 'that', 'these', 'those', 'my', 'your', 'its', 'not', 'no', 'so', 'than',
  'then', 'there', 'here', 'what', 'which', 'who', 'whom', 'how', 'when', 'where',
  'why', 'all', 'any', 'some', 'can', 'could', 'will', 'would', 'should', 'may',
  'might', 'must', 'get', 'me', 'us', 'them', 'about', 'into', 'over', 'under',
  'out', 'up', 'down', 'again', 'more', 'most', 'other', 'such', 'only', 'own',
  'same', 'too', 'very', 'just', 'want', 'need', 'give', 'let', 'via', 'per',
]);

/**
 * Normalize accented characters so queries match regardless of diacritics.
 * Decompose to NFD and drop the combining marks: "café" -> "cafe", "Zürich" -> "zurich".
 * This is correct text normalization for any script, not a per-language feature — it
 * removes a whole class of near-miss failures where the indexed text and the query
 * spell the same word with different diacritics.
 */
export function foldAccents(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
}

/** Casefold + camelCase split + accent folding. Exported for tests and debugging. */
export function normalizeText(text) {
  return foldAccents(String(text ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')).toLowerCase();
}

/**
 * Light two-pass suffix stripping. Not a full Porter stemmer — deliberately
 * conservative, tuned so that the variants that actually matter in an API catalog
 * collapse onto one term:
 *   price/prices/pricing -> pric, query/queries -> query,
 *   translate/translation -> translat, transaction/transactions -> transact.
 */
export function stem(token) {
  let t = token;
  if (t.length <= 3) return t;

  // Stage A — plural endings, applied twice ("addresses" -> "address" -> "addres")
  for (let pass = 0; pass < 2; pass++) {
    const n = t.length;
    if (n > 5 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
    else if (n > 4 && t.endsWith('es')) t = t.slice(0, -2);
    else if (n > 4 && t.endsWith('s')) t = t.slice(0, -1);
    else break;
  }

  // Stage B — derivational endings
  const n = t.length;
  if (n > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (n > 5 && t.endsWith('ion')) t = t.slice(0, -3);
  else if (n > 5 && t.endsWith('ed')) t = t.slice(0, -2);
  else if (n > 5 && t.endsWith('ly')) t = t.slice(0, -2);

  // Stage C — trailing silent "e" so price/pricing/prices all land on "pric"
  if (t.length > 4 && t.endsWith('e')) t = t.slice(0, -1);

  return t;
}

/** Full analyzer: text -> array of index terms. */
export function tokenize(text) {
  const raw = normalizeText(text).split(/[^\p{L}\p{N}]+/u);
  const out = [];
  for (const r of raw) {
    if (!r) continue;
    if (r.length === 1 && !/\d/.test(r)) continue; // single letters carry no signal
    if (STOPWORDS.has(r)) continue;
    out.push(stem(r));
  }
  return out;
}

/* ────────────────────────── document construction ────────────────────────── */

/** Pull `{ name, description }` pairs out of a JSON Schema `properties` map. */
function schemaParams(schema) {
  const params = [];
  if (!schema || typeof schema !== 'object') return params;
  const props = schema.properties;
  if (props && typeof props === 'object') {
    for (const [name, def] of Object.entries(props)) {
      params.push({
        name,
        description: def && typeof def === 'object' && typeof def.description === 'string' ? def.description : '',
      });
    }
  }
  return params;
}

/**
 * Every input parameter we can see, with its description when documented.
 * Sources: JSON Schema (`input.inputSchema` for MCP, `input.schema` for HTTP) and the
 * bare example objects (`queryParams`, `body`, `pathParams`) which give names only.
 */
export function paramsOf(rec) {
  const input = rec?.input ?? {};
  const byName = new Map();
  for (const p of [...schemaParams(input.inputSchema), ...schemaParams(input.schema)]) {
    byName.set(p.name, p);
  }
  for (const bag of [input.queryParams, input.body, input.pathParams]) {
    if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
      for (const name of Object.keys(bag)) if (!byName.has(name)) byName.set(name, { name, description: '' });
    }
  }
  return [...byName.values()];
}

/** Tokenized per-field view of a record. Exported so the UI can highlight matches. */
export function buildFields(rec) {
  const res = rec?.resource ?? {};
  const params = paramsOf(rec);

  let urlPath = '';
  try {
    urlPath = new URL(res.url).pathname;
  } catch {
    urlPath = String(res.url ?? '');
  }

  return {
    serviceName: tokenize(res.serviceName ?? ''),
    description: tokenize(res.description ?? rec?.input?.description ?? ''),
    tags: tokenize(Array.isArray(res.tags) ? res.tags.join(' ') : ''),
    params: tokenize(params.map((p) => `${p.name} ${p.description}`).join(' ')),
    outputFormat: tokenize(`${rec?.output?.format ?? ''} ${rec?.output?.type ?? ''}`),
    url: tokenize(`${urlPath} ${rec?.input?.toolName ?? ''}`),
  };
}

/**
 * Metadata completeness, 0..1 — the mean of five components. This is the signal that
 * rewards publishers who actually document their endpoint, and it is the ONLY quality
 * signal available on a cold catalog (see docs/SEARCH-QUALITY.md).
 */
export function completenessOf(rec) {
  const res = rec?.resource ?? {};
  const params = paramsOf(rec);
  const documented = params.filter((p) => p.description && p.description.length >= 3).length;

  const detail = {
    description: typeof res.description === 'string' && res.description.trim().length >= 20 ? 1 : 0,
    outputSchema: rec?.output && (rec.output.format || rec.output.example || rec.output.schema) ? 1 : 0,
    // No params to document counts as satisfied; otherwise it is the documented fraction.
    paramDocs: params.length === 0 ? 1 : documented / params.length,
    tags: Array.isArray(res.tags) && res.tags.length > 0 ? 1 : 0,
    iconUrl: typeof res.iconUrl === 'string' && res.iconUrl.length > 0 ? 1 : 0,
  };
  const score = (detail.description + detail.outputSchema + detail.paramDocs + detail.tags + detail.iconUrl) / 5;
  return { score, detail };
}

/* ─────────────────────────────── BM25 core ─────────────────────────────── */

function weightedBag(fields, fieldWeights) {
  const tf = new Map();
  const fieldsByTerm = new Map();
  let length = 0;
  for (const [field, tokens] of Object.entries(fields)) {
    const w = fieldWeights[field] ?? 1;
    if (w <= 0) continue;
    for (const tok of tokens) {
      tf.set(tok, (tf.get(tok) ?? 0) + w);
      length += w;
      let s = fieldsByTerm.get(tok);
      if (!s) fieldsByTerm.set(tok, (s = new Set()));
      s.add(field);
    }
  }
  return { tf, length, fieldsByTerm };
}

/**
 * Build a reusable inverted-index-ish structure over `docs`. `createCatalog` caches
 * this between searches and invalidates it on upsert.
 */
export function buildIndex(docs, opts = {}) {
  const fieldWeights = { ...FIELD_WEIGHTS, ...(opts.fieldWeights ?? {}) };
  const entries = docs.map((doc) => {
    const fields = buildFields(doc);
    const { tf, length, fieldsByTerm } = weightedBag(fields, fieldWeights);
    return { doc, fields, tf, length, fieldsByTerm, completeness: completenessOf(doc) };
  });

  const df = new Map();
  for (const e of entries) for (const term of e.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);

  const totalLen = entries.reduce((a, e) => a + e.length, 0);
  return { entries, df, N: entries.length, avgdl: entries.length ? totalLen / entries.length : 0, fieldWeights };
}

/**
 * scoreHybrid(query, docs) -> ranked copies of `docs` carrying `_score` and `_explain`.
 *
 * - Empty query: every doc is returned, ordered by the quality prior alone.
 * - Non-empty query: only docs matching >= 1 query term are returned (BM25 recall set).
 *
 * `_explain` is a full breakdown — the UI renders it so a user can SEE why something
 * ranked where it did.
 *
 * @param {string} query
 * @param {object[]} docs   records in the CONTRACT.md shape
 * @param {object} [opts]   { weights, fieldWeights, now, index }
 */
export function scoreHybrid(query, docs, opts = {}) {
  const W = { ...RANK_WEIGHTS, ...(opts.weights ?? {}) };
  const now = opts.now ?? Date.now();
  const index = opts.index ?? buildIndex(docs, opts);
  const { df, N, avgdl } = index;

  const qTerms = [...new Set(tokenize(query ?? ''))];
  const hasQuery = qTerms.length > 0;

  const out = [];
  for (const e of index.entries) {
    // ── relevance ──
    let bm25 = 0;
    const termExplain = [];
    const matchedFields = new Set();
    for (const term of qTerms) {
      const tf = e.tf.get(term);
      if (!tf) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const denom = tf + W.k1 * (1 - W.b + W.b * (avgdl ? e.length / avgdl : 1));
      const contribution = idf * ((tf * (W.k1 + 1)) / denom);
      bm25 += contribution;
      termExplain.push({
        term,
        tf,
        df: n,
        idf: round(idf),
        contribution: round(contribution),
        fields: [...(e.fieldsByTerm.get(term) ?? [])],
      });
      for (const f of e.fieldsByTerm.get(term) ?? []) matchedFields.add(f);
    }

    if (hasQuery && termExplain.length === 0) continue; // not in the recall set

    // ── quality prior ──
    const settlements = Math.max(0, Number(e.doc.settlements ?? 0) || 0);
    const popularity = Math.min(1, Math.log1p(settlements) / Math.log1p(W.POPULARITY_REFERENCE));

    const lastSeenAt = Number(e.doc.lastSeenAt ?? 0) || 0;
    const ageDays = lastSeenAt ? Math.max(0, (now - lastSeenAt) / 86_400_000) : 365;
    const recency = Math.pow(0.5, ageDays / W.RECENCY_HALF_LIFE_DAYS);

    const bm25Norm = bm25 / (bm25 + W.BM25_SATURATION);

    const parts = {
      relevance: W.relevance * bm25Norm,
      completeness: W.completeness * e.completeness.score,
      popularity: W.popularity * popularity,
      recency: W.recency * recency,
    };
    const score = parts.relevance + parts.completeness + parts.popularity + parts.recency;

    termExplain.sort((a, b) => b.contribution - a.contribution);

    out.push({
      ...e.doc,
      _score: round(score),
      _explain: {
        query: qTerms,
        bm25: round(bm25),
        bm25Norm: round(bm25Norm),
        terms: termExplain.slice(0, 8),
        matchedFields: [...matchedFields],
        quality: {
          completeness: round(e.completeness.score),
          completenessDetail: e.completeness.detail,
          popularity: round(popularity),
          settlements,
          recency: round(recency),
          ageDays: round(ageDays, 2),
        },
        parts: {
          relevance: round(parts.relevance),
          completeness: round(parts.completeness),
          popularity: round(parts.popularity),
          recency: round(parts.recency),
        },
        weights: {
          relevance: W.relevance,
          completeness: W.completeness,
          popularity: W.popularity,
          recency: W.recency,
          k1: W.k1,
          b: W.b,
          fieldWeights: index.fieldWeights,
        },
      },
    });
  }

  // Deterministic ordering: score desc, then settlements desc, then id asc.
  out.sort(
    (a, b) =>
      b._score - a._score ||
      (b.settlements ?? 0) - (a.settlements ?? 0) ||
      String(a.id).localeCompare(String(b.id)),
  );
  return out;
}

function round(n, digits = 4) {
  const f = 10 ** digits;
  return Math.round((Number.isFinite(n) ? n : 0) * f) / f;
}

export default { scoreHybrid, buildIndex, tokenize, stem, completenessOf, RANK_WEIGHTS, FIELD_WEIGHTS };
