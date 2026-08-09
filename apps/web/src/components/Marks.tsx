/** Brand marks — inline SVG mirrors of /assets/starsight-mark.svg, so the
 *  chrome never depends on an image file being present. */

/** The Starsight pin: accent drop, ink core, four-pointed star. */
export function StarsightMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <path
        fill="var(--accent)"
        d="M256 486 C 196 400 100 330 100 218 a 156 156 0 1 1 312 0 C 412 330 316 400 256 486 Z"
      />
      <circle cx="256" cy="218" r="98" fill="var(--ink)" />
      <path
        fill="var(--cream)"
        d="M256 84 Q 278 192 364 218 Q 278 244 256 352 Q 234 244 148 218 Q 234 192 256 84 Z"
      />
    </svg>
  )
}

/** The four-pointed star on its own — section markers and bullets.
 *  Inherits currentColor so it recolors with its context. */
export function StarGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 1 Q 13.7 9.4 23 12 Q 13.7 14.6 12 23 Q 10.3 14.6 1 12 Q 10.3 9.4 12 1 Z"
      />
    </svg>
  )
}
