import { useCallback, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { CopyButton } from '../components/CopyButton'
import { StellarsightMark } from '../components/Marks'
import { ROUTES, SELLER_URL, type PlaygroundRoute } from '../lib/playground/config'
import { discoverAsset, establishTrustline, fundWithFriendbot, generateKeypair, requestFaucet } from '../lib/playground/onboard'
import { payInBrowser, type PayEvent } from '../lib/playground/payBrowser'
import { corruptSignature, inflateEcho, replayPayment, type AttackOutcome } from '../lib/playground/tamper'
import { INDEX_URL } from '../lib/api'

type StepId = 'key' | 'fund' | 'trust' | 'faucet' | 'pay' | 'bazaar' | 'break'
type Status = 'idle' | 'running' | 'done' | 'failed'

type StepState = {
  status: Status
  detail?: string
  error?: { code: string; reason: string }
}

const INITIAL: Record<StepId, StepState> = {
  key: { status: 'idle' },
  fund: { status: 'idle' },
  trust: { status: 'idle' },
  faucet: { status: 'idle' },
  pay: { status: 'idle' },
  bazaar: { status: 'idle' },
  break: { status: 'idle' },
}

const short = (s: string, head = 6, tail = 6) => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s)

/**
 * Each attack, with the property it tests and the outcome that property predicts.
 *
 * `expect` is written out because two of these are refused and one is not, and a page
 * that painted all three green without saying which was which would be claiming the
 * wrong controls. Every line here was checked against the live chain; see
 * test/replay-naming.test.mjs, which pins the same three properties.
 */
const ATTACKS: { kind: AttackOutcome['kind']; title: string; expect: string; mechanism: string }[] = [
  {
    kind: 'replay',
    title: 'resend the authorization that already settled',
    expect: 'must be refused',
    mechanism:
      'A Soroban authorization entry carries a nonce and is consumed when it settles, so the chain refuses the second submission on its own. This facilitator also remembers the (address, nonce) pair it settled — the same key the chain protects on — so the refusal can say “replay” instead of the opaque simulation error the upstream package returns.',
  },
  {
    kind: 'corrupt-signature',
    title: 'flip a byte inside the signed envelope',
    expect: 'must be refused',
    mechanism:
      'The signature covers the transaction, so mutating any of it invalidates the entry. This one signs a fresh, unspent authorization first: mutating a spent one would be refused for its nonce, and the refusal would get miscredited to signature validation.',
  },
  {
    kind: 'inflate-echo',
    title: 'multiply the echoed price by 100',
    expect: 'must settle at the original price',
    mechanism:
      'The price a client echoes back is decoration. The seller re-derives price, asset and recipient from its own route table, and the money moves according to the signed transaction — so inflating the echo is ignored rather than refused. Being charged the true amount is the control working; an overcharge would be the finding.',
  },
]

/** One HTTP exchange, rendered so the protocol is visible rather than described. */
function Exchange({ e }: { e: Extract<PayEvent, { stage: 'http' }> }) {
  const [open, setOpen] = useState(false)
  const decodedChallenge = e.headers['PAYMENT-REQUIRED']
  return (
    <div className="pg-exchange">
      <button className="pg-exchange__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`pg-code pg-code--${e.status === 200 ? 'ok' : e.status === 402 ? 'pay' : 'warn'}`}>{e.status}</span>
        <code>
          {e.method} {new URL(e.url).pathname}
        </code>
        {e.note && <span className="pg-note">{e.note}</span>}
        <span className="pg-exchange__chev">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="pg-exchange__body">
          {Object.entries(e.headers).length > 0 && (
            <dl className="pg-headers">
              {Object.entries(e.headers).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>
                    <code>{short(v, 40, 12)}</code>
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {decodedChallenge && (
            <p className="pg-hint">
              That header is base64 — the challenge (price, asset, recipient) travels in it, which is where x402 v2
              puts it.
            </p>
          )}
          {e.body !== undefined && e.body !== '' && (
            <pre className="pg-pre">{typeof e.body === 'string' ? e.body : JSON.stringify(e.body, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  )
}

export default function Playground() {
  const [steps, setSteps] = useState(INITIAL)
  const [wallet, setWallet] = useState<{ secret: string; publicKey: string } | null>(null)
  const [revealSecret, setRevealSecret] = useState(false)
  const [asset, setAsset] = useState<{ code: string; issuer: string } | null>(null)
  const [route, setRoute] = useState<PlaygroundRoute>(ROUTES[0])
  const [exchanges, setExchanges] = useState<Extract<PayEvent, { stage: 'http' }>[]>([])
  const [receipt, setReceipt] = useState<{ txHash: string | null; explorerUrl: string | null; amount: string; elapsedMs: number } | null>(null)
  const [cataloging, setCataloging] = useState<string | null>(null)
  const [bazaar, setBazaar] = useState<{ before: number | null; after: number | null; serviceName: string } | null>(null)
  const [attacks, setAttacks] = useState<AttackOutcome[]>([])
  const paymentHeader = useRef<string | null>(null)

  const set = useCallback((id: StepId, next: StepState) => setSteps((s) => ({ ...s, [id]: next })), [])

  const busy = Object.values(steps).some((s) => s.status === 'running')
  const target = useMemo(() => `${SELLER_URL || window.location.origin}${route.path}`, [route])

  /** Steps 1-4: a funded buyer, from nothing. */
  const onboard = useCallback(async () => {
    setExchanges([])
    setReceipt(null)
    setAttacks([])
    setBazaar(null)
    paymentHeader.current = null

    set('key', { status: 'running' })
    const kp = generateKeypair()
    setWallet(kp)
    set('key', { status: 'done', detail: kp.publicKey })

    set('fund', { status: 'running' })
    const funded = await fundWithFriendbot(kp.publicKey)
    if (!funded.ok) return set('fund', { status: 'failed', error: funded })
    set('fund', { status: 'done', detail: '10,000 test XLM from Friendbot' })

    set('trust', { status: 'running' })
    const found = await discoverAsset(kp.publicKey)
    if (!found.ok) return set('trust', { status: 'failed', error: found })
    setAsset({ code: found.assetCode, issuer: found.assetIssuer })

    if (!found.granted) {
      const trusted = await establishTrustline(kp.secret, found.assetCode, found.assetIssuer)
      if (!trusted.ok) return set('trust', { status: 'failed', error: trusted })
      set('trust', { status: 'done', detail: `signed in this tab · tx ${short(trusted.txHash, 8, 6)}` })
    } else {
      set('trust', { status: 'done', detail: 'already trusted' })
    }

    set('faucet', { status: 'running' })
    const grant = await requestFaucet(kp.publicKey)
    if (!grant.ok) return set('faucet', { status: 'failed', error: grant })
    set('faucet', { status: 'done', detail: `${grant.amount} ${grant.assetCode} · limiter: ${grant.limiter}` })
  }, [set])

  /** Step 5-6: the real paid call, and the listing it feeds. */
  const pay = useCallback(async () => {
    if (!wallet) return
    set('pay', { status: 'running' })
    setExchanges([])

    // Snapshot the listing before paying, so the delta afterwards is measured, not claimed.
    let before: number | null = null
    let serviceName = route.label
    try {
      const r = await fetch(`${INDEX_URL}/discovery/search?query=${encodeURIComponent(route.label)}&limit=5`)
      const j = await r.json()
      const hit = (j.resources ?? j.items ?? []).find((x: { resource?: { url?: string } }) =>
        String(x?.resource?.url ?? '').includes(route.path.split('/').slice(0, 3).join('/')),
      )
      if (hit) {
        before = Number(hit.settlements ?? 0)
        serviceName = hit.serviceName ?? hit.resource?.serviceName ?? serviceName
      }
    } catch {
      /* the delta is a nice-to-have; the payment is the point */
    }

    const result = await payInBrowser(target, {
      payerSecret: wallet.secret,
      method: route.method,
      body: route.body,
      onEvent: (e) => {
        if (e.stage === 'http') setExchanges((x) => [...x, e])
      },
    })

    if (!result.ok) return set('pay', { status: 'failed', error: result })
    if (result.signedOnly) {
      // Unreachable in this flow — `signOnly` is only used by the adversarial step — but
      // narrowing it here is what lets the settled fields below be read without a cast.
      return set('pay', {
        status: 'failed',
        error: { code: 'PLAYGROUND_UNEXPECTED', reason: 'the payment stopped at the signature instead of settling' },
      })
    }

    paymentHeader.current = result.paymentHeader
    setReceipt({ txHash: result.txHash, explorerUrl: result.explorerUrl, amount: result.amount, elapsedMs: result.elapsedMs })
    const bazaarStatus = (result.extensions as { bazaar?: { status?: string } } | null)?.bazaar?.status ?? null
    setCataloging(bazaarStatus)
    set('pay', { status: 'done', detail: `settled in ${(result.elapsedMs / 1000).toFixed(1)}s` })

    // The aha: this settlement is now part of the listing's public history.
    set('bazaar', { status: 'running' })
    try {
      const r = await fetch(`${INDEX_URL}/discovery/search?query=${encodeURIComponent(route.label)}&limit=5`)
      const j = await r.json()
      const hit = (j.resources ?? j.items ?? []).find((x: { resource?: { url?: string } }) =>
        String(x?.resource?.url ?? '').includes(route.path.split('/').slice(0, 3).join('/')),
      )
      const after = hit ? Number(hit.settlements ?? 0) : null
      setBazaar({ before, after, serviceName })
      set('bazaar', { status: 'done' })
    } catch (e) {
      set('bazaar', { status: 'failed', error: { code: 'INDEX_UNREACHABLE', reason: String(e) } })
    }
  }, [wallet, route, target, set])

  /** Step 7: break it on purpose. */
  const breakIt = useCallback(async () => {
    if (!wallet || !paymentHeader.current) return
    set('break', { status: 'running' })
    setAttacks([])
    const opts = { payerSecret: wallet.secret, method: route.method, body: route.body }

    const results: AttackOutcome[] = []
    for (const run of [
      () => replayPayment(target, paymentHeader.current as string, opts),
      () => corruptSignature(target, opts),
      () => inflateEcho(target, opts),
    ]) {
      results.push(await run())
      setAttacks([...results])
    }

    const failed = results.filter((r) => !r.passed && !r.notSent)
    const skipped = results.filter((r) => r.notSent)
    set('break', {
      status: failed.length ? 'failed' : 'done',
      detail: failed.length
        ? undefined
        : `${results.length - skipped.length} propert${results.length - skipped.length === 1 ? 'y' : 'ies'} held${skipped.length ? `, ${skipped.length} not run` : ''}`,
      error: failed.length
        ? {
            code: 'PROPERTY_VIOLATED',
            reason: `${failed.map((f) => f.kind).join(', ')} did not behave as the security property requires. That is a real finding — please open an issue with the transaction hash.`,
          }
        : undefined,
    })
  }, [wallet, route, target, set])

  const Step = ({ id, n, title, children }: { id: StepId; n: number; title: string; children?: React.ReactNode }) => {
    const s = steps[id]
    return (
      <li className={`pg-step pg-step--${s.status}`}>
        <div className="pg-step__n">{s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : n}</div>
        <div className="pg-step__body">
          <h3 className="pg-step__title">{title}</h3>
          {s.detail && <p className="pg-step__detail">{s.detail}</p>}
          {s.error && (
            <p className="pg-step__error">
              <code>{s.error.code}</code> {s.error.reason}
            </p>
          )}
          {children}
        </div>
      </li>
    )
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
            <Link to="/console">Console</Link>
            <Link to="/explorer">Explorer</Link>
          </nav>
          <span className="source-pill source-pill--seed" title="Everything here happens on Stellar testnet with a key generated in this tab.">
            <span className="dot" />
            testnet · throwaway key
          </span>
        </div>
      </header>

      <main id="main" className="shell pg">
        <div className="pg-head">
          <span className="label">Playground</span>
          <h1 className="console__title">
            Pay for something, <em>right now.</em>
          </h1>
          <p className="pg-lede">
            No wallet, no signup, no API key. This page generates a Stellar keypair that never leaves your browser,
            funds it, and completes a real x402 payment on testnet — the same loop an AI agent runs, with every HTTP
            exchange shown. The asset is a demo token with no value.
          </p>
        </div>

        <ol className="pg-steps">
          <Step id="key" n={1} title="A keypair, made here">
            {wallet && (
              <div className="pg-key">
                <div>
                  <span className="label">public</span>
                  <code>{wallet.publicKey}</code>
                  <CopyButton text={wallet.publicKey} what="public key" variant="bar" label="" />
                </div>
                <div>
                  <span className="label">secret</span>
                  <code>{revealSecret ? wallet.secret : '·'.repeat(24)}</code>
                  <button className="chip" onClick={() => setRevealSecret((v) => !v)}>
                    {revealSecret ? 'hide' : 'reveal'}
                  </button>
                </div>
                <p className="pg-hint">
                  In memory only. It is never stored, never sent anywhere — the faucet is given the public key — and it
                  is gone when you refresh. That is deliberate.
                </p>
              </div>
            )}
          </Step>

          <Step id="fund" n={2} title="Friendbot funds it with test XLM" />

          <Step id="trust" n={3} title="Your key signs its own trustline">
            {asset && (
              <p className="pg-hint">
                <code>
                  {asset.code}:{short(asset.issuer, 8, 6)}
                </code>{' '}
                — signed in this tab and submitted straight to Horizon. This trustline fee is the only XLM your key ever
                spends: the payment itself is fee-sponsored by the facilitator.
              </p>
            )}
          </Step>

          <Step id="faucet" n={4} title="The faucet grants the demo token" />

          <Step id="pay" n={5} title="A real 402 → sign → settle → 200">
            <div className="pg-routes">
              {ROUTES.map((r) => (
                <button
                  key={r.id}
                  className={`chip ${route.id === r.id ? 'chip--on' : ''}`}
                  aria-pressed={route.id === r.id}
                  onClick={() => setRoute(r)}
                  disabled={busy}
                >
                  {r.method} {r.label}
                </button>
              ))}
            </div>
            <p className="pg-hint">{route.blurb}</p>
            {exchanges.map((e, i) => (
              <Exchange key={i} e={e} />
            ))}
            {receipt && (
              <div className="pg-receipt">
                <p>
                  Settled {Number(receipt.amount) / 1e7} {asset?.code} in {(receipt.elapsedMs / 1000).toFixed(1)}s.
                </p>
                {receipt.explorerUrl && (
                  <a className="pg-tx" href={receipt.explorerUrl} target="_blank" rel="noreferrer">
                    {receipt.txHash} ↗
                  </a>
                )}
                {cataloging && (
                  <p className="pg-hint">
                    <code>EXTENSION-RESPONSES</code> reported <code>bazaar: {cataloging}</code> — the facilitator
                    catalogued the resource as a side effect of the settlement, with no registration step.
                  </p>
                )}
              </div>
            )}
          </Step>

          <Step id="bazaar" n={6} title="Your payment is now in the Bazaar's public history">
            {bazaar && (
              <p className="pg-hint">
                <strong>{bazaar.serviceName}</strong>{' '}
                {bazaar.before !== null && bazaar.after !== null ? (
                  <>
                    went from {bazaar.before} to {bazaar.after} settlements.
                  </>
                ) : (
                  <>is in the catalog.</>
                )}{' '}
                Anyone querying <Link to="/console">the console</Link> sees the same number — settlement count is a
                ranking signal, and it is the one signal a seller cannot write for itself.
              </p>
            )}
          </Step>

          <Step id="break" n={7} title="Now break it on purpose">
            <p className="pg-hint">
              Three attacks, each testing a different property. Two must be refused. The third must{' '}
              <em>settle</em> — at the original price — because the price a client echoes back is decoration, and
              ignoring it is the control. Each runs against a freshly signed authorization so the outcome is
              attributable to the property under test rather than to a spent nonce.
            </p>
            {ATTACKS.map((spec) => {
              const a = attacks.find((x) => x.kind === spec.kind)
              const state = !a ? 'pending' : a.notSent ? 'not-sent' : a.passed ? 'held' : 'violated'
              return (
                <div key={spec.kind} className={`pg-attack pg-attack--${state}`}>
                  <span className="pg-attack__k">
                    {spec.title} · <em>{spec.expect}</em>
                  </span>
                  {a && (
                    <>
                      <span className="pg-attack__v">
                        {/* `observed` already names the code, so printing it again read as
                            a stutter. The reason is the part that adds information. */}
                        {a.observed}
                        {a.reason && ` — ${a.reason}`}
                      </span>
                      {!a.notSent && <span className="pg-attack__why">{spec.mechanism}</span>}
                    </>
                  )}
                </div>
              )
            })}
          </Step>
        </ol>

        <div className="pg-actions">
          <button className="btn btn--primary" onClick={onboard} disabled={busy}>
            {wallet ? 'Start over with a new key' : 'Make me a buyer'}
          </button>
          <button className="btn" onClick={pay} disabled={busy || steps.faucet.status !== 'done'}>
            Pay for {route.label}
          </button>
          <button className="btn" onClick={breakIt} disabled={busy || steps.pay.status !== 'done'}>
            Try to break it
          </button>
        </div>

        <p className="pg-foot">
          Everything above ran against the same public endpoints documented in{' '}
          <a href="https://docs.stellarsight.xyz/evidence/verify-it-yourself">Verify it yourself</a>. The keypair dies
          with this tab; the settlement stays on chain.
        </p>
      </main>
    </div>
  )
}
