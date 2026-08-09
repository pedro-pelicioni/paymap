import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AssetImg } from '../components/AssetImg'
import { Globe } from '../components/Globe'
import { IntegrityLedger } from '../components/IntegrityLedger'
import { LoopDiagram, PaymapGlyph, StarChart } from '../components/Marks'
import { SightBoard } from '../components/SightBoard'
import { StackStatus } from '../components/StackStatus'
import { Ticker } from '../components/Ticker'
import { ASSET_CODE, demoCatalog, loadCatalog, testnetTxs } from '../lib/api'
import { explorerTx, shortHash } from '../lib/format'
import { rank } from '../lib/rank'
import { RevealGroup, SplitLine } from '../lib/reveal'
import type { Catalog } from '../lib/types'

const GITHUB = 'https://github.com/pedro-pelicioni/paymap'

export default function Landing() {
  const [cat, setCat] = useState<Catalog>(() => demoCatalog())

  useEffect(() => {
    let alive = true
    loadCatalog().then((c) => alive && setCat(c))
    return () => {
      alive = false
    }
  }, [])

  const top = rank('', cat.items).sort((a, b) => b.settlements - a.settlements)
  const isLive = cat.source === 'live'
  /**
   * Only the live index has observed settlements. The baked fixture is an
   * illustrative catalog, so in DEMO we show no figure at all rather than a
   * number a viewer could read as real history.
   */
  const settled = isLive ? cat.items.reduce((a, r) => a + (r.settlements || 0), 0) : null

  return (
    <div className="theme t-paper">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <span className="grain" aria-hidden="true" />

      <header className="topbar">
        <div className="shell topbar__in">
          <Link className="topbar__mark" to="/" aria-label="PAYMAP home">
            <PaymapGlyph />
            <span>PAYMAP</span>
          </Link>
          <nav className="topbar__nav" aria-label="Sections">
            <a href="#problem">The problem</a>
            <a href="#loop">The loop</a>
            <a href="#board">Sight board</a>
            <a href="#testnet">On testnet</a>
          </nav>
          <Link className="btn btn--sm btn--solid" to="/console">
            Open console
          </Link>
        </div>
      </header>

      <main id="main">
        {/* ---------------------------------------------------------- hero */}
        <section className="hero">
          <Globe />
          <StarChart />
          <AssetImg src="/assets/hero.png" className="hero__art" />
          <div className="shell hero__in">
            <div className="hero__kicker reveal" style={{ ['--d' as string]: '80ms' }}>
              <span className="label">Stellar testnet</span>
              <span className="sep">·</span>
              <span className="label">x402 discovery layer</span>
              <span className="sep">·</span>
              <span className="label">Plate No. 01</span>
            </div>

            <h1 className="wordmark reveal" style={{ ['--d' as string]: '160ms' }}>
              PAYMAP<sup>°</sup>
            </h1>

            <div className="hero__lines">
              <div className="reveal" style={{ ['--d' as string]: '340ms' }}>
                <p className="hero__claim">
                  Find <em>what to pay for</em> on Stellar.
                </p>
                <p className="lede hero__sub">
                  Discovery for the x402 economy. Agents advertise their paid APIs, other agents
                  find them in plain language, pay in a single HTTP round trip, and get on with the
                  work.
                </p>
                <div className="hero__cta">
                  <Link className="btn btn--solid" to="/console">
                    Open the console
                  </Link>
                  <a className="btn btn--ghost" href={GITHUB} target="_blank" rel="noreferrer noopener">
                    Source ↗
                  </a>
                </div>
              </div>

              <aside className="plate fix reveal" style={{ ['--d' as string]: '460ms' }}>
                <header className="plate__cap">
                  <span className="label">Position fix</span>
                  <span
                    className={`source-pill source-pill--${cat.source}`}
                    style={{ marginLeft: 'auto' }}
                  >
                    <span className="dot dot--pulse" />
                    {cat.source}
                  </span>
                </header>
                <div className="fix__body">
                  <div className="fix__row">
                    <span className="fix__k">Resources indexed</span>
                    <span className="fix__v">{String(cat.total).padStart(2, '0')}</span>
                  </div>
                  <div className="fix__row">
                    <span className="fix__k">Settlements observed</span>
                    {settled === null ? (
                      <span className="fix__v" style={{ color: 'var(--fg-3)' }}>
                        —{' '}
                        <span style={{ fontSize: '0.625rem', letterSpacing: '0.13em' }}>
                          · DEMO CATALOG
                        </span>
                      </span>
                    ) : (
                      <span className="fix__v fix__v--accent">
                        {settled.toLocaleString('en-US')}
                      </span>
                    )}
                  </div>
                  <div className="fix__row">
                    <span className="fix__k">Test asset</span>
                    <span className="fix__v">{ASSET_CODE}</span>
                  </div>
                  <div className="fix__row">
                    <span className="fix__k">Network</span>
                    <span className="fix__v" style={{ fontSize: '0.75rem' }}>
                      stellar:testnet
                    </span>
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </section>

        <div className="reveal" style={{ ['--d' as string]: '620ms' }}>
          <Ticker items={cat.items} />
        </div>

        {/* ------------------------------------------------------- problem */}
        <section className="section" id="problem">
          <div className="shell">
            <RevealGroup className="section__head">
              <span className="section__no rise rise--rule">01 — The problem</span>
              <h2 className="section__title">
                <SplitLine text="x402 settles. Nothing tells an agent *what exists*." from={1} />
              </h2>
            </RevealGroup>

            <StackStatus />

            <RevealGroup className="cols">
              <blockquote className="pullquote rise" style={{ ['--i' as string]: 0 }}>
                A payment rail without a chart is a port with no harbour lights.
              </blockquote>
              <div className="cols__body rise" style={{ ['--i' as string]: 1 }}>
                <p className="prose">
                  x402 gave the web a payment handshake, and Stellar gave it settlement that is fast
                  and cheap enough for machines to use per request. That half works. The other half
                  does not: an agent holding a wallet still has <strong>no way to find out what is
                  purchasable</strong>. Every integration is hand-wired in advance, which is exactly
                  the thing autonomous agents were supposed to stop doing.
                </p>
                <div className="split">
                  <div className="note rise" style={{ ['--i' as string]: 2 }}>
                    <h3>No index</h3>
                    <p>
                      Paid endpoints are announced in READMEs and Discord threads. Nothing machine-
                      readable, nothing rankable, nothing an agent can query at runtime.
                    </p>
                  </div>
                  <div className="note rise" style={{ ['--i' as string]: 3 }}>
                    <h3>No trust boundary</h3>
                    <p>
                      An open catalog is an open door. Route templates that escape their prefix,
                      forged icon origins, tag floods — all of it has to be refused at the edge.
                    </p>
                  </div>
                  <div className="note rise" style={{ ['--i' as string]: 4 }}>
                    <h3>No ranking signal</h3>
                    <p>
                      Text relevance alone is gameable. Real settlements, metadata completeness and
                      recency are the signals a paying agent actually cares about.
                    </p>
                  </div>
                  <div className="note rise" style={{ ['--i' as string]: 5 }}>
                    <h3>No explanation</h3>
                    <p>
                      An agent that cannot see <em>why</em> a result won cannot audit its own
                      spending. Every score here opens up into its parts.
                    </p>
                  </div>
                </div>
              </div>
            </RevealGroup>
          </div>
        </section>

        {/* ---------------------------------------------------------- loop */}
        <section className="section" id="loop">
          <div className="shell">
            <RevealGroup className="section__head">
              <span className="section__no rise rise--rule">02 — The loop</span>
              <h2 className="section__title">
                <SplitLine text="Four steps, *one* round trip." from={1} />
              </h2>
            </RevealGroup>

            <RevealGroup className="steps">
              <article className="step-card rise" style={{ ['--i' as string]: 0 }}>
                <div className="step-card__no">STEP 01</div>
                <h3>Advertise</h3>
                <p>
                  A seller upserts a record — resource URL, tags, price, network, asset. The index
                  validates it, soft-drops what is malformed and refuses what is hostile.
                </p>
              </article>
              <article className="step-card rise" style={{ ['--i' as string]: 1 }}>
                <div className="step-card__no">STEP 02</div>
                <h3>Discover</h3>
                <p>
                  An agent asks in plain language. Hybrid ranking — BM25 over boosted fields, plus
                  catalog health — returns sights with a full <code>_explain</code> breakdown.
                </p>
              </article>
              <article className="step-card rise" style={{ ['--i' as string]: 2 }}>
                <div className="step-card__no">STEP 03</div>
                <h3>Settle</h3>
                <p>
                  <code>402</code> carries the terms. The agent signs an authorization entry; the
                  facilitator sponsors the fee and submits to Stellar testnet.
                </p>
              </article>
              <article className="step-card rise" style={{ ['--i' as string]: 3 }}>
                <div className="step-card__no">STEP 04</div>
                <h3>Consume</h3>
                <p>
                  <code>200</code> returns the goods with the settlement receipt in the header — and
                  that settlement feeds straight back into the ranking.
                </p>
              </article>
            </RevealGroup>

            <figure className="diagram">
              <LoopDiagram />
            </figure>
          </div>
        </section>

        {/* --------------------------------------------------------- board */}
        <section className="section" id="board">
          <div className="shell">
            <RevealGroup className="section__head">
              <span className="section__no rise rise--rule">03 — The sight board</span>
              <h2 className="section__title">
                <SplitLine text="Every result is a *sight* taken on the catalog." from={1} />
              </h2>
            </RevealGroup>
            <RevealGroup>
              <p
                className="lede rise"
                style={{ maxWidth: '62ch', marginBottom: '1.75rem', ['--i' as string]: 0 }}
              >
                A sight is the observation a navigator takes to fix position. Each one carries its
                price, its resource type, and a score bar split into the four signals that produced
                it. Run a query in the console and the board physically re-orders.
              </p>
              <div className="rise" style={{ ['--i' as string]: 1 }}>
                <SightBoard
                  items={top.slice(0, 4)}
                  caption={`${isLive ? 'Live catalog' : 'Demo catalog'} — top by settlements`}
                />
              </div>
              <div className="rise" style={{ marginTop: '1.5rem', ['--i' as string]: 2 }}>
                <Link className="btn btn--solid" to="/console">
                  Open the console
                </Link>
              </div>
            </RevealGroup>
          </div>
        </section>

        {/* ------------------------------------------------------- testnet */}
        <section className="section" id="testnet">
          <div className="shell">
            <RevealGroup className="section__head">
              <span className="section__no rise rise--rule">04 — On testnet</span>
              <h2 className="section__title">
                <SplitLine text="Real payments, *really settled*." from={1} />
              </h2>
            </RevealGroup>
            <RevealGroup className="cols">
              <div>
                <p className="prose rise" style={{ maxWidth: '30ch', ['--i' as string]: 0 }}>
                  Every hash below is a transaction on Stellar testnet, submitted by the facilitator
                  during this build. Open any of them.
                </p>
              </div>
              <div className="txs">
                {testnetTxs.slice(0, 12).map((tx, i) => (
                  <a
                    className="tx rise"
                    style={{ ['--i' as string]: i, ['--step' as string]: '42ms' }}
                    key={tx.hash}
                    href={explorerTx(tx.hash)}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <span className="tx__no">{String(i + 1).padStart(2, '0')}</span>
                    <span className="tx__label">{tx.label}</span>
                    <span className="tx__hash">{shortHash(tx.hash)} ↗</span>
                  </a>
                ))}
                {testnetTxs.length === 0 && (
                  <p className="prose" style={{ padding: '1rem 0' }}>
                    Settlement log is being written.
                  </p>
                )}
              </div>
            </RevealGroup>
          </div>
        </section>

        {/* ----------------------------------------------------- integrity */}
        <section className="section section--tight">
          <RevealGroup className="shell cols">
            <div>
              <span
                className="section__no rise rise--rule"
                style={{ display: 'inline-block', ['--i' as string]: 0 }}
              >
                05 — Trust boundary
              </span>
            </div>
            <div style={{ display: 'grid', gap: '1.25rem' }}>
              <p className="prose rise" style={{ maxWidth: '60ch', ['--i' as string]: 1 }}>
                The facilitator is not a mailbox. Everything entering the index is validated, and
                what it refuses is written down where anyone can read it.
              </p>
              <div className="rise" style={{ ['--i' as string]: 2 }}>
                <IntegrityLedger entries={cat.integrity} />
              </div>
            </div>
          </RevealGroup>
        </section>
      </main>

      <footer className="footer">
        <div className="shell">
          <div className="footer__top">
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <AssetImg src="/assets/lot-mark.png" width={56} height={56} />
              <p className="footer__mark">
                PAYMAP<sup style={{ fontSize: '0.3em', color: 'var(--brass)' }}>°</sup>
              </p>
            </div>
            <nav className="footer__links" aria-label="Elsewhere">
              <a className="link" href={GITHUB} target="_blank" rel="noreferrer noopener">
                GitHub ↗
              </a>
              <Link className="link" to="/console">
                Console
              </Link>
              <a
                className="link"
                href="https://stellar.expert/explorer/testnet"
                target="_blank"
                rel="noreferrer noopener"
              >
                Explorer ↗
              </a>
            </nav>
          </div>
          <div className="footer__colophon">
            <span>Stellar Summit São Paulo 2026</span>
            <span>x402 · stellar:testnet · asset {ASSET_CODE}</span>
            <span>Instrument Serif · Bricolage Grotesque · DM Mono</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
