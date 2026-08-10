// Pulls real testnet tx hashes out of docs/TESTNET-TXS.md (written by another agent)
// into src/data/testnet-txs.json. Never fails the build: always exits 0.
//
// Each hash is then dated against Horizon. The console REPLAYS one of these as the
// outcome of a payment loop the visitor just watched animate, so the receipt has to say
// when the settlement actually happened — a real hash with no date reads as "this just
// happened", which is the one thing it is not. A date we cannot fetch is simply absent
// and the receipt drops the row; it is never guessed, and never stamped with now.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../src/data/testnet-txs.json')
const doc = resolve(here, '../../../docs/TESTNET-TXS.md')
const HORIZON = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org'
const FETCH_TIMEOUT_MS = 4000

/** Facts already on disk. An offline build keeps them rather than dropping them. */
function known() {
  try {
    const prev = JSON.parse(readFileSync(out, 'utf8'))
    return new Map(
      prev
        .filter((r) => r?.hash && (r.settledAt || r.amount))
        .map((r) => [r.hash, { settledAt: r.settledAt, amount: r.amount }]),
    )
  } catch {
    return new Map()
  }
}

/**
 * What Horizon says this transaction did: when it landed, and how much it actually moved.
 *
 * The amount matters as much as the date. The receipt used to print the catalogue record's
 * price beside this transaction's hash, and the two never agreed — the seed prices top out
 * at 0.0015 SXT while the smallest demo settlement moved 0.005, so a reviewer clicking
 * through to stellar.expert was guaranteed to see a figure contradicting the page.
 *
 * Returns undefined for anything we cannot stand behind: an unreachable Horizon, a failed
 * transaction (it settled nothing), or an operation with no single asset movement to name.
 */
async function fromHorizon(hash) {
  try {
    const res = await fetch(`${HORIZON}/transactions/${hash}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return {}
    const body = await res.json()
    if (body?.successful !== true) return {}
    const settledAt = typeof body?.created_at === 'string' ? body.created_at : undefined

    const ops = await fetch(`${HORIZON}/transactions/${hash}/operations`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    let amount
    if (ops.ok) {
      const records = (await ops.json())?._embedded?.records ?? []
      const moves = records
        .flatMap((op) => op?.asset_balance_changes ?? [])
        .filter((c) => c?.type === 'transfer' && c?.amount)
      // Exactly one transfer, or we cannot say "this settlement moved X" without picking.
      if (moves.length === 1) amount = String(moves[0].amount)
    }
    return { settledAt, amount }
  } catch {
    return {}
  }
}

try {
  if (!existsSync(doc)) {
    console.log('[sync-txs] docs/TESTNET-TXS.md not present — keeping current data')
    process.exit(0)
  }
  const md = readFileSync(doc, 'utf8')
  const seen = new Set()
  const rows = []
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    const m = line.match(/\b([a-fA-F0-9]{64})\b/)
    if (!m) continue
    const hash = m[1].toLowerCase()
    if (seen.has(hash)) continue
    seen.add(hash)
    // label = whatever human text sits on the line, minus the hash and md noise
    let label = line
      .replace(m[1], '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[|`*_>#\[\]()-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (label.length > 64) label = label.slice(0, 64).trim()
    rows.push({ hash, label: label || 'settlement', source: 'live' })
  }
  if (!rows.length) {
    console.log('[sync-txs] no 64-hex hashes found — keeping current data')
    process.exit(0)
  }

  const cached = known()
  const enriched = await Promise.all(
    rows.map(async (row) => {
      const prev = cached.get(row.hash)
      const fresh = prev?.settledAt && prev?.amount ? prev : await fromHorizon(row.hash)
      const settledAt = prev?.settledAt ?? fresh.settledAt
      const amount = prev?.amount ?? fresh.amount
      return { ...row, ...(settledAt ? { settledAt } : {}), ...(amount ? { amount } : {}) }
    }),
  )
  const withDate = enriched.filter((r) => r.settledAt).length
  const withAmount = enriched.filter((r) => r.amount).length

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(enriched, null, 2) + '\n')
  console.log(
    `[sync-txs] wrote ${enriched.length} tx hash(es), ${withDate} dated, ${withAmount} with amount`,
  )
} catch (err) {
  console.log('[sync-txs] skipped:', err && err.message)
}
process.exit(0)
