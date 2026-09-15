import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronsUpDown, RotateCcw } from 'lucide-react'

import { FontList } from '@/components/fonts/font-list'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { findFont } from '@/lib/fonts/catalog'

import {
  DEFAULT_TEXT_SETTINGS,
  READER_MODES,
  RESUME_BEHAVIORS,
  TEXT_LINE_HEIGHT_RANGE,
  TEXT_SIZE_RANGE,
  TEXT_WIDTH_RANGE,
  useFullscreenReader,
  useReaderMode,
  useResumeBehavior,
  useTextReaderSettings,
} from './reader-settings'
import type {
  ReaderMode,
  ResumeBehavior,
  TextReaderSettings,
} from './reader-settings'

const APP_FONT_LABEL = 'App font'

/** Every reader preference, in the one place they are set. */
export function ReaderSettingsPanel() {
  const [mode, setMode] = useReaderMode()
  const [resume, setResume] = useResumeBehavior()
  const [fullscreen, setFullscreen] = useFullscreenReader()
  const [text, updateText] = useTextReaderSettings()

  const resumeSummary =
    RESUME_BEHAVIORS.find((option) => option.value === resume)?.summary ?? ''

  const isDefaultText = (
    Object.keys(DEFAULT_TEXT_SETTINGS) as (keyof TextReaderSettings)[]
  ).every((key) => text[key] === DEFAULT_TEXT_SETTINGS[key])

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-card">
        <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium">Reader</h2>
          <span className="text-xs text-muted-foreground">
            Applies to every series
          </span>
        </header>

        <div className="divide-y divide-border">
          <Row
            id="reader-mode"
            label="Reading mode"
            hint="One scrolling strip, or a page at a time. Novels always scroll."
          >
            <Select
              value={mode}
              onValueChange={(value) => setMode(value as ReaderMode)}
            >
              <SelectTrigger id="reader-mode" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {READER_MODES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          <Row
            id="reader-resume"
            label="When reopening a chapter"
            hint={resumeSummary}
          >
            <Select
              value={resume}
              onValueChange={(value) => setResume(value as ResumeBehavior)}
            >
              <SelectTrigger id="reader-resume" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RESUME_BEHAVIORS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          <Row
            id="reader-fullscreen"
            label="Fullscreen"
            hint="Fills the screen and keeps it on. Fades after 20 seconds idle so the phone can lock."
          >
            <Switch
              id="reader-fullscreen"
              checked={fullscreen}
              onCheckedChange={setFullscreen}
            />
          </Row>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium">Novel text</h2>
        </header>

        <div className="divide-y divide-border">
          <RangeRow
            id="reader-text-size"
            label="Size"
            value={text.fontSize}
            min={TEXT_SIZE_RANGE.min}
            max={TEXT_SIZE_RANGE.max}
            step={1}
            display={`${text.fontSize}px`}
            onChange={(fontSize) => updateText({ fontSize })}
          />
          <RangeRow
            id="reader-text-leading"
            label="Line height"
            value={text.lineHeight}
            min={TEXT_LINE_HEIGHT_RANGE.min}
            max={TEXT_LINE_HEIGHT_RANGE.max}
            step={0.05}
            display={text.lineHeight.toFixed(2)}
            onChange={(lineHeight) => updateText({ lineHeight })}
          />
          <RangeRow
            id="reader-text-width"
            label="Width"
            value={text.width}
            min={TEXT_WIDTH_RANGE.min}
            max={TEXT_WIDTH_RANGE.max}
            step={1}
            display={`${text.width} chars`}
            onChange={(width) => updateText({ width })}
          />

          <Row id="reader-text-font" label="Typeface">
            <TypefacePicker
              value={text.font}
              onChange={(font) => updateText({ font })}
            />
          </Row>

          <Row
            id="reader-text-justify"
            label="Justify"
            hint="Flush both margins, with hyphenation."
          >
            <Switch
              id="reader-text-justify"
              checked={text.justify}
              onCheckedChange={(checked) => updateText({ justify: checked })}
            />
          </Row>

          <div className="flex justify-end px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={isDefaultText}
              onClick={() => updateText(DEFAULT_TEXT_SETTINGS)}
            >
              <RotateCcw aria-hidden />
              Reset to defaults
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}

function Row({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
        {hint ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function RangeRow({
  id,
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  /** The value as the reader should read it, units included. */
  display: string
  onChange(value: number): void
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-4">
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
        <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums text-foreground">
          {display}
        </span>
      </div>
      <input
        id={id}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="mt-2 w-full accent-primary"
      />
    </div>
  )
}

function TypefacePicker({
  value,
  onChange,
}: {
  value: string
  onChange(id: string): void
}) {
  const [open, setOpen] = useState(false)
  const triggerId = useId()
  const active = findFont(value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={triggerId}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Typeface"
          className="w-52 justify-between"
        >
          <span className="truncate" style={{ fontFamily: active?.stack }}>
            {active?.name ?? APP_FONT_LABEL}
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1">
        <FontList
          autoFocus
          value={value}
          onChange={onChange}
          defaultLabel={APP_FONT_LABEL}
        />
      </PopoverContent>
    </Popover>
  )
}
