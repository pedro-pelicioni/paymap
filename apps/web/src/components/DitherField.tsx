import { useEffect, useRef } from 'react'
import '../styles/dither.css'

/**
 * An ordered-dither swirl field, on a 2D canvas.
 *
 * Why it is here: it is the hero's ground texture and nothing more. It is
 * `aria-hidden`, `pointer-events: none`, and states nothing a reader could
 * miss. It layers *with* the hero's blueprint grid (`.hero::before`) and the
 * low accent ember (`.hero::after`) rather than replacing either — all three
 * sit at z-index 0 and paint in tree order: grid, field, ember.
 *
 * The technique, from first principles — no WebGL, no shaders:
 *
 *   1. Keep an OFFSCREEN buffer one pixel per output block, so at `pxSize` 4
 *      the per-frame work is a sixteenth of the visible area.
 *   2. Per buffer pixel, evaluate a continuous scalar field `v` in [0,1] from
 *      a swirl: centre and aspect-correct the coordinate, take r = hypot(x,y)
 *      and a = atan2(y,x), then sum two octaves of `sin(a·arms + r·f − t·s)`
 *      at different radial frequencies and rotations so it never resolves into
 *      a clean spiral. Everything animates off one time variable.
 *   3. Quantise with the 4x4 BAYER matrix. `floor(v·2 + bayer[y&3][x&3])`
 *      lands in {0,1,2}: transparent, back tone, front tone. That threshold
 *      pattern — not a smooth ramp — is what produces the characteristic
 *      cross-hatched gradient between each pair of levels.
 *   4. `putImageData` to the small buffer, then `drawImage` it up with
 *      `imageSmoothingEnabled = false` so every block stays hard-edged.
 *
 * Legibility, because this sits behind the headline and the value proposition
 * and is the single biggest legibility risk on the page:
 *   - it stays in the grey ramp; the accent appears only where the field's own
 *     crest and a third, much finer octave coincide — measured across a full
 *     revolution, a mean 3.8-4.3% of level-2 blocks and never more than 0.31%
 *     of the canvas. See the note on HOT_RAW/HOT_S for why "finer" is the word
 *     that matters there;
 *   - the weight is driven to *exactly zero* over the copy column. The column
 *     is not guessed: `--shell` is resolved by the browser off a probe span,
 *     and the two-column split from pages.css is mirrored here, so the carve
 *     tracks the real layout at every width;
 *   - it fades to nothing before all four edges, and dither degrades the right
 *     way — as the weight falls, blocks thin out and then stop, with no seam;
 *   - dither.css steps the opacity down at 1020px and 640px, where the copy
 *     goes full width.
 *
 * Cost control, because this must never be the reason a frame is late:
 *   - r, atan2 and the whole mask are time-invariant, so they are computed once
 *     per resize into flat Float32Arrays. A frame is then two or three `sin`
 *     calls per block and one 32-bit store;
 *   - blocks that can never fire are skipped on a single compare;
 *   - the loop renders at FPS, not at refresh rate — this barely moves, and a
 *     low frame rate is also the correct look for a low-bit-depth render;
 *   - it stops entirely off screen or in a background tab, and never restarts
 *     itself while paused;
 *   - `prefers-reduced-motion: reduce` paints one static frame and no loop.
 *
 * Colour is not hard-coded. The component reads `--dither-front`,
 * `--dither-back` and `--dither-hot` (plus a plain-number alpha for each) back
 * out of the host through the probe span, which makes the browser resolve
 * whatever token chain they point at down to an `rgb()` string.
 * styles/dither.css maps them onto the design tokens, so the stylesheet stays
 * the single source of truth for pigment and this file never names a colour.
 */

/* ------------------------------------------------------------------ dither */

/** The 4x4 ordered (Bayer) dither matrix, row-major. */
const BAYER_RAW = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
/** Normalised as (m + 0.5) / 16, so the lowest threshold is 0.031 and never 0
 *  — a weight of zero must mean "no block", with no cell able to fire on it. */
const BAYER = new Float32Array(16)
for (let i = 0; i < 16; i++) BAYER[i] = (BAYER_RAW[i] + 0.5) / 16

/** Output levels above transparent: 1 = back tone, 2 = front tone. */
const LEVELS = 2
/** Below this weight no Bayer cell can reach level 1, so the block is skipped. */
const DEAD = (1 - 15.5 / 16) / LEVELS

/* ------------------------------------------------------------------- field */

/** Frames per second. Deliberately low: this barely moves, and chunky blocks
 *  updating at refresh rate read as noise rather than as a slow field. */
const FPS = 20
const FRAME_MS = 1000 / FPS

/** Radians per second per unit of `speed`. At the 0.9 default the pattern makes
 *  one revolution in roughly 75 seconds. */
const TEMPO = 0.28

/** Radial frequency of each octave. Non-harmonic on purpose. */
const F1 = 5.4
const F2 = 8.9
const F3 = 41.3
/** Arms in the third octave. It is deliberately far finer than the first two
 *  (3 and 5 arms at F1/F2) — see the note on the accent gate below. */
const A3 = 17
/** Fixed rotation between the first two octaves. */
const PHI2 = 1.107
/** Their amplitudes. They sum to 0.5, so v lands in [0,1] with no clamping. */
const W1 = 0.34
const W2 = 0.16

/** The accent gate, in two parts: the field's own crest (HOT_RAW) and the third
 *  octave (HOT_S). Both are needed — gating on the third octave alone fires on
 *  a handful of blocks anti-correlated with where level 2 lands, so the accent
 *  may as well not exist.
 *
 *  The frequency of that third octave is the load-bearing part, and it is why
 *  A3/F3 are 17/41.3 rather than something in the same range as F1/F2. When the
 *  third octave is COARSE, its lobes are the same size as the crest bands of the
 *  main field, the two drift in and out of phase, and the accent count swings
 *  with them: at 2 arms / F3 4.1 a 1440x910 hero measured 0 accent blocks for
 *  seconds at a time and then 1843 (2.2% of the canvas, 55% of every level-2
 *  block on screen) at the alignment. That is not an accent, it is a periodic
 *  orange flush behind the headline.
 *
 *  Making the third octave fine relative to the crest bands decorrelates them:
 *  every crest band now straddles many alternating lobes, so the accent lands as
 *  short dashes along the ridge and its area stops depending on phase. Measured
 *  over 160 frames spanning a full revolution, at 1021-1920px wide: mean 3.8-4.3%
 *  of level-2 blocks, peak 8.4-12.8%, never above 0.31% of the canvas. The
 *  thresholds are high because the gate is now a thin band on a thin ridge. */
const HOT_RAW = 0.94
const HOT_S = 0.82

/** Radial envelope: hollow at the centre, peaking mid-field, falling off past
 *  R_PEAK. Units are half-heights of the box. It does NOT reach zero at the
 *  corners on its own — measured, the ring term is still 0.27 (1920x900) to
 *  0.92 (375x820) at the corner blocks. Reaching true zero at the edges is the
 *  job of E_X/E_T/E_B below, and of the radial mask in dither.css. */
const R_IN = 0.2
const R_PEAK = 0.62
const R_OUT = 1.45

/** Edge fades, as a fraction of the box. Every one of them reaches zero. */
const E_X = 0.035
const E_T = 0.085
const E_B = 0.17

/** The copy-column carve. It runs the full height of the copy — releasing it
 *  earlier put weight back under `.hero__note`, which is --fg-3 mono at 11px
 *  and the least contrasty text in the hero.
 *
 *  Below CARVE_BOTTOM the carve releases and the field comes back hard — it is
 *  not a dead tail. E_B does not zero it there; that fade only starts at vy
 *  0.83. Measured off the canvas at 1440x910, 28.6% of the pixels under the
 *  proof strip's box are painted. It does not matter: `.proof` grounds itself
 *  on an opaque `--surface` and `.hero__in` is z-index 2 over this z-index 0,
 *  so every one of those blocks is occluded. Same for the terminal card, on
 *  opaque #0d0e11. The release is what gives the field somewhere to live
 *  underneath the fold without ever reaching live text. */
const CARVE_FEATHER = 0.085
const CARVE_BOTTOM = 0.78
const CARVE_FADE = 0.18

/** How much of the field the carve removes.
 *
 *  Two columns: all of it. There is clean ground either side of the copy, so
 *  the field has somewhere to go and the headline gets bare ink.
 *
 *  Stacked: the copy is the full shell and a total carve would leave the
 *  component drawing nothing at all below 1020px. 0.86 caps the field at 0.14
 *  behind the copy, which is under the 0.5 that level 2 needs — so only the
 *  back tone can appear there, never the front tone and never the accent.
 *  Measured against cream that is 16.3:1, against 16.7:1 on bare ink. */
const CARVE_WIDE = 1
const CARVE_STACKED = 0.86

/** Layout facts mirrored from pages.css / base.css, so the carve tracks the
 *  real hero grid. `--shell` itself is resolved by the browser, not guessed. */
const STACK_BP = 1020 /* .hero__grid collapses to one column here */
const COPY_FRAC = 0.51 /* 1.02fr of (1.02fr + 0.98fr) */
const GAP_MIN = 32 /* clamp(2rem, 5vw, 4rem) */
const GAP_MAX = 64
const COPY_PAD = 26 /* px of clearance kept around the copy column */
const SHELL_MAX = 1180
const SHELL_GUTTER = 40

/** Frozen clock for the static (reduced-motion) frame, in ms. */
const STATIC_MS = 12500

/** Smoothstep on a value clamped to [0,1]. */
function s01(t: number): number {
  if (!(t > 0)) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}

/* ------------------------------------------------------------------ colour */

type Rgba = { r: number; g: number; b: number; a: number }

function alphaOf(raw: string): number {
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return Number.NaN
  return raw.endsWith('%') ? n / 100 : n
}

/**
 * Parse the normalised output of `getComputedStyle().color`. That is `rgb()` or
 * `rgba()` for hex and named inputs; engines hand back `color(srgb ...)` for
 * some computed values, and the hex branch is belt and braces for anything that
 * reports the authored value instead.
 */
function parseColor(value: string): Rgba | null {
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

  const srgb = /^color\(\s*srgb\s+([^)]*)\)$/.exec(s)
  if (srgb) {
    const parts = srgb[1].split(/[\s/]+/).filter((p) => p.length > 0)
    if (parts.length < 3) return null
    const ch = (raw: string): number => {
      const n = parseFloat(raw)
      if (!Number.isFinite(n)) return Number.NaN
      return (raw.endsWith('%') ? n / 100 : n) * 255
    }
    const r = ch(parts[0])
    const g = ch(parts[1])
    const b = ch(parts[2])
    const a = parts.length > 3 ? alphaOf(parts[3]) : 1
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
    if (!Number.isFinite(a)) return null
    return { r, g, b, a }
  }

  const m = /^rgba?\(([^)]*)\)$/.exec(s)
  if (!m) return null
  const parts = m[1].split(/[\s,/]+/).filter((p) => p.length > 0)
  if (parts.length < 3) return null
  const num = (raw: string): number => {
    const n = parseFloat(raw)
    if (!Number.isFinite(n)) return Number.NaN
    return raw.endsWith('%') ? (n / 100) * 255 : n
  }
  const r = num(parts[0])
  const g = num(parts[1])
  const b = num(parts[2])
  const a = parts.length > 3 ? alphaOf(parts[3]) : 1
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
  if (!Number.isFinite(a)) return null
  return { r, g, b, a }
}

type Tones = { back: Rgba; front: Rgba; hot: Rgba | null }

/**
 * Resolve the three tone properties, each scaled by its own plain-number alpha.
 *
 * Setting `color: var(--x)` on a probe and reading `getComputedStyle().color`
 * back makes the engine do the work: `var()` chains, hex, named colours and
 * modern colour spaces all come back normalised. Reading the custom property
 * directly would hand back whatever syntax was authored.
 *
 * Every read is gated on the property actually existing, because `color:
 * var(--missing)` is invalid at computed-value time and the probe would report
 * the *inherited* text colour — cream, which would be catastrophic here.
 */
function readTones(host: HTMLElement, probe: HTMLElement): Tones | null {
  const hostStyle = window.getComputedStyle(host)
  const declared = (prop: string): boolean => hostStyle.getPropertyValue(prop).trim().length > 0

  // Without a front tone there is no field; the hero's own atmosphere still renders.
  if (!declared('--dither-front')) return null

  const read = (prop: string): Rgba | null => {
    if (!declared(prop)) return null
    probe.style.color = ''
    probe.style.color = `var(${prop})`
    return parseColor(window.getComputedStyle(probe).color)
  }
  const alpha = (prop: string): number => {
    const raw = parseFloat(hostStyle.getPropertyValue(prop))
    return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1
  }

  const front = read('--dither-front')
  const back = read('--dither-back')
  const hot = read('--dither-hot')
  probe.style.color = ''
  if (!front) return null

  const f: Rgba = { ...front, a: front.a * alpha('--dither-front-a') }
  // A hot alpha of 0 means "no accent", not "punch a transparent hole in the
  // crest" — so it collapses to null and those blocks fall back to the front
  // tone. `--dither-hot-a: 0` is the supported way to take the accent out.
  const hotA = hot ? hot.a * alpha('--dither-hot-a') : 0
  return {
    front: f,
    back: back ? { ...back, a: back.a * alpha('--dither-back-a') } : { ...f, a: f.a * 0.5 },
    hot: hot && hotA > 0 ? { ...hot, a: hotA } : null,
  }
}

/** Byte order of a Uint32 view over an ImageData buffer. */
const LITTLE_ENDIAN = (() => {
  const probe = new Uint32Array(1)
  new Uint8Array(probe.buffer)[0] = 0x0d
  return probe[0] === 0x0d
})()

/** Pack a tone into one 32-bit RGBA word, matching the platform's byte order. */
function pack(c: Rgba): number {
  const b8 = (n: number): number => Math.max(0, Math.min(255, Math.round(n))) & 255
  const r = b8(c.r)
  const g = b8(c.g)
  const b = b8(c.b)
  const a = b8(c.a * 255)
  const word = LITTLE_ENDIAN
    ? (a << 24) | (b << 16) | (g << 8) | r
    : (r << 24) | (g << 16) | (b << 8) | a
  return word >>> 0
}

/* --------------------------------------------------------------- component */

export type DitherFieldProps = {
  /** Edge of one output block, in CSS pixels. Chunky on purpose. */
  pxSize?: number
  /** Field speed. 0.9 is roughly one revolution per 75 seconds. */
  speed?: number
  /** Arms in the primary octave. */
  arms?: number
  className?: string
}

export function DitherField({ pxSize = 4, speed = 0.9, arms = 3, className }: DitherFieldProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const hostEl = hostRef.current
    const canvasEl = canvasRef.current
    if (!hostEl || !canvasEl) return
    const context = canvasEl.getContext('2d')
    if (!context) return
    // The small buffer. A plain element, not OffscreenCanvas — this needs no
    // worker, and support for the element is universal.
    const bufferEl = document.createElement('canvas')
    const bufferContext = bufferEl.getContext('2d')
    if (!bufferContext) return

    // Pin the checked values: narrowing of a captured binding does not survive
    // into the hoisted declarations below.
    const host: HTMLDivElement = hostEl
    const canvas: HTMLCanvasElement = canvasEl
    const ctx: CanvasRenderingContext2D = context
    const buffer: HTMLCanvasElement = bufferEl
    const bctx: CanvasRenderingContext2D = bufferContext

    // One probe, two jobs: it resolves the tone tokens (via `color`) and the
    // shell width (via `width: var(--shell)`, which the host's own box makes the
    // browser resolve against exactly the width `.shell` sees).
    const probe = document.createElement('span')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText =
      'position:absolute;left:0;top:0;height:0;width:var(--shell);' +
      'visibility:hidden;pointer-events:none'
    host.appendChild(probe)

    const tones = readTones(host, probe)
    if (!tones) {
      host.removeChild(probe)
      return
    }

    /* ------------------------------------------------------------ settings */

    const px = Math.max(2, Math.min(16, Math.round(pxSize)))
    const armCount = Math.max(1, Math.min(8, Math.round(arms)))
    const rate = Math.max(0, Math.min(4, speed)) * TEMPO

    const frontPix = pack(tones.front)
    const backPix = pack(tones.back)
    const hotPix = tones.hot ? pack(tones.hot) : frontPix

    /* -------------------------------------------------------------- sizing */

    let cssW = 0
    let cssH = 0
    let dpr = 0

    /** Device pixels per block. Kept integral so blocks never alias. */
    let blockDev = px
    let bw = 0
    let bh = 0

    let image: ImageData | null = null
    let pixels: Uint32Array | null = null
    // Time-invariant, rebuilt only on resize: the three octave phases and the
    // combined mask weight, one entry per block.
    let p1 = new Float32Array(0)
    let p2 = new Float32Array(0)
    let p3 = new Float32Array(0)
    let mask = new Float32Array(0)

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

    /**
     * Where the copy column sits, as a normalised span of the hero's width,
     * plus how hard to carve it. `--shell` is resolved by the browser off the
     * probe rather than recomputed here, so this tracks the real layout; the
     * rest mirrors the `.hero__grid` template in pages.css.
     */
    function copySpan(): [number, number, number] {
      const w = parseFloat(window.getComputedStyle(probe).width)
      const shellW =
        Number.isFinite(w) && w > 1 ? w : Math.min(SHELL_MAX, Math.max(0, cssW - SHELL_GUTTER))
      // Anything that mirrors a media query or a `vw` unit has to be measured the
      // way CSS measures it. `window.innerWidth`, like a media query and like
      // 5vw, INCLUDES a classic scrollbar; the host's own box does not. The gap
      // is a couple of pixels either way, but the branch is not: at an inner
      // width of 1021-1035 with a 15px scrollbar the host reports <= 1020, so
      // this used to take the stacked branch — carving the whole width at 0.86
      // and never fully clearing the headline — while .hero__grid was still two
      // columns and dither.css was still at the desktop opacity.
      const vw = window.innerWidth > 0 ? window.innerWidth : cssW
      const gap = Math.min(GAP_MAX, Math.max(GAP_MIN, vw * 0.05))
      const stacked = vw <= STACK_BP
      const copyW = stacked ? shellW : Math.max(0, (shellW - gap) * COPY_FRAC)
      const left = (cssW - shellW) / 2
      return [
        (left - COPY_PAD) / cssW,
        (left + copyW + COPY_PAD) / cssW,
        stacked ? CARVE_STACKED : CARVE_WIDE,
      ]
    }

    /**
     * Recompute everything that does not depend on time. Runs on resize only.
     * The atan2 per block is the expensive part; keeping it out of the frame
     * loop is what makes a full-bleed field affordable at all.
     */
    function rebuild(): void {
      if (cssW < 2 || cssH < 2) {
        bw = 0
        bh = 0
        return
      }

      blockDev = Math.max(1, Math.round(px * dpr))
      bw = Math.max(1, Math.ceil(canvas.width / blockDev))
      bh = Math.max(1, Math.ceil(canvas.height / blockDev))
      buffer.width = bw
      buffer.height = bh

      const img = bctx.createImageData(bw, bh)
      image = img
      pixels = new Uint32Array(img.data.buffer)

      const n = bw * bh
      p1 = new Float32Array(n)
      p2 = new Float32Array(n)
      p3 = new Float32Array(n)
      mask = new Float32Array(n)

      const aspect = cssW / cssH
      const [c0, c1, carveDepth] = copySpan()

      for (let by = 0; by < bh; by++) {
        const vy = (by + 0.5) / bh
        const ay = vy - 0.5
        const row = by * bw
        // Constant along a row: the vertical edge fade and the carve's own
        // vertical falloff (full behind the copy, gone below it).
        const edgeY = s01(vy / E_T) * s01((1 - vy) / E_B)
        const carveY = 1 - s01((vy - CARVE_BOTTOM) / CARVE_FADE)

        for (let bx = 0; bx < bw; bx++) {
          const u = (bx + 0.5) / bw
          const ax = (u - 0.5) * aspect
          const r = Math.sqrt(ax * ax + ay * ay)
          const ang = Math.atan2(ay, ax)
          const i = row + bx

          p1[i] = ang * armCount + r * F1
          p2[i] = (ang + PHI2) * (armCount + 2) - r * F2
          p3[i] = ang * A3 - r * F3

          const ring = s01((r - R_IN) / (R_PEAK - R_IN)) * (1 - s01((r - R_PEAK) / (R_OUT - R_PEAK)))
          const edgeX = s01(u / E_X) * s01((1 - u) / E_X)
          // 1 inside the copy column, feathered to 0 outside it.
          const carveX = 1 - s01(Math.max(c0 - u, u - c1) / CARVE_FEATHER)

          mask[i] = ring * edgeX * edgeY * (1 - carveDepth * carveX * carveY)
        }
      }
    }

    /* --------------------------------------------------------------- frame */

    function draw(t: number): void {
      const img = image
      const out = pixels
      if (!img || !out || bw === 0 || bh === 0) return

      const t1 = t * rate
      const t2 = t * rate * 0.61
      const t3 = t * rate * 0.37

      out.fill(0)

      for (let by = 0; by < bh; by++) {
        const row = by * bw
        const bayerRow = (by & 3) * 4
        for (let bx = 0; bx < bw; bx++) {
          const i = row + bx
          const w = mask[i]
          if (w < DEAD) continue

          const raw = 0.5 + W1 * Math.sin(p1[i] - t1) + W2 * Math.sin(p2[i] + t2)
          // The whole trick, in one line: threshold against the Bayer cell for
          // this block rather than against a constant.
          let level = (raw * w * LEVELS + BAYER[bayerRow + (bx & 3)]) | 0
          if (level <= 0) continue
          if (level > LEVELS) level = LEVELS
          if (level < LEVELS) {
            out[i] = backPix
            continue
          }
          // Cheap compares first: the third sin only runs on blocks that have
          // already cleared both the level and the crest test.
          out[i] = raw > HOT_RAW && Math.sin(p3[i] + t3) > HOT_S ? hotPix : frontPix
        }
      }

      bctx.putImageData(img, 0, 0)

      // A canvas resize resets context state, so reassert both rather than
      // tracking whether they are still valid.
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(buffer, 0, 0, bw, bh, 0, 0, bw * blockDev, bh * blockDev)
    }

    /* ----------------------------------------------------------- lifecycle */

    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reduced = media.matches
    let onScreen = true
    let awake = document.visibilityState !== 'hidden'

    let raf = 0
    let last = 0
    let acc = 0
    // Animated time. Frozen while paused, so resuming does not jump the field.
    let clock = STATIC_MS

    const render = (): void => draw(clock * 0.001)

    const frame = (now: number): void => {
      raf = window.requestAnimationFrame(frame)
      if (last === 0) last = now
      // A long gap (a backgrounded tab that slipped past visibilitychange, a
      // stalled main thread) must not teleport the field a quarter turn.
      const dt = Math.min(100, now - last)
      last = now
      clock += dt
      acc += dt
      if (acc < FRAME_MS) return
      acc -= FRAME_MS
      if (acc > FRAME_MS) acc = 0
      render()
    }

    const start = (): void => {
      if (raf !== 0 || reduced || !onScreen || !awake) return
      last = 0
      acc = 0
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
      if (!setSize(w, h)) return
      rebuild()
      render()
    }

    const onMedia = (): void => {
      reduced = media.matches
      if (reduced) {
        stop()
        clock = STATIC_MS
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

    const onWindowResize = (): void => {
      const box = host.getBoundingClientRect()
      applySize(box.width, box.height)
    }

    // Browser zoom moves devicePixelRatio and fires `resize`, but dragging the
    // window onto a display with a different ratio moves it while every CSS box
    // stays exactly the same size — so neither `resize` nor the ResizeObserver
    // fires, and the canvas would keep a backing store at the old ratio: soft,
    // half-pixel block edges, which is the one thing this component is built not
    // to have. Watch the ratio itself. The query has to name the current value,
    // so it is re-armed on every change.
    let dprMedia: MediaQueryList | null = null
    const onDpr = (): void => {
      armDpr()
      onWindowResize()
    }
    function armDpr(): void {
      dprMedia?.removeEventListener('change', onDpr)
      dprMedia = null
      const ratio = window.devicePixelRatio
      if (!Number.isFinite(ratio) || ratio <= 0) return
      // Engines without the `resolution` feature just return a list that never
      // matches and never fires; the component degrades to resize-only.
      const mq = window.matchMedia(`(resolution: ${ratio}dppx)`)
      mq.addEventListener('change', onDpr)
      dprMedia = mq
    }
    armDpr()

    // Paint one frame synchronously so the hero is never briefly empty; the
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
      dprMedia?.removeEventListener('change', onDpr)
      dprMedia = null
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', onWindowResize)
      if (probe.parentNode === host) host.removeChild(probe)
      // Drop the backing stores rather than waiting on the collector: a hero
      // buffer is a megabyte of typed arrays.
      buffer.width = 0
      buffer.height = 0
      image = null
      pixels = null
      p1 = new Float32Array(0)
      p2 = new Float32Array(0)
      p3 = new Float32Array(0)
      mask = new Float32Array(0)
    }
  }, [pxSize, speed, arms])

  return (
    <div ref={hostRef} className={className ? `dither ${className}` : 'dither'} aria-hidden="true">
      <canvas ref={canvasRef} className="dither__canvas" />
    </div>
  )
}
