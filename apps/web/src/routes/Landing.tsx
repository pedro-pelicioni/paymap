import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AssetImg } from '../components/AssetImg'
import { PaymapMark, StarGlyph } from '../components/Marks'
import { Ticker } from '../components/Ticker'
import { demoCatalog, loadCatalog, testnetTxs } from '../lib/api'
import { explorerTx, shortHash } from '../lib/format'
import { RevealGroup } from '../lib/reveal'
import type { Catalog } from '../lib/types'

const GITHUB = 'https://github.com/pedro-pelicioni/paymap'

/* ------------------------------------------------------------ terminal */

function Terminal() {
  return (
    <div className="terminal">
      <div className="terminal__bar">
        <span className="terminal__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="terminal__title">paymap.dev — discovery/search</span>
        <span className="terminal__title" style={{ marginLeft: 'auto' }}>
          x402 v2
        </span>
      </div>
      <div className="terminal__body">
        <pre>
          <span className="t-p">$ </span>
          <span className="t-cmd">
            {"curl 'https://paymap.dev/discovery/search?query=invoice%20ocr&limit=3'"}
          </span>
          {'\n'}
          <span className="t-dim">{'{'}</span>
          {'\n  '}
          <span className="t-key">"x402Version"</span>
          <span className="t-dim">: </span>
          <span className="t-num">2</span>
          <span className="t-dim">,</span>
          {'\n  '}
          <span className="t-key">"resources"</span>
          <span className="t-dim">: [{'{'}</span>
          {'\n    '}
          <span className="t-key">"resource"</span>
          <span className="t-dim">: </span>
          <span className="t-str">"https://api.documents.example/v1/invoice-ocr"</span>
          <span className="t-dim">,</span>
          {'\n    '}
          <span className="t-key">"serviceName"</span>
          <span className="t-dim">: </span>
          <span className="t-str">"Invoice OCR"</span>
          <span className="t-dim">,</span>
          {'\n    '}
          <span className="t-key">"_score"</span>
          <span className="t-dim">: </span>
          <span className="t-num">0.8098</span>
          <span className="t-dim">,</span>
          {'\n    '}
          <span className="t-key">"accepts"</span>
          <span className="t-dim">: [{'{'} </span>
          <span className="t-key">"scheme"</span>
          <span className="t-dim">: </span>
          <span className="t-str">"exact"</span>
          <span className="t-dim">,</span>
          {'\n      '}
          <span className="t-key">"network"</span>
          <span className="t-dim">: </span>
          <span className="t-good">"stellar:testnet"</span>
          <span className="t-dim">,</span>
          {'\n      '}
          <span className="t-key">"amount"</span>
          <span className="t-dim">: </span>
          <span className="t-str">"15000"</span>
          <span className="t-dim">,</span>
          {'\n      '}
          <span className="t-key">"payTo"</span>
          <span className="t-dim">: </span>
          <span className="t-str">"GDQN…KTL3"</span>
          <span className="t-dim"> {'}'}]</span>
          {'\n  '}
          <span className="t-dim">{'}'}, </span>
          <span className="t-dim">… 2 more ],</span>
          {'\n  '}
          <span className="t-key">"partialResults"</span>
          <span className="t-dim">: </span>
          <span className="t-num">false</span>
          <span className="t-dim">,</span>
          {'\n  '}
          <span className="t-key">"pagination"</span>
          <span className="t-dim">: {'{'} </span>
          <span className="t-key">"limit"</span>
          <span className="t-dim">: </span>
          <span className="t-num">3</span>
          <span className="t-dim">, </span>
          <span className="t-key">"cursor"</span>
          <span className="t-dim">: </span>
          <span className="t-num">null</span>
          <span className="t-dim"> {'}'}</span>
          {'\n'}
          <span className="t-dim">{'}'}</span>
          {'\n'}
          <span className="t-p">$ </span>
          <span className="terminal__cursor" aria-hidden="true" />
        </pre>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- landing */

export default function Landing() {
  const [cat, setCat] = useState<Catalog>(() => demoCatalog())
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    let alive = true
    loadCatalog().then((c) => alive && setCat(c))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const paymentTxs = testnetTxs.slice(0, 8)

  return (
    <div className="theme">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <span className="grain" aria-hidden="true" />

      <header className={`topbar${scrolled ? ' is-scrolled' : ''}`}>
        <div className="shell topbar__in">
          <Link className="topbar__mark" to="/" aria-label="PAYMAP home">
            <PaymapMark />
            <span>PAYMAP</span>
          </Link>
          <nav className="topbar__nav" aria-label="Site">
            <Link to="/console">Console</Link>
            <a href={GITHUB} target="_blank" rel="noreferrer noopener">
              GitHub
            </a>
          </nav>
          <span
            className={`source-pill source-pill--${cat.source}`}
            title={
              cat.source === 'live'
                ? 'connected to the discovery index'
                : 'index unreachable — rendering the baked fixture'
            }
          >
            <span className="dot dot--pulse" />
            {cat.source}
          </span>
          <Link className="btn btn--sm btn--solid" to="/console">
            Open console
          </Link>
        </div>
      </header>

      <main id="main">
        {/* ---------------------------------------------------------- hero */}
        <section className="hero">
          <div className="shell hero__in">
            <div className="hero__grid">
              <div>
                <span className="kicker reveal" style={{ ['--d' as string]: '60ms' }}>
                  <span className="dot" />
                  stellar:testnet
                  <span className="sep">·</span>
                  x402 v2
                </span>
                <h1 className="hero__title reveal" style={{ ['--d' as string]: '140ms' }}>
                  Find <em>what to pay for</em> on Stellar.
                </h1>
                <p className="lede hero__sub reveal" style={{ ['--d' as string]: '240ms' }}>
                  PAYMAP is the facilitator-side Bazaar discovery layer for x402 — a public,
                  hosted index where agents advertise paid APIs, search them in plain language,
                  and settle in one HTTP round trip.
                </p>
                <div className="hero__cta reveal" style={{ ['--d' as string]: '330ms' }}>
                  <Link className="btn btn--solid" to="/console">
                    Open console
                  </Link>
                  <a
                    className="btn btn--ghost"
                    href={GITHUB}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    GitHub ↗
                  </a>
                </div>
                <p className="hero__note reveal" style={{ ['--d' as string]: '420ms' }}>
                  npm install && npm run setup — no API keys, no captcha, no faucet.
                </p>
              </div>
              <div className="reveal" style={{ ['--d' as string]: '380ms' }}>
                <Terminal />
              </div>
            </div>

            {/* ------------------------------------------------- proof strip */}
            <RevealGroup>
              <div
                className="proof rise"
                style={{ marginTop: 'clamp(2.5rem, 6vw, 4rem)', ['--i' as string]: 0 }}
              >
                <div className="proof__cell">
                  <span className="proof__n">
                    <em>14</em>
                  </span>
                  <span className="proof__l">settled x402 payments on Stellar testnet</span>
                </div>
                <div className="proof__cell">
                  <span className="proof__n">84</span>
                  <span className="proof__l">tests, 0 failing — 66 of them adversarial</span>
                </div>
                <div className="proof__cell">
                  <span className="proof__n">46</span>
                  <span className="proof__l">stock-client API checks against the handlers</span>
                </div>
                <div className="proof__cell">
                  <span className="proof__n">Apache-2.0</span>
                  <span className="proof__l">permissive from the first commit</span>
                </div>
              </div>
            </RevealGroup>
          </div>
        </section>

        <Ticker items={cat.items} />

        {/* --------------------------------------------------------- bento */}
        <section className="section" id="features">
          <div className="shell">
            <RevealGroup className="section__head">
              <span className="section__kicker rise" style={{ ['--i' as string]: 0 }}>
                <StarGlyph /> What ships
              </span>
              <h2 className="section__title rise" style={{ ['--i' as string]: 1 }}>
                Discovery is the missing half of x402. <em>This is it, running.</em>
              </h2>
              <p className="lede section__sub rise" style={{ ['--i' as string]: 2 }}>
                An agent that can pay but cannot discover is an agent with a wallet and no map.
                PAYMAP is the map — and the whole payment loop around it, end to end on testnet.
              </p>
            </RevealGroup>

            <RevealGroup className="bento">
              <article className="bento__card bento__card--3 rise" style={{ ['--i' as string]: 0 }}>
                <span className="bento__kicker">
                  <StarGlyph size={9} /> Bazaar discovery
                </span>
                <h3>A public Bazaar any agent can call</h3>
                <p>
                  The spec's <code>/discovery</code> endpoints, served from the same catalog code
                  locally and at <code>paymap.dev</code> — readable by the stock{' '}
                  <code>@x402/extensions</code> client, with CORS open because the point is for
                  other people's agents to call it.
                </p>
                <div className="bento__code">
                  <div className="row">
                    <span className="method">GET</span>
                    <span className="path">/discovery/resources</span>
                    <span className="note">paginated catalog, spec filters</span>
                  </div>
                  <div className="row">
                    <span className="method">GET</span>
                    <span className="path">/discovery/search</span>
                    <span className="note">natural language, ranked</span>
                  </div>
                  <div className="row">
                    <span className="method">GET</span>
                    <span className="path">/discovery/health</span>
                    <span className="note">mode · records · commit</span>
                  </div>
                </div>
              </article>

              <article className="bento__card bento__card--3 rise" style={{ ['--i' as string]: 1 }}>
                <span className="bento__kicker">
                  <StarGlyph size={9} /> Explainable ranking
                </span>
                <h3>
                  Every <code>_explain</code> sums to its <code>_score</code>
                </h3>
                <p>
                  BM25 over boosted fields, blended with catalog health. Quality breaks ties — it
                  never overrides relevance — and a test asserts the four parts sum exactly to the
                  score.
                </p>
                <div className="bento__code" aria-label="Ranking formula">
                  <span className="formula">
                    <b>1.00</b>·bm25 + <b>0.12</b>·completeness + <b>0.08</b>·popularity +{' '}
                    <b>0.05</b>·recency
                  </span>
                  <span className="minibar" aria-hidden="true">
                    <i className="seg--bm25" style={{ width: '80%' }} />
                    <i className="seg--metadata" style={{ width: '9.6%' }} />
                    <i className="seg--settlements" style={{ width: '6.4%' }} />
                    <i className="seg--recency" style={{ width: '4%' }} />
                  </span>
                  <span className="minibar__legend">
                    <span>
                      <i className="seg--bm25" style={{ display: 'inline-block' }} />
                      BM25
                    </span>
                    <span>
                      <i className="seg--metadata" style={{ display: 'inline-block' }} />
                      metadata
                    </span>
                    <span>
                      <i className="seg--settlements" style={{ display: 'inline-block' }} />
                      settlements
                    </span>
                    <span>
                      <i className="seg--recency" style={{ display: 'inline-block' }} />
                      recency
                    </span>
                  </span>
                </div>
              </article>

              <article className="bento__card rise" style={{ ['--i' as string]: 2 }}>
                <span className="bento__kicker">
                  <StarGlyph size={9} /> Catalog integrity
                </span>
                <h3>Soft-drop at the trust boundary</h3>
                <p>
                  Every discovery field is attacker-controlled. Hostile routes are refused; hostile
                  fields are dropped and the record survives.
                </p>
                <div className="miniledger">
                  <div className="miniledger__row">
                    <span className="verdict verdict--rejected">rejected</span>
                    <span className="miniledger__rule">route-template/traversal</span>
                  </div>
                  <div className="miniledger__row">
                    <span className="verdict verdict--soft-drop">soft-drop</span>
                    <span className="miniledger__rule">resource/icon-url-origin</span>
                  </div>
                  <div className="miniledger__row">
                    <span className="verdict verdict--soft-drop">soft-drop</span>
                    <span className="miniledger__rule">resource/tags-cardinality</span>
                  </div>
                </div>
              </article>

              <article className="bento__card rise" style={{ ['--i' as string]: 3 }}>
                <span className="bento__kicker">
                  <StarGlyph size={9} /> Fee-sponsored payments
                </span>
                <h3>The buyer needs zero XLM</h3>
                <p>
                  The facilitator's fee account sponsors every network fee. On a settled
                  transaction, <code>fee_account</code> is the facilitator — not the payer.
                </p>
                <div className="bento__code">
                  <div className="row">
                    <span className="path">extra.areFeesSponsored</span>
                    <span className="note" style={{ color: 'var(--good)' }}>
                      true
                    </span>
                  </div>
                </div>
              </article>

              <article className="bento__card rise" style={{ ['--i' as string]: 4 }}>
                <span className="bento__kicker">
                  <StarGlyph size={9} /> MCP server
                </span>
                <h3>Four tools, schemas on both ends</h3>
                <p>
                  Any MCP client can discover and pay — input <em>and</em> output schemas, a
                  17-code error enum, settled payments driven over MCP.
                </p>
                <div className="bento__code">
                  <div className="row">
                    <span className="path">paymap_search</span>
                  </div>
                  <div className="row">
                    <span className="path">paymap_browse</span>
                  </div>
                  <div className="row">
                    <span className="path">paymap_describe</span>
                  </div>
                  <div className="row">
                    <span className="path">paymap_pay</span>
                  </div>
                </div>
              </article>

              <article
                className="bento__card bento__card--6 rise"
                style={{ ['--i' as string]: 5 }}
              >
                <div className="bento__wide">
                  <div>
                    <span className="bento__kicker">
                      <StarGlyph size={9} /> Self-hosted facilitator
                    </span>
                    <h3 style={{ marginTop: '0.6rem' }}>Yours to fork and run</h3>
                    <p style={{ marginTop: '0.6rem' }}>
                      verify / settle / supported on the Apache-2.0 <code>@x402/stellar</code>{' '}
                      package — no AGPL dependencies, no third-party relayer, no API keys. It
                      issues its own SEP-41 test asset, so setup runs start to finish with no web
                      forms.
                    </p>
                  </div>
                  <div className="bento__wide-side">
                    <div className="bento__code" style={{ width: '100%', marginTop: 0 }}>
                      <div className="row">
                        <span className="method" style={{ color: 'var(--accent)' }}>
                          POST
                        </span>
                        <span className="path">/verify</span>
                        <span className="note">isValid · payer</span>
                      </div>
                      <div className="row">
                        <span className="method" style={{ color: 'var(--accent)' }}>
                          POST
                        </span>
                        <span className="path">/settle</span>
                        <span className="note">tx hash · EXTENSION-RESPONSES</span>
                      </div>
                      <div className="row">
                        <span className="method">GET</span>
                        <span className="path">/supported</span>
                        <span className="note">kinds · areFeesSponsored</span>
                      </div>
                    </div>
                    <a
                      className="btn btn--ghost btn--sm"
                      href={GITHUB}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Read the source ↗
                    </a>
                  </div>
                </div>
              </article>
            </RevealGroup>
          </div>
        </section>

        {/* -------------------------------------------------------- verify */}
        <section className="section" id="verify">
          <div className="shell verify">
            <RevealGroup>
              <span className="section__kicker rise" style={{ ['--i' as string]: 0 }}>
                <StarGlyph /> On testnet
              </span>
              <h2 className="section__title rise" style={{ ['--i' as string]: 1 }}>
                Verify it in <em>60 seconds.</em>
              </h2>
              <p className="prose section__sub rise" style={{ ['--i' as string]: 2 }}>
                Nothing here asks for trust. Every hash on the right is a real transaction this
                code submitted to Stellar testnet — open any of them on stellar.expert and read{' '}
                <code style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.85em' }}>
                  successful: true
                </code>{' '}
                off the ledger.
              </p>
              <pre className="verify__cmd rise" style={{ ['--i' as string]: 3 }}>
                {'$ npm test          # 84 tests, 0 failing\n'}
                {'$ npm run verify:api # 46 stock-client checks\n'}
                {'$ npm run demo       # discover → 402 → sign → settle → 200'}
              </pre>
            </RevealGroup>
            <RevealGroup>
              <div className="txs rise" style={{ ['--i' as string]: 1 }}>
                {paymentTxs.map((tx, i) => (
                  <a
                    key={tx.hash}
                    className="tx"
                    href={explorerTx(tx.hash)}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <span className="tx__no">{String(i + 1).padStart(2, '0')}</span>
                    <span className="tx__label">{tx.label}</span>
                    <span className="tx__hash">{shortHash(tx.hash)} ↗</span>
                  </a>
                ))}
                {paymentTxs.length === 0 && (
                  <p className="prose" style={{ padding: '1.25rem' }}>
                    Settlement log is being written.
                  </p>
                )}
              </div>
            </RevealGroup>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="shell">
          <div className="footer__top">
            <div>
              <div className="footer__brand">
                <AssetImg src="/assets/paymap-mark.svg" width={34} height={34} />
                <p className="footer__mark">PAYMAP</p>
              </div>
              <p className="footer__tag">Find what to pay for on Stellar.</p>
            </div>
            <nav className="footer__links" aria-label="Elsewhere">
              <Link className="link" to="/console">
                Console
              </Link>
              <a className="link" href={GITHUB} target="_blank" rel="noreferrer noopener">
                GitHub ↗
              </a>
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
            <span>Apache-2.0</span>
            <span>x402 v2 · stellar:testnet</span>
            <span>Built in São Paulo, Brazil.</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
