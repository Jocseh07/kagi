import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronDown,
  GalleryVertical,
  Minus,
  Plus,
  RotateCcw,
  Settings2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Combobox } from '@/components/ui/combobox'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useFontStack } from '@/lib/fonts/load'
import { useStandalone } from '@/lib/pwa/installed'
import { wordStartLength } from '@/lib/text/word-starts'
import type { WordStartStrength } from '@/lib/text/word-starts'
import { cn } from '@/lib/utils'

import { TypefacePicker } from './reader-settings-controls'
import {
  DEFAULT_TEXT_SETTINGS,
  READER_SURFACES,
  RESUME_BEHAVIORS,
  TEXT_LINE_HEIGHT_RANGE,
  TEXT_SIZE_RANGE,
  TEXT_WIDTH_RANGE,
  WORD_START_STRENGTHS,
  isDefaultTextSettings,
  readerSurfaceStyle,
  useIdleDim,
  useReaderMode,
  useReaderSurface,
  useResumeBehavior,
  useTextReaderSettings,
  useWordStarts,
} from '@/lib/reader/reader-settings'
import type { ReaderMode, ReaderSurface, ResumeBehavior } from '@/lib/reader/reader-settings'
import { ToolbarButton } from './ui'

const MODES: { value: ReaderMode; label: string; icon: typeof GalleryVertical }[] = [
  { value: 'continuous', label: 'Scroll', icon: GalleryVertical },
  { value: 'paged-ltr', label: 'Left to right', icon: ArrowRightToLine },
  { value: 'paged-rtl', label: 'Right to left', icon: ArrowLeftToLine },
]

/** Short names for the swatches; the full names stay in Settings → Reader. */
const SURFACE_LABEL: Record<ReaderSurface, string> = {
  dark: 'Dark',
  muted: 'Muted',
  black: 'Black',
  app: 'App',
}

/**
 * The reader's own preferences, in the reader: the ones changed mid-chapter up
 * front, the ones set once folded away. Same stores as Settings → Reader, so a
 * size changed here is the size there.
 */
export function ReaderSettingsSheet({ novel }: { novel: boolean }) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ToolbarButton
          className="size-10 p-0 aria-expanded:bg-accent aria-expanded:text-accent-foreground"
          aria-expanded={open}
          aria-label="Reader settings"
          title="Reader settings"
        >
          <Settings2 aria-hidden className="size-5" />
        </ToolbarButton>
      </PopoverTrigger>

      <PopoverContent
        // Upward: this lives in a bar pinned to the bottom of the reader.
        side="top"
        align="end"
        className="max-h-[70dvh] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto p-0"
        // The reader closes the chapter on Escape. While this is open, Escape
        // belongs to it — stopping here keeps the reader from also exiting.
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <h2 className="sr-only">Reader settings</h2>
        <div className="@container flex flex-col gap-5 p-4">
          {novel ? null : <ModeChoice />}
          <SurfaceChoice />
          {novel ? <TextControls /> : null}
          {novel ? <ReadingAidControls /> : null}
          <MoreOptions />
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Group({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {action}
      </div>
      {children}
    </div>
  )
}

/** Novels always scroll, so only the comic reader shows this. */
function ModeChoice() {
  const [mode, setMode] = useReaderMode()

  return (
    <Group label="Reading mode">
      <ToggleGroup
        type="single"
        value={mode}
        onValueChange={(value) => value && setMode(value as ReaderMode)}
        className="grid w-full grid-cols-3 rounded-lg bg-muted p-1"
        spacing={1}
      >
        {MODES.map((item) => (
          <ToggleGroupItem
            key={item.value}
            value={item.value}
            className="h-14 flex-col gap-1 text-xs data-[state=on]:bg-card data-[state=on]:text-card-foreground data-[state=on]:shadow-sm"
          >
            <item.icon aria-hidden />
            {item.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Group>
  )
}

/** Each swatch drawn on the surface it picks, so the choice previews itself. */
function SurfaceChoice() {
  const [surface, setSurface] = useReaderSurface()

  return (
    <Group label="Background">
      <ToggleGroup
        type="single"
        value={surface}
        onValueChange={(value) => value && setSurface(value as ReaderSurface)}
        className="grid w-full grid-cols-4"
        spacing={2}
      >
        {READER_SURFACES.map((item) => {
          const skin = readerSurfaceStyle(item.value)
          return (
            <ToggleGroupItem
              key={item.value}
              value={item.value}
              title={item.hint}
              className="group/swatch h-auto flex-col gap-1.5 p-0 text-xs text-muted-foreground hover:bg-transparent data-[state=on]:bg-transparent data-[state=on]:text-foreground"
            >
              <span
                className={cn(
                  skin.className,
                  'grid aspect-square w-full place-items-center rounded-lg border border-border bg-background font-serif text-lg text-foreground group-data-[state=on]/swatch:ring-2 group-data-[state=on]/swatch:ring-primary',
                )}
                style={skin.style}
                aria-hidden
              >
                Aa
              </span>
              {SURFACE_LABEL[item.value]}
            </ToggleGroupItem>
          )
        })}
      </ToggleGroup>
    </Group>
  )
}

function TextControls() {
  const [text, updateText] = useTextReaderSettings()

  return (
    <Group
      label="Text"
      action={
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          disabled={isDefaultTextSettings(text)}
          onClick={() => updateText(DEFAULT_TEXT_SETTINGS)}
        >
          <RotateCcw data-icon="inline-start" />
          Reset
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Stepper
          label="Size"
          value={text.fontSize}
          step={1}
          range={TEXT_SIZE_RANGE}
          display={`${text.fontSize} px`}
          onChange={(fontSize) => updateText({ fontSize })}
        />
        <Stepper
          label="Line height"
          value={text.lineHeight}
          step={0.05}
          range={TEXT_LINE_HEIGHT_RANGE}
          display={text.lineHeight.toFixed(2)}
          onChange={(lineHeight) => updateText({ lineHeight })}
        />
        <Stepper
          label="Width"
          value={text.width}
          step={2}
          range={TEXT_WIDTH_RANGE}
          display={`${text.width} ch`}
          onChange={(width) => updateText({ width })}
        />
        <div className="flex items-center gap-2">
          <Label htmlFor="sheet-text-font" className="w-24 shrink-0 font-normal">
            Typeface
          </Label>
          <div className="min-w-0 flex-1">
            <TypefacePicker
              id="sheet-text-font"
              value={text.font}
              onChange={(font) => updateText({ font })}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="sheet-text-justify" className="flex-1 font-normal">
            Justify
          </Label>
          <Switch
            id="sheet-text-justify"
            checked={text.justify}
            onCheckedChange={(justify) => updateText({ justify })}
          />
        </div>
      </div>
    </Group>
  )
}

const SAMPLE_WORD = 'Lantern'

/** Each strength drawn on the word it would mark, so the choice previews itself. */
function ReadingAidControls() {
  const [wordStarts, updateWordStarts] = useWordStarts()
  const [text] = useTextReaderSettings()
  const fontFamily = useFontStack(text.font)

  return (
    <Group label="Reading aid">
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label htmlFor="sheet-word-starts" className="font-normal">
              Bold word starts
            </Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Bolds the start of each word to pace your eye.
            </p>
          </div>
          <kbd className="mt-0.5 hidden rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground lg:inline">
            B
          </kbd>
          <Switch
            id="sheet-word-starts"
            className="mt-0.5"
            aria-keyshortcuts="B"
            title="Bold word starts (B)"
            checked={wordStarts.enabled}
            onCheckedChange={(enabled) => updateWordStarts({ enabled })}
          />
        </div>

        <div
          inert={!wordStarts.enabled}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
            wordStarts.enabled ? 'grid-rows-[1fr]' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <ToggleGroup
              type="single"
              aria-label="Strength"
              value={wordStarts.strength}
              onValueChange={(value) =>
                value && updateWordStarts({ strength: value as WordStartStrength })
              }
              className="grid w-full grid-cols-3 p-0.5"
              spacing={2}
            >
              {WORD_START_STRENGTHS.map((item) => {
                const cut = wordStartLength(SAMPLE_WORD, item.value)
                return (
                  <ToggleGroupItem
                    key={item.value}
                    value={item.value}
                    className="group/swatch h-auto flex-col gap-1.5 p-0 text-xs text-muted-foreground hover:bg-transparent data-[state=on]:bg-transparent data-[state=on]:text-foreground"
                  >
                    <span
                      className="grid h-12 w-full place-items-center rounded-lg border border-border bg-background text-base font-normal text-foreground group-data-[state=on]/swatch:ring-2 group-data-[state=on]/swatch:ring-primary"
                      style={{ fontFamily }}
                      aria-hidden
                    >
                      <span>
                        <b className="font-semibold">{SAMPLE_WORD.slice(0, cut)}</b>
                        {SAMPLE_WORD.slice(cut)}
                      </span>
                    </span>
                    {item.label}
                  </ToggleGroupItem>
                )
              })}
            </ToggleGroup>
          </div>
        </div>
      </div>
    </Group>
  )
}

function Stepper({
  label,
  value,
  step,
  range,
  display,
  onChange,
}: {
  label: string
  value: number
  step: number
  range: { min: number; max: number }
  /** The value as the reader reads it, units included. */
  display: string
  onChange(next: number): void
}) {
  // Rounded to the step so repeated 0.05s do not drift into 1.7000000000000002.
  const move = (direction: 1 | -1) => {
    const next = Math.round((value + direction * step) / step) * step
    onChange(Math.min(range.max, Math.max(range.min, Number(next.toFixed(2)))))
  }

  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-sm">{label}</span>
      <div className="flex flex-1 items-center rounded-lg bg-muted p-1">
        <Button
          variant="ghost"
          size="icon-lg"
          className="flex-1"
          aria-label={`Decrease ${label.toLowerCase()}`}
          disabled={value <= range.min}
          onClick={() => move(-1)}
        >
          <Minus />
        </Button>
        <span className="w-16 text-center text-xs tabular-nums" aria-live="polite">
          {display}
        </span>
        <Button
          variant="ghost"
          size="icon-lg"
          className="flex-1"
          aria-label={`Increase ${label.toLowerCase()}`}
          disabled={value >= range.max}
          onClick={() => move(1)}
        >
          <Plus />
        </Button>
      </div>
    </div>
  )
}

/** Set once and rarely touched, so folded away. */
function MoreOptions() {
  const [resume, setResume] = useResumeBehavior()
  const [dimIdle, setDimIdle] = useIdleDim()
  const standalone = useStandalone()

  return (
    <Collapsible className="rounded-lg border border-border">
      <CollapsibleTrigger className="group/more flex h-11 w-full items-center justify-between px-3 text-sm">
        More options
        <ChevronDown
          aria-hidden
          className="size-4 text-muted-foreground transition-transform group-data-[state=open]/more:rotate-180 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 border-t border-border p-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sheet-resume" className="font-normal">
            When reopening a chapter
          </Label>
          <Combobox
            id="sheet-resume"
            label="When reopening a chapter"
            className="w-full"
            options={RESUME_BEHAVIORS}
            value={resume}
            onChange={(value) => setResume(value as ResumeBehavior)}
          />
        </div>
        {standalone ? (
          <SwitchRow
            id="sheet-dim"
            label="Dim when idle"
            checked={dimIdle}
            onChange={setDimIdle}
          />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

function SwitchRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  onChange(next: boolean): void
}) {
  return (
    <div className="flex items-center gap-3">
      <Label htmlFor={id} className="min-w-0 flex-1 font-normal">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
