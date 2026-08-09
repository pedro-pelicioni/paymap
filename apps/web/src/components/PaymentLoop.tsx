import { useEffect, useState } from 'react'
import { ASSET_CODE, testnetTxs } from '../lib/api'
import { explorerTx, formatAmount, shortHash, shortKey } from '../lib/format'
import type { StarsightRecord } from '../lib/types'

const DURATIONS = [1100, 1200, 1500, 800]

/**
 * Only the `demo:` rows are x402 payments. The rest of docs/TESTNET-TXS.md is setup and
 * housekeeping — trustlines, the asset issuance, the SAC deploy, a legacy-asset cleanup.
 * Picking from all of them once produced a receipt that read "settled 0.0500 SXT" over
 * the hash of a `changeTrust` operation, which is a small lie told confidently. Filter
 * first, so the receipt can only ever point at a transaction that actually moved SXT.
 */
const paymentTxs = testnetTxs.filter((t) => /^demo:/i.test(t.label ?? ''))

/** deterministic pick so the same sight always shows the same settled payment */
function hashPick(id: string): string | undefined {
  const pool = paymentTxs.length ? paymentTxs : []
  if (!pool.length) return undefined
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return pool[h % pool.length]?.hash
}

/**
 * Traces one x402 round trip: 402 → sign → settle → 200.
 *
 * This is a REPLAY, and the UI says so. It walks the four stages on a timer and lands on
 * a real settled testnet transaction drawn from docs/TESTNET-TXS.md — it does not settle
 * a payment at click time. Settling live needs the resource server and the facilitator,
 * which run locally (`npm run dev:all`); only the discovery index is deployed publicly.
 *
 * The hash is genuine, which is exactly why the label matters: a viewer who clicks
 * through to stellar.expert sees `successful: true` and would otherwise reasonably
 * conclude they had just triggered it.
 */
export function PaymentLoop({ rec, runId }: { rec: StarsightRecord | null; runId: number }) {
  const [stage, setStage] = useState(0)

  useEffect(() => {
    if (!rec) return
    setStage(0)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      setStage(4)
      return
    }
    const timers: number[] = []
    let acc = 0
    DURATIONS.forEach((d, i) => {
      acc += d
      timers.push(window.setTimeout(() => setStage(i + 1), acc))
    })
    return () => timers.forEach(clearTimeout)
  }, [rec?.id, runId])

  if (!rec) {
    return (
      <section className="plate" aria-labelledby="loop-h">
        <header className="plate__cap">
          <span className="label" id="loop-h">
            Payment loop
          </span>
        </header>
        <p className="loop__empty">
          Pick a result and press PAY.
          <br />
          One HTTP round trip: 402 → sign → settle → 200.
        </p>
      </section>
    )
  }

  const amount = formatAmount(rec.amount ?? rec.maxAmountRequired)
  const hash = hashPick(rec.id)
  const steps = [
    {
      title: 'Request',
      code: <span className="step__code code--402">402 PAYMENT REQUIRED</span>,
      note: `The seller answers with its terms instead of the goods.`,
      wire: `{ "x402Version": 2, "scheme": "exact",
  "network": "${rec.network}",
  "amount": "${rec.amount ?? rec.maxAmountRequired}",
  "asset": "${shortKey(rec.asset, 6, 6)}",
  "payTo": "${shortKey(rec.payTo, 6, 6)}" }`,
    },
    {
      title: 'Sign',
      code: <span className="step__code">auth entry</span>,
      note: 'The agent signs a Soroban authorization entry for exactly that amount. Network fees are sponsored by the facilitator, so the agent needs no XLM.',
      wire: `payer  ${shortKey(rec.payTo, 6, 6)}
value  ${amount} ${ASSET_CODE}
fees   sponsored (areFeesSponsored: true)`,
    },
    {
      title: 'Settle',
      code: <span className="step__code">POST /settle</span>,
      note: 'The facilitator verifies the entry and submits it to Stellar testnet.',
      wire: `POST http://localhost:4021/settle
→ verify  isValid: true
→ submit  stellar:testnet`,
    },
    {
      title: 'Deliver',
      code: <span className="step__code code--200">200 OK</span>,
      note: 'Same round trip, now with the response body — plus the settlement receipt in the header.',
      wire: `EXTENSION-RESPONSES: base64(
  { "bazaar": { "status": "success" } } )`,
    },
  ]

  return (
    <section className="plate" aria-labelledby="loop-h">
      <header className="plate__cap">
        <span className="label" id="loop-h">
          Payment loop
        </span>
        <span
          className="source-pill"
          style={{ marginLeft: '0.6rem' }}
          title="This traces a settled payment step by step. It does not settle one now — the resource server and facilitator run locally. The hash below is from a real testnet run."
        >
          <span className="dot" />
          replay
        </span>
        <span className="label" style={{ marginLeft: 'auto', color: 'var(--fg-3)' }}>
          {stage >= 4 ? 'settled' : `step ${Math.min(stage + 1, 4)} / 4`}
        </span>
      </header>

      <div className="loop">
        <p className="step__note" style={{ marginBottom: '0.9rem' }}>
          <strong style={{ color: 'var(--fg)' }}>{rec.resource.serviceName}</strong> · {amount}{' '}
          {ASSET_CODE}
        </p>

        <div className="loop__steps" aria-live="polite">
          {steps.map((s, i) => {
            const state = stage > i ? 'is-done' : stage === i ? 'is-active' : ''
            return (
              <div className={`step ${state}`} key={s.title}>
                <div className="step__mark">
                  <span className="step__dot" />
                </div>
                <div>
                  <div className="step__title">
                    <span>{s.title}</span>
                    {s.code}
                  </div>
                  <p className="step__note">{s.note}</p>
                  {(stage === i || stage > i) && <pre className="step__wire">{s.wire}</pre>}
                </div>
              </div>
            )
          })}
        </div>

        {stage >= 4 && (
          <div className="receipt">
            <div className="receipt__row">
              <span>settled</span>
              <b>
                {amount} {ASSET_CODE}
              </b>
            </div>
            <div className="receipt__row">
              <span>network</span>
              <b>{rec.network}</b>
            </div>
            <div className="receipt__row">
              <span>scheme</span>
              <b>{rec.scheme} · fees sponsored</b>
            </div>
            {hash ? (
              <a
                className="receipt__hash"
                href={explorerTx(hash)}
                target="_blank"
                rel="noreferrer noopener"
              >
                {shortHash(hash)} ↗ stellar.expert
              </a>
            ) : null}
            {hash ? (
              <p className="step__note" style={{ marginTop: '0.7rem' }}>
                Hash from a real settled run on Stellar testnet — open it and check. Run{' '}
                <code>npm run dev:all</code> to settle live against your own facilitator.
              </p>
            ) : (
              <p className="receipt__row">
                <span>tx</span>
                <b>pending</b>
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
