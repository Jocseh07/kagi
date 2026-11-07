interface PageScrubberProps {
  /** Comics count pages; novels report a 0–100 position. */
  kind: 'pages' | 'percent'
  /** Page index (0-based) for pages, whole percent for percent. */
  value: number
  /** Page count for pages; ignored for percent. */
  total: number
  rightToLeft?: boolean
  /** A page index, or a whole percent. */
  onChange(next: number): void
}

/**
 * Where you are in the chapter, and a way to get anywhere in it.
 *
 * A native range input: it already has keyboard, touch and screen reader
 * behaviour, and `accent-primary` puts it on the theme.
 */
export function PageScrubber({
  kind,
  value,
  total,
  rightToLeft = false,
  onChange,
}: PageScrubberProps) {
  const pages = kind === 'pages'
  const min = pages ? 1 : 0
  const max = pages ? total : 100
  const shown = pages ? Math.min(value + 1, total) : value

  return (
    <div className="flex items-center gap-3 px-2">
      <span className="w-9 text-right text-xs text-foreground tabular-nums">
        {pages ? shown : `${shown}%`}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={shown}
        dir={rightToLeft ? 'rtl' : 'ltr'}
        aria-label={pages ? 'Page' : 'Position in chapter'}
        aria-valuetext={pages ? `Page ${shown} of ${total}` : `${shown} percent`}
        className="h-10 min-w-0 flex-1 cursor-pointer accent-primary"
        onChange={(event) => {
          const next = Number(event.target.value)
          onChange(pages ? next - 1 : next)
        }}
      />
      <span className="w-9 text-xs text-muted-foreground tabular-nums">
        {pages ? total : null}
      </span>
    </div>
  )
}
