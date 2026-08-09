import { useEffect, useRef } from 'react'

/**
 * A point-cloud globe engraved into the hero plate.
 *
 * Plain 2D canvas — no WebGL, no dependencies. Points are laid out on a
 * Fibonacci sphere, spun through a yaw/pitch rotation matrix and projected
 * orthographically; depth drives radius and alpha so the far hemisphere reads
 * as a ghost behind the near one.
 *
 * It sits at z-index 0 in the hero, beneath `.chart-bg` and `.hero__art`, and
 * is decorative only: every failure path renders nothing at all, and the hero
 * is complete without it.
 */

const POINTS = 1100
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/** ink / brass / jade, matching the brand tokens in base.css */
const INK = '11,12,14'
const BRASS = '255,122,24'
const JADE = '0,194,160'

type Pt = { x: number; y: number; z: number; rgb: string; a: number }

function sphere(): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < POINTS; i++) {
    const y = 1 - (2 * i + 1) / POINTS
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const t = i * GOLDEN_ANGLE
    // deterministic accent placement — no per-frame randomness, so no flicker
    const brass = i % 17 === 0
    const jade = !brass && i % 23 === 0
    pts.push({
      x: Math.cos(t) * r,
      y,
      z: Math.sin(t) * r,
      rgb: brass ? BRASS : jade ? JADE : INK,
      a: brass ? 0.5 : jade ? 0.42 : 0.3,
    })
  }
  return pts
}

export function Globe() {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || typeof canvas.getContext !== 'function') return

    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = canvas.getContext('2d')
    } catch {
      ctx = null
    }
    if (!ctx) return
    const c = ctx

    const cleanups: Array<() => void> = []
    let raf = 0

    try {
      const pts = sphere()

      const reduced =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches

      let w = 0
      let h = 0

      // eased pointer steer, in normalised -1..1 screen space
      let targetX = 0
      let targetY = 0
      let steerX = 0
      let steerY = 0
      let spin = 0.6
      let last = 0

      const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const rect = canvas.getBoundingClientRect()
        w = Math.max(1, Math.round(rect.width))
        h = Math.max(1, Math.round(rect.height))
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
        c.setTransform(dpr, 0, 0, dpr, 0, 0)
      }

      const draw = () => {
        c.clearRect(0, 0, w, h)

        // left of the composition, opposite the paymap plate on the right
        const R = Math.max(80, Math.min(w * 0.16, h * 0.42))
        const cx = w * 0.2
        const cy = h * 0.56

        const yaw = spin + steerX * 0.55
        const pitch = 0.2 - steerY * 0.32
        const cyw = Math.cos(yaw)
        const syw = Math.sin(yaw)
        const cp = Math.cos(pitch)
        const sp = Math.sin(pitch)

        // engraved limb
        c.globalAlpha = 1
        c.strokeStyle = `rgba(${INK},0.07)`
        c.lineWidth = 1
        c.beginPath()
        c.arc(cx, cy, R, 0, Math.PI * 2)
        c.stroke()

        // far hemisphere first, then near — cheaper than sorting every frame
        for (let pass = 0; pass < 2; pass++) {
          let fill = ''
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i]
            const x1 = p.x * cyw + p.z * syw
            const z1 = p.z * cyw - p.x * syw
            const y2 = p.y * cp - z1 * sp
            const z2 = p.y * sp + z1 * cp
            const near = z2 > 0
            if ((pass === 1) !== near) continue

            const dn = (z2 + 1) / 2
            let alpha = p.a * (0.16 + 0.84 * dn * dn)
            if (!near) alpha *= 0.4
            if (alpha < 0.012) continue

            const next = `rgba(${p.rgb},1)`
            if (next !== fill) {
              fill = next
              c.fillStyle = next
            }
            c.globalAlpha = alpha
            c.beginPath()
            c.arc(cx + R * x1, cy - R * y2, 0.5 + 1.05 * dn, 0, Math.PI * 2)
            c.fill()
          }
        }
        c.globalAlpha = 1
      }

      const frame = (t: number) => {
        raf = 0
        const dt = last ? Math.min(64, t - last) : 16
        last = t
        spin += dt * 0.00011
        steerX += (targetX - steerX) * 0.045
        steerY += (targetY - steerY) * 0.045
        draw()
        raf = window.requestAnimationFrame(frame)
      }

      const stop = () => {
        if (raf) window.cancelAnimationFrame(raf)
        raf = 0
      }
      const start = () => {
        if (raf || reduced) return
        last = 0
        raf = window.requestAnimationFrame(frame)
      }

      resize()
      draw()
      cleanups.push(stop)

      if (reduced) return

      const onMove = (e: PointerEvent) => {
        const vw = window.innerWidth || 1
        const vh = window.innerHeight || 1
        targetX = (e.clientX / vw) * 2 - 1
        targetY = (e.clientY / vh) * 2 - 1
      }
      window.addEventListener('pointermove', onMove, { passive: true })
      cleanups.push(() => window.removeEventListener('pointermove', onMove))

      const onResize = () => {
        resize()
        draw()
      }
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(onResize)
        ro.observe(canvas)
        cleanups.push(() => ro.disconnect())
      } else {
        window.addEventListener('resize', onResize)
        cleanups.push(() => window.removeEventListener('resize', onResize))
      }

      // don't burn frames once the hero has scrolled away
      let onScreen = true
      if (typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver((entries) => {
          onScreen = entries.some((en) => en.isIntersecting)
          if (onScreen && !document.hidden) start()
          else stop()
        })
        io.observe(canvas)
        cleanups.push(() => io.disconnect())
      }

      const onVis = () => {
        if (document.hidden || !onScreen) stop()
        else start()
      }
      document.addEventListener('visibilitychange', onVis)
      cleanups.push(() => document.removeEventListener('visibilitychange', onVis))

      start()
    } catch {
      // decorative only — a dead globe must never take the hero with it
      try {
        canvas.style.display = 'none'
      } catch {
        /* ignore */
      }
    }

    return () => {
      if (raf) window.cancelAnimationFrame(raf)
      for (const fn of cleanups) {
        try {
          fn()
        } catch {
          /* ignore */
        }
      }
    }
  }, [])

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  )
}
