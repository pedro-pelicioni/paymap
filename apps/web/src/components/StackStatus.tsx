import type { CSSProperties } from 'react'
import { useReveal } from '../lib/reveal'

/**
 * The whole argument, stated as an instrument self-test.
 *
 * Settlement on Stellar is finished work — four moving parts, all of them
 * shipped by x402 and the network itself. Discovery has the same four-part
 * shape and, in the ecosystem at large, none of the parts.
 *
 * The third row is not decoration either: with only the first two, a reader on
 * PAYMAP's own landing page sees "Discovery — Unsolved — 0/4" and reasonably
 * concludes that THIS project does not do those things. It does, and they are
 * live. So the plate has to carry the diagnosis and the answer, or it argues
 * against itself.
 *
 * The meters are the argument: one fills, one does not, and the third fills
 * because of the work in this repo.
 */

type Row = {
  name: string
  verdict: string
  ok: boolean
  parts: string[]
  /** 0–1; drives the meter and the tally */
  score: number
}

const ROWS: Row[] = [
  {
    name: 'Settlement',
    verdict: 'Solved',
    ok: true,
    parts: [
      '402 carries the terms',
      'agent signs an authorization entry',
      'facilitator sponsors the fee',
      'receipt rides back in the header',
    ],
    score: 1,
  },
  {
    name: 'Discovery',
    verdict: 'Unsolved',
    ok: false,
    parts: [
      'no machine-readable index',
      'no trust boundary at the edge',
      'no ranking signal',
      'no explanation of the result',
    ],
    score: 0,
  },
  {
    name: 'Discovery, with PAYMAP',
    verdict: 'Live',
    ok: true,
    parts: [
      'readable by the stock @x402/extensions client',
      'soft-drop validation at the edge',
      'BM25 + metadata + settlements + recency',
      'every result explains its own score',
    ],
    score: 1,
  },
]

export function StackStatus() {
  const ref = useReveal<HTMLElement>()
  return (
    <section className="plate stack" aria-labelledby="stack-h" ref={ref}>
      <header className="plate__cap">
        <span className="label" id="stack-h">
          Stack self-test
        </span>
        <span className="label stack__net">x402 · stellar:testnet</span>
      </header>

      <div className="stack__rows">
        {ROWS.map((row, i) => {
          const done = Math.round(row.score * row.parts.length)
          return (
            <article
              className={`stack__row rise ${row.ok ? 'is-ok' : 'is-gap'}`}
              style={{ '--i': i } as CSSProperties}
              key={row.name}
            >
              <div className="stack__id">
                <h3 className="stack__name">{row.name}</h3>
                <span className="stack__flag">
                  <span className="dot" aria-hidden="true" />
                  {row.verdict}
                </span>
              </div>

              <ul className="stack__parts">
                {row.parts.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>

              <div className="stack__gauge">
                <div
                  className="stack__meter"
                  role="img"
                  aria-label={`${done} of ${row.parts.length} parts in place`}
                >
                  <i style={{ '--w': row.score } as CSSProperties} />
                  <span className="stack__ticks" aria-hidden="true">
                    {row.parts.map((p) => (
                      <b key={p} />
                    ))}
                  </span>
                </div>
                <span className="stack__tally" aria-hidden="true">
                  {done} / {row.parts.length}
                </span>
              </div>
            </article>
          )
        })}
      </div>

      <p className="stack__foot">
        The second row is why this exists. The third is <em>running right now</em> —{' '}
        <a href="https://paymap.dev/discovery/health" target="_blank" rel="noreferrer noopener">
          check it
        </a>
        .
      </p>
    </section>
  )
}
