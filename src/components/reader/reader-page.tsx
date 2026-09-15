import { memo, useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

import { ImageReadBlockedError, descramblePage } from '@/lib/images/descramble'
import type { Page } from '@/lib/sources/types'

import { ErrorPanel, Spinner, ToolbarButton } from './ui'
import { getPageAspect, recordPageAspect } from './use-image-preload'

export type PageFit = 'width' | 'screen'

/**
 * How much of a placeholder a failed page reserves. An error panel is a few
 * lines of text, so it holds less space than a page that is still coming — the
 * ratio the old `50vh` kept against the `70vh` placeholder.
 */
const ERROR_HEIGHT_SHARE = 5 / 7

interface ReaderPageProps {
  page: Page
  total: number
  fit: PageFit
  /**
   * Height an unloaded page reserves, in pixels. The strip passes the same
   * number it estimated the row at, so a page whose shape is still unknown is
   * measured at exactly its estimate and moves nothing on the way in. Unused
   * when fitting to the screen, where a page is always exactly one viewport.
   */
  placeholderHeight?: number
}

type DescrambleState =
  | { status: 'working' }
  | { status: 'done'; src: string }
  | { status: 'blocked'; message: string }
  | { status: 'failed'; message: string }

/**
 * Memoised because the strip re-renders whenever the reader around it does —
 * a page turn, a chapter swap, the chrome coming and going — while the pages
 * on screen have not changed. `page` comes straight from the cached page list,
 * so its identity is stable and a shallow comparison is enough.
 */
export const ReaderPage = memo(function ReaderPage({
  page,
  total,
  fit,
  placeholderHeight,
}: ReaderPageProps) {
  const [attempt, setAttempt] = useState(0)
  const [showScrambled, setShowScrambled] = useState(false)
  const [descramble, setDescramble] = useState<DescrambleState>({
    status: 'working',
  })

  const spec = page.descramble
  const label = `Page ${page.index + 1} of ${total}`
  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    if (!spec) return

    let objectUrl: string | undefined
    let abandoned = false
    setDescramble((current) =>
      current.status === 'working' ? current : { status: 'working' },
    )

    descramblePage(page.imageUrl, spec).then(
      (blob) => {
        if (abandoned) return
        objectUrl = URL.createObjectURL(blob)
        setDescramble({ status: 'done', src: objectUrl })
      },
      (error: unknown) => {
        if (abandoned) return
        setDescramble(
          error instanceof ImageReadBlockedError
            ? { status: 'blocked', message: error.message }
            : {
                status: 'failed',
                message: error instanceof Error ? error.message : String(error),
              },
        )
      },
    )

    return () => {
      abandoned = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [page.imageUrl, spec, attempt])

  const wrapperClass =
    fit === 'screen'
      ? 'flex h-full w-full items-center justify-center'
      : 'relative flex w-full flex-col items-center justify-center'

  // A scrambled page must never be shown as though it were correct; the reader
  // only renders the raw image after an explicit, labelled opt-in.
  if (spec && !showScrambled && descramble.status !== 'done') {
    return (
      <div
        style={fit === 'screen' ? undefined : { minHeight: placeholderHeight }}
        className={`${wrapperClass} p-6`}
      >
        {descramble.status === 'working' ? (
          <Spinner label={`Unscrambling ${label.toLowerCase()}`} />
        ) : (
          <ErrorPanel
            title={
              descramble.status === 'blocked'
                ? `${label} is scrambled and cannot be unscrambled here`
                : `${label} could not be unscrambled`
            }
            detail={descramble.message}
          >
            <ToolbarButton variant="solid" onClick={retry}>
              Try again
            </ToolbarButton>
            <ToolbarButton onClick={() => setShowScrambled(true)}>
              Show scrambled image anyway
            </ToolbarButton>
          </ErrorPanel>
        )}
      </div>
    )
  }

  const src = descramble.status === 'done' && spec ? descramble.src : page.imageUrl

  return (
    <div className={wrapperClass}>
      {spec && showScrambled ? (
        <p className="w-full border-y border-border bg-muted px-3 py-1.5 text-center text-xs text-muted-foreground">
          Showing the raw scrambled image. The tiles are out of order.
        </p>
      ) : null}
      <PageImage
        key={`${src}:${attempt}`}
        src={src}
        cacheKey={page.imageUrl}
        label={label}
        fit={fit}
        placeholderHeight={placeholderHeight}
        isObjectUrl={descramble.status === 'done' && Boolean(spec)}
        onRetry={retry}
      />
    </div>
  )
})

interface PageImageProps {
  src: string
  /**
   * The page's own url, which is what its shape is remembered under. Not `src`:
   * a descrambled page is shown from a blob url that is new every time, while
   * the dimensions belong to the page.
   */
  cacheKey: string
  label: string
  fit: PageFit
  placeholderHeight: number | undefined
  isObjectUrl: boolean
  onRetry(): void
}

/**
 * The space a page holds before its image is on screen.
 *
 * A known shape is reserved exactly, as an aspect ratio against the column's
 * width. A page that outran the preloader has no shape yet and falls back to
 * the strip's placeholder height. Once the image is ready it sizes the box
 * itself and neither is wanted.
 */
function pendingSpace(
  fit: PageFit,
  status: 'loading' | 'ready' | 'error',
  aspect: number | null,
  placeholderHeight: number | undefined,
): CSSProperties | undefined {
  if (fit === 'screen' || status === 'ready') return undefined
  if (aspect) return { aspectRatio: `1 / ${aspect}` }
  return placeholderHeight === undefined
    ? undefined
    : { minHeight: placeholderHeight }
}

function PageImage({
  src,
  cacheKey,
  label,
  fit,
  placeholderHeight,
  isObjectUrl,
  onRetry,
}: PageImageProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  // A cached image can finish before React attaches the load listener.
  const captureSettled = useCallback(
    (node: HTMLImageElement | null) => {
      if (!node?.complete) return
      if (node.naturalWidth > 0) recordPageAspect(cacheKey, node)
      setStatus(node.naturalWidth > 0 ? 'ready' : 'error')
    },
    [cacheKey],
  )

  const settle = useCallback(
    (event: { currentTarget: HTMLImageElement }) => {
      recordPageAspect(cacheKey, event.currentTarget)
      setStatus('ready')
    },
    [cacheKey],
  )

  /*
    The space the page will occupy, held from the first render rather than
    claimed when the image lands.

    An image with no reserved height is laid out at the placeholder height and
    then jumps to its real one, which in a virtualised strip re-measures the row
    and shifts every page below it — during the scroll that is loading them.
    The preloader learns each page's shape a few pages ahead, so by the time a
    page mounts the strip usually knows exactly how tall to draw it and nothing
    moves. `placeholderHeight` remains the fallback for a page that outran it —
    a fixed pixel height rather than a viewport unit, so that it is the same
    number the strip estimated the row at and survives a full-screen
    transition unchanged.
  */
  const aspect = getPageAspect(cacheKey)

  if (status === 'error') {
    return (
      <div
        style={
          fit === 'screen' || placeholderHeight === undefined
            ? undefined
            : { minHeight: Math.round(placeholderHeight * ERROR_HEIGHT_SHARE) }
        }
        className={
          fit === 'screen'
            ? 'flex h-full w-full items-center justify-center p-6'
            : 'flex w-full items-center justify-center p-6'
        }
      >
        <ErrorPanel
          title={`${label} did not load`}
          detail="The image request failed. Other pages are unaffected — retry just this one."
        >
          <ToolbarButton variant="solid" onClick={onRetry}>
            Retry page
          </ToolbarButton>
        </ErrorPanel>
      </div>
    )
  }

  return (
    <div
      style={pendingSpace(fit, status, aspect, placeholderHeight)}
      className={
        fit === 'screen'
          ? 'relative flex h-full w-full items-center justify-center'
          : 'relative w-full'
      }
    >
      {/*
        The spinner follows the viewport rather than the page's own centre. A
        webtoon strip reserved at its real shape can be several screens tall, so
        a spinner centred in it would sit off screen for the whole load — the
        page would read as blank rather than as loading.
      */}
      {status === 'loading' ? (
        <div className="pointer-events-none absolute inset-0">
          <div className="sticky top-0 flex h-dvh max-h-full items-center justify-center">
            <Spinner label={`Loading ${label.toLowerCase()}`} />
          </div>
        </div>
      ) : null}

      {/*
        No crossOrigin: on a CDN that sends no CORS headers, requesting one
        makes the image fail to render entirely. Display never needs readable
        pixels — only descrambling does.

        No `loading="lazy"` either: the strip only mounts the pages around the
        viewport, so the window is already drawn there. A second gate on top of
        it just holds the request back until the page is nearly on screen, which
        puts the fetch and the decode in the middle of the scroll.
      */}
      <img
        ref={captureSettled}
        src={src}
        alt={label}
        referrerPolicy={isObjectUrl ? undefined : 'no-referrer'}
        decoding="async"
        draggable={false}
        onLoad={settle}
        onError={() => setStatus('error')}
        className={
          fit === 'screen'
            ? 'max-h-full max-w-full object-contain'
            : `block h-auto w-full ${status === 'ready' ? '' : 'opacity-0'}`
        }
      />
    </div>
  )
}
