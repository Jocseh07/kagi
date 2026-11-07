import { useMemo, useState } from 'react'
import { Link, Navigate, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeft, Sparkles } from 'lucide-react'

import { StopPointFields } from '@/components/adapt/stop-point'
import { StylePicker } from '@/components/adapt/style-picker'
import { MangaCover } from '@/components/manga-grid'
import { usePageBack } from '@/components/page-back'
import { PageContainer } from '@/components/page-container'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { MISSING_ENDPOINT } from '@/lib/adapt/client'
import { resolveStop } from '@/lib/adapt/flow'
import type { StopChoice, StopMode } from '@/lib/adapt/flow'
import { createAdaptation } from '@/lib/adapt/pipeline'
import { useAdaptSettings } from '@/lib/adapt/settings'
import { supportsAdaptations } from '@/lib/adapt/store'
import type { AdaptStyle } from '@/lib/adapt/store'
import { useAdaptationForNovel } from '@/lib/adapt/use-adaptation'
import { useDatabaseReady } from '@/lib/db/provider'
import { storedUpdateQueryOptions } from '@/lib/reader/chapter-queries'
import { ADAPTED_SOURCE_ID } from '@/lib/sources/adapted'
import { getSource } from '@/lib/sources/registry'
import type { MangaUpdate, SManga, Source } from '@/lib/sources/types'
import { describeError } from '@/lib/ui/describe-error'

const STEPS = ['Style', 'Range', 'Review'] as const

type Step = 1 | 2 | 3

interface StartSearch {
  step?: Step
  style?: AdaptStyle
  notes?: string
  stop?: StopMode
  count?: string
  prologue?: boolean
  check?: boolean
}

export const Route = createFileRoute('/adapt/start/$sourceId/$slug')({
  validateSearch: (search: Record<string, unknown>): StartSearch => {
    const next: StartSearch = {}
    if (search.step === 2 || search.step === 3) next.step = search.step
    if (search.style === 'webtoon' || search.style === 'manga' || search.style === 'sketch') next.style = search.style
    if (typeof search.notes === 'string' && search.notes.trim()) next.notes = search.notes
    if (search.stop === 'end' || search.stop === 'next' || search.stop === 'until') next.stop = search.stop
    if (typeof search.count === 'string' || typeof search.count === 'number') next.count = String(search.count)
    if (search.prologue === false) next.prologue = false
    if (search.check === false) next.check = false
    return next
  },
  component: StartPage,
  pendingComponent: StartPending,
})

function StartPending() {
  return (
    <PageContainer>
      <StartSkeleton />
    </PageContainer>
  )
}

function StartSkeleton() {
  return (
    <div aria-busy="true" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <Skeleton className="h-8 w-full" />
      <div className="flex items-center gap-3">
        <Skeleton className="aspect-2/3 w-12 shrink-0 rounded-sm" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <Skeleton className="h-9 w-2/3" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

function StartPage() {
  const { sourceId, slug } = Route.useParams()
  const source = useMemo(() => {
    try {
      return getSource(sourceId)
    } catch {
      return null
    }
  }, [sourceId])

  if (!source) {
    return (
      <PageContainer>
        <ErrorPanel error={new Error(`Unknown source: ${sourceId}`)} />
      </PageContainer>
    )
  }
  return <StartView key={`${sourceId}/${slug}`} source={source} slug={slug} />
}

function StartView({ source, slug }: { source: Source; slug: string }) {
  const stub = useMemo<SManga>(
    () => ({ url: `/series/${slug}`, title: slug, status: 'unknown', initialized: false, memo: { slug } }),
    [slug],
  )
  // Same key as the novel page, so arriving from it shows the novel at once.
  const detail = useQuery<MangaUpdate>({
    queryKey: ['manga', source.id, slug],
    queryFn: () => source.getMangaUpdate(stub, { fetchDetails: true, fetchChapters: true }),
  })
  const databaseReady = useDatabaseReady()
  const stored = useQuery({ ...storedUpdateQueryOptions(source.id, slug), enabled: databaseReady })
  const update = detail.data ?? stored.data ?? null
  const back = useMemo(
    () => ({ to: '/manga/$sourceId/$slug', params: { sourceId: source.id, slug }, label: 'Novel' }),
    [source.id, slug],
  )
  usePageBack(back)

  const waiting = detail.isPending && (stored.isPending || stored.data === null)

  return (
    <PageContainer>
      {waiting ? (
        <StartSkeleton />
      ) : update === null ? (
        <ErrorPanel error={detail.error} onRetry={() => void detail.refetch()} />
      ) : !supportsAdaptations() ? (
        <ErrorPanel error={new Error('This browser cannot store adaptations.')} />
      ) : (
        <StartFlow source={source} slug={slug} novel={update.manga} chapterCount={update.chapters.length} />
      )}
    </PageContainer>
  )
}

function StartFlow({
  source,
  slug,
  novel,
  chapterCount,
}: {
  source: Source
  slug: string
  novel: SManga
  chapterCount: number
}) {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const existing = useAdaptationForNovel(source.id, novel.url)
  const settings = useAdaptSettings()
  const endpointMissing = settings.isSuccess && !settings.data.endpoint
  const step = search.step ?? 1
  const style = search.style ?? 'webtoon'
  const stop: StopChoice = { mode: search.stop ?? 'next', count: search.count ?? '10' }
  const skipPrologue = search.prologue ?? true
  const checkPanels = search.check ?? true
  const [notes, setNotes] = useState(search.notes ?? '')
  const stopAt = resolveStop(stop, 0)

  const setSearch = (patch: Partial<StartSearch>) =>
    void navigate({ to: Route.fullPath, params: { sourceId: source.id, slug }, search: { ...search, ...patch }, replace: true })

  const start = useMutation({
    mutationFn: () =>
      createAdaptation(source.id, novel, chapterCount, {
        style,
        styleNotes: notes,
        stopAt: stopAt ?? undefined,
        skipPrologue,
        checkPanels,
      }),
    onSuccess: (adaptation) =>
      void navigate({
        to: '/manga/$sourceId/$slug',
        params: { sourceId: ADAPTED_SOURCE_ID, slug: adaptation.id },
        search: { tab: 'progress' },
        replace: true,
      }),
  })

  if (existing.data && !start.isPending && !start.isSuccess) {
    return (
      <Navigate
        to="/manga/$sourceId/$slug"
        params={{ sourceId: ADAPTED_SOURCE_ID, slug: existing.data.id }}
        replace
      />
    )
  }

  const stepSearch = (next: Step) => ({ ...search, notes: notes.trim() || undefined, step: next === 1 ? undefined : next })
  const styleLabel = { webtoon: 'Webtoon', manga: 'Manga', sketch: 'Sketch' }[style]
  const stopLabel =
    stopAt === undefined ? 'End of the novel' : stopAt === null ? 'Not set' : `Novel chapter ${stopAt} of ${chapterCount}`

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <nav aria-label="Progress" className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground tabular-nums">
          Step {step} of {STEPS.length}
        </p>
        <ol className="grid grid-cols-3 gap-2">
          {STEPS.map((name, index) => (
            <li key={name} className="flex flex-col gap-1">
              <span className={`h-1 rounded-full ${index < step ? 'bg-foreground' : 'bg-muted'}`} />
              <span
                className={index + 1 === step ? 'text-xs font-medium' : 'text-xs text-muted-foreground'}
                aria-current={index + 1 === step ? 'step' : undefined}
              >
                {name}
              </span>
            </li>
          ))}
        </ol>
      </nav>

      <div className="flex items-center gap-3">
        <MangaCover url={novel.thumbnailUrl} className="w-12 shrink-0" />
        <div className="flex min-w-0 flex-col">
          <p className="truncate text-sm font-medium">{novel.title}</p>
          <p className="truncate text-xs text-muted-foreground tabular-nums">
            {novel.author ? `${novel.author} · ` : ''}
            {source.name} · {chapterCount} {chapterCount === 1 ? 'chapter' : 'chapters'}
          </p>
        </div>
      </div>

      {step === 1 ? (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Pick an art style</h1>
            <p className="text-sm text-muted-foreground">You can change it later. Chapters already drawn keep theirs.</p>
          </header>
          <StylePicker value={style} onChange={(next) => setSearch({ style: next, notes: notes.trim() || undefined })} />
          <Field>
            <FieldLabel htmlFor="style-notes">Style notes</FieldLabel>
            <Textarea
              id="style-notes"
              name="notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Muted colours, thick ink lines, 1990s shoujo eyes"
            />
            <FieldDescription>Optional. Added to every image.</FieldDescription>
          </Field>
        </>
      ) : step === 2 ? (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">How much to adapt</h1>
            <p className="text-sm text-muted-foreground">New chapters on the source join the queue on their own.</p>
          </header>
          <FieldGroup>
            <Field>
              <FieldLabel>Stop at</FieldLabel>
              <StopPointFields
                base={0}
                total={chapterCount}
                value={stop}
                onChange={(next) => setSearch({ stop: next.mode, count: next.count })}
              />
            </Field>
            <Field orientation="horizontal">
              <Switch id="skip-prologue" checked={skipPrologue} onCheckedChange={(on) => setSearch({ prologue: on ? undefined : false })} />
              <FieldContent>
                <FieldLabel htmlFor="skip-prologue">Skip a prologue that adds nothing</FieldLabel>
                <FieldDescription>Kept when it returns later as a flashback.</FieldDescription>
              </FieldContent>
            </Field>
            <Field orientation="horizontal">
              <Switch id="check-panels" checked={checkPanels} onCheckedChange={(on) => setSearch({ check: on ? undefined : false })} />
              <FieldContent>
                <FieldLabel htmlFor="check-panels">Check every panel</FieldLabel>
                <FieldDescription>Redraws panels that miss their sheet. Doubles text calls.</FieldDescription>
              </FieldContent>
            </Field>
          </FieldGroup>
        </>
      ) : (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Start the adaptation</h1>
            <p className="text-sm text-muted-foreground">Keeps going while this tab is open. Pause any time.</p>
          </header>
          <dl className="flex flex-col divide-y rounded-lg px-3 ring-1 ring-border">
            <SummaryRow label="Style" edit={stepSearch(1)} disabled={start.isPending}>
              <span className="font-medium">{styleLabel}</span>
              <span className="block truncate text-muted-foreground">{notes.trim() || 'No style notes'}</span>
            </SummaryRow>
            <SummaryRow label="Stop at" edit={stepSearch(2)} disabled={start.isPending}>
              <span className="font-medium tabular-nums">{stopLabel}</span>
              <span className="block text-muted-foreground">
                {[skipPrologue ? 'Skips an empty prologue' : 'Keeps the prologue', checkPanels ? 'checks every panel' : 'no panel check'].join(', ')}
              </span>
            </SummaryRow>
          </dl>
          <section className="flex flex-col gap-2" aria-labelledby="first-title">
            <h2 id="first-title" className="text-sm font-medium">
              What happens first
            </h2>
            <ol className="flex flex-col gap-2 text-sm">
              {[
                'Reads the first novel chapters and plans the cast',
                'Writes beats and the storyboard for chapter 1',
                'Draws sheets for the cast and places it shows',
                checkPanels ? 'Draws and checks the panels, then letters the pages' : 'Draws the panels, then letters the pages',
              ].map((line, index) => (
                <li key={line} className="flex gap-2">
                  <span className="w-5 shrink-0 text-muted-foreground tabular-nums">{index + 1}</span>
                  <span className="min-w-0 flex-1">{line}</span>
                </li>
              ))}
            </ol>
          </section>
          {endpointMissing ? (
            <Alert>
              <AlertTitle>Can't start yet</AlertTitle>
              <AlertDescription>{MISSING_ENDPOINT}</AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/settings" search={{ tab: 'adapt', billing: undefined }}>
                    Open settings
                  </Link>
                </Button>
              </AlertAction>
            </Alert>
          ) : null}
          {settings.isError ? <ErrorPanel error={settings.error} onRetry={() => void settings.refetch()} /> : null}
          {start.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not start</AlertTitle>
              <AlertDescription>{describeError(start.error)}</AlertDescription>
            </Alert>
          ) : null}
        </>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {step === 1 ? (
          <Button asChild variant="outline">
            <Link to="/manga/$sourceId/$slug" params={{ sourceId: source.id, slug }}>
              Cancel
            </Link>
          </Button>
        ) : (
          <Button asChild variant="outline" disabled={start.isPending}>
            <Link
              to={Route.fullPath}
              params={{ sourceId: source.id, slug }}
              search={stepSearch((step - 1) as Step)}
              disabled={start.isPending}
              aria-disabled={start.isPending}
            >
              <ArrowLeft data-icon="inline-start" />
              Back
            </Link>
          </Button>
        )}
        {step < 3 ? (
          <Button asChild disabled={step === 2 && stopAt === null}>
            <Link to={Route.fullPath} params={{ sourceId: source.id, slug }} search={stepSearch((step + 1) as Step)}>
              Continue
            </Link>
          </Button>
        ) : (
          <Button onClick={() => start.mutate()} disabled={start.isPending || stopAt === null || !settings.data?.endpoint}>
            {start.isPending ? <Spinner data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
            Start
          </Button>
        )}
      </div>
    </div>
  )
}

function SummaryRow({
  label,
  edit,
  disabled,
  children,
}: {
  label: string
  edit: StartSearch
  disabled: boolean
  children: React.ReactNode
}) {
  const { sourceId, slug } = Route.useParams()
  return (
    <div className="flex items-start gap-2 py-3">
      <dt className="w-24 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm">{children}</dd>
      <Link
        to={Route.fullPath}
        params={{ sourceId, slug }}
        search={edit}
        disabled={disabled}
        className="text-sm underline-offset-4 hover:underline aria-disabled:pointer-events-none aria-disabled:opacity-50"
        aria-disabled={disabled}
        aria-label={`Edit ${label.toLowerCase()}`}
      >
        Edit
      </Link>
    </div>
  )
}
