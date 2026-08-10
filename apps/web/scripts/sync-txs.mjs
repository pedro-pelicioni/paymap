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

/** Dates already on disk. An offline build keeps them rather than dropping them. */
function knownDates() {
  try {
    const prev = JSON.parse(readFileSync(out, 'utf8'))
    return new Map(prev.filter((r) => r?.hash && r?.settledAt).map((r) => [r.hash, r.settledAt]))
  } catch {
    return new Map()
  }
}

/** Horizon's created_at for one hash, or undefined. Never throws. */
async function settledAt(hash) {
  try {
    const res = await fetch(`${HORIZON}/transactions/${hash}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return undefined
    const body = await res.json()
    // A failed transaction is still a transaction, but it settled nothing. Dating one
    // would put a timestamp next to a receipt that never moved an asset.
    if (body?.successful !== true) return undefined
    return typeof body?.created_at === 'string' ? body.created_at : undefined
  } catch {
    return undefined
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

  const cached = knownDates()
  const dated = await Promise.all(
    rows.map(async (row) => {
      const at = cached.get(row.hash) ?? (await settledAt(row.hash))
      return at ? { ...row, settledAt: at } : row
    }),
  )
  const withDate = dated.filter((r) => r.settledAt).length

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(dated, null, 2) + '\n')
  console.log(`[sync-txs] wrote ${dated.length} tx hash(es), ${withDate} dated`)
} catch (err) {
  console.log('[sync-txs] skipped:', err && err.message)
}
process.exit(0)
