/**
 * The x402 payment loop, in the browser.
 *
 * This is a port of `payAndFetch` from apps/agent/src/pay.mjs, not a reimplementation of
 * x402: the signing, encoding and header handling all come from the same published
 * packages the Node agent and the conformance script use — `@x402/fetch`,
 * `@x402/stellar`, `@x402/stellar/exact/client`. The only things that change in a browser
 * are the config layer (no .env) and base64 decoding (no Buffer).
 *
 * The error codes are the SAME enum, deliberately: a visitor who hits
 * `STELLARSIGHT_REPLAY_REJECTED` here and a developer who hits it from the CLI are being
 * told the same thing by the same contract. test/pay-browser-parity.test.mjs fails if the
 * two drift.
 *
 * `onEvent` is widened relative to pay.mjs: it also emits the raw HTTP exchanges, because
 * the playground's job is to SHOW the protocol, not just complete it.
 */

import './polyfill'

import { x402Client, x402HTTPClient } from '@x402/fetch'
import { ExactStellarScheme } from '@x402/stellar/exact/client'
import { createEd25519Signer } from '@x402/stellar'

import { NETWORK, RPC_URL } from './config'

/** The rejection vocabulary, mirrored from apps/agent/src/pay.mjs. */
export const ERROR_CODES = {
  STELLARSIGHT_BAD_REQUEST: 'STELLARSIGHT_BAD_REQUEST',
  STELLARSIGHT_RESOURCE_UNREACHABLE: 'STELLARSIGHT_RESOURCE_UNREACHABLE',
  STELLARSIGHT_402_MALFORMED: 'STELLARSIGHT_402_MALFORMED',
  STELLARSIGHT_UNSUPPORTED_NETWORK: 'STELLARSIGHT_UNSUPPORTED_NETWORK',
  STELLARSIGHT_SIGN_FAILED: 'STELLARSIGHT_SIGN_FAILED',
  STELLARSIGHT_INSUFFICIENT_BALANCE: 'STELLARSIGHT_INSUFFICIENT_BALANCE',
  STELLARSIGHT_REPLAY_REJECTED: 'STELLARSIGHT_REPLAY_REJECTED',
  STELLARSIGHT_AUTH_EXPIRED: 'STELLARSIGHT_AUTH_EXPIRED',
  STELLARSIGHT_SETTLE_FAILED: 'STELLARSIGHT_SETTLE_FAILED',
  STELLARSIGHT_UPSTREAM_ERROR: 'STELLARSIGHT_UPSTREAM_ERROR',
  STELLARSIGHT_TIMEOUT: 'STELLARSIGHT_TIMEOUT',
} as const

export type ErrorCode = keyof typeof ERROR_CODES

/** Same classifier as pay.mjs, same order — the parity test compares them string for string. */
export function classifySettleFailure(reasonText: unknown): ErrorCode {
  const r = String(reasonText || '').toLowerCase()
  if (/replay|already (used|paid|settled|attempted)|duplicate|nonce/.test(r)) return 'STELLARSIGHT_REPLAY_REJECTED'
  if (/expire|expired|too late|ledger bounds|timebound|time bound|stale/.test(r)) return 'STELLARSIGHT_AUTH_EXPIRED'
  if (/insufficient|balance|underfunded|trustline|no trust/.test(r)) return 'STELLARSIGHT_INSUFFICIENT_BALANCE'
  return 'STELLARSIGHT_SETTLE_FAILED'
}

export type PayEvent =
  | { stage: 'http'; method: string; url: string; status: number; headers: Record<string, string>; body?: unknown; note?: string }
  | { stage: 'challenge'; price: string; asset: string; payTo: string; x402Version: number; accepts: unknown[] }
  | { stage: 'signed'; headerBytes: number; payer: string }
  | { stage: 'settled'; txHash: string | null; explorerUrl: string | null }

export type PayResult =
  | {
      ok: true
      /** Present on both success variants so it discriminates the union. */
      signedOnly?: false
      status: number
      body: unknown
      txHash: string | null
      explorerUrl: string | null
      payer: string
      amount: string
      asset: string
      extensions: Record<string, unknown> | null
      paymentHeader: string | null
      elapsedMs: number
    }
  | {
      ok: true
      signedOnly: true
      paymentHeader: string
      amount: string
      asset: string
      payer: string
      elapsedMs: number
    }
  | { ok: false; code: string; reason: string; status?: number; body?: unknown; extensions?: Record<string, unknown> | null }

const fail = (code: string, reason: string, extra: Record<string, unknown> = {}) => ({
  ok: false as const,
  code,
  reason: reason?.trim() ? reason : `unspecified failure (${code})`,
  ...extra,
})

const errText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e))

/** Browser base64 → UTF-8, in place of Buffer.from(x, 'base64'). */
export function decodeBase64Json(value: string): Record<string, unknown> | null {
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

/** x402 v2 renamed `maxAmountRequired` to `amount`; accept either, as pay.mjs does. */
const requirementAmount = (a: Record<string, unknown>): string =>
  String((a?.amount ?? a?.maxAmountRequired ?? '0') as string)

const looksLikeTxHash = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s.trim())

const explorerFor = (txHash: string | null) =>
  txHash ? `https://stellar.expert/explorer/testnet/tx/${txHash}` : null

/** Headers worth showing in the transcript; the rest is noise. */
const INTERESTING = ['payment-required', 'payment-response', 'extension-responses', 'content-type', 'www-authenticate']

function pickHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of INTERESTING) {
    const v = res.headers.get(name)
    if (v) out[name.toUpperCase()] = v
  }
  return out
}

export type PayOptions = {
  payerSecret: string
  method?: string
  body?: unknown
  /** Send this exact PAYMENT-SIGNATURE instead of signing fresh — powers the "break it" step. */
  forcePaymentHeader?: string
  /**
   * Stop after signing and hand back the header without settling.
   *
   * The adversarial step needs a valid, UNSPENT authorization entry to mutate. A header
   * taken from a completed payment carries a consumed nonce, so every attack built on it
   * is refused for replay before the property under test is reached — and would then be
   * presented as evidence of that property. Nothing is charged on this path.
   */
  signOnly?: boolean
  onEvent?: (e: PayEvent) => void
  challengeTimeoutMs?: number
  settleTimeoutMs?: number
}

/**
 * Run one paid call: unpaid probe → 402 → sign → retry → settle.
 *
 * Timeouts are deliberately below the 60s serverless ceiling so a slow settlement
 * surfaces as OUR timeout with our reason, rather than as a CDN 504 the visitor has to
 * interpret.
 */
export async function payInBrowser(url: string, opts: PayOptions): Promise<PayResult> {
  const started = Date.now()
  const emit = (e: PayEvent) => {
    try {
      opts.onEvent?.(e)
    } catch {
      /* narration must never break the loop */
    }
  }
  const method = (opts.method ?? 'GET').toUpperCase()
  const challengeTimeout = opts.challengeTimeoutMs ?? 15_000
  const settleTimeout = opts.settleTimeoutMs ?? 50_000

  let signer
  let client
  let httpClient
  try {
    signer = createEd25519Signer(opts.payerSecret, NETWORK)
    client = new x402Client().register(NETWORK, new ExactStellarScheme(signer, { url: RPC_URL }))
    httpClient = new x402HTTPClient(client)
  } catch (e) {
    return fail('STELLARSIGHT_SIGN_FAILED', `Could not build a payment client for this key: ${errText(e)}`)
  }

  const baseHeaders: Record<string, string> = { accept: 'application/json' }
  const init: RequestInit = { method, headers: baseHeaders }
  if (method !== 'GET' && method !== 'HEAD' && opts.body !== undefined) {
    init.body = JSON.stringify(opts.body)
    baseHeaders['content-type'] = 'application/json'
  }

  const call = async (extra: Record<string, string> | undefined, timeoutMs: number) =>
    fetch(url, { ...init, headers: { ...baseHeaders, ...(extra ?? {}) }, signal: AbortSignal.timeout(timeoutMs) })

  /* 1 — the unpaid probe --------------------------------------------------- */

  let first: Response
  try {
    first = await call(undefined, challengeTimeout)
  } catch (e) {
    const timedOut = /abort|timeout/i.test(errText(e))
    return fail(
      timedOut ? 'STELLARSIGHT_TIMEOUT' : 'STELLARSIGHT_RESOURCE_UNREACHABLE',
      timedOut ? `The resource did not answer within ${challengeTimeout}ms.` : `Could not reach ${url}: ${errText(e)}`,
    )
  }

  const firstBody = await first.text()
  emit({
    stage: 'http',
    method,
    url,
    status: first.status,
    headers: pickHeaders(first),
    body: firstBody.slice(0, 400),
    note: 'no payment attached',
  })

  if (first.status !== 402) {
    return fail(
      'STELLARSIGHT_UPSTREAM_ERROR',
      `Expected a 402 challenge, got HTTP ${first.status}. A paid route answers 402 to an unpaid request.`,
      { status: first.status },
    )
  }

  /* 2 — the challenge, parsed by the SDK ----------------------------------- */

  // Typed as the SDK returns it: `getPaymentRequiredResponse` hands back the decoded
  // PaymentRequired, and `createPaymentPayload` takes exactly that value back. Narrowing
  // it to a local shape here would only mean re-widening it at the call below.
  let paymentRequired: Awaited<ReturnType<typeof httpClient.getPaymentRequiredResponse>>
  try {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(firstBody)
    } catch {
      /* v2 puts the challenge in the header; a body is optional */
    }
    paymentRequired = httpClient.getPaymentRequiredResponse((n: string) => first.headers.get(n), parsed)
  } catch (e) {
    return fail(
      'STELLARSIGHT_402_MALFORMED',
      `The 402 carried no decodable PAYMENT-REQUIRED header: ${errText(e)}. x402 v2 puts the PaymentRequired object in that header.`,
      { status: 402 },
    )
  }

  const accepts: Record<string, unknown>[] = Array.isArray(paymentRequired?.accepts)
    ? (paymentRequired.accepts as unknown as Record<string, unknown>[])
    : []
  const usable = accepts.filter((a) => a?.network === NETWORK && a?.scheme === 'exact')
  if (!usable.length) {
    return fail(
      'STELLARSIGHT_UNSUPPORTED_NETWORK',
      `This resource accepts [${accepts.map((a) => `${a?.scheme}@${a?.network}`).join(', ')}], and the playground pays exact@${NETWORK}.`,
      { status: 402 },
    )
  }
  const chosen = usable.reduce((lo, a) => (BigInt(requirementAmount(a)) < BigInt(requirementAmount(lo)) ? a : lo))
  const price = requirementAmount(chosen)

  emit({
    stage: 'challenge',
    price,
    asset: String(chosen.asset ?? ''),
    payTo: String(chosen.payTo ?? ''),
    x402Version: Number(paymentRequired.x402Version ?? 0),
    accepts,
  })

  /* 3 — sign the Soroban authorization entry ------------------------------- */

  let paymentHeaders: Record<string, string>
  if (opts.forcePaymentHeader) {
    paymentHeaders = { 'PAYMENT-SIGNATURE': opts.forcePaymentHeader, 'X-PAYMENT': opts.forcePaymentHeader }
    emit({ stage: 'signed', headerBytes: opts.forcePaymentHeader.length, payer: signer.address })
  } else {
    try {
      const payload = await client.createPaymentPayload(paymentRequired)
      const encoded = httpClient.encodePaymentSignatureHeader(payload)
      const value = encoded['PAYMENT-SIGNATURE'] ?? encoded['X-PAYMENT']
      paymentHeaders = { ...encoded, 'X-PAYMENT': value }
      emit({ stage: 'signed', headerBytes: String(value).length, payer: signer.address })
    } catch (e) {
      const msg = errText(e)
      const code = /insufficient|balance|trustline/i.test(msg)
        ? 'STELLARSIGHT_INSUFFICIENT_BALANCE'
        : 'STELLARSIGHT_SIGN_FAILED'
      return fail(code, `Could not sign the authorization entry for ${price} ${chosen.asset}: ${msg}`, { status: 402 })
    }
  }

  if (opts.signOnly) {
    return {
      ok: true,
      signedOnly: true as const,
      paymentHeader: paymentHeaders['PAYMENT-SIGNATURE'] ?? paymentHeaders['X-PAYMENT'],
      amount: price,
      asset: String(chosen.asset ?? ''),
      payer: signer.address,
      elapsedMs: Date.now() - started,
    }
  }

  /* 4 — the paid retry ----------------------------------------------------- */

  let second: Response
  try {
    second = await call(paymentHeaders, settleTimeout)
  } catch (e) {
    const timedOut = /abort|timeout/i.test(errText(e))
    return fail(
      timedOut ? 'STELLARSIGHT_TIMEOUT' : 'STELLARSIGHT_RESOURCE_UNREACHABLE',
      timedOut
        ? `Settlement did not complete within ${settleTimeout}ms. The payment may still have landed — check the payer account on stellar.expert before retrying.`
        : `The paid retry could not reach ${url}: ${errText(e)}`,
    )
  }

  const secondText = await second.text()
  let body: unknown = secondText
  try {
    body = JSON.parse(secondText)
  } catch {
    /* a non-JSON body is still a body */
  }

  const extHeader = second.headers.get('EXTENSION-RESPONSES')
  const extensions = extHeader ? decodeBase64Json(extHeader) : null

  emit({
    stage: 'http',
    method,
    url,
    status: second.status,
    headers: pickHeaders(second),
    body: typeof body === 'string' ? body.slice(0, 400) : body,
    note: 'PAYMENT-SIGNATURE attached',
  })

  let settle: { success?: boolean; errorReason?: string; transaction?: string; payer?: string } | null = null
  try {
    settle = httpClient.getPaymentSettleResponse((n: string) => second.headers.get(n))
  } catch {
    settle = null
  }

  if (second.status === 402) {
    const why = settle?.errorReason ?? (body as { error?: string })?.error
    return fail(
      classifySettleFailure(why),
      why ? `The seller rejected the payment: ${why}` : 'The seller answered 402 again and gave no errorReason.',
      { status: 402, body, extensions },
    )
  }

  if (settle && settle.success === false) {
    return fail(classifySettleFailure(settle.errorReason), `Settlement failed: ${settle.errorReason ?? 'no errorReason given'}`, {
      status: second.status,
      body,
      extensions,
    })
  }

  if (second.status >= 400) {
    return fail('STELLARSIGHT_UPSTREAM_ERROR', `The paid call returned HTTP ${second.status}.`, {
      status: second.status,
      body,
      extensions,
    })
  }

  const txHash = looksLikeTxHash(settle?.transaction) ? String(settle?.transaction).trim() : null
  emit({ stage: 'settled', txHash, explorerUrl: explorerFor(txHash) })

  return {
    ok: true,
    signedOnly: false,
    status: second.status,
    body,
    txHash,
    explorerUrl: explorerFor(txHash),
    payer: settle?.payer ?? signer.address,
    amount: price,
    asset: String(chosen.asset ?? ''),
    extensions,
    paymentHeader: paymentHeaders['PAYMENT-SIGNATURE'] ?? null,
    elapsedMs: Date.now() - started,
  }
}
