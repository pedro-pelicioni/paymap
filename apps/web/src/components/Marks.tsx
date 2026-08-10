/** Brand marks — inline SVG mirrors of /assets/stellarsight-mark.svg, so the
 *  chrome never depends on an image file being present. */

/**
 * The Stellarsight mark: a star casting a beam of light onto the ground it lights.
 *
 * Three shapes, painted back to front — the pool of light, the beam, then the
 * star on top. Two details carry the whole thing and are easy to lose when
 * redrawing it:
 *
 *  1. The beam's sides are CONCAVE, flaring like a bell. Straight sides turn it
 *     into a traffic cone.
 *  2. The star's lower point tapers into the beam's waist, so the two read as one
 *     object — light leaving a star — rather than as two stacked shapes.
 *
 * The beam is solid rather than a gradient on purpose: a gradient needs `<defs>`,
 * and an id inside `<defs>` collides the moment two marks render on one page.
 */
export function StellarsightMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <ellipse cx="256" cy="444" rx="238" ry="9" fill="var(--fg-3)" />
      <path
        fill="var(--accent)"
        d="M252 256 C 246 338 214 408 150 441 L 362 441 C 298 408 266 338 260 256 Z"
      />
      <path
        fill="var(--cream)"
        d="M256 54 Q 264 126 341 143 Q 264 160 256 268 Q 248 160 171 143 Q 248 126 256 54 Z"
      />
    </svg>
  )
}

/**
 * The four-pointed star on its own — section markers and bullets.
 * Inherits currentColor so it recolors with its context.
 *
 * It carries the mark's concavity so the family reads, but stays VERTICALLY
 * SYMMETRIC where the mark's star is not: this one sits on a text baseline
 * beside a heading, and the mark's long lower point would hang below it.
 */
export function StarGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 1 Q 13 10.25 23 12 Q 13 13.75 12 23 Q 11 13.75 1 12 Q 11 10.25 12 1 Z"
      />
    </svg>
  )
}
