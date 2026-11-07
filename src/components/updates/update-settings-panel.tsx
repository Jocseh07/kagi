import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { SettingRow, SettingsGroup } from '@/components/settings/settings-group'
import { Combobox } from '@/components/ui/combobox'
import { Switch } from '@/components/ui/switch'
import { listCategories } from '@/lib/db/categories'
import { useDatabase } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import {
  DEFAULT_UPDATE_PREFS,
  UPDATE_INTERVALS,
  loadUpdatePrefs,
  saveUpdatePrefs,
  updatePrefsQueryKey,
} from '@/lib/updates/update-manager'
import type {
  UpdateIntervalHours,
  UpdatePrefs,
  UpdateSkipRules,
} from '@/lib/updates/update-manager'
import { describeError } from '@/lib/ui/describe-error'

const ALL_CATEGORIES = 'all'

const INTERVAL_OPTIONS = UPDATE_INTERVALS.map((hours) => ({
  value: String(hours),
  label: intervalLabel(hours),
}))

const SKIP_RULES: {
  key: keyof UpdateSkipRules
  title: string
  summary: string
}[] = [
  {
    key: 'withUnread',
    title: 'Entries with unread chapters',
    summary: 'You already have something to read.',
  },
  {
    key: 'notStarted',
    title: 'Entries you have not started',
    summary: 'The chapters already stored are new enough.',
  },
  {
    key: 'completed',
    title: 'Completed entries',
    summary: 'The source says the series has finished.',
  },
]

export function UpdateSettingsPanel() {
  const { status } = useDatabase()
  const ready = status === 'ready'
  const queryClient = useQueryClient()

  const prefs = useQuery({
    queryKey: updatePrefsQueryKey,
    queryFn: loadUpdatePrefs,
    enabled: ready,
    staleTime: 0,
  })

  const categories = useQuery({
    queryKey: dbKeys.categories,
    queryFn: listCategories,
    enabled: ready,
    staleTime: 0,
  })

  const categoryOptions = useMemo(
    () => [
      { value: ALL_CATEGORIES, label: 'All categories' },
      ...(categories.data ?? []).map((category) => ({
        value: category.id,
        label: category.name,
      })),
    ],
    [categories.data],
  )

  const save = useMutation({
    mutationFn: (patch: Partial<UpdatePrefs>) => saveUpdatePrefs(patch),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: updatePrefsQueryKey }),
  })

  // The refetch that confirms a write lags the click, so an in-flight change
  // is shown as if it had already landed.
  const current: UpdatePrefs = {
    ...(prefs.data ?? DEFAULT_UPDATE_PREFS),
    ...(save.isPending ? save.variables : {}),
  }
  const disabled = !ready || prefs.isPending

  return (
    <>
      <SettingsGroup
        title="Update checks"
        description="Used by the check on the Updates page. Nothing runs until you start it."
      >
        <SettingRow
          id="updates-interval"
          label="Remind me to check"
          hint="Flags the Updates page once the last check is older than this."
          control={
            <Combobox
              id="updates-interval"
              label="Remind me to check"
              className="w-full @md:w-48"
              options={INTERVAL_OPTIONS}
              value={String(current.intervalHours)}
              disabled={disabled}
              onChange={(value) =>
                save.mutate({ intervalHours: intervalOf(value) })
              }
            />
          }
        />

        <SettingRow
          id="updates-category"
          label="Categories to check"
          hint="Fewer categories, shorter checks."
          control={
            <Combobox
              id="updates-category"
              label="Categories to check"
              className="w-full @md:w-48"
              options={categoryOptions}
              value={current.categoryId ?? ALL_CATEGORIES}
              disabled={disabled || categories.isPending}
              searchPlaceholder="Search categories"
              onChange={(value) =>
                save.mutate({
                  categoryId: value === ALL_CATEGORIES ? null : value,
                })
              }
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Skip during a check"
        description="Each skipped entry is one less request to a source."
      >
        {SKIP_RULES.map((rule) => (
          <SettingRow
            key={rule.key}
            id={`updates-${rule.key}`}
            inline
            label={rule.title}
            hint={rule.summary}
            control={
              <Switch
                id={`updates-${rule.key}`}
                checked={current.rules[rule.key]}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  save.mutate({
                    rules: { ...current.rules, [rule.key]: checked === true },
                  })
                }
              />
            }
          />
        ))}
      </SettingsGroup>

      {save.isError && (
        <p role="alert" className="px-1 text-xs text-destructive">
          Could not save. {describeError(save.error)}
        </p>
      )}
    </>
  )
}

function intervalLabel(hours: UpdateIntervalHours): string {
  if (hours === 0) return 'Never'
  if (hours === 168) return 'Weekly'
  if (hours === 24) return 'Daily'
  return `Every ${hours} hours`
}

function intervalOf(value: string): UpdateIntervalHours {
  const parsed = Number.parseInt(value, 10)
  const match = UPDATE_INTERVALS.find((hours) => hours === parsed)
  return match ?? DEFAULT_UPDATE_PREFS.intervalHours
}
