import { Fragment } from 'react'
import { Check, CircleAlert } from 'lucide-react'

import type { ChapterFlow, StepState } from '@/lib/adapt/flow'
import { cn } from '@/lib/utils'

const STEPS = [
  { key: 'script', label: 'Script' },
  { key: 'cast', label: 'Sheets' },
  { key: 'panels', label: 'Panels' },
  { key: 'drawn', label: 'Done' },
] as const

const SPOKEN: Record<StepState, string> = { done: 'done', now: 'in progress', stopped: 'stopped', wait: 'waiting' }

const TONE: Record<StepState, string> = {
  done: 'text-muted-foreground',
  now: 'font-medium text-foreground',
  stopped: 'font-medium text-destructive',
  wait: 'text-muted-foreground/70',
}

function Dot({ state, live }: { state: StepState; live: boolean }) {
  if (state === 'done') return <Check aria-hidden className="size-3.5 shrink-0" />
  if (state === 'stopped') return <CircleAlert aria-hidden className="size-3.5 shrink-0" />
  if (state === 'now') {
    return <span aria-hidden className={cn('size-2 shrink-0 rounded-full bg-primary', live && 'motion-safe:animate-pulse')} />
  }
  return <span aria-hidden className="size-2 shrink-0 rounded-full ring-1 ring-border" />
}

/** The four steps on one line, in spans so it can sit inside a button. Phones label only the current step. */
export function FlowSteps({ flow, live }: { flow: ChapterFlow; live: boolean }) {
  const label = (key: (typeof STEPS)[number]['key'], text: string) =>
    (flow[key] === 'now' || flow[key] === 'stopped') && flow.now ? `${text} ${flow.now}` : text
  const spoken = STEPS.map(({ key, label: text }) => `${label(key, text)} ${SPOKEN[flow[key]]}`).join(', ')

  return (
    <span role="img" aria-label={spoken} className="flex items-center gap-1 text-xs">
      {STEPS.map(({ key, label: text }, index) => {
        const state = flow[key]
        const current = state === 'now' || state === 'stopped'
        return (
          <Fragment key={key}>
            {index ? <span aria-hidden className="h-px w-2 shrink-0 bg-border" /> : null}
            <span className={cn('flex shrink-0 items-center gap-1', TONE[state])}>
              <Dot state={state} live={live} />
              <span className={cn('tabular-nums', !current && 'hidden sm:inline')}>{label(key, text)}</span>
            </span>
          </Fragment>
        )
      })}
    </span>
  )
}
