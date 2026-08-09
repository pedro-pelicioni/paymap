/** Engraved instrument marks — all inline SVG, no image dependencies. */

import { useReveal } from '../lib/reveal'

export function PaymapGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 21 A18 18 0 0 1 21 3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 21 L21 3" fill="none" stroke="currentColor" strokeWidth="0.7" opacity="0.5" />
      <path d="M3 21 L15.5 13" fill="none" stroke="var(--brass)" strokeWidth="1.3" />
      <circle cx="3" cy="21" r="1.6" fill="currentColor" />
      <circle cx="15.5" cy="13" r="1.4" fill="var(--brass)" />
      {[0, 1, 2, 3, 4].map((i) => {
        const a = (Math.PI / 4) * 1 + (i * Math.PI) / 12
        return (
          <line
            key={i}
            x1={3 + 18 * Math.cos(a)}
            y1={21 - 18 * Math.sin(a)}
            x2={3 + 15.5 * Math.cos(a)}
            y2={21 - 15.5 * Math.sin(a)}
            stroke="currentColor"
            strokeWidth="0.7"
            opacity="0.65"
          />
        )
      })}
    </svg>
  )
}

/** Faint star chart for the hero backdrop. */
export function StarChart() {
  const stars: [number, number, number][] = [
    [60, 120, 2.6], [180, 60, 1.7], [250, 190, 3.1], [330, 90, 1.9], [410, 240, 2.2],
    [470, 130, 1.5], [540, 300, 2.8], [120, 300, 1.6], [610, 190, 2], [300, 360, 1.8],
    [690, 90, 1.4], [200, 440, 2.4], [420, 440, 1.5], [560, 60, 1.8], [640, 380, 2.1],
  ]
  const lines: [number, number][][] = [
    [[60, 120], [180, 60]], [[180, 60], [330, 90]], [[330, 90], [470, 130]],
    [[470, 130], [610, 190]], [[250, 190], [330, 90]], [[250, 190], [120, 300]],
    [[540, 300], [610, 190]], [[540, 300], [420, 440]], [[420, 440], [300, 360]],
    [[300, 360], [250, 190]], [[610, 190], [640, 380]],
  ]
  return (
    <div className="chart-bg" aria-hidden="true">
      <svg viewBox="0 0 760 520" fill="none">
        <g stroke="var(--fg)" strokeWidth="0.6" opacity="0.28">
          {lines.map(([a, b], i) => (
            <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
          ))}
        </g>
        {/* declination arcs */}
        <g stroke="var(--fg)" strokeWidth="0.5" opacity="0.14" fill="none">
          <circle cx="380" cy="250" r="170" />
          <circle cx="380" cy="250" r="250" />
          <circle cx="380" cy="250" r="330" />
        </g>
        {/* graduated arc, brass */}
        <g>
          <path d="M120 470 A360 360 0 0 1 480 110" stroke="var(--brass)" strokeWidth="1" opacity="0.55" fill="none" />
          {Array.from({ length: 19 }).map((_, i) => {
            const a = Math.PI + (i * Math.PI) / 36
            const cx = 480
            const cy = 470
            const r1 = 360
            const r2 = i % 3 === 0 ? 348 : 354
            return (
              <line
                key={i}
                x1={cx + r1 * Math.cos(a)}
                y1={cy + r1 * Math.sin(a)}
                x2={cx + r2 * Math.cos(a)}
                y2={cy + r2 * Math.sin(a)}
                stroke="var(--brass)"
                strokeWidth="0.9"
                opacity="0.5"
              />
            )
          })}
        </g>
        {stars.map(([x, y, r], i) => (
          <circle
            key={i}
            className="star"
            cx={x}
            cy={y}
            r={r}
            fill={i % 5 === 0 ? 'var(--brass)' : 'var(--fg)'}
            style={{ animationDelay: `${(i % 7) * 0.6}s` }}
          />
        ))}
      </svg>
    </div>
  )
}

/** Vertical graduated scale beside the sight board. */
export function ArcScale() {
  return (
    <div className="arcscale" aria-hidden="true">
      <svg viewBox="0 0 26 320" fill="none" preserveAspectRatio="none">
        <path d="M20 6 A300 300 0 0 0 20 314" stroke="var(--rule)" strokeWidth="1" fill="none" />
        {Array.from({ length: 13 }).map((_, i) => {
          const y = 6 + i * (308 / 12)
          const major = i % 3 === 0
          return (
            <g key={i}>
              <line
                x1={major ? 8 : 13}
                y1={y}
                x2={20}
                y2={y}
                stroke={major ? 'var(--fg-3)' : 'var(--rule)'}
                strokeWidth="1"
              />
              {major && (
                <text
                  x="0"
                  y={y + 3}
                  fill="var(--fg-3)"
                  style={{ font: "8px 'DM Mono', monospace", letterSpacing: '0.08em' }}
                >
                  {90 - i * 7.5}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

const FEEDBACK_ARC = 'M890 152 C890 250, 370 250, 370 152'

/**
 * The four-step loop, drawn as an instrument plate.
 *
 * It draws itself when it scrolls into view — stations first, then the brass
 * wires between them left to right, then the jade feedback arc right to left,
 * and finally a pulse that keeps running that arc. The technique is the one
 * behind every "animated beam" component: give the path `pathLength="1"` so a
 * dash pattern can be written in fractions of the path, then move
 * `stroke-dashoffset`. Drawing beats a static arrow here because the feedback
 * arc is the diagram's one non-obvious claim — settlements re-rank the index —
 * and a line that travels backwards says that faster than a caption does.
 */
export function LoopDiagram() {
  const ref = useReveal<SVGSVGElement>()
  const nodes = [
    { x: 110, t: 'ADVERTISE', s: 'seller upserts a record' },
    { x: 370, t: 'DISCOVER', s: 'agent searches in words' },
    { x: 630, t: 'SETTLE', s: '402 → sign → settle → 200' },
    { x: 890, t: 'CONSUME', s: 'agent uses the response' },
  ]
  return (
    <svg
      ref={ref}
      className="loopdia"
      viewBox="0 0 1000 300"
      role="img"
      aria-label="The PAYMAP loop: advertise, discover, settle, consume, with settlements feeding back into ranking."
    >
      <g stroke="var(--rule)" strokeWidth="1">
        <line x1="0" y1="118" x2="1000" y2="118" />
      </g>
      {nodes.slice(0, -1).map((n, i) => (
        <g key={i} style={{ ['--i' as string]: i }}>
          <path
            className="wire"
            pathLength={1}
            d={`M${n.x + 62} 118 L${nodes[i + 1].x - 68} 118`}
            stroke="var(--brass)"
            strokeWidth="1.4"
            fill="none"
          />
          <path
            className="tip"
            d={`M${nodes[i + 1].x - 74} 112 l7 6 -7 6`}
            stroke="var(--brass)"
            strokeWidth="1.4"
            fill="none"
          />
        </g>
      ))}
      {/* feedback arc: settlement count feeds the ranking */}
      {/* no pathLength here: it would rescale the 4-4 dash into one solid dash */}
      <path
        className="feed"
        d={FEEDBACK_ARC}
        stroke="var(--good)"
        strokeWidth="1.2"
        strokeDasharray="4 4"
        fill="none"
      />
      {/* the settlement travelling back up the arc, drawn over it */}
      <path
        className="pulse"
        pathLength={1}
        d={FEEDBACK_ARC}
        stroke="var(--good)"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
        aria-hidden="true"
      />
      <path className="tip feed-tip" d="M364 158 l6 -7 6 7" stroke="var(--good)" strokeWidth="1.2" fill="none" />
      <text className="feed-tip" x="630" y="268" textAnchor="middle" fill="var(--good)" style={{ font: "11px 'DM Mono', monospace", letterSpacing: '0.14em' }}>
        SETTLEMENTS FEED THE RANKING
      </text>
      {nodes.map((n, i) => (
        <g className="node" style={{ ['--i' as string]: i }} key={n.t}>
          <circle cx={n.x} cy="118" r="34" fill="var(--bg)" stroke="var(--fg)" strokeWidth="1" />
          <circle cx={n.x} cy="118" r="27" fill="none" stroke="var(--rule)" strokeWidth="1" />
          <text x={n.x} y="124" textAnchor="middle" fill="var(--fg)" style={{ font: "italic 22px 'Instrument Serif', serif" }}>
            {i + 1}
          </text>
          <text x={n.x} y="42" textAnchor="middle" fill="var(--fg)" style={{ font: "500 11px 'DM Mono', monospace", letterSpacing: '0.18em' }}>
            {n.t}
          </text>
          <text x={n.x} y="64" textAnchor="middle" fill="var(--fg-2)" style={{ font: "12px 'Bricolage Grotesque', sans-serif" }}>
            {n.s}
          </text>
        </g>
      ))}
    </svg>
  )
}
