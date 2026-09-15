import type { ReactNode } from 'react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, FileDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { DownloadFailure } from '@/lib/images/download'
import { cbzFilename, downloadChapter, saveBlob } from '@/lib/images/download'
import type { SChapter, SManga, Source } from '@/lib/sources/types'

import { DownloadRing } from './download-ring'

/** How long the saved tick stays before the button returns to its resting state. */
const DONE_LINGER_MS = 2500

const FAILURE_TITLES: Record<DownloadFailure['reason'], string> = {
  'cors-blocked': 'This source blocks downloads',
  network: 'Could not reach the image host',
  'http-status': 'The image host rejected a page',
  'no-pages': 'Nothing to download',
  cancelled: 'Download cancelled',
  'zip-failed': 'Could not build the archive',
}

type ExportState =
  | { phase: 'idle' }
  /** The page list is fetched before the pages, so there is nothing to count yet. */
  | { phase: 'listing' }
  | { phase: 'packing'; completed: number; total: number }
  | { phase: 'done' }
  | { phase: 'failed'; title: string; detail: string }

interface ExportCbzButtonProps {
  source: Source
  manga: SManga
  chapter: SChapter
}

/**
 * Saves one chapter to disk as a CBZ.
 *
 * Distinct from `ChapterDownloadButton`, which keeps a chapter readable in this
 * browser: this writes a file the reader owns and can take elsewhere. It lives
 * on the series page rather than in the reader because exporting is a thing you
 * do *to* a chapter, not while reading one.
 *
 * The series page holds no page lists, so the fetch happens on tap — hence the
 * separate `listing` phase before any progress can be counted.
 *
 * Memoized because it hangs off a virtualized chapter row, which re-renders on
 * every scroll frame; its props are stable per chapter.
 */
export const ExportCbzButton = memo(function ExportCbzButton({
  source,
  manga,
  chapter,
}: ExportCbzButtonProps) {
  const [state, setState] = useState<ExportState>({ phase: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  // A result is transient: it reports what just happened, then gets out of the
  // way so the row reads as a row again.
  useEffect(() => {
    if (state.phase !== 'done') return
    const timer = setTimeout(() => setState({ phase: 'idle' }), DONE_LINGER_MS)
    return () => clearTimeout(timer)
  }, [state.phase])

  const start = useCallback(async () => {
    const controller = new AbortController()
    abortRef.current = controller
    setState({ phase: 'listing' })

    let pages
    try {
      pages = await source.getPageList(manga, chapter, controller.signal)
    } catch (error) {
      abortRef.current = null
      if (controller.signal.aborted) {
        setState({ phase: 'idle' })
        return
      }
      setState({
        phase: 'failed',
        title: 'Could not load the page list',
        detail: error instanceof Error ? error.message : String(error),
      })
      return
    }

    setState({ phase: 'packing', completed: 0, total: pages.length })

    const result = await downloadChapter(pages, {
      filename: cbzFilename(manga.title, chapter.name),
      signal: controller.signal,
      onProgress: (completed, total) =>
        setState({ phase: 'packing', completed, total }),
    })

    abortRef.current = null

    if (result.ok) {
      saveBlob(result.blob, result.filename)
      setState({ phase: 'done' })
      return
    }

    // Cancelling is the reader's own doing, not a failure to report.
    if (result.reason === 'cancelled') {
      setState({ phase: 'idle' })
      return
    }

    setState({
      phase: 'failed',
      title: FAILURE_TITLES[result.reason],
      detail: result.message,
    })
  }, [source, manga, chapter])

  const busy = state.phase === 'listing' || state.phase === 'packing'
  const presentation = describe(state)

  return (
    <Button
      variant={presentation.variant}
      size="icon-sm"
      className="shrink-0 max-sm:size-8"
      title={presentation.title}
      aria-label={presentation.title}
      onClick={() =>
        busy ? abortRef.current?.abort() : void start()
      }
    >
      {presentation.icon}
    </Button>
  )
})

interface Presentation {
  icon: ReactNode
  title: string
  variant: 'ghost' | 'secondary' | 'destructive'
}

function describe(state: ExportState): Presentation {
  if (state.phase === 'listing') {
    return {
      icon: <DownloadRing value={0} max={1} indeterminate stop label="Fetching the page list" className="size-4" />,
      title: 'Fetching the page list — tap to cancel',
      variant: 'secondary',
    }
  }

  if (state.phase === 'packing') {
    const counted = state.total > 0
    const done = Math.min(state.completed, state.total)
    const percent = `${Math.round((done / (state.total || 1)) * 100)}%`
    return {
      icon: (
        <DownloadRing
          value={done}
          max={state.total}
          indeterminate={!counted}
          stop
          label={counted ? `Packing — ${percent}` : 'Packing'}
          className="size-4"
        />
      ),
      title: counted
        ? `Packing — ${percent} — tap to cancel`
        : 'Packing — tap to cancel',
      variant: 'secondary',
    }
  }

  if (state.phase === 'done') {
    return {
      icon: <CircleCheck className="fill-primary/15 text-primary" />,
      title: 'Saved to your downloads',
      variant: 'secondary',
    }
  }

  if (state.phase === 'failed') {
    return {
      icon: <CircleAlert />,
      title: `${state.title}: ${state.detail} — tap to try again`,
      variant: 'destructive',
    }
  }

  return {
    icon: <FileDown />,
    title: 'Save this chapter as a CBZ file',
    variant: 'ghost',
  }
}
