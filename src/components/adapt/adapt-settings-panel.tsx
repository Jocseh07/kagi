import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PlugZap } from 'lucide-react'

import { SettingRow, SettingsGroup } from '@/components/settings/settings-group'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { listModels } from '@/lib/adapt/client'
import {
  adaptSettingsQueryKey,
  useAdaptSettings,
  writeAdaptSetting,
} from '@/lib/adapt/settings'
import type { AdaptSettings, GenerationMode } from '@/lib/adapt/settings'
import {
  ADAPT_DEFAULTS,
  CHAPTERS_AT_ONCE_CHOICES,
  CONCURRENCY_CHOICES,
  GENERATION_MODES,
  READ_AHEAD_CHOICES,
  SCRIPTS_AHEAD_CHOICES,
} from '@/lib/adapt/settings-model'
import { describeError } from '@/lib/ui/describe-error'

type SettingChange = {
  [K in keyof Required<AdaptSettings>]: { field: K; value: NonNullable<AdaptSettings[K]> }
}[keyof AdaptSettings]

const MODE_LABELS: Record<GenerationMode, string> = { fast: 'Fast', balanced: 'Balanced', custom: 'Custom' }
const MODE_HINTS: Record<GenerationMode, string> = {
  fast: 'Smaller chapters, earlier pages. Story coverage stays.',
  balanced: 'Plans ahead while pages are drawn.',
  custom: 'Choose your models and generation limits.',
}

function checkedAt(time: number): string {
  return `checked ${new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
}

export function AdaptSettingsPanel() {
  const queryClient = useQueryClient()
  const stored = useAdaptSettings()
  const settings = stored.data ?? ADAPT_DEFAULTS

  const save = useMutation({
    mutationFn: ({ field, value }: SettingChange) => writeAdaptSetting(field, value),
    onSettled: () => queryClient.invalidateQueries({ queryKey: adaptSettingsQueryKey }),
  })

  const models = useQuery({
    queryKey: ['adapt', 'models', settings.endpoint, settings.apiKey],
    queryFn: () => listModels(settings),
    enabled: stored.isSuccess && settings.endpoint !== '',
    retry: false,
    staleTime: 60_000,
  })

  const textModels = (models.data ?? []).filter((id) => !id.startsWith('gpt-image'))
  const imageModels = (models.data ?? []).filter((id) => id.startsWith('gpt-image'))
  const mode = settings.mode ?? 'custom'
  const busy = save.isPending || !stored.isSuccess

  return (
    <>
      {stored.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading settings…</p> : null}
      {stored.isError ? (
        <div role="alert" className="flex items-center gap-2">
          <p className="text-sm text-destructive">Settings could not load. Retry to make changes.</p>
          <Button type="button" variant="outline" disabled={stored.isFetching} onClick={() => void stored.refetch()}>
            {stored.isFetching ? <Spinner data-icon="inline-start" /> : null}
            Retry settings
          </Button>
        </div>
      ) : null}
      <fieldset disabled={busy} className="contents" aria-busy={save.isPending}>
      <legend className="sr-only">Generation settings</legend>
      <SettingsGroup title="CLIProxy" description="Adaptations run through CLIProxy on this machine." aside={save.isPending ? <span role="status">Saving…</span> : undefined}>
        <TextSetting
          id="adapt-endpoint"
          label="Endpoint"
          placeholder="http://localhost:8317/v1"
          value={settings.endpoint}
          onCommit={(value) => save.mutateAsync({ field: 'endpoint', value })}
        />
        <TextSetting
          id="adapt-key"
          label="API key"
          hint="Leave empty when CLIProxy needs no key."
          type="password"
          value={settings.apiKey}
          onCommit={(value) => save.mutateAsync({ field: 'apiKey', value })}
        />
        <SettingRow
          label="Connection"
          hint={
            models.isFetching ? (
              'Testing…'
            ) : models.isError ? (
              <span className="text-destructive">
                {describeError(models.error)} · {checkedAt(models.errorUpdatedAt)}
              </span>
            ) : models.data ? (
              `Connected · ${models.data.length} models · ${checkedAt(models.dataUpdatedAt)}`
            ) : stored.isSuccess && !settings.endpoint ? (
              'No endpoint set'
            ) : null
          }
          control={
            <Button type="button" variant="outline" onClick={() => void models.refetch()} disabled={models.isFetching || !settings.endpoint}>
              {models.isFetching ? <Spinner data-icon="inline-start" /> : <PlugZap data-icon="inline-start" />}
              Test connection
            </Button>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Generation mode">
        <SettingRow
          label="Mode"
          hint={MODE_HINTS[mode]}
          control={
            <ToggleGroup
              type="single"
              aria-label="Generation mode"
              value={mode}
              disabled={busy}
              onValueChange={(value) => {
                const next = GENERATION_MODES.find((choice) => choice === value)
                if (next && next !== mode) save.mutate({ field: 'mode', value: next })
              }}
              className="w-full @md:w-72"
            >
              {GENERATION_MODES.map((choice) => (
                <ToggleGroupItem key={choice} value={choice} className="flex-1">
                  {MODE_LABELS[choice]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          }
        />
        <SettingRow
          id="adapt-priority"
          inline
          label="Priority speed"
          hint="GPT text runs about twice as fast. Costs extra on the OpenAI API."
          control={
            <Switch
              id="adapt-priority"
              checked={settings.priority ?? false}
              disabled={busy}
              onCheckedChange={(checked) => save.mutate({ field: 'priority', value: checked })}
            />
          }
        />
      </SettingsGroup>

      <fieldset disabled={mode !== 'custom'} className="contents">
      <legend className="sr-only">Custom generation choices</legend>

      <SettingsGroup title="Models">
        <ModelSetting
          id="adapt-planning"
          label="Planning"
          hint="Reads chapters, picks the cast and looks"
          value={settings.planningModel}
          options={textModels}
          onChange={(value) => save.mutate({ field: 'planningModel', value })}
        />
        <ModelSetting
          id="adapt-script"
          label="Scripts"
          hint="Every chapter: panels and dialogue"
          value={settings.scriptModel}
          options={textModels}
          onChange={(value) => save.mutate({ field: 'scriptModel', value })}
        />
        <ModelSetting
          id="adapt-image"
          label="Images"
          hint="Draws sheets and panels"
          value={settings.imageModel}
          options={imageModels}
          onChange={(value) => save.mutate({ field: 'imageModel', value })}
        />
      </SettingsGroup>

      <SettingsGroup title="Drawing">
        <SettingRow
          label="Drawn at once"
          hint="Across all chapters, earliest first"
          control={
            <ChoiceSetting
              label="Images drawn at once"
              value={settings.concurrency}
              choices={CONCURRENCY_CHOICES}
              onChange={(value) => save.mutate({ field: 'concurrency', value })}
            />
          }
        />
        <SettingRow
          label="Chapters at once"
          hint="Later chapters wait for earlier ones"
          control={
            <ChoiceSetting
              label="Chapters drawn at once"
              value={settings.chaptersAtOnce}
              choices={CHAPTERS_AT_ONCE_CHOICES}
              onChange={(value) => save.mutate({ field: 'chaptersAtOnce', value })}
            />
          }
        />
        <SettingRow
          label="Scripts ahead"
          hint="Written before their chapter is drawn"
          control={
            <ChoiceSetting
              label="Scripts written ahead"
              value={settings.scriptsAhead}
              choices={SCRIPTS_AHEAD_CHOICES}
              onChange={(value) => save.mutate({ field: 'scriptsAhead', value })}
            />
          }
        />
        <SettingRow
          label="Read ahead"
          hint="Novel chapters read before each plan"
          control={
            <ChoiceSetting
              label="Novel chapters read ahead"
              value={settings.readAhead}
              choices={READ_AHEAD_CHOICES}
              onChange={(value) => save.mutate({ field: 'readAhead', value })}
            />
          }
        />
      </SettingsGroup>
      </fieldset>
      </fieldset>

      {save.isError ? (
        <p role="alert" className="px-1 text-sm text-destructive">Could not save your change. Try again.</p>
      ) : null}
    </>
  )
}

function TextSetting({
  id,
  label,
  hint,
  type = 'text',
  placeholder,
  value,
  onCommit,
}: {
  id: string
  label: string
  hint?: string
  type?: 'text' | 'password'
  placeholder?: string
  value: string
  onCommit(value: string): Promise<void>
}) {
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <SettingRow
      id={id}
      label={label}
      hint={hint}
      control={
        <Input
          id={id}
          name={id}
          type={type}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={draft ?? value}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft === null) return
            if (draft.trim() === value) {
              setDraft(null)
              return
            }
            const submitted = draft
            void onCommit(submitted.trim()).then(
              () => setDraft((current) => current === submitted ? null : current),
              () => undefined,
            )
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          className="@md:w-72"
        />
      }
    />
  )
}

function ModelSetting({
  id,
  label,
  hint,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  hint: string
  value: string
  options: readonly string[]
  onChange(value: string): void
}) {
  const ids = options.includes(value) ? options : [value, ...options]
  return (
    <SettingRow
      id={id}
      label={label}
      hint={hint}
      control={
        <Combobox
          id={id}
          label={label}
          value={value}
          onChange={onChange}
          options={ids.map((model) => ({ value: model, label: model }))}
          searchPlaceholder="Search models"
          emptyMessage="No models match."
          className="w-full @md:w-72"
        />
      }
    />
  )
}

function ChoiceSetting({
  label,
  value,
  choices,
  onChange,
}: {
  label: string
  value: number
  choices: readonly number[]
  onChange(value: number): void
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label={label}
      value={String(value)}
      onValueChange={(next) => {
        if (next) onChange(Number(next))
      }}
      className="w-full @md:w-72"
    >
      {choices.map((choice) => (
        <ToggleGroupItem key={choice} value={String(choice)} className="flex-1 tabular-nums">
          {choice}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
