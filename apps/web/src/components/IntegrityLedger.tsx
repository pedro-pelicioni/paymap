import type { IntegrityProvenance } from '../lib/types'

const clock = (t: number) =>
  new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const day = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : null

/**
 * The facilitator is a trust boundary, not a mailbox. This is the ledger of what
 * the index refused or stripped on the way in.
 *
 * Two sources feed it and the panel distinguishes them, because they are not worth
 * the same thing to a reader. `live` verdicts were reported by a running index.
 * Otherwise these are a REPLAY: a fixed hostile corpus pushed through the same
 * validator by apps/web/scripts/gen-integrity.mjs, with every rule, verdict and reason
 * captured verbatim from its output. The replay is real evidence that the validator
 * works; it is not evidence that anyone attacked the catalog today, and labelling it
 * as though it were is the failure this component is written to avoid.
 */
export function IntegrityLedger({ ledger }: { ledger: IntegrityProvenance }) {
  const { entries, live, generatedAt, commit } = ledger
  const rejected = entries.filter((e) => e.verdict === 'rejected').length

  /*
   * A replay runs in one pass, so its verdicts share one timestamp. The panel used to
   * print a distinct wall-clock per row — the generator staged them 7 minutes apart —
   * and sixteen evenly-spaced "events" trailing the viewer's own clock read as an
   * attack log from the last two hours. Live verdicts keep their real, varying times;
   * a single-run replay gets ordinals, and the one true time goes in the lead line.
   */
  const oneRun = entries.length > 1 && entries.every((e) => e.at === entries[0].at)
  const runClock = generatedAt
    ? new Date(generatedAt).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      })
    : null

  return (
    <section className="plate" aria-labelledby="integrity-h">
      <header className="plate__cap">
        <span className="label" id="integrity-h">
          Catalog integrity
        </span>
        <span className="label" style={{ marginLeft: 'auto', color: 'var(--warn)' }}>
          {rejected} rejected / {entries.length - rejected} stripped
        </span>
      </header>

      <p className="ledger__prov">
        {live ? (
          <>
            <span className="dot dot--pulse" /> Observed by the running index.
          </>
        ) : (
          <>
            <span className="dot" /> Replay of the hostile corpus through the validator, in
            one run{day(generatedAt) ? ` on ${day(generatedAt)}` : null}
            {runClock ? ` at ${runClock} UTC` : null}
            {commit ? ` (commit ${commit})` : null}. Every verdict below is the validator's
            own output — run <code>npm test</code> for the cases behind them.
          </>
        )}
      </p>

      <div className="ledger">
        {entries.length === 0 && (
          <p className="ledger__why" style={{ padding: '0.8rem 0' }}>
            Nothing refused yet in this window.
          </p>
        )}
        {entries.slice(0, 12).map((e, i) => (
          <article className="ledger__row" key={`${e.rule}-${i}`}>
            {oneRun ? (
              <span className="ledger__t">{String(i + 1).padStart(2, '0')}</span>
            ) : (
              <time className="ledger__t" dateTime={new Date(e.at).toISOString()}>
                {clock(e.at)}
              </time>
            )}
            <div>
              <div>
                <span className={`verdict verdict--${e.verdict}`}>
                  {e.verdict === 'rejected' ? 'rejected' : 'soft-drop'}
                </span>
                <span className="ledger__rule">{e.rule}</span>
              </div>
              <code className="ledger__input">{e.input}</code>
              <p className="ledger__why">{e.reason}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
