# PAYMAP — visual assets

Concept: celestial navigation chart meets a precision instrument. Engraved brass
instrument plates, star charts, constellation lines, arc scales with degree ticks,
antique cartographic linework, ledger rules.

Palette: ink `#0B0C0E` · paper `#F2EDE3` · brass `#FF7A18` · jade `#00C2A0` · clay `#B4553A`

| File | What it is | Intended CSS treatment | Origin |
| --- | --- | --- | --- |
| `hero.png` | 1920×1080 — engraved instrument plate: a graduated brass limb struck against a star field of jade sight lines and clay constellations over ledger rules. No text of any kind. | Full-bleed hero background, `object-fit: cover`. On the dark shell use `opacity: .5–.65` with `mix-blend-mode: luminosity`, or scrim it with `linear-gradient(90deg, ink 0%, transparent 60%)` so live type stays legible over the left third. Focal interest sits left-of-centre — anchor headlines against it, not on top of it. | Model-generated (Higgsfield / nano-banana-pro), then cropped to 16:9, resampled and palette-quantised to 96 colours. |
| `texture-grain.png` | 1024×1024 — perfectly tileable paper grain: 2×2 fibre clumping, faint specks, and a wrapping low-frequency unevenness so the sheet never looks flat. Near-monochrome around mid-grey. | Low-opacity overlay on any surface: `background-image: url(texture-grain.png); background-repeat: repeat; mix-blend-mode: overlay; opacity: .05–.08`. For `multiply` on cream use ~6%. Tiles seamlessly in both axes — no `background-size` needed. | Hand-authored (deterministic generator, pure-stdlib PNG writer). Seamlessness is guaranteed by construction; a model render would have shown tile seams. |
| `lot-mark.png` | 512×512 — the brand mark: a paymap reduced to limb, index arm, pivot and a single brass star. Flat two-colour, ink on cream. | Standalone mark at 32–96px. Ships on a cream ground (`#F2EDE3`-ish), so place it on paper surfaces directly; on the ink shell, sit it in a cream chip — `border-radius: 8px` — rather than knocking the background out. Use `favicon.svg` where a transparent mark is needed. | Model-generated, downscaled to 512 and palette-quantised to 32 colours. |
| `og-card.png` | 1200×630 — social share card: engraved plate and star chart across the upper two thirds, with the lower third left as clean empty paper for the site's live text. No text in the image. | `og:image` / `twitter:image`. Overlay title and URL in the lower band (roughly `y > 66%`); that region is flat paper, so ink type reads without a scrim. Do not letterbox — it is already exactly 1.91:1. | Model-generated, cropped from 16:9 to 1.91:1 (trimmed from the top to preserve the empty band), resampled and palette-quantised to 128 colours. |
| `pattern-ruled.svg` | 64×64 tile — ruled ledger paper: 1px hairlines on a 16px rhythm, column rules, and a gutter tick. Drawn in neutral warm grey at low alpha so it does not invert. | `background-image: url(pattern-ruled.svg); background-repeat: repeat;` at `opacity: .5–.9` depending on ground. Reads on both ink and paper without a second variant — raise `opacity` on ink, lower it on cream. Pairs with `texture-grain.png` layered above it. | Hand-authored SVG. |
| `favicon.svg` | 32×32 — the lot mark reduced to pure geometry: limb, index arm, pivot, one star. Two colours, brass on an ink rounded square. | `<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">`. Carries its own ink background, so it holds up on light and dark browser chrome alike. Strokes are 3.6 units at 32 — verified legible at 16px. | Hand-authored SVG. |

## Notes

- Every raster is free of text, letterforms and numerals. The first hero render
  carried degree numerals along the arc scale and was regenerated; the shipped
  version has bare tick marks only.
- PNGs are indexed-colour (palette) PNGs. The source art is flat risograph-style
  work with a small real palette, so quantisation is visually lossless here and
  cuts file size by 3–5×. All four are under 800KB.
- No file depends on any other; nothing references a font or an external URL.
