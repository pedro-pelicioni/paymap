import { useEffect, useState } from 'react'
import { ASSET_CODE, testnetTxs } from '../lib/api'
import { explorerTx, formatAmount, settledOn, shortHash, shortKey } from '../lib/format'
import type { StellarsightRecord, TxEntry } from '../lib/types'

const DURATIONS = [1100, 1200, 1500, 800]

/**
 * Only rows that are x402 payments AND carry a recorded transfer amount. The rest of
 * docs/TESTNET-TXS.md is setup and housekeeping — trustlines, the asset issuance, the SAC
 * deploy, a legacy-asset cleanup. Picking from all of them once produced a receipt reading
 * "settled 0.0500 SXT" over the hash of a `changeTrust` operation, which is a small lie
 * told confidently. The `amount` test is the stronger half of the filter now: the receipt
 * is sourced entirely from the transaction, so a row without one cannot fill it.
 */
const paymentTxs = testnetTxs.filter(
  (t) => /^(demo|conformance):/i.test(t.label ?? '') && Boolean(t.amount),
)

/** deterministic pick so the same sight always shows the same settled payment */
function txPick(id: string): TxEntry | undefined {
  const pool = paymentTxs.length ? paymentTxs : []
  if (!pool.length) return undefined
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return pool[h % pool.length]
}

/**
 * Traces one x402 round trip: 402 → sign → settle → 200.
 *
 * This is a REPLAY, and the UI says so. It walks the four stages on a timer and lands on
 * a real settled testnet transaction drawn from docs/TESTNET-TXS.md — it does not settle
 * a payment at click time. The facilitator is deployed — /supported, /verify and /settle
 * answer on this origin — so what this panel withholds is the click-time settlement, not
 * the service.
 *
 * The hash is genuine, which is exactly why the labelling matters: a viewer who clicks
 * through to stellar.expert sees `successful: true` and would otherwise reasonably
 * conclude they had just triggered it. So the receipt states the date, and every figure in
 * it — amount, payer, payee, asset — is read off that transaction rather than off the
 * record the visitor clicked. The record's price drives the 402 challenge in steps 1-2 and
 * nothing else; the two are different numbers and pretending otherwise is what the panel
 * used to do.
 */
export function PaymentLoop({ rec, runId }: { rec: StellarsightRecord | null; runId: number }) {
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
  const tx = txPick(rec.id)
  const when = settledOn(tx?.settledAt)
  // Horizon returns a decimal string ("0.0050000"); formatAmount expects stroops and would
  // turn it into 5.00e-10. Different unit, different formatter.
  const settledAmount = tx?.amount
    ? Number(tx.amount).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
    : undefined
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
      // No `payer` line. It used to print rec.payTo — the seller's payout address, the same
      // key the step above prints as the destination. A payment cannot have payer == payTo.
      // Steps 1-2 describe the terms this record advertises; the accounts that actually moved
      // value belong in the receipt, sourced from the transaction.
      wire: `value  ${amount} ${ASSET_CODE}
fees   sponsored (areFeesSponsored: true)`,
    },
    {
      title: 'Settle',
      code: <span className="step__code">POST /settle</span>,
      note: 'The facilitator verifies the entry and submits it to Stellar testnet.',
      wire: `POST https://stellarsight.xyz/settle
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
          title="This traces a settled payment step by step. It does not settle one at click time. The hash below is from a real testnet run, and the facilitator that settled it answers on this origin."
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

        {stage >= 4 &&
          (tx ? (
            /*
             * Every figure here comes from the linked transaction, none from the record.
             * The record's price and this settlement's amount are different numbers and
             * always were: seed prices top out at 0.0015 SXT, the smallest demo settlement
             * moved 0.005, so the two ranges never overlap. Printing the record's price over
             * a real hash guaranteed that anyone who opened stellar.expert saw the page
             * contradicted. The terms live in steps 1-2; this block is the settlement.
             */
            <div className="receipt">
              <p className="step__note" style={{ marginBottom: '0.7rem' }}>
                A settlement that already happened, replayed. Not this record, and not now —
                every figure below is read off the transaction.
              </p>
              <div className="receipt__row">
                <span>moved</span>
                <b>
                  {settledAmount} {tx.assetCode ?? ASSET_CODE}
                </b>
              </div>
              {tx.from ? (
                <div className="receipt__row">
                  <span>payer</span>
                  <b>{shortKey(tx.from, 6, 6)}</b>
                </div>
              ) : null}
              {tx.to ? (
                <div className="receipt__row">
                  <span>paid to</span>
                  <b>{shortKey(tx.to, 6, 6)}</b>
                </div>
              ) : null}
              <div className="receipt__row">
                <span>network</span>
                <b>{rec.network}</b>
              </div>
              {when ? (
                <div className="receipt__row">
                  <span>settled on</span>
                  <b>{when}</b>
                </div>
              ) : null}
              <a
                className="receipt__hash"
                href={explorerTx(tx.hash)}
                target="_blank"
                rel="noreferrer noopener"
              >
                {shortHash(tx.hash)} ↗ stellar.expert
              </a>
              <p className="step__note" style={{ marginTop: '0.7rem' }}>
                Open it: the amount, the accounts and the date above are what you will find.
                Fees were paid by the facilitator, not the payer. Run <code>npm run demo</code>{' '}
                to drive a fresh payment through this same hosted stack.
              </p>
            </div>
          ) : (
            <div className="receipt">
              <p className="step__note">
                No settled transaction is on file for this resource, so there is nothing to
                replay. The steps above are the terms it advertises, not a payment.
              </p>
            </div>
          ))}
      </div>
    </section>
  )
}
