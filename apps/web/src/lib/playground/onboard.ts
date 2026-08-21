/**
 * The four steps that turn a browser tab into a funded x402 buyer.
 *
 * Each one is the browser counterpart of something scripts/setup-testnet.mjs does for a
 * developer, and each returns `{ ok }` or `{ ok: false, code, reason }` — never throws,
 * same contract as apps/agent/src/pay.mjs, so the UI renders a reason instead of a stack
 * trace.
 *
 * The secret key is generated here and returned to the caller, which holds it in React
 * state for the life of the tab. It is never written to storage, never sent to a server
 * (the faucet takes the PUBLIC key), and dies on refresh — which is the point, and what
 * the page says.
 */

import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder, BASE_FEE } from '@stellar/stellar-sdk'

import { FAUCET_URL, FRIENDBOT_URL, HORIZON_URL } from './config'

export type Step<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; code: string; reason: string }

const fail = (code: string, reason: string, extra: Record<string, unknown> = {}) => ({
  ok: false as const,
  code,
  reason: reason?.trim() ? reason : `unspecified failure (${code})`,
  ...extra,
})

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e)

/** A key that exists only in this tab. */
export function generateKeypair(): { secret: string; publicKey: string } {
  const kp = Keypair.random()
  return { secret: kp.secret(), publicKey: kp.publicKey() }
}

/** Testnet XLM, from the public faucet everyone uses. */
export async function fundWithFriendbot(publicKey: string): Promise<Step<{ alreadyFunded?: boolean }>> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(`${FRIENDBOT_URL}/?addr=${publicKey}`, { signal: AbortSignal.timeout(30_000) })
      if (r.ok) return { ok: true }
      const body = await r.text()
      // Friendbot answers 400 for an account it has already created — which is success.
      if (/op_already_exists|already funded/i.test(body)) return { ok: true, alreadyFunded: true }
      if (attempt === 2) return fail('FRIENDBOT_REFUSED', `Friendbot answered ${r.status}: ${body.slice(0, 200)}`)
    } catch (e) {
      if (attempt === 2) return fail('FRIENDBOT_UNREACHABLE', `Could not reach Friendbot: ${errText(e)}`)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return fail('FRIENDBOT_REFUSED', 'Friendbot did not fund the account.')
}

/**
 * Ask the faucet who the asset issuer is, by asking for a grant we know it will refuse.
 *
 * The account has no trustline yet, so the faucet answers FAUCET_NO_TRUSTLINE and names
 * the exact asset it wants trusted. Reading the issuer out of that refusal rather than
 * hardcoding it means the playground follows the deployment if the asset ever changes,
 * and it exercises the refusal path on the way through.
 */
export async function discoverAsset(publicKey: string): Promise<Step<{ assetCode: string; assetIssuer: string; granted?: unknown }>> {
  try {
    const r = await fetch(`${FAUCET_URL}/playground/fund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: publicKey }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await r.json()
    if (body?.code === 'FAUCET_NO_TRUSTLINE') {
      return { ok: true, assetCode: body.assetCode, assetIssuer: body.assetIssuer }
    }
    if (body?.ok) {
      // Already trusted (a re-run in the same tab): nothing left to establish.
      return { ok: true, assetCode: body.assetCode, assetIssuer: body.assetIssuer, granted: body }
    }
    return fail(body?.code ?? 'FAUCET_ERROR', body?.reason ?? `the faucet answered ${r.status}`)
  } catch (e) {
    return fail('FAUCET_UNREACHABLE', `Could not reach the faucet: ${errText(e)}`)
  }
}

/**
 * Sign and submit the trustline with the throwaway key, in the browser.
 *
 * This is the only XLM the visitor's key ever spends. The payment itself costs them
 * nothing: the facilitator sponsors the network fee, which is the claim the next step
 * demonstrates rather than asserts.
 */
export async function establishTrustline(
  secret: string,
  assetCode: string,
  assetIssuer: string,
): Promise<Step<{ txHash: string }>> {
  try {
    const kp = Keypair.fromSecret(secret)
    const horizon = new Horizon.Server(HORIZON_URL)
    const account = await horizon.loadAccount(kp.publicKey())
    const tx = new TransactionBuilder(account, {
      fee: String(Number(BASE_FEE) * 10),
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: new Asset(assetCode, assetIssuer) }))
      .setTimeout(60)
      .build()
    tx.sign(kp)
    const res = await horizon.submitTransaction(tx)
    return { ok: true, txHash: res.hash }
  } catch (e) {
    const codes = (e as { response?: { data?: { extras?: { result_codes?: unknown } } } })?.response?.data?.extras
      ?.result_codes
    return fail('TRUSTLINE_FAILED', `changeTrust was rejected: ${codes ? JSON.stringify(codes) : errText(e)}`)
  }
}

/** The grant itself, from the public endpoint, with its own rate limits. */
export async function requestFaucet(
  publicKey: string,
): Promise<Step<{ amount: string; assetCode: string; txHash: string | null; limiter: string; explorerUrl: string | null }>> {
  try {
    const r = await fetch(`${FAUCET_URL}/playground/fund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: publicKey }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await r.json()
    if (!body?.ok) {
      // The faucet's own reason is the diagnosis — a rate limit, a missing secret, a
      // Horizon outage. Pass it through verbatim rather than restating it.
      return fail(body?.code ?? 'FAUCET_ERROR', body?.reason ?? `the faucet answered ${r.status}`, {
        retryAfterSeconds: body?.retryAfterSeconds,
      })
    }
    return {
      ok: true,
      amount: body.amount,
      assetCode: body.assetCode,
      txHash: body.txHash ?? null,
      limiter: body.limiter,
      explorerUrl: body.explorerUrl ?? null,
    }
  } catch (e) {
    return fail('FAUCET_UNREACHABLE', `Could not reach the faucet: ${errText(e)}`)
  }
}
