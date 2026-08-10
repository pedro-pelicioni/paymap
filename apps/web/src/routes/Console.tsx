import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { IntegrityLedger } from '../components/IntegrityLedger'
import { StellarsightMark } from '../components/Marks'
import { PaymentLoop } from '../components/PaymentLoop'
import { SightBoard } from '../components/SightBoard'
import { Ticker } from '../components/Ticker'
import { demoCatalog, INDEX_URL, loadCatalog, search } from '../lib/api'
import { rank } from '../lib/rank'
import type { Catalog, StellarsightRecord } from '../lib/types'

const EXAMPLES = ['an agent that reads invoices', 'usd to brl rate', 'postal code lookup', 'mcp tool for ocr']

export default function Console() {
  const [cat, setCat] = useState<Catalog>(() => demoCatalog())
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [items, setItems] = useState<StellarsightRecord[]>(() =>
    rank('', demoCatalog().items).sort((a, b) => b.settlements - a.settlements),
  )
  const [busy, setBusy] = useState(false)
  const [took, setTook] = useState(0)
  const [paying, setPaying] = useState<StellarsightRecord | null>(null)
  const [runId, setRunId] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    loadCatalog().then((c) => {
      if (!alive) return
      setCat(c)
      setItems(rank('', c.items).sort((a, b) => b.settlements - a.settlements))
    })
    return () => {
      alive = false
    }
  }, [])

  async function run(q: string) {
    setQuery(q)
    setDraft(q)
    setBusy(true)
    const out = await search(q, cat.items, cat.source === 'live')
    setItems(out.items)
    setTook(out.tookMs)
    setBusy(false)
  }

  function onPay(rec: StellarsightRecord) {
    setPaying(rec)
    setRunId((n) => n + 1)
    if (window.innerWidth < 1120) {
      document.getElementById('loop-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  return (
    <div className="theme">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <span className="grain" aria-hidden="true" />

      <header className="topbar topbar--solid">
        <div className="shell topbar__in">
          <Link className="topbar__mark" to="/" aria-label="STELLARSIGHT home">
            <StellarsightMark />
            <span>STELLARSIGHT</span>
          </Link>
          <nav className="topbar__nav" aria-label="Sections">
            <Link to="/">Home</Link>
            <a href="#board">Results</a>
            <a href="#loop-panel">Payment loop</a>
          </nav>
          {/*
            Two claims, kept apart on purpose. The catalog really is live; the payment
            loop never is. One unqualified LIVE in the corner was reading as a warranty
            over the whole page, replayed settlement included.
          */}
          <span
            className={`source-pill source-pill--${cat.source}`}
            title={cat.source === 'live' ? `catalog connected to ${INDEX_URL}` : 'index unreachable — baked fixture'}
          >
            <span className="dot dot--pulse" />
            {cat.source} catalog
          </span>
          <span
            className="source-pill source-pill--seed"
            style={{ marginLeft: '0.5rem' }}
            title="The payment loop traces a settlement that already happened on testnet. Nothing settles from this page — the resource server and facilitator run locally."
          >
            <span className="dot" />
            replay payments
          </span>
        </div>
      </header>

      <Ticker items={cat.items} />

      <main id="main" className="shell console">
        <div className="console__main">
          <div className="console__head">
            <div>
              <span className="label">Discovery console</span>
              <h1 className="console__title">
                Ask for <em>what you need.</em>
              </h1>
            </div>
            <span className="label" style={{ color: 'var(--fg-3)' }}>
              {cat.source === 'live' ? INDEX_URL : 'baked fixture · no server required'}
            </span>
          </div>

          <form
            className="search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault()
              run(draft)
            }}
          >
            <label className="visually-hidden" htmlFor="q">
              Search the catalog
            </label>
            <StellarsightMark size={20} />
            <input
              id="q"
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="an agent that reads invoices"
              autoComplete="off"
              spellCheck={false}
            />
            {busy && <span className="search__spin" aria-hidden="true" />}
            <button className="search__go" type="submit">
              Search
            </button>
          </form>

          <div className="chips">
            <span className="label">Try</span>
            {EXAMPLES.map((ex) => (
              <button className="chip" key={ex} onClick={() => run(ex)}>
                {ex}
              </button>
            ))}
            {query && (
              <button
                className="chip"
                onClick={() => {
                  setDraft('')
                  run('')
                }}
              >
                clear ✕
              </button>
            )}
          </div>

          <div className="board__wrap" id="board">
            <div>
              {items.length ? (
                <SightBoard
                  items={items}
                  query={query}
                  onPay={onPay}
                  caption={query ? `Results for “${query}”` : 'Full catalog — ranked'}
                />
              ) : (
                <div className="emptystate">
                  <p>No results for that query.</p>
                </div>
              )}
              <p className="label" style={{ marginTop: '0.9rem', color: 'var(--fg-3)' }}>
                {items.length} result{items.length === 1 ? '' : 's'} · ranked in {took.toFixed(1)} ms
                · BM25 + metadata + settlements + recency
              </p>
            </div>
          </div>
        </div>

        <aside className="console__aside" aria-label="Payment and integrity">
          <div id="loop-panel">
            <PaymentLoop rec={paying} runId={runId} />
          </div>
          <IntegrityLedger ledger={cat.integrity} />
        </aside>
      </main>
    </div>
  )
}
