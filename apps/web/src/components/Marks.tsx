/** Brand marks — inline SVG mirrors of /assets/starsight-mark.svg, so the
 *  chrome never depends on an image file being present. */

/**
 * The Starsight mark: a star high in the frame casting a cone of light down to
 * the ground it lights.
 *
 * Three shapes, in paint order — the beam first so the star sits on top of it,
 * then the star, then the rail it reaches. The beam is a flat shape at low
 * opacity rather than a gradient: a gradient needs `<defs>`, and an id in a
 * `<defs>` collides the moment two of these render on one page.
 */
export function StarsightMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <path fill="var(--accent)" fillOpacity={0.26} d="M234 208 L134 402 L378 402 L278 208 Z" />
      <path
        fill="var(--cream)"
        d="M256 52 Q 274 140 340 162 Q 274 184 256 272 Q 238 184 172 162 Q 238 140 256 52 Z"
      />
      <rect x="110" y="394" width="292" height="22" rx="11" fill="var(--fg-3)" />
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
