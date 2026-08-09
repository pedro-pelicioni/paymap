export type ResourceBlock = {
  url: string
  serviceName?: string
  tags?: string[]
  iconUrl?: string
  description?: string
}

/**
 * What the discovery API actually puts on the wire, before `sane()` normalises it.
 *
 * Two shapes arrive here and both must work:
 *
 *  · the spec `DiscoveryResource` (`@x402/extensions`) — `resource` is a URL STRING,
 *    money lives in `accepts[0]` as x402 v2 `PaymentRequirements` (`amount`, not
 *    `maxAmountRequired`), the timestamp is `lastUpdated` in ISO 8601, and
 *    serviceName / description / tags / iconUrl sit at the TOP LEVEL;
 *  · the baked fixture and any older STARSIGHT record — `resource` is a block, the money
 *    fields are flat, the timestamp is `lastSeenAt` in epoch ms.
 *
 * `sane()` collapses both onto `StarsightRecord`, which is the board's own shape.
 */
export type WirePaymentRequirements = {
  scheme?: string
  network?: string
  asset?: string
  /** x402 v2 */
  amount?: string
  /** x402 v1 */
  maxAmountRequired?: string
  payTo?: string
  maxTimeoutSeconds?: number
}

export type WireRecord = {
  id?: string
  resource?: ResourceBlock | string
  type?: string
  x402Version?: number
  accepts?: WirePaymentRequirements[]
  lastUpdated?: string
  serviceName?: string
  description?: string
  tags?: string[]
  iconUrl?: string
  network?: string
  scheme?: string
  payTo?: string
  asset?: string
  maxAmountRequired?: string
  amount?: string
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  routeTemplate?: string
  extensions?: string[] | Record<string, unknown>
  lastSeenAt?: number
  settlements?: number
  seeded?: boolean
  _score?: number
  _explain?: unknown
}

export type StarsightRecord = {
  id: string
  resource: ResourceBlock
  type: 'http' | 'mcp'
  network: string
  scheme: string
  payTo: string
  asset: string
  /** x402 v1 name for the price */
  maxAmountRequired: string
  /** x402 v2 name for the price — read both, render whichever is present */
  amount?: string
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  routeTemplate?: string
  extensions?: string[]
  lastSeenAt: number
  settlements: number
  /**
   * Marked by the index (and by the baked fixture) on illustrative catalog
   * entries. Absent means a real, payable, settle-backed resource.
   */
  seeded?: boolean
  /** attached client-side (or by the index) — why this lot ranked where it did */
  _explain?: Explain
}

export type Explain = {
  total: number
  parts: { key: ExplainKey; value: number; detail: string }[]
  terms: {
    term: string
    /** the field(s) the term hit — joined when the index reports several */
    field: string
    tf: number
    idf: number
    weight: number
    /**
     * Corpus-wide document frequency. Only the index knows this; the local
     * ranker sees one document at a time, so it is absent on the fallback path.
     */
    df?: number
  }[]
}

export type ExplainKey = 'bm25' | 'metadata' | 'settlements' | 'recency'

export type IntegrityEntry = {
  at: number
  verdict: 'rejected' | 'soft-drop'
  rule: string
  field: string
  input: string
  reason: string
}

/**
 * Where an integrity ledger came from. `live: true` means these verdicts were observed
 * by a running index; `live: false` means they are a replay of the hostile corpus in
 * apps/web/scripts/gen-integrity.mjs through the same validator, generated at
 * `generatedAt` off `commit`. The panel renders the difference — a replay must never
 * be presented as observed traffic.
 */
export type IntegrityProvenance = {
  entries: IntegrityEntry[]
  live: boolean
  generatedAt?: string
  commit?: string
}

export type TxEntry = { hash: string; label: string; source?: 'live' | 'demo' }

export type Source = 'live' | 'demo'

export type Catalog = {
  items: StarsightRecord[]
  integrity: IntegrityProvenance
  source: Source
  asset: string
  total: number
}
