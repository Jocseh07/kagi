/**
 * The fullscreen reader's frame: a black band on each edge, and the veil that
 * fades the page down once it has been left alone.
 *
 * The bands are true black on purpose (`letterbox`, not a theme surface): they
 * mask the edges the way a display bezel does, and the reader already paints
 * the browser chrome the same black. The veil is the same colour at partial
 * opacity, so what is underneath stays faintly legible while it rests.
 */
export function ReaderFullscreen({ dimmed }: { dimmed: boolean }) {
  return (
    <>
      <div aria-hidden className="reader-letterbox-top fixed inset-x-0 top-0 z-30 bg-letterbox" />
      <div aria-hidden className="reader-letterbox-bottom fixed inset-x-0 bottom-0 z-30 bg-letterbox" />
      <div
        aria-hidden
        className={`fixed inset-0 z-40 bg-letterbox/80 transition-opacity duration-dim ease-out motion-reduce:transition-none ${
          dimmed ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
    </>
  )
}
