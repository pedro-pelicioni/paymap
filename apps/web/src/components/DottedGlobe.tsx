import { useEffect, useRef } from 'react'
import '../styles/globe.css'

/**
 * A slowly turning sphere drawn as a field of points, on a 2D canvas.
 *
 * Why it is here: the Bazaar is a *public* index. `/discovery/*` answers with
 * `Access-Control-Allow-Origin: *` on purpose, because the whole point is that
 * somebody else's agent — anywhere — can call it without asking us first. The
 * globe is that sentence as a picture, and nothing more. It is decorative,
 * `aria-hidden`, and `pointer-events: none`; it carries no information a reader
 * could miss, and it is not interactive.
 *
 * The technique, from first principles — no WebGL, no scene graph:
 *
 *   1. Distribute N points over the unit sphere with the golden-spiral
 *      (Fibonacci) construction: y walks linearly from +1 to −1, the ring
 *      radius is sqrt(1 − y²), and longitude advances by the golden angle
 *      π(3 − √5) each step. Even coverage, no crowding at the poles, no
 *      rejection sampling, closed form.
 *   2. Each frame, spin every point around the Y axis, then apply one fixed
 *      tilt around X so the axis reads as an axis rather than a seam.
 *   3. Project with a single perspective divide from a camera CAM radii away:
 *      k = CAM / (CAM − z). Near points spread out, far points gather in.
 *   4. Shade by depth. Alpha follows t = (z + 1)/2 raised to FALLOFF, so the
 *      far hemisphere drops away fast instead of muddying the near one; radius
 *      follows t linearly. That depth ramp is the entire illusion.
 *
 * Cost control, because this sits behind real content and must never be the
 * reason a frame is late:
 *   - a few hundred points, one rAF loop, cancelled on unmount;
 *   - fills are batched into BINS alpha buckets, so a frame is ~BINS
 *     `fillStyle` writes and ~BINS `fill()` calls rather than one per point,
 *     and iterating buckets low→high paints far→near for free;
 *   - the loop stops entirely when the element scrolls off screen or the tab
 *     goes to the background, and never restarts itself while paused;
 *   - `prefers-reduced-motion: reduce` renders one static frame and no loop.
 *
 * Colour is not hard-coded. The component reads `--globe-dot`, `--globe-node`
 * and `--globe-rim` back out of the host element through a throwaway probe
 * span, which makes the browser resolve whatever token chain those point at
 * down to a plain `rgb()/rgba()` string. styles/globe.css maps them onto the
 * real design tokens, so the stylesheet stays the single source of truth for
 * pigment and this file never names a colour.
 */

const TAU = Math.PI * 2
/** π(3 − √5) — the golden angle, in radians. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
/** Camera distance in sphere radii. Higher is flatter; 4.2 is a long lens. */
const CAM = 4.2
/** Screen radius of the silhouette, relative to the sphere radius, under CAM. */
const SILHOUETTE = CAM / Math.sqrt(CAM * CAM - 1)
/** Alpha buckets. 26 steps is below the threshold where banding is visible. */
const BINS = 26
/** Depth ramp for the grey field. */
const DOT_MIN = 0.045
const DOT_MAX = 0.5
/** >1 pushes the far hemisphere down harder than linear. */
const FALLOFF = 1.9
/** Depth ramp for the live nodes — brighter, but only on the near side. */
const NODE_MIN = 0.1
const NODE_MAX = 0.88
const NODE_FALLOFF = 1.6
/** Angle the static (reduced-motion) frame is drawn at. */
const STATIC_ANGLE = 0.62
/** Frozen clock for the static frame, so node brightness is deterministic. */
const STATIC_CLOCK = 900

type Rgba = { r: number; g: number; b: number; a: number }

/**
 * Parse the normalised output of `getComputedStyle().color`. That is always
 * `rgb(...)` or `rgba(...)` in practice; the hex branch is belt and braces for
 * engines that hand back the authored value instead.
 */
function parseRgba(value: string): Rgba | null {
  const s = value.trim().toLowerCase()
  if (!s || s === 'transparent' || s === 'none') return null

  if (s.charAt(0) === '#') {
    const h = s.slice(1)
    const short = h.length === 3 || h.length === 4
    if (!short && h.length !== 6 && h.length !== 8) return null
    const step = short ? 1 : 2
    const at = (i: number): number => {
      const raw = h.slice(i * step, i * step + step)
      return parseInt(short ? raw + raw : raw, 16)
    }
    const r = at(0)
    const g = at(1)
    const b = at(2)
    const a = h.length === 4 || h.length === 8 ? at(3) / 255 : 1
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
    if (!Number.isFinite(a)) return null
    return { r, g, b, a }
  }

  const m = /^rgba?\(([^)]*)\)$/.exec(s)
  if (!m) return null
  const parts = m[1].split(/[\s,/]+/).filter((p) => p.length > 0)
  if (parts.length < 3) return null
  const num = (raw: string, scale: number): number => {
    const v = parseFloat(raw)
    if (!Number.isFinite(v)) return Number.NaN
    return raw.endsWith('%') ? (v / 100) * scale : v
  }
  const r = num(parts[0], 255)
  const g = num(parts[1], 255)
  const b = num(parts[2], 255)
  const a = parts.length > 3 ? num(parts[3], 1) : 1
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
  if (!Number.isFinite(a)) return null
  return { r, g, b, a }
}

type Palette = { dot: Rgba; node: Rgba; rim: Rgba }

/**
 * Resolve the three custom properties into concrete channels.
 *
 * Setting `color: var(--x)` on a probe and reading `getComputedStyle().color`
 * back makes the engine do the work: `var()` chains, `color-mix()`, hex, named
 * colours and modern colour spaces all come back normalised. Reading the custom
 * property directly would hand back whatever syntax was authored.
 */
function readPalette(host: HTMLElement): Palette | null {
  // If a property is undefined, `color: var(--it)` is invalid at computed-value
  // time and the probe reports the *inherited* text colour — cream, which is
  // wildly too loud for any of these three roles. Every read is gated on the
  // property actually existing, so an undefined token yields null (and, for the
  // dot, no globe at all) rather than a cream one.
  const hostStyle = window.getComputedStyle(host)
  const declared = (prop: string): boolean => hostStyle.getPropertyValue(prop).trim().length > 0

  // Without a dot colour there is no globe; the CSS atmosphere still renders.
  if (!declared('--globe-dot')) return null

  const probe = document.createElement('span')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;pointer-events:none'
  host.appendChild(probe)

  const read = (prop: string): Rgba | null => {
    if (!declared(prop)) return null
    probe.style.color = ''
    probe.style.color = `var(${prop})`
    return parseRgba(window.getComputedStyle(probe).color)
  }

  const dot = read('--globe-dot')
  const node = read('--globe-node')
  const rim = read('--globe-rim')
  host.removeChild(probe)

  if (!dot) return null
  return { dot, node: node ?? dot, rim: rim ?? { ...dot, a: dot.a * 0.2 } }
}

/** Golden-spiral point set on the unit sphere, packed as x,y,z triples. */
function fibonacciSphere(n: number): Float32Array {
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2
    const ring = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = GOLDEN_ANGLE * i
    out[i * 3] = Math.cos(theta) * ring
    out[i * 3 + 1] = y
    out[i * 3 + 2] = Math.sin(theta) * ring
  }
  return out
}

/**
 * Which points read as live nodes. Spaced evenly along the spiral, which — since
 * y is linear in i — spaces them evenly in latitude, while the golden angle
 * scatters their longitudes. Confined to the middle band: a node sitting on the
 * silhouette's top edge reads as a stray pixel, not a node.
 */
function nodeIndices(total: number, count: number): number[] {
  const out: number[] = []
  if (count <= 0 || total <= 0) return out
  const lo = Math.floor(total * 0.17)
  const span = Math.max(1, Math.floor(total * 0.66))
  const seen = new Set<number>()
  for (let i = 0; i < count; i++) {
    const at = Math.min(total - 1, lo + Math.floor(((i + 0.5) / count) * span))
    // A tiny `points` with a large `nodes` would land two on the same index;
    // keeping the list unique is what keeps it in step with `phases` below.
    if (seen.has(at)) continue
    seen.add(at)
    out.push(at)
  }
  return out
}

export type DottedGlobeProps = {
  /** Points on the sphere. Deliberately in the low hundreds. */
  points?: number
  /** How many of those read as live nodes, in the accent. Keep it small. */
  nodes?: number
  /** Revolutions per minute. 0.9 is one turn every ~67s. */
  rpm?: number
  /** Fixed tilt of the spin axis, in degrees. */
  tiltDeg?: number
  className?: string
}

export function DottedGlobe({
  points = 520,
  nodes = 6,
  rpm = 0.9,
  tiltDeg = 21,
  className,
}: DottedGlobeProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const hostEl = hostRef.current
    const canvasEl = canvasRef.current
    if (!hostEl || !canvasEl) return
    const context = canvasEl.getContext('2d')
    if (!context) return
    const paints = readPalette(hostEl)
    if (!paints) return

    // Pin the checked values: narrowing of a captured binding does not survive
    // into the hoisted `draw`/`setSize` declarations below.
    const host: HTMLDivElement = hostEl
    const canvas: HTMLCanvasElement = canvasEl
    const ctx: CanvasRenderingContext2D = context
    const palette: Palette = paints

    /* ---------------------------------------------------------- geometry */

    const count = Math.max(24, Math.min(2000, Math.round(points)))
    const sphere = fibonacciSphere(count)
    const live = nodeIndices(count, Math.max(0, Math.min(24, Math.round(nodes))))
    const isNode = new Uint8Array(count)
    for (const i of live) isNode[i] = 1
    // Independent, irrational-ish offsets so the nodes never breathe in unison.
    const phases = new Float32Array(live.length)
    for (let i = 0; i < live.length; i++) phases[i] = i * 1.703 + 0.4

    const tilt = (tiltDeg * Math.PI) / 180
    const cosTilt = Math.cos(tilt)
    const sinTilt = Math.sin(tilt)
    const speed = (rpm * TAU) / 60 // radians per second

    /* ------------------------------------------------------------ paint */

    // One fill style per alpha bucket, built once.
    const dotStyles: string[] = []
    for (let b = 0; b < BINS; b++) {
      const a = DOT_MIN + (DOT_MAX - DOT_MIN) * ((b + 0.5) / BINS)
      dotStyles.push(`rgba(${palette.dot.r},${palette.dot.g},${palette.dot.b},${a * palette.dot.a})`)
    }
    const rimStyle = `rgba(${palette.rim.r},${palette.rim.g},${palette.rim.b},${palette.rim.a})`

    // Reused every frame; never reallocated, so the loop does not churn the heap.
    const bins: number[][] = []
    for (let b = 0; b < BINS; b++) bins.push([])
    const nodeBuf: number[] = []

    /* ------------------------------------------------------------ sizing */

    let cssW = 0
    let cssH = 0
    let dpr = 0

    /** Returns true when the backing store actually changed. */
    function setSize(w: number, h: number): boolean {
      const nextDpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)
      const nw = Math.max(0, Math.round(w))
      const nh = Math.max(0, Math.round(h))
      if (nw === cssW && nh === cssH && nextDpr === dpr) return false
      cssW = nw
      cssH = nh
      dpr = nextDpr
      canvas.width = Math.max(1, Math.round(nw * dpr))
      canvas.height = Math.max(1, Math.round(nh * dpr))
      return true
    }

    /* ------------------------------------------------------------- frame */

    function draw(angle: number, clock: number): void {
      if (cssW === 0 || cssH === 0) return

      // The transform resets whenever the backing store is resized, so reassert
      // it here rather than tracking whether it is still valid.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)

      const cx = cssW / 2
      const cy = cssH / 2
      const screenR = Math.min(cssW, cssH) * 0.5 * 0.93
      if (screenR <= 4) return
      const R = screenR / SILHOUETTE // sphere radius in px, so the rim lands on screenR
      const dotBase = Math.min(1.9, Math.max(0.7, R * 0.0085))

      // The silhouette, as one hairline. This is what makes a scatter of dots
      // read as a sphere rather than as noise.
      ctx.strokeStyle = rimStyle
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(cx, cy, screenR, 0, TAU)
      ctx.stroke()

      const cosA = Math.cos(angle)
      const sinA = Math.sin(angle)

      for (let b = 0; b < BINS; b++) bins[b].length = 0
      nodeBuf.length = 0

      for (let i = 0; i < count; i++) {
        const x0 = sphere[i * 3]
        const y0 = sphere[i * 3 + 1]
        const z0 = sphere[i * 3 + 2]

        // spin about Y
        const x1 = x0 * cosA + z0 * sinA
        const z1 = z0 * cosA - x0 * sinA
        // then the fixed tilt about X
        const y2 = y0 * cosTilt - z1 * sinTilt
        const z2 = y0 * sinTilt + z1 * cosTilt

        const k = CAM / (CAM - z2) // the one perspective divide
        const sx = cx + x1 * k * R
        const sy = cy - y2 * k * R
        const t = (z2 + 1) * 0.5 // 0 at the back of the sphere, 1 at the front

        if (isNode[i] === 1) {
          nodeBuf.push(sx, sy, dotBase * (0.6 + 1.1 * t), t)
          continue
        }

        const shade = Math.pow(t, FALLOFF)
        let b = (shade * BINS) | 0
        if (b >= BINS) b = BINS - 1
        else if (b < 0) b = 0
        bins[b].push(sx, sy, dotBase * (0.45 + 0.95 * t))
      }

      // Low buckets first: the far hemisphere is painted under the near one.
      for (let b = 0; b < BINS; b++) {
        const bin = bins[b]
        if (bin.length === 0) continue
        ctx.fillStyle = dotStyles[b]
        ctx.beginPath()
        for (let p = 0; p < bin.length; p += 3) {
          const x = bin[p]
          const y = bin[p + 1]
          const r = bin[p + 2]
          // moveTo first, or canvas joins consecutive arcs into one outline.
          ctx.moveTo(x + r, y)
          ctx.arc(x, y, r, 0, TAU)
        }
        ctx.fill()
      }

      // The live nodes: a handful, each on its own slow breath. They are
      // decorative only — nothing here is stated in colour alone.
      for (let n = 0, idx = 0; n < nodeBuf.length; n += 4, idx++) {
        const x = nodeBuf[n]
        const y = nodeBuf[n + 1]
        const r = nodeBuf[n + 2]
        const t = nodeBuf[n + 3]
        const breath = 0.58 + 0.42 * Math.sin(clock * 0.00085 + phases[idx])
        const depth = NODE_MIN + (NODE_MAX - NODE_MIN) * Math.pow(t, NODE_FALLOFF)
        const a = depth * breath * palette.node.a
        ctx.fillStyle = `rgba(${palette.node.r},${palette.node.g},${palette.node.b},${a})`
        ctx.beginPath()
        ctx.arc(x, y, r, 0, TAU)
        ctx.fill()
      }
    }

    /* -------------------------------------------------------- lifecycle */

    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reduced = media.matches
    let onScreen = true
    let awake = document.visibilityState !== 'hidden'

    let raf = 0
    let last = 0
    let angle = STATIC_ANGLE
    // Animated time. Frozen while paused, so resuming does not jump the nodes.
    let clock = STATIC_CLOCK

    const render = (): void => draw(angle, clock)

    const frame = (now: number): void => {
      raf = window.requestAnimationFrame(frame)
      if (last === 0) last = now
      // A long gap (a backgrounded tab that slipped past visibilitychange, a
      // stalled main thread) must not teleport the globe a third of a turn.
      const dt = Math.min(100, now - last)
      last = now
      clock += dt
      angle = (angle + speed * dt * 0.001) % TAU
      render()
    }

    const start = (): void => {
      if (raf !== 0 || reduced || !onScreen || !awake) return
      last = 0
      raf = window.requestAnimationFrame(frame)
    }
    const stop = (): void => {
      if (raf === 0) return
      window.cancelAnimationFrame(raf)
      raf = 0
    }

    const applySize = (w: number, h: number): void => {
      // Writing canvas.width/height wipes the backing store. Repaint now rather
      // than waiting on the loop: while paused or reduced nothing else ever
      // would, and while running it closes the one blank frame after a resize.
      if (setSize(w, h)) render()
    }

    const onMedia = (): void => {
      reduced = media.matches
      if (reduced) {
        stop()
        angle = STATIC_ANGLE
        clock = STATIC_CLOCK
        render()
      } else {
        start()
      }
    }

    const onVisibility = (): void => {
      awake = document.visibilityState !== 'hidden'
      if (awake) start()
      else stop()
    }

    // Layout changes only; devicePixelRatio changes arrive on window resize.
    const onWindowResize = (): void => applySize(cssW, cssH)

    // Paint one frame synchronously so the block is never briefly empty; the
    // ResizeObserver below then owns every subsequent size.
    const rect = host.getBoundingClientRect()
    applySize(rect.width, rect.height)

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver((entries) => {
            const entry = entries[entries.length - 1]
            if (!entry) return
            const box = entry.contentRect
            applySize(box.width, box.height)
          })
        : null
    ro?.observe(host)

    const io =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(
            (entries) => {
              const entry = entries[entries.length - 1]
              if (!entry) return
              onScreen = entry.isIntersecting
              if (onScreen) start()
              else stop()
            },
            // A little lead-in, so it is already turning when it arrives.
            { rootMargin: '96px', threshold: 0 },
          )
        : null
    io?.observe(host)

    media.addEventListener('change', onMedia)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('resize', onWindowResize, { passive: true })

    start()

    return () => {
      stop()
      ro?.disconnect()
      io?.disconnect()
      media.removeEventListener('change', onMedia)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', onWindowResize)
    }
  }, [points, nodes, rpm, tiltDeg])

  return (
    <div ref={hostRef} className={className ? `globe ${className}` : 'globe'} aria-hidden="true">
      <canvas ref={canvasRef} className="globe__canvas" />
    </div>
  )
}
