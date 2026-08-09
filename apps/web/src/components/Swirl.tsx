import { useEffect, useRef } from 'react'
import '../styles/swirl.css'

/**
 * SWIRL — an ambient flow field behind the hero.
 *
 * The technique, not the decoration: N particles are advected through a smooth
 * 3D value-noise field (two octaves, written below — no dependency) whose third
 * axis is time, so the field itself drifts. Each particle keeps a short ring
 * buffer of past positions and is drawn as a two-pass polyline: a dim tail and a
 * brighter head. That is what makes it read as *routing* — traffic finding lanes
 * through a network — rather than as a screensaver.
 *
 * Restraint is enforced numerically, not by taste:
 *   · the field is biased rightward (DRIFT), so flow has a direction
 *   · the palette is the grey ramp; the accent is rationed to ~1 particle in 22
 *   · peak stroke alpha lands a hairline at roughly the weight of `--rule`
 *   · the canvas is masked away from the headline column (see swirl.css)
 *
 * Lifecycle: one rAF loop, a fixed 60 Hz accumulator so a 120 Hz panel does not
 * run it at double speed, paused when off-screen or when the tab is hidden, and
 * fully replaced by a single composed still frame under `prefers-reduced-motion`.
 */

/* ------------------------------------------------------------------ noise */

const TAU = Math.PI * 2

/** integer hash → [0,1). All-int32 via imul so it cannot drift on precision. */
function hash(i: number, j: number, k: number): number {
  let h = (Math.imul(i, 0x1b873593) + Math.imul(j, 0x27d4eb2f)) ^ Math.imul(k, 0x0d2f6b3d)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  h = h ^ (h >>> 15)
  return (h >>> 0) / 4294967296
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

/** trilinear value noise on the unit lattice → [0,1] */
function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const u = smooth(x - xi)
  const v = smooth(y - yi)
  const w = smooth(z - zi)

  const c000 = hash(xi, yi, zi)
  const c100 = hash(xi + 1, yi, zi)
  const c010 = hash(xi, yi + 1, zi)
  const c110 = hash(xi + 1, yi + 1, zi)
  const c001 = hash(xi, yi, zi + 1)
  const c101 = hash(xi + 1, yi, zi + 1)
  const c011 = hash(xi, yi + 1, zi + 1)
  const c111 = hash(xi + 1, yi + 1, zi + 1)

  const x00 = c000 + (c100 - c000) * u
  const x10 = c010 + (c110 - c010) * u
  const x01 = c001 + (c101 - c001) * u
  const x11 = c011 + (c111 - c011) * u
  const y0 = x00 + (x10 - x00) * v
  const y1 = x01 + (x11 - x01) * v
  return y0 + (y1 - y0) * w
}

/** two octaves — the second breaks up the lattice artefacts of plain value noise */
function field(x: number, y: number, z: number): number {
  return noise3(x, y, z) * 0.7 + noise3(x * 2.3 + 11.7, y * 2.3 + 3.1, z * 1.7 + 5.5) * 0.3
}

/* ---------------------------------------------------------------- palette */

/**
 * The ramp is owned by base.css; it is read off the mounted host at start, not
 * copied. A duplicated hex is a copy that drifts — this one already had, the
 * literal for `--g-400` read 124 where the token is #7d818f (125).
 *
 * [custom property, fallback if it is missing, peak alpha]
 */
const TOKENS: ReadonlyArray<readonly [string, string, number]> = [
  ['--g-400', '#7d818f', 0.3],
  ['--g-300', '#a4a7b2', 0.22],
  ['--g-500', '#575b68', 0.34],
  ['--accent', '#f5400e', 0.26], // rationed, see ACCENT_RATE
]
const PEAK: readonly number[] = TOKENS.map((t) => t[2])

/** `#abc` | `#aabbcc` | `rgb(…)` | `rgba(…)` → `"r,g,b"`. */
function channels(raw: string, fallback: string): string {
  const v = raw.trim() || fallback
  if (v.charCodeAt(0) === 35 /* # */) {
    const hex = v.slice(1)
    const full = hex.length === 3 ? hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] : hex
    if (full.length >= 6) {
      const n = Number.parseInt(full.slice(0, 6), 16)
      if (Number.isFinite(n)) return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
    }
  } else {
    const m = v.match(/-?[\d.]+/g)
    if (m && m.length >= 3) {
      return `${Math.round(+m[0])},${Math.round(+m[1])},${Math.round(+m[2])}`
    }
  }
  // the fallbacks above are all well-formed 6-digit hex, so this terminates
  return v === fallback ? '125,129,143' : channels(fallback, fallback)
}

/* ------------------------------------------------------------------ tuning */

const MAX = 170 //   hard ceiling on particles — buffers are allocated once
const TRAIL = 16 //  ring-buffer samples per particle
const SAMPLE_EVERY = 4 // sim steps between samples — TRAIL*SAMPLE_EVERY frames
//                        of history, ~80px of path at the average speed
const AREA_PER = 8600 // css px² of hero per particle
const MIN_COUNT = 34

const FIELD_X = 0.0018 //  ~2 noise cells across a 1180px shell
const FIELD_Y = 0.0016 // coarser vertically: broad lanes, not tight wiggles
const FIELD_Z = 0.00022 // field morphs over ~75s — calm, not churning
const TURNS = 1.1 //      full rotations the angle sweeps — low = long lanes
const CURL = 0.58 //      weight of the noise heading
const DRIFT = 0.86 //     constant rightward bias: flow has a direction
const SQUASH = 0.42 //    flattens the field into lanes. Without it the curl
//                        reads as falling debris rather than as routing.
const STEER = 0.055 //    velocity smoothing — low = long, laminar arcs
const ACCENT_RATE = 0.045

const FRAME = 1000 / 60
const MAX_STEPS = 4 //    catch-up ceiling per animation frame
const WARMUP = 90 //      steps before the first paint (> TRAIL*SAMPLE_EVERY,
//                        so every particle already has a full tail)
const STILL = 180 //      steps for the reduced-motion still frame

/* -------------------------------------------------------------------- run */

/**
 * All of the engine. Taking the three non-null handles as parameters keeps them
 * non-nullable inside the hoisted helpers below (a `useEffect`-local `const`
 * narrowed by a guard does not stay narrowed inside a function declaration).
 *
 * Returns its own teardown.
 */
function run(
  host: HTMLDivElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): () => void {
  /* ---- state ------------------------------------------------------ */
  let w = 0
  let h = 0
  let dpr = 1
  let count = 0
  let tick = 0
  let phase = 0

  /* Resolved once, off the mounted host, so the ramp stays base.css's to own. */
  const cs = getComputedStyle(host)
  const prefix: readonly string[] = TOKENS.map(
    ([name, fb]) => `rgba(${channels(cs.getPropertyValue(name), fb)},`,
  )

  const px = new Float32Array(MAX * TRAIL)
  const py = new Float32Array(MAX * TRAIL)
  const head = new Int32Array(MAX)
  const filled = new Int32Array(MAX)
  const vx = new Float32Array(MAX)
  const vy = new Float32Array(MAX)
  const life = new Float32Array(MAX)
  const ttl = new Float32Array(MAX)
  const spd = new Float32Array(MAX)
  const wid = new Float32Array(MAX)
  const tone = new Uint8Array(MAX)

  /* ---- particles --------------------------------------------------- */

  /**
   * Uniform over the whole field, on birth and on respawn alike. A left-edge
   * spawn (the usual choice for a directional field) starves the right half
   * here, because a particle's lifetime is shorter than the time it needs to
   * cross the hero — the result is a populated left and a visible void.
   */
  function spawn(i: number, desync = false): void {
    const b = i * TRAIL
    px[b] = -60 + Math.random() * (w + 120)
    py[b] = Math.random() * h
    head[i] = 0
    filled[i] = 1
    vx[i] = DRIFT
    vy[i] = 0
    ttl[i] = 300 + Math.random() * 380
    // only on the initial fill: scatter lifetimes so the field does not pulse
    // in and out in unison for its first few seconds
    life[i] = desync ? Math.random() * ttl[i] * 0.8 : 0
    spd[i] = 0.8 + Math.random() * 1.3
    const accent = Math.random() < ACCENT_RATE
    tone[i] = accent ? 3 : (Math.random() * 3) | 0
    wid[i] = accent ? 0.5 + Math.random() * 0.5 : 0.55 + Math.random() * 0.85
  }

  function step(): void {
    tick += 1
    const z = tick * FIELD_Z
    phase = (phase + 1) % SAMPLE_EVERY
    const commit = phase === 0

    for (let i = 0; i < count; i++) {
      const b = i * TRAIL
      const hi = head[i]
      let x = px[b + hi]
      let y = py[b + hi]

      const angle = field(x * FIELD_X, y * FIELD_Y, z) * TAU * TURNS
      // DRIFT > CURL keeps tx strictly positive: nothing stalls, nothing clumps
      const tx = Math.cos(angle) * CURL + DRIFT
      const ty = Math.sin(angle) * CURL * SQUASH
      const nvx = vx[i] + (tx - vx[i]) * STEER
      const nvy = vy[i] + (ty - vy[i]) * STEER
      vx[i] = nvx
      vy[i] = nvy

      x += nvx * spd[i]
      y += nvy * spd[i]
      life[i] += 1

      if (life[i] >= ttl[i] || x < -80 || x > w + 80 || y < -80 || y > h + 80) {
        spawn(i)
        continue
      }

      if (commit) {
        // freeze the current head as a trail sample and open a new live slot
        const ni = (hi + 1) % TRAIL
        head[i] = ni
        px[b + ni] = x
        py[b + ni] = y
        if (filled[i] < TRAIL) filled[i] += 1
      } else {
        px[b + hi] = x
        py[b + hi] = y
      }
    }
  }

  /* ---- paint -------------------------------------------------------- */

  /** stroke `len` newest ring samples of particle `i` as one polyline */
  function tracePath(i: number, len: number): void {
    const b = i * TRAIL
    const hi = head[i]
    ctx.beginPath()
    for (let j = len - 1; j >= 0; j--) {
      const k = (hi - j + TRAIL) % TRAIL
      if (j === len - 1) ctx.moveTo(px[b + k], py[b + k])
      else ctx.lineTo(px[b + k], py[b + k])
    }
    ctx.stroke()
  }

  function draw(): void {
    ctx.clearRect(0, 0, w, h)
    // additive: strokes can only ever lighten, so they never muddy the grid
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (let i = 0; i < count; i++) {
      const n = filled[i]
      if (n < 2) continue

      // sine envelope over the lifetime — no popping in or out
      const envelope = Math.sin(Math.PI * Math.min(life[i] / ttl[i], 1))
      const alpha = envelope * PEAK[tone[i]]
      if (alpha < 0.004) continue

      const rgb = prefix[tone[i]]
      ctx.lineWidth = wid[i]

      ctx.strokeStyle = `${rgb}${(alpha * 0.42).toFixed(3)})` // tail: whole ring, dim
      tracePath(i, n)

      ctx.strokeStyle = `${rgb}${alpha.toFixed(3)})` // head: newest few, full weight
      tracePath(i, n < 3 ? n : 3)
    }

    painted = true
    if (!canvas.hasAttribute('data-lit')) canvas.setAttribute('data-lit', '')
  }

  /* ---- sizing ------------------------------------------------------- */

  function resize(): void {
    const rect = host.getBoundingClientRect()
    const nw = Math.max(1, Math.round(rect.width))
    const nh = Math.max(1, Math.round(rect.height))
    const ndpr = Math.min(window.devicePixelRatio || 1, 2)
    if (nw === w && nh === h && ndpr === dpr) return

    w = nw
    h = nh
    dpr = ndpr
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    // assigning width/height resets the context — restore the scale after
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const target = Math.max(MIN_COUNT, Math.min(MAX, Math.round((w * h) / AREA_PER)))
    for (let i = count; i < target; i++) spawn(i, true)
    count = target

    // Assigning width/height wipes the backing store. If the loop is parked —
    // reduced motion, off-screen, hidden tab — nothing would ever repaint it,
    // and under reduced motion the still frame would be gone for good. Compose
    // one frame here instead. (Only once something has been drawn: repainting
    // before the first fill would just light an empty canvas.)
    if (painted && !running) draw()
  }

  /* ---- loop --------------------------------------------------------- */

  let raf = 0
  let last = 0
  let acc = 0
  let running = false
  let warmed = false
  let painted = false
  let onscreen = true
  let awake = !document.hidden

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  let reduced = mq.matches

  const frame: FrameRequestCallback = (now) => {
    raf = requestAnimationFrame(frame)
    if (!last) last = now
    let dt = now - last
    last = now
    if (dt > 100) dt = 100 // a resumed tab must not fast-forward

    acc += dt
    let steps = 0
    while (acc >= FRAME && steps < MAX_STEPS) {
      step()
      acc -= FRAME
      steps += 1
    }
    if (acc > FRAME) acc = 0
    if (steps > 0) draw()
  }

  function stop(): void {
    if (!running) return
    running = false
    cancelAnimationFrame(raf)
    raf = 0
  }

  /** one composed frame, no loop — the reduced-motion state */
  function still(): void {
    for (let i = 0; i < STILL; i++) step()
    draw()
  }

  function start(): void {
    if (running || reduced || !onscreen || !awake) return
    if (!warmed) {
      warmed = true
      for (let i = 0; i < WARMUP; i++) step()
    }
    running = true
    last = 0
    acc = 0
    raf = requestAnimationFrame(frame)
  }

  /* ---- wiring ------------------------------------------------------- */

  resize()

  const onWindowResize = () => resize()
  // Always on, not just as the ResizeObserver fallback: `resize()` early-returns
  // when nothing changed, and a window resize is the cheapest signal for the one
  // case ResizeObserver misses — see the density watch below.
  window.addEventListener('resize', onWindowResize)

  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize())
    ro.observe(host)
  }

  /* A devicePixelRatio change on its own — dragging the window onto a display of
     a different density — moves no CSS box, so ResizeObserver never fires and the
     backing store is left at the wrong scale: soft, or over-sharp, until some
     later resize happens to correct it. A resolution query pinned at the current
     density flips the instant the density does; re-arm it at the new one. */
  let dprMq: MediaQueryList | null = null
  const onDensity = () => {
    resize()
    watchDensity()
  }
  function watchDensity(): void {
    dprMq?.removeEventListener('change', onDensity)
    dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    dprMq.addEventListener('change', onDensity)
  }
  watchDensity()

  let io: IntersectionObserver | null = null
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) onscreen = entry.isIntersecting
        if (onscreen) start()
        else stop()
      },
      { threshold: 0 },
    )
    io.observe(host)
  }

  const onVisibility = () => {
    awake = !document.hidden
    if (awake) start()
    else stop()
  }
  document.addEventListener('visibilitychange', onVisibility)

  const onMotionPref = () => {
    reduced = mq.matches
    if (reduced) {
      stop()
      still()
    } else {
      start()
    }
  }
  mq.addEventListener('change', onMotionPref)

  if (reduced) still()
  else start()

  return () => {
    stop()
    ro?.disconnect()
    io?.disconnect()
    window.removeEventListener('resize', onWindowResize)
    document.removeEventListener('visibilitychange', onVisibility)
    mq.removeEventListener('change', onMotionPref)
    dprMq?.removeEventListener('change', onDensity)
  }
}

/* -------------------------------------------------------------- component */

/** Decorative. Mount as the first child of a positioned block (the hero). */
export function Swirl({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return
    return run(host, canvas, ctx)
  }, [])

  return (
    <div ref={hostRef} className={className ? `swirl ${className}` : 'swirl'} aria-hidden="true">
      <canvas ref={canvasRef} className="swirl__canvas" />
    </div>
  )
}

export default Swirl
