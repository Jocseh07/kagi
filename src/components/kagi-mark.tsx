import { cn } from '@/lib/utils'

/** The Page turn mark, drawn in `currentColor` so it follows the theme. Source: public/favicon.svg. */
export function KagiMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <path fill="currentColor" d="M6 6H15.5V26H6A2 2 0 0 1 4 24V8A2 2 0 0 1 6 6Z" />
      <path
        fill="currentColor"
        fillOpacity={0.35}
        d="M17 6H26A2 2 0 0 1 28 8V24A2 2 0 0 1 26 26H17Z"
      />
      <path
        fill="currentColor"
        d="M16.5 26V6C18.8 3.5 21.6 2.4 24 2.6C22.6 9 22.4 16.4 23.4 22.6C20.9 22.5 18.6 23.7 16.5 26Z"
      />
    </svg>
  )
}
