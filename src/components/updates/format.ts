const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
]

export function relativeTime(timestamp: number): string {
  const elapsed = timestamp - Date.now()
  for (const [unit, size] of UNITS) {
    if (Math.abs(elapsed) >= size) {
      return RELATIVE.format(Math.round(elapsed / size), unit)
    }
  }
  return 'just now'
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})

/** "Today" and "Yesterday" read better than a date the user has to work out. */
export function dayLabel(midnight: number): string {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const elapsedDays = Math.round((today.getTime() - midnight) / 86_400_000)
  if (elapsedDays === 0) return 'Today'
  if (elapsedDays === 1) return 'Yesterday'
  return DAY_FORMAT.format(midnight)
}

/** Mirrors `chapterKeyOf` in the reader: the route param is the url's last segment. */
export function chapterKeyOf(url: string, chapterNumber: number): string {
  return url.split('/').pop() ?? String(chapterNumber)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
