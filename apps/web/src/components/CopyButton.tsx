/** CopyButton — one-click copy for every shell command on the page.
 *
 *  Design brief: a quiet utility, not a colourful pill. Hairline border, mono
 *  micro-label, muted until the surrounding code surface is hovered or focused.
 *
 *  Three things this file is careful about, because a copy button that lies is
 *  worse than no copy button at all:
 *
 *  1. It works off a secure origin. `navigator.clipboard` is undefined (or
 *     rejects) on plain http, which is exactly how a developer reaches a dev
 *     server on their LAN — so there is a `document.execCommand('copy')`
 *     fallback behind a hidden textarea.
 *  2. Failure is visible. If both paths fail the label turns into the manual
 *     instruction instead of a check mark.
 *  3. The result is announced. The visible label is decorative; a sibling
 *     role="status" carries a spelled-out message for screen readers.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import '../styles/copy.css'

/* ------------------------------------------------------------------ helper */

/**
 * One fragment of a command as it is rendered on screen.
 *
 * A plain string is literal text with no wrapper span. An object renders as
 * `<span className={className}>{text}</span>`; set `copy: false` for the parts
 * that are chrome rather than command — the `$ ` prompt, an inline comment —
 * so they are painted but never land on the clipboard.
 */
export type CodeSpan = string | { text: string; className?: string; copy?: boolean }

/**
 * Derive the literal a shell would run from the same array that paints the
 * spans. This is the whole point of the type: the hero terminal's command is
 * split across coloured spans, and writing it a second time as a string
 * argument to `<CopyButton text="..." />` is how the two silently drift apart.
 * Declare the array once, pass it to `<CodeSpans>` to render and to
 * `copyText()` to copy.
 *
 * Leading/trailing whitespace is trimmed — you never want it in a paste.
 */
export function copyText(spans: readonly CodeSpan[]): string {
  let out = ''
  for (const span of spans) {
    if (typeof span === 'string') {
      out += span
    } else if (span.copy !== false) {
      out += span.text
    }
  }
  return out.trim()
}

/** Render a `CodeSpan[]` as the coloured spans it describes. */
export function CodeSpans({ spans }: { spans: readonly CodeSpan[] }): ReactElement {
  return (
    <>
      {spans.map((span, i) =>
        typeof span === 'string' ? (
          <Fragment key={i}>{span}</Fragment>
        ) : (
          <span key={i} className={span.className}>
            {span.text}
          </span>
        ),
      )}
    </>
  )
}

/* ------------------------------------------------------------- clipboard */

/** Hidden-textarea + execCommand path. Synchronous, works on http origins. */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false

  const ta = document.createElement('textarea')
  ta.value = text
  // readOnly keeps the soft keyboard down on touch; setSelectionRange still
  // works on a read-only textarea, which is what iOS needs.
  ta.readOnly = true
  ta.tabIndex = -1
  ta.setAttribute('aria-hidden', 'true')
  ta.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;' +
    'outline:0;opacity:0;pointer-events:none;'

  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.body.appendChild(ta)

  let ok = false
  try {
    ta.focus({ preventScroll: true })
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  } finally {
    ta.remove()
    // Put focus back on the button so a keyboard user does not lose their place.
    previous?.focus({ preventScroll: true })
  }
  return ok
}

/** Async Clipboard API when it is actually usable, hidden textarea otherwise. */
async function writeClipboard(text: string): Promise<boolean> {
  const secure = typeof window !== 'undefined' && window.isSecureContext
  if (secure && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied, or a browser that exposes the API and then refuses
      // it. Fall through rather than reporting a success that did not happen.
    }
  }
  return legacyCopy(text)
}

/** ⌘ on Apple hardware, Ctrl everywhere else — the failure hint has to be right. */
function appleKeys(): boolean {
  if (typeof navigator === 'undefined') return false
  return /mac|iphone|ipad|ipod/i.test(navigator.userAgent)
}

/* -------------------------------------------------------------- component */

type Status = 'idle' | 'copied' | 'failed'

const HOLD_OK = 1600
const HOLD_FAIL = 4000

export type CopyButtonProps = {
  /** The exact literal placed on the clipboard. */
  text: string
  /**
   * Names the thing being copied in the accessible name: `Copy {what}`.
   * Defaults to `command`, giving "Copy command".
   */
  what?: string
  /** Visible idle micro-label. Pass `''` for an icon-only button. */
  label?: string
  /**
   * `float` (default) parks the button at the top-right of the nearest
   * ancestor carrying `.copy-host`, fading in on hover / focus-within and
   * staying permanently visible where there is no hover (touch). The host must
   * not itself scroll horizontally — see the warning at the top of copy.css.
   * `bar` sits in normal flow — for a terminal chrome strip, where it can
   * always be visible because there is no code underneath it, and the only
   * safe choice over a long nowrap command that scrolls.
   */
  variant?: 'float' | 'bar'
  className?: string
}

export function CopyButton({
  text,
  what = 'command',
  label = 'Copy',
  variant = 'float',
  className,
}: CopyButtonProps): ReactElement {
  const [status, setStatus] = useState<Status>('idle')
  const timer = useRef<number | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
    }
  }, [])

  const onClick = useCallback(() => {
    void (async () => {
      const ok = await writeClipboard(text)
      if (!alive.current) return
      setStatus(ok ? 'copied' : 'failed')
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        timer.current = null
        if (alive.current) setStatus('idle')
      }, ok ? HOLD_OK : HOLD_FAIL)
    })()
  }, [text])

  const combo = appleKeys() ? '⌘C' : 'Ctrl+C'
  // The failure label is the bare combo, not "Press ⌘C": the float variant sits
  // on top of code, and a label that grows from 63px to 120px ("PRESS CTRL+C")
  // walks straight over the line underneath it. The alert glyph carries the
  // "this failed" half, `title` and the live region carry the full sentence.
  // An icon-only button (label='') stays icon-only in every state for the same
  // reason — its host only reserves an icon-wide gutter.
  const visible = label === '' ? '' : status === 'copied' ? 'Copied' : status === 'failed' ? combo : label

  // Spelled out, because "⌘C" is read as junk by most screen readers.
  const announced =
    status === 'copied'
      ? `${what.charAt(0).toUpperCase()}${what.slice(1)} copied to clipboard`
      : status === 'failed'
        ? `Copy failed. Select the ${what} and press ${appleKeys() ? 'Command' : 'Control'}-C.`
        : ''

  return (
    <>
      <button
        type="button"
        className={`copy copy--${variant}${className ? ` ${className}` : ''}`}
        data-state={status}
        onClick={onClick}
        aria-label={`Copy ${what}`}
        title={status === 'failed' ? `Copy failed — press ${combo}` : `Copy ${what}`}
      >
        <CopyGlyph state={status} />
        {visible !== '' && (
          <span className="copy__label" aria-hidden="true">
            {visible}
          </span>
        )}
      </button>
      {/* Sibling, not a child of the button, for two reasons. Blink drops an
          `opacity: 0` subtree out of the accessibility tree, and `.copy--float`
          is opacity 0 until you reach for it — a live region parked in there is
          invisible to AT at exactly the moment it is written to. Out here it is
          always registered. It also keeps the transient text well clear of the
          button's accessible name. `.visually-hidden` is position:absolute, so
          it adds nothing to flex/grid layout wherever it lands. */}
      <span role="status" aria-live="polite" className="visually-hidden">
        {announced}
      </span>
    </>
  )
}

/* ------------------------------------------------------------------ glyph */
/* Inline SVG on currentColor, same idiom as components/Marks.tsx — no icon
   package, and it recolors with the button's state for free. */

function CopyGlyph({ state }: { state: Status }): ReactElement {
  return (
    <svg
      className="copy__glyph glyph"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {state === 'copied' ? (
        <path d="M20 6 L9 17.5 L4 12.5" />
      ) : state === 'failed' ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5 V13" />
          <path d="M12 16.4 V16.5" />
        </>
      ) : (
        <>
          <rect x="9" y="9" width="11" height="11" rx="2.5" />
          <path d="M5.5 15 A2.5 2.5 0 0 1 4 12.7 V6 A2 2 0 0 1 6 4 H12.7 A2.5 2.5 0 0 1 15 5.5" />
        </>
      )}
    </svg>
  )
}

export default CopyButton
