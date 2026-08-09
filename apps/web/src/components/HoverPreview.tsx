import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ASSET_CODE } from '../lib/api'
import { ago, formatAmount } from '../lib/format'
import type { StarsightRecord } from '../lib/types'
import '../styles/hover-preview.css'

/**
 * HoverPreview — a floating detail card that tracks the cursor.
 *
 * The technique, reduced to its useful core:
 *
 *  · the card lives in a portal on <body>, `position: fixed`, so an ancestor with
 *    `overflow: hidden` (the ticker, every plate) can never clip it;
 *  · pointermove only *writes a ref*. One rAF loop reads that ref, resolves the
 *    anchor against the viewport, and writes a single `translate3d`. There is no
 *    layout write per event, and nothing but transform/opacity is ever animated;
 *  · the loop damps toward the cursor exponentially — `1 - e^(-dt/TAU)` — which is
 *    frame-rate independent, unlike a fixed lerp factor. It stops scheduling once
 *    it is within a quarter pixel of the target and restarts on the next move, so
 *    a parked cursor costs nothing;
 *  · near a viewport edge the anchor *flips* to the other side of the cursor rather
 *    than being clamped, so the card is never squashed against the edge or clipped.
 *    The flip is published as `data-fx` / `data-fy` and the enter animation takes
 *    its transform-origin from it, so the card always grows out of the cursor.
 *
 * It is a preview, not a dialog: `pointer-events: none`, so it can never steal the
 * hover it was opened by, and nothing inside it is focusable.
 *
 * Two anchoring modes:
 *   'pointer' — follows the cursor (fine pointers only)
 *   'anchor'  — pinned under the trigger. Used for keyboard focus and for
 *               `prefers-reduced-motion`, where a card chasing the cursor is
 *               exactly the motion the user asked us not to make.
 *
 * On coarse pointers the hover listeners are never attached at all.
 */

/* --- tuning ------------------------------------------------------------- */

/** damping time constant, ms — smaller is snappier */
const TAU = 58
/** cursor → card offset, px */
const GAP_X = 18
const GAP_Y = 20
/** viewport gutter the card is never allowed inside, px */
const PAD = 12
/** trigger → card gap in anchor mode, px */
const ANCHOR_GAP = 10

type Mode = 'pointer' | 'anchor'
type Point = { x: number; y: number }

/* --- media queries ------------------------------------------------------ */

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const sync = () => setMatch(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [query])
  return match
}

/* --- component ---------------------------------------------------------- */

export type HoverPreviewProps = {
  /** what the card shows — any node; it is rendered into a portal on <body> */
  content: ReactNode
  /** the trigger's own content */
  children: ReactNode
  /** classes for the trigger wrapper, e.g. `ticker__item` */
  className?: string
  /**
   * Keyboard reachable. Leave `true` unless the trigger sits inside an
   * `aria-hidden` region — a focusable node inside `aria-hidden` is an
   * accessibility fault, so opt out there rather than shipping one.
   */
  focusable?: boolean
}

export function HoverPreview({
  content,
  children,
  className,
  focusable = true,
}: HoverPreviewProps) {
  const rawId = useId()
  const cardId = `hp-${rawId.replace(/:/g, '')}`

  const [mode, setMode] = useState<Mode | null>(null)

  const hoverable = useMedia('(hover: hover) and (pointer: fine)')
  const reduced = useMedia('(prefers-reduced-motion: reduce)')

  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  /* Everything the loop touches is a ref: state changes only when the card
     opens or closes, never while it moves. */
  const modeRef = useRef<Mode | null>(null)
  const reducedRef = useRef(reduced)
  const pointerRef = useRef<Point>({ x: 0, y: 0 })
  const curRef = useRef<Point>({ x: 0, y: 0 })
  const writtenRef = useRef<Point>({ x: NaN, y: NaN })
  const sizeRef = useRef<Point>({ x: 0, y: 0 })
  const viewRef = useRef<Point>({ x: 0, y: 0 })
  const flipRef = useRef({ fx: 'right', fy: 'down' })
  const rafRef = useRef(0)
  const lastRef = useRef(0)
  const primedRef = useRef(false)
  /** set by Escape / pointerdown — suppresses reopening until the trigger is left */
  const dismissedRef = useRef(false)

  reducedRef.current = reduced

  /* ---------------------------------------------------------------- reads */

  const readViewport = useCallback(() => {
    viewRef.current.x = window.innerWidth
    viewRef.current.y = window.innerHeight
  }, [])

  const measure = useCallback(() => {
    const el = cardRef.current
    if (!el) return
    sizeRef.current.x = el.offsetWidth
    sizeRef.current.y = el.offsetHeight
  }, [])

  /** Resolve the card's top-left in viewport space, flipping near the edges. */
  const resolve = useCallback((): Point => {
    const w = sizeRef.current.x
    const h = sizeRef.current.y
    const vw = viewRef.current.x
    const vh = viewRef.current.y
    let x: number
    let y: number
    let fx = 'right'
    let fy = 'down'

    if (modeRef.current === 'pointer') {
      const p = pointerRef.current
      x = p.x + GAP_X
      y = p.y + GAP_Y
      // not enough room to the right / below — put the card on the other side
      // of the cursor instead of letting it collide with the edge
      if (x + w > vw - PAD) {
        x = p.x - GAP_X - w
        fx = 'left'
      }
      if (y + h > vh - PAD) {
        y = p.y - GAP_Y - h
        fy = 'up'
      }
    } else {
      const r = wrapRef.current?.getBoundingClientRect()
      const left = r ? r.left : PAD
      const right = r ? r.right : PAD + w
      const top = r ? r.top : PAD
      const bottom = r ? r.bottom : PAD
      x = left
      y = bottom + ANCHOR_GAP
      if (x + w > vw - PAD) {
        x = right - w
        fx = 'left'
      }
      if (y + h > vh - PAD) {
        y = top - ANCHOR_GAP - h
        fy = 'up'
      }
    }

    // last resort: a card wider or taller than the viewport still stays legible
    x = Math.min(Math.max(x, PAD), Math.max(PAD, vw - w - PAD))
    y = Math.min(Math.max(y, PAD), Math.max(PAD, vh - h - PAD))
    flipRef.current.fx = fx
    flipRef.current.fy = fy
    return { x, y }
  }, [])

  /* ---------------------------------------------------------------- loop */

  /* One loop, one handle. `schedule` is a no-op while a frame is already
     pending, so N events between two frames still cost one frame. */
  const frameRef = useRef<(t: number) => void>(() => {})

  /**
   * `cold` means "the loop was parked" — the elapsed time since the last frame is
   * meaningless (it could be seconds) so the next frame must use the nominal step
   * instead. The loop's OWN tail call is warm: it must leave `lastRef` alone, or
   * every frame reads `dt = 16` and the damping stops being frame-rate independent.
   */
  const schedule = useCallback((cold = true) => {
    if (rafRef.current) return
    if (cold) lastRef.current = 0
    rafRef.current = requestAnimationFrame((t) => frameRef.current(t))
  }, [])

  const frame = useCallback(
    (t: number) => {
      rafRef.current = 0
      const el = cardRef.current
      const active = modeRef.current
      if (!el || !active) return

      // all reads first …
      const goal = resolve()
      const cur = curRef.current

      if (!primedRef.current || reducedRef.current || active === 'anchor') {
        cur.x = goal.x
        cur.y = goal.y
      } else {
        const dt = lastRef.current ? Math.min(64, t - lastRef.current) : 16
        const k = 1 - Math.exp(-dt / TAU)
        cur.x += (goal.x - cur.x) * k
        cur.y += (goal.y - cur.y) * k
      }
      lastRef.current = t
      primedRef.current = true

      // … then the writes, so a frame never reads back what it just wrote
      const nx = Math.round(cur.x)
      const ny = Math.round(cur.y)
      if (nx !== writtenRef.current.x || ny !== writtenRef.current.y) {
        el.style.transform = `translate3d(${nx}px, ${ny}px, 0)`
        writtenRef.current.x = nx
        writtenRef.current.y = ny
      }
      if (el.dataset.fx !== flipRef.current.fx) el.dataset.fx = flipRef.current.fx
      if (el.dataset.fy !== flipRef.current.fy) el.dataset.fy = flipRef.current.fy

      const moving = Math.abs(goal.x - cur.x) > 0.25 || Math.abs(goal.y - cur.y) > 0.25
      // anchor mode keeps ticking: the trigger itself may be moving (the ticker
      // tape) and one rect read per frame is cheaper than a scroll/resize/mutation
      // net that would still miss it.
      if (moving || active === 'anchor') schedule(false)
    },
    [resolve, schedule],
  )
  frameRef.current = frame

  /* ---------------------------------------------------------------- open/close */

  const open = useCallback((next: Mode) => {
    if (dismissedRef.current) return
    modeRef.current = next
    primedRef.current = false
    writtenRef.current.x = NaN
    writtenRef.current.y = NaN
    setMode(next)
  }, [])

  const close = useCallback(() => {
    modeRef.current = null
    setMode(null)
  }, [])

  /* Place the card before its first paint, so it never flashes at 0,0.
     The entrance itself is a CSS keyframe on the inner element — a keyframe
     runs from its own from-state regardless of when the mount painted, which a
     transition would not. */
  useLayoutEffect(() => {
    if (!mode) return
    const el = cardRef.current
    if (!el) return
    readViewport()
    measure()
    // reduced motion resolves as 'anchor' — pinned, not chasing
    const goal = resolve()
    curRef.current.x = goal.x
    curRef.current.y = goal.y
    primedRef.current = true
    const nx = Math.round(goal.x)
    const ny = Math.round(goal.y)
    el.style.transform = `translate3d(${nx}px, ${ny}px, 0)`
    el.dataset.fx = flipRef.current.fx
    el.dataset.fy = flipRef.current.fy
    writtenRef.current.x = nx
    writtenRef.current.y = ny
    if (mode === 'anchor') schedule()
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  }, [mode, measure, readViewport, resolve, schedule])

  /* ---------------------------------------------------------------- hover */

  useEffect(() => {
    // coarse pointer / no hover: attach nothing at all
    if (!hoverable) return
    const el = wrapRef.current
    if (!el) return

    const onEnter = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      pointerRef.current.x = e.clientX
      pointerRef.current.y = e.clientY
      // a chasing card is motion; honour the reduced-motion request by pinning
      open(reducedRef.current ? 'anchor' : 'pointer')
    }
    const onMove = (e: PointerEvent) => {
      pointerRef.current.x = e.clientX
      pointerRef.current.y = e.clientY
      if (modeRef.current === 'pointer') schedule()
    }
    const onLeave = () => {
      dismissedRef.current = false
      // the trigger may still hold keyboard focus — hand the card back to the
      // anchored mode instead of yanking it out from under a keyboard user
      const active = document.activeElement
      if (focusable && active instanceof Node && el.contains(active)) {
        if (modeRef.current === 'pointer') open('anchor')
        return
      }
      if (modeRef.current) close()
    }

    el.addEventListener('pointerenter', onEnter)
    el.addEventListener('pointermove', onMove, { passive: true })
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('pointercancel', onLeave)
    return () => {
      el.removeEventListener('pointerenter', onEnter)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('pointercancel', onLeave)
    }
  }, [hoverable, focusable, open, close, schedule])

  /* ---------------------------------------------------------------- focus */

  useEffect(() => {
    if (!focusable) return
    const el = wrapRef.current
    if (!el) return
    const onFocusIn = () => open('anchor')
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget
      if (next instanceof Node && el.contains(next)) return
      dismissedRef.current = false
      close()
    }
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
    return () => {
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
    }
  }, [focusable, open, close])

  /* ------------------------------------------------------- while open only */

  useEffect(() => {
    if (!mode) return

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      dismissedRef.current = true
      close()
    }
    // the cursor position we are tracking goes stale the instant the page moves
    const onScroll = () => {
      if (modeRef.current === 'pointer') close()
      else if (modeRef.current) schedule()
    }
    const onResize = () => {
      readViewport()
      measure()
      schedule()
    }
    const onHide = () => {
      if (document.hidden) close()
    }
    const onDown = () => {
      dismissedRef.current = true
      close()
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    window.addEventListener('resize', onResize, { passive: true })
    window.addEventListener('pointerdown', onDown, { passive: true })
    document.addEventListener('visibilitychange', onHide)

    // trigger scrolled out of view (or the tape carried it past the mask):
    // there is nothing to preview, so stop the loop by closing outright
    let io: IntersectionObserver | null = null
    const trigger = wrapRef.current
    if (trigger && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) if (!entry.isIntersecting) close()
        },
        { threshold: 0 },
      )
      io.observe(trigger)
    }

    /* The size is measured once, on open — but a webfont can land after that and
       reflow the card. A stale size resolves the wrong flip, so re-measure when
       the card actually changes size. Repositioning writes `transform` only, which
       cannot change the border box, so this can never feed back on itself. */
    let ro: ResizeObserver | null = null
    const card = cardRef.current
    if (card && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        measure()
        schedule()
      })
      ro.observe(card)
    }

    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointerdown', onDown)
      document.removeEventListener('visibilitychange', onHide)
      io?.disconnect()
      ro?.disconnect()
    }
  }, [mode, close, schedule, measure, readViewport])

  /* ---------------------------------------------------------------- render */

  const openNow = mode !== null

  return (
    <span
      ref={wrapRef}
      className={className ? `hp ${className}` : 'hp'}
      data-open={openNow ? '1' : undefined}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={openNow ? cardId : undefined}
    >
      {children}
      {openNow && typeof document !== 'undefined'
        ? createPortal(
            <div ref={cardRef} id={cardId} role="tooltip" className="hp-card">
              <div className="hp-card__in">{content}</div>
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}

/* ====================================================================== */
/*  The STARSIGHT-shaped payload for the card.                            */
/* ====================================================================== */

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * What a catalog entry actually is, for someone who has only seen its name go
 * past on the tape. Every field is read off `StarsightRecord` — nothing invented.
 */
export function CatalogPreview({ record }: { record: StarsightRecord }) {
  const { resource } = record
  const name = resource.serviceName || hostOf(resource.url)
  const price = formatAmount(record.amount ?? record.maxAmountRequired)
  const tags = resource.tags ?? []

  return (
    <div className="hp-rec">
      <div className="hp-rec__head">
        <span className="hp-rec__name">{name}</span>
        <span className={`pill pill--${record.type}`}>{record.type.toUpperCase()}</span>
      </div>

      {resource.description ? <p className="hp-rec__desc">{resource.description}</p> : null}

      <div className="hp-rec__price">
        <span className="hp-rec__price-l">price</span>
        <span className="hp-rec__amt">{price}</span>
        <span className="hp-rec__asset">{ASSET_CODE}</span>
        <span className="hp-rec__scheme">{record.scheme}</span>
      </div>

      {tags.length > 0 ? (
        <ul className="hp-rec__tags">
          {tags.slice(0, 6).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}

      <div className="hp-rec__url">{resource.url}</div>

      <div className="hp-rec__foot">
        <span>{record.network}</span>
        <span className="hp-rec__sep" aria-hidden="true">
          ·
        </span>
        <span>{record.seeded ? 'catalog entry' : `${record.settlements} settled`}</span>
        <span className="hp-rec__sep" aria-hidden="true">
          ·
        </span>
        <span>{ago(record.lastSeenAt)}</span>
      </div>
    </div>
  )
}
