import { useId } from 'react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { resolveStop } from '@/lib/adapt/flow'
import type { StopChoice, StopMode } from '@/lib/adapt/flow'

const MODES: readonly { value: StopMode; label: string }[] = [
  { value: 'end', label: 'All' },
  { value: 'next', label: 'Next' },
  { value: 'until', label: 'Up to' },
]

function isStopMode(value: string): value is StopMode {
  return value === 'end' || value === 'next' || value === 'until'
}

export function StopPointFields({
  base,
  total,
  value,
  onChange,
}: {
  /** Novel chapters already drawn; "next" counts from here. */
  base: number
  total: number
  value: StopChoice
  onChange(next: StopChoice): void
}) {
  const inputId = useId()
  const stopAt = resolveStop(value, base)

  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        type="single"
        aria-label="Stop"
        value={value.mode}
        onValueChange={(next) => {
          if (isStopMode(next)) onChange({ ...value, mode: next })
        }}
        className="grid w-full grid-cols-3"
      >
        {MODES.map((mode) => (
          <ToggleGroupItem key={mode.value} value={mode.value}>
            {mode.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {value.mode === 'end' ? null : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={inputId}>{value.mode === 'next' ? 'Chapters' : 'Novel chapter'}</Label>
          <Input
            id={inputId}
            name="stop"
            type="number"
            inputMode="numeric"
            min={value.mode === 'next' ? 1 : base + 1}
            value={value.count}
            aria-invalid={stopAt === null}
            onChange={(event) => onChange({ ...value, count: event.target.value })}
            className="tabular-nums"
          />
          <p className={stopAt === null ? 'text-xs text-destructive' : 'text-xs text-muted-foreground tabular-nums'}>
            {stopAt === null
              ? value.mode === 'next'
                ? 'Enter 1 or more.'
                : `Enter a chapter after ${base}.`
              : `Stops at novel chapter ${stopAt} of ${total}`}
          </p>
        </div>
      )}
    </div>
  )
}
