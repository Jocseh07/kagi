import { Download } from 'lucide-react'

/** The unread and saved counts joined in one chip on a cover's top-left corner. */
export function CoverBadges({ unread, saved }: { unread: number; saved: number }) {
  if (unread <= 0 && saved <= 0) return null

  return (
    <div className="pointer-events-none absolute top-1 left-1 flex overflow-hidden rounded-sm">
      {unread > 0 && (
        <span className="bg-primary px-1.5 py-0.5 text-2xs font-semibold text-primary-foreground">
          {unread}
          <span className="sr-only"> unread</span>
        </span>
      )}
      {saved > 0 && (
        <span className="flex items-center gap-0.5 bg-secondary px-1.5 py-0.5 text-2xs font-semibold text-secondary-foreground">
          <Download className="size-2.5" />
          {saved}
          <span className="sr-only"> saved</span>
        </span>
      )}
    </div>
  )
}
