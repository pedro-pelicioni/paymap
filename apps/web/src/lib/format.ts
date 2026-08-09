const DECIMALS = 7

/** stroops-style integer string -> human SXT amount */
export function formatAmount(raw: string | number | undefined): string {
  const n = Number(raw ?? 0)
  if (!Number.isFinite(n)) return '—'
  const v = n / 10 ** DECIMALS
  if (v === 0) return '0'
  if (v < 0.0001) return v.toExponential(2)
  return v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
}

export function shortKey(k: string | undefined, head = 4, tail = 4): string {
  if (!k) return '—'
  if (k.length <= head + tail + 1) return k
  return `${k.slice(0, head)}…${k.slice(-tail)}`
}

export function shortHash(h: string): string {
  return h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h
}

export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

export const sightNumber = (i: number) => String(i + 1).padStart(2, '0')

/** score 0..1 rendered as a paymap bearing, e.g. 0.62 -> "055.8°" */
export function bearing(score: number): string {
  const deg = Math.max(0, Math.min(1, score)) * 90
  return `${deg.toFixed(1).padStart(4, '0')}°`
}

export const explorerTx = (hash: string) =>
  `https://stellar.expert/explorer/testnet/tx/${hash}`

export const explorerAccount = (g: string) =>
  `https://stellar.expert/explorer/testnet/account/${g}`

export const explorerContract = (c: string) =>
  `https://stellar.expert/explorer/testnet/contract/${c}`

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}
