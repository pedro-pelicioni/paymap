import fixtureRaw from '../data/fixture.json'
import txsRaw from '../data/testnet-txs.json'
import integrityRaw from '../data/integrity.json'
import { rank } from './rank'
import type {
  Catalog,
  Explain,
  ExplainKey,
  IntegrityEntry,
  IntegrityProvenance,
  StarsightRecord,
  TxEntry,
  WireRecord,
} from './types'

/**
 * Where the discovery API lives.
 *
 *   VITE_INDEX_URL set  -> exactly that, always (an explicit override wins everywhere,
 *                          and `VITE_INDEX_URL=""` is a legal way to force same-origin).
 *   production build    -> '' — a same-origin RELATIVE base. The deployed site serves
 *                          /discovery/* itself from api/discovery/*.mjs, so the console
 *                          goes LIVE against its own origin with nothing to configure
 *                          and no CORS hop.
 *   dev server          -> http://localhost:4022, the port CONTRACT.md pins the index to.
 *
 * If the API is unreachable in either case, `loadCatalog`/`search` still fall back to the
 * baked fixture and the pill reads DEMO. That path is unchanged.
 */
const CONFIGURED_INDEX_URL = import.meta.env.VITE_INDEX_URL as string | undefined

export const INDEX_URL: string =
  typeof CONFIGURED_INDEX_URL === 'string'
    ? CONFIGURED_INDEX_URL.replace(/\/$/, '')
    : import.meta.env.PROD
      ? ''
      : 'http://localhost:4022'

export const ASSET_CODE = 'SXT'

/**
 * A local index answers in single-digit milliseconds, so 1.4s is generous. A serverless
 * cold start is not: the first request after an idle period pays for module load plus
 * seeding the catalog. Being too impatient there would show DEMO on a site that is
 * actually LIVE, so production gets a longer leash.
 */
const TIMEOUT_MS = import.meta.env.PROD ? 4000 : 1400

async function getJSON(path: string): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${INDEX_URL}${path}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The index (or another agent's fixture) may hand us several shapes. Take them all.
 *
 * `resources` comes FIRST deliberately: the two discovery envelopes differ on purpose —
 * `SearchDiscoveryResourcesResponse` names the array `resources` while
 * `DiscoveryResourcesResponse` names it `items`. STARSIGHT's search endpoint currently
 * emits both (`items` is a deprecated duplicate alias of the same array for one
 * release), so preferring `resources` reads the spec key wherever it exists and falls
 * back to `items` for the list endpoint and the baked fixture.
 */
function pickItems(payload: unknown): WireRecord[] {
  if (Array.isArray(payload)) return payload as WireRecord[]
  const o = (payload ?? {}) as Record<string, unknown>
  for (const key of ['resources', 'items', 'records', 'results', 'data']) {
    const v = o[key]
    if (Array.isArray(v)) return v as WireRecord[]
  }
  return []
}

function pickIntegrity(payload: unknown): IntegrityEntry[] {
  const o = (payload ?? {}) as Record<string, unknown>
  for (const key of ['integrity', 'rejected', 'dropped', 'items']) {
    const v = o[key]
    if (Array.isArray(v) && v.length && typeof (v[0] as IntegrityEntry)?.rule === 'string') {
      return v as IntegrityEntry[]
    }
  }
  return []
}

/* ------------------------------------------------------------------ _explain */

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const round = (n: number, dp: number): number => {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const PART_KEYS: ExplainKey[] = ['bm25', 'metadata', 'settlements', 'recency']

/**
 * The index speaks its own `_explain` dialect: `parts` is an *object*
 * (`{relevance, completeness, popularity, recency}`), each term carries
 * `contribution` plus a `fields` array, and there is no `total` at all. The
 * board renders the local ranker's dialect: `parts` as an ordered array of
 * `{key, value, detail}` and terms with a single `field`/`weight`.
 *
 * Translating here — at the edge — means nothing downstream has to know which
 * ranker produced a row. The index knows strictly more than the local ranker
 * (true corpus-wide `df`, every field a term hit, the exact k1/b in force), so
 * the live path renders a richer panel than the fallback, not a poorer one.
 */
function normalizeTerms(raw: unknown): Explain['terms'] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((t) => {
      const o = obj(t)
      const fields = Array.isArray(o.fields) ? o.fields.map((f) => String(f)).filter(Boolean) : []
      const field =
        (typeof o.field === 'string' && o.field) || fields.join(' + ') || 'unscored field'
      // the index calls it `contribution`; the local ranker calls it `weight`
      const weight = num(o.weight, num(o.contribution))
      const term: Explain['terms'][number] = {
        term: String(o.term ?? ''),
        field,
        tf: round(num(o.tf), 2),
        idf: round(num(o.idf), 2),
        weight: round(weight, 3),
      }
      if (typeof o.df === 'number' && Number.isFinite(o.df)) term.df = o.df
      return term
    })
    .filter((t) => t.term)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
}

/**
 * Returns `undefined` when there is nothing usable, so the caller can fall back
 * to the local ranker. Every field is optional on the way in: a missing signal
 * degrades to zero rather than throwing.
 */
function normalizeExplain(raw: unknown, score?: unknown): Explain | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const ex = raw as Record<string, unknown>

  // Already the board's dialect (local ranker, or an index that adopted it).
  if (Array.isArray(ex.parts)) {
    const parts = ex.parts.map((p) => {
      const o = obj(p)
      return {
        key: (PART_KEYS.includes(o.key as ExplainKey) ? o.key : String(o.key ?? '')) as ExplainKey,
        value: num(o.value),
        detail: String(o.detail ?? ''),
      }
    })
    const summed = parts.reduce((a, p) => a + p.value, 0)
    return {
      total: num(ex.total, summed || num(score)),
      parts,
      terms: normalizeTerms(ex.terms),
    }
  }

  const sParts = obj(ex.parts)
  const quality = obj(ex.quality)
  const weights = obj(ex.weights)
  const detail = obj(quality.completenessDetail)
  const matched = Array.isArray(ex.matchedFields)
    ? ex.matchedFields.map((f) => String(f)).filter(Boolean)
    : []

  const bm25 = num(ex.bm25)
  const bm25Norm = num(ex.bm25Norm)
  const filled = Object.keys(detail).filter((k) => num(detail[k]) >= 1)
  const missing = Object.keys(detail).filter((k) => num(detail[k]) < 1)
  const settlements = num(quality.settlements)
  const ageDays = num(quality.ageDays)

  const parts: Explain['parts'] = [
    {
      key: 'bm25',
      value: num(sParts.relevance),
      detail: bm25
        ? `BM25 ${bm25.toFixed(2)} → ${bm25Norm.toFixed(3)} norm · k1=${num(weights.k1, 1.2)} b=${num(weights.b, 0.75)}${matched.length ? ` · hit ${matched.join(', ')}` : ''}`
        : 'no query terms matched — text contributes nothing',
    },
    {
      key: 'metadata',
      value: num(sParts.completeness),
      detail: Object.keys(detail).length
        ? `${filled.length}/${Object.keys(detail).length} complete${missing.length ? ` · missing ${missing.join(', ')}` : ' — advertisement complete'}`
        : `completeness ${num(quality.completeness).toFixed(2)}`,
    },
    {
      key: 'settlements',
      value: num(sParts.popularity),
      detail: `${settlements.toLocaleString('en-US')} settlements observed → ${num(quality.popularity).toFixed(3)} log-scaled`,
    },
    {
      key: 'recency',
      value: num(sParts.recency),
      detail: `last seen ${ageDays < 0.05 ? 'today' : `${ageDays.toFixed(2)} d ago`} · decay ${num(quality.recency).toFixed(3)}`,
    },
  ]

  const summed = parts.reduce((a, p) => a + p.value, 0)
  return { total: round(summed || num(score), 4), parts, terms: normalizeTerms(ex.terms) }
}

/**
 * Guard against a partly-filled record so one bad row can never blank the board, and
 * collapse the two wire shapes onto one.
 *
 * The spec `DiscoveryResource` puts the URL in `resource` as a plain STRING, the
 * presentation fields at the top level, and the money in `accepts[0]` — where x402 v2
 * `PaymentRequirements` calls the price `amount`, not `maxAmountRequired`. The fixture
 * (and any pre-projection record) uses the old block shape. Read whichever is there.
 */
function sane(r: WireRecord): StarsightRecord {
  const block = r?.resource && typeof r.resource === 'object' ? r.resource : undefined
  const url =
    (typeof r?.resource === 'string' ? r.resource : block?.url) || r?.id || 'unknown://resource'

  const offer = Array.isArray(r?.accepts) ? (r.accepts[0] ?? {}) : {}
  const tags = r?.tags ?? block?.tags
  // `lastUpdated` is ISO 8601 (spec); `lastSeenAt` is epoch ms (STARSIGHT-native).
  const seenAt =
    Number(r?.lastSeenAt) || (r?.lastUpdated ? Date.parse(r.lastUpdated) : NaN) || Date.now()

  const extensions = Array.isArray(r?.extensions)
    ? r.extensions
    : r?.extensions && typeof r.extensions === 'object'
      ? Object.keys(r.extensions)
      : undefined

  const explain = normalizeExplain(r?._explain, r?._score)
  const out: StarsightRecord = {
    ...(r as Partial<StarsightRecord>),
    id: r?.id ?? url,
    resource: {
      url,
      serviceName: r?.serviceName || block?.serviceName || url.replace(/^https?:\/\//, ''),
      tags: Array.isArray(tags) ? tags.slice(0, 16) : [],
      description: r?.description ?? block?.description ?? '',
      iconUrl: r?.iconUrl ?? block?.iconUrl,
    },
    type: r?.type === 'mcp' ? 'mcp' : 'http',
    network: r?.network ?? offer.network ?? 'stellar:testnet',
    scheme: r?.scheme ?? offer.scheme ?? 'exact',
    payTo: r?.payTo ?? offer.payTo ?? '',
    asset: r?.asset ?? offer.asset ?? '',
    // x402 v2 renamed this to `amount`; v1 (and CONTRACT.md) says `maxAmountRequired`
    maxAmountRequired: String(
      offer.amount ?? r?.amount ?? offer.maxAmountRequired ?? r?.maxAmountRequired ?? '0',
    ),
    extensions,
    lastSeenAt: seenAt,
    settlements: Number(r?.settlements) || 0,
  }
  // `...r` carried the index's raw dialect through; replace it with the board's,
  // or drop it entirely so the caller knows to rank locally instead.
  if (explain) out._explain = explain
  else delete out._explain
  return out
}

/**
 * Fixtures go stale the moment they are written. Slide every timestamp forward so
 * the recency signal still reads as a live catalog during the demo.
 */
function rebase(items: StarsightRecord[]): StarsightRecord[] {
  const newest = items.reduce((a, r) => Math.max(a, r.lastSeenAt || 0), 0)
  const delta = Date.now() - newest
  if (!newest || delta < 60_000) return items
  return items.map((r) => ({ ...r, lastSeenAt: r.lastSeenAt + delta }))
}

const fixtureItems = () => rebase(pickItems(fixtureRaw).map(sane))

/**
 * The integrity ledger has exactly one baked source: `integrity.json`. It used to have
 * two — fixture.json carried its own copy — and the two drifted apart from each other
 * and from the validator. One source, generated, or this happens again.
 *
 * `integrity.json` is written by apps/web/scripts/gen-integrity.mjs, which replays a
 * hostile corpus through the real validator and records what it returned. The offsets
 * are anchored to `generatedAt` — when the corpus was ACTUALLY run — and deliberately
 * not to `Date.now()`. Sliding them forward on every page load is what made a static
 * file read as a live feed, which is the one thing this panel must not do.
 */
export const bakedIntegrity = (): IntegrityProvenance => fixtureIntegrity()

const fixtureIntegrity = (): IntegrityProvenance => {
  const raw = integrityRaw as {
    generatedAt?: string
    commit?: string | null
    entries?: ({ minutesAgo: number } & Omit<IntegrityEntry, 'at'>)[]
  }
  const anchor = raw.generatedAt ? Date.parse(raw.generatedAt) : Date.now()
  return {
    entries: (raw.entries ?? []).map((e) => ({
      ...(e as unknown as IntegrityEntry),
      at: anchor - e.minutesAgo * 60_000,
    })),
    live: false,
    generatedAt: raw.generatedAt,
    commit: raw.commit ?? undefined,
  }
}

export function demoCatalog(): Catalog {
  const items = fixtureItems()
  return {
    items,
    integrity: fixtureIntegrity(),
    source: 'demo',
    asset: (fixtureRaw as { asset?: string }).asset ?? items[0]?.asset ?? '',
    total: items.length,
  }
}

export async function loadCatalog(): Promise<Catalog> {
  try {
    const payload = await getJSON('/discovery/resources?limit=50&extensions=bazaar')
    const items = pickItems(payload).map(sane)
    if (!items.length) throw new Error('empty index')
    let observed = pickIntegrity(payload)
    if (!observed.length) {
      try {
        observed = pickIntegrity(await getJSON('/discovery/integrity?limit=20'))
      } catch {
        /* the index need not expose this yet — fall back to the baked replay */
      }
    }
    // A live catalog does not make the ledger live. Only verdicts the index actually
    // reported are `live: true`; otherwise we fall back to the replay and say so.
    const integrity: IntegrityProvenance = observed.length
      ? { entries: observed, live: true }
      : fixtureIntegrity()
    return {
      items,
      integrity,
      source: 'live',
      asset: items[0]?.asset ?? '',
      total: Number((payload as { total?: number })?.total) || items.length,
    }
  } catch {
    return demoCatalog()
  }
}

export type SearchOutcome = {
  items: StarsightRecord[]
  source: 'live' | 'demo'
  partialResults: boolean
  tookMs: number
}

/**
 * Ranking always runs locally as well, so the _explain breakdown is present even
 * when the index answers without one.
 */
export async function search(
  query: string,
  fallback: StarsightRecord[],
  live: boolean,
): Promise<SearchOutcome> {
  const started = performance.now()
  if (live && query.trim()) {
    try {
      const payload = await getJSON(`/discovery/search?query=${encodeURIComponent(query)}&limit=20`)
      const items = pickItems(payload).map(sane)
      if (items.length) {
        // `sane` has already translated any index-supplied `_explain` into the
        // board's dialect. Only rank locally for rows the index did not explain.
        const explained = items.map((r, i) =>
          r._explain?.parts?.length ? r : { ...r, ...rank(query, [r])[0], _rank: i },
        )
        return {
          items: explained as StarsightRecord[],
          source: 'live',
          partialResults: Boolean((payload as { partialResults?: boolean })?.partialResults),
          tookMs: performance.now() - started,
        }
      }
    } catch {
      /* fall through to the local ranker */
    }
  }
  const items = rank(query, fallback)
  return {
    items: query.trim() ? items : rank('', fallback).sort((a, b) => b.settlements - a.settlements),
    source: live ? 'live' : 'demo',
    partialResults: false,
    tookMs: performance.now() - started,
  }
}

export const testnetTxs: TxEntry[] = Array.isArray(txsRaw) ? (txsRaw as TxEntry[]) : []
