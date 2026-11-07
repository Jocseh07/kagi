import { RotateCcw } from 'lucide-react'

import { useFontOptions } from '@/components/fonts/font-options'
import { Button } from '@/components/ui/button'
import { SettingRow } from '@/components/settings/settings-group'
import { Combobox } from '@/components/ui/combobox'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useStandalone } from '@/lib/pwa/installed'
import { cn } from '@/lib/utils'

import {
  DEFAULT_TEXT_SETTINGS,
  isDefaultTextSettings,
  READER_MODES,
  READER_SURFACES,
  RESUME_BEHAVIORS,
  TEXT_LINE_HEIGHT_RANGE,
  TEXT_SIZE_RANGE,
  TEXT_WIDTH_RANGE,
  WORD_START_STRENGTHS,
  readerSurfaceStyle,
  useIdleDim,
  useReaderMode,
  useReaderSurface,
  useResumeBehavior,
  useTextReaderSettings,
  useWordStarts,
} from '@/lib/reader/reader-settings'
import type {
  ReaderMode,
  ReaderSurface,
  ResumeBehavior,
} from '@/lib/reader/reader-settings'
import type { WordStartStrength } from '@/lib/text/word-starts'

const APP_FONT_LABEL = 'App font'

/**
 * The reader preference rows themselves, with no card or header of their own:
 * the settings page wraps them in its groups.
 */
export function ReaderBehaviorRows() {
  const [mode, setMode] = useReaderMode()
  const [resume, setResume] = useResumeBehavior()
  const [dimIdle, setDimIdle] = useIdleDim()
  const [surface, setSurface] = useReaderSurface()
  const standalone = useStandalone()

  const resumeSummary =
    RESUME_BEHAVIORS.find((option) => option.value === resume)?.summary ?? ''
  const surfaceHint =
    READER_SURFACES.find((option) => option.value === surface)?.hint ?? ''

  return (
    <>
      <SettingRow
        id="reader-mode"
        label="Reading mode"
        hint="Novels always scroll."
        control={
          <Combobox
            id="reader-mode"
            label="Reading mode"
            className="w-full @md:w-52"
            align="end"
            options={READER_MODES}
            value={mode}
            onChange={(value) => setMode(value as ReaderMode)}
          />
        }
      />

      <SettingRow
        id="reader-resume"
        label="Reopening a chapter"
        hint={resumeSummary}
        control={
          <Combobox
            id="reader-resume"
            label="Reopening a chapter"
            className="w-full @md:w-52"
            align="end"
            options={RESUME_BEHAVIORS}
            value={resume}
            onChange={(value) => setResume(value as ResumeBehavior)}
          />
        }
      />

      {standalone ? (
        <SettingRow
          id="reader-dim-idle"
          inline
          label="Dim when idle"
          hint="Keeps the screen on, then fades after 20 seconds untouched."
          control={
            <Switch
              id="reader-dim-idle"
              checked={dimIdle}
              onCheckedChange={setDimIdle}
            />
          }
        />
      ) : null}

      <SettingRow
        label="Background"
        hint={surfaceHint}
        className="@lg:flex-row @lg:items-center @lg:gap-4 @md:flex-col @md:items-stretch"
        control={<SurfacePicker value={surface} onChange={setSurface} />}
      />
    </>
  )
}

/**
 * The four page backgrounds as swatches, each painted by the same skin the
 * reader root wears, so a swatch is exactly the page it selects.
 */
function SurfacePicker({
  value,
  onChange,
}: {
  value: ReaderSurface
  onChange(next: ReaderSurface): void
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label="Background"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as ReaderSurface)
      }}
      className="grid w-full grid-cols-4 @lg:w-72"
    >
      {READER_SURFACES.map((option) => {
        const skin = readerSurfaceStyle(option.value)
        return (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            aria-label={option.label}
            className="h-auto flex-col gap-1.5 py-1.5 text-xs font-normal text-muted-foreground data-[state=on]:text-foreground"
          >
            <span
              aria-hidden
              className={cn(
                skin.className,
                'flex size-8 overflow-hidden rounded-full border border-border bg-background',
              )}
              style={skin.style}
            >
              {/* Follows the app: half page, half ink, since it can be either. */}
              {option.value === 'app' ? (
                <span className="ml-auto h-full w-1/2 bg-foreground" />
              ) : null}
            </span>
            {option.value === 'app' ? 'App' : option.label}
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}

/** Novel typography. Meaningless for a comic, so the comic reader omits it. */
export function NovelTextRows() {
  const [text, updateText] = useTextReaderSettings()
  const [wordStarts, updateWordStarts] = useWordStarts()

  return (
    <>
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

      <SettingRow
        id="reader-text-font"
        label="Typeface"
        control={
          <TypefacePicker
            id="reader-text-font"
            value={text.font}
            onChange={(font) => updateText({ font })}
          />
        }
      />

      <SettingRow
        id="reader-text-justify"
        inline
        label="Justify"
        hint="Flush both margins, with hyphenation."
        control={
          <Switch
            id="reader-text-justify"
            checked={text.justify}
            onCheckedChange={(checked) => updateText({ justify: checked })}
          />
        }
      />

      <SettingRow
        id="reader-word-starts"
        inline
        label="Bold word starts"
        hint="Bolds the start of each word to pace your eye."
        control={
          <Switch
            id="reader-word-starts"
            checked={wordStarts.enabled}
            onCheckedChange={(enabled) => updateWordStarts({ enabled })}
          />
        }
      />

      {wordStarts.enabled ? (
        <SettingRow
          id="reader-word-start-strength"
          label="Strength"
          control={
            <Combobox
              id="reader-word-start-strength"
              label="Strength"
              className="w-full @md:w-52"
              align="end"
              options={WORD_START_STRENGTHS}
              value={wordStarts.strength}
              onChange={(value) =>
                updateWordStarts({ strength: value as WordStartStrength })
              }
            />
          }
        />
      ) : null}
    </>
  )
}

/** Puts the novel typography back to its defaults; disabled when it already is. */
export function TextResetButton() {
  const [text, updateText] = useTextReaderSettings()

  return (
    <Button
      variant="ghost"
      size="sm"
      className="-my-1 h-10 text-xs text-muted-foreground md:h-8"
      disabled={isDefaultTextSettings(text)}
      onClick={() => updateText(DEFAULT_TEXT_SETTINGS)}
    >
      <RotateCcw aria-hidden />
      Reset
    </Button>
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

export function TypefacePicker({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange(id: string): void
}) {
  const options = useFontOptions(APP_FONT_LABEL)

  return (
    <Combobox
      id={id}
      label="Typeface"
      value={value}
      onChange={onChange}
      options={options}
      searchPlaceholder="Search fonts"
      emptyMessage="No font by that name."
      closeOnSelect={false}
      align="end"
      className="w-full @md:w-52"
    />
  )
}
