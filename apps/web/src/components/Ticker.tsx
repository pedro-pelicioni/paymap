import { ASSET_CODE } from '../lib/api'
import { formatAmount } from '../lib/format'
import type { StellarsightRecord } from '../lib/types'
import { CatalogPreview, HoverPreview } from './HoverPreview'

/**
 * One tape cell.
 *
 * The tape renders every item twice so the marquee can loop seamlessly. Only the
 * FIRST run is real content: it is announced and keyboard reachable. The second run
 * is a visual duplicate, so it stays `aria-hidden` and out of the tab order — a
 * focusable node inside an `aria-hidden` subtree is an accessibility fault, and
 * duplicate announcements of the same catalog entry are noise.
 */
function Cell({ r, focusable }: { r: StellarsightRecord; focusable: boolean }) {
  return (
    <HoverPreview className="ticker__item" focusable={focusable} content={<CatalogPreview record={r} />}>
      <span className="tick">◦</span>
      <b>{r.resource.serviceName}</b>
      <span className="amt">
        {formatAmount(r.amount ?? r.maxAmountRequired)} {ASSET_CODE}
      </span>
      <span className="tick">{r.type.toUpperCase()}</span>
      <span className="tick">{r.seeded ? 'catalog' : `${r.settlements} settled`}</span>
    </HoverPreview>
  )
}

/** Continuously scrolling tape of what is live in the catalog. */
export function Ticker({ items }: { items: StellarsightRecord[] }) {
  if (!items.length) return null
  return (
    <div className="ticker" role="group" aria-label="Live catalog tape">
      <div className="ticker__track">
        {items.map((r) => (
          <Cell key={r.id} r={r} focusable />
        ))}
        <span aria-hidden="true" style={{ display: 'contents' }}>
          {items.map((r) => (
            <Cell key={`dup-${r.id}`} r={r} focusable={false} />
          ))}
        </span>
      </div>
    </div>
  )
}
