import { ASSET_CODE } from '../lib/api'
import { formatAmount } from '../lib/format'
import type { PaymapRecord } from '../lib/types'

/** Continuously scrolling tape of what is live in the catalog. */
export function Ticker({ items }: { items: PaymapRecord[] }) {
  if (!items.length) return null
  const run = [...items, ...items]
  return (
    <div className="ticker" aria-hidden="true">
      <div className="ticker__track">
        {run.map((r, i) => (
          <span className="ticker__item" key={`${r.id}-${i}`}>
            <span className="tick">◦</span>
            <b>{r.resource.serviceName}</b>
            <span className="amt">
              {formatAmount(r.amount ?? r.maxAmountRequired)} {ASSET_CODE}
            </span>
            <span className="tick">{r.type.toUpperCase()}</span>
            <span className="tick">{r.seeded ? 'catalog' : `${r.settlements} settled`}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
