/**
 * The veil that fades the page down once the reader has been left alone. Black
 * at partial opacity, so what is underneath stays faintly legible while it
 * rests.
 */
export function ReaderIdleVeil({ dimmed }: { dimmed: boolean }) {
  return (
    <div
      aria-hidden
      className={`fixed inset-0 z-40 bg-letterbox/80 transition-opacity duration-dim ease-out motion-reduce:transition-none ${
        dimmed ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    />
  )
}
